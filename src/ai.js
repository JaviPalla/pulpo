"use strict";

/**
 * Review con IA: analiza el diff de una PR y devuelve comentarios de review
 * estructurados (en inglés) que Monstro convierte en BORRADORES locales — nunca
 * se publica nada sin que el usuario pulse Publicar.
 *
 * Backends, en orden:
 *  1. ANTHROPIC_API_KEY presente → SDK oficial de Anthropic con structured
 *     outputs (JSON estricto garantizado por schema).
 *  2. CLI de Claude Code (`claude -p --output-format json`) → usa la sesión
 *     ya autenticada del usuario; el JSON se extrae del campo `result`.
 */

const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const config = require("./config");

/**
 * Catálogo de modelos para la review. Los IDs valen tal cual para los dos
 * backends (API y `claude --model`). `efforts` lista los niveles que ese
 * modelo acepta en output_config.effort / --effort; vacío = no soportado
 * (Haiku tampoco soporta thinking adaptativo, así que se omite ahí).
 */
const AI_MODELS = {
  "claude-opus-4-8": { label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "max"] },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", efforts: [] },
};
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_EFFORT = "high";
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Modelo + esfuerzo efectivos: lo configurado, saneado contra el catálogo. */
function aiSettings() {
  const cfg = config.load();
  const model = AI_MODELS[cfg.aiModel] ? cfg.aiModel : DEFAULT_MODEL;
  const efforts = AI_MODELS[model].efforts;
  const effort = efforts.includes(cfg.aiEffort)
    ? cfg.aiEffort
    : efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null;
  return { model, effort };
}

/** Como aiSettings() pero pudiendo forzar modelo/esfuerzo (lo elige el usuario en el form del plan).
 * Si el override trae un modelo válido, su esfuerzo se sanea contra el catálogo de ESE modelo. */
function resolveAi(override) {
  if (!override || !override.model || !AI_MODELS[override.model]) return aiSettings();
  const model = override.model;
  const efforts = AI_MODELS[model].efforts;
  const effort = efforts.includes(override.effort)
    ? override.effort
    : efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : efforts[efforts.length - 1] || null;
  return { model, effort };
}

const MAX_DIFF_CHARS = 70_000;
const CLI_TIMEOUT_MS = 12 * 60 * 1000;
// Sin MCP servers ni persistencia de sesión: arranque más rápido y sin tocar
// el historial de Claude Code del usuario. La review es un one-shot sin tools.
const CLI_ARGS = [
  "-p",
  "--output-format", "json",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--no-session-persistence",
];

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Concise overall review summary in English (markdown allowed).",
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path exactly as it appears in the diff." },
          line: { type: "integer", description: "Line number the comment anchors to." },
          side: { type: "string", enum: ["LEFT", "RIGHT"] },
          body: { type: "string", description: "The review comment, in English." },
        },
        required: ["path", "line", "side", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "comments"],
  additionalProperties: false,
};

function buildPrompt({ title, body, diffText, truncated }) {
  return `You are a senior software engineer reviewing a colleague's pull request. Review the diff below and produce focused, actionable review comments.

Rules:
- Write everything in English (comments and summary).
- Focus on real issues: correctness bugs, edge cases, race conditions, security, performance, misleading names, dead code. Avoid style nits and empty praise.
- At most 8 inline comments — only the ones worth a human's attention. If the change looks good, return few or zero comments and say so in the summary.
- Each inline comment anchors to a line VISIBLE IN THE DIFF: use side "RIGHT" with the new-file line number for added/context lines, or side "LEFT" with the old-file line number for deleted lines. Use the exact file path shown in the diff.
- Be concrete: say what is wrong and what you would do instead.
${truncated ? "- Note: the diff was truncated for length; mention that in the summary.\n" : ""}
Respond with ONLY a JSON object matching this shape (no prose, no code fences):
{"summary": string, "comments": [{"path": string, "line": integer, "side": "LEFT"|"RIGHT", "body": string}]}

# Pull request
Title: ${title}

Description:
${body || "(no description)"}

# Diff
${diffText}`;
}

function buildDiffText(files) {
  const parts = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    if (!file.patch) continue;
    const header = `--- a/${file.previousFilename || file.filename}\n+++ b/${file.filename}\n`;
    const chunk = header + file.patch + "\n";
    if (used + chunk.length > MAX_DIFF_CHARS) {
      truncated = true;
      break;
    }
    parts.push(chunk);
    used += chunk.length;
  }
  return { diffText: parts.join("\n"), truncated };
}

/* ---------- backend 1: SDK oficial (requiere ANTHROPIC_API_KEY) ---------- */

async function generateViaSdk(prompt, model, effort, schema) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  const client = new Anthropic();
  const request = {
    model,
    max_tokens: 16000,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  };
  if (AI_MODELS[model].efforts.length) {
    request.thinking = { type: "adaptive" };
    if (effort) request.output_config.effort = effort;
  }
  const response = await client.messages.create(request);
  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Empty response from the Anthropic API");
  return JSON.parse(text);
}

/* ---------- backend 2: CLI de Claude Code (sesión del usuario) ---------- */

function claudeCliPath() {
  try {
    // Windows: `where` (devuelve una ruta por línea, nos quedamos con la primera).
    // Unix/macOS: shell de login para heredar el PATH del usuario (nvm, brew, etc.).
    const out =
      process.platform === "win32"
        ? execFileSync("where", ["claude"], { encoding: "utf8", timeout: 5000 }).split(/\r?\n/)[0]
        : execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function generateViaCli(prompt, cliPath, model, effort) {
  const args = [...CLI_ARGS, "--model", model];
  if (effort) args.push("--effort", effort);
  return new Promise((resolve, reject) => {
    // shell:true en Windows: el CLI suele ser claude.cmd y Node ya no lanza .cmd sin shell.
    const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(
          new Error(
            `La review tardó más de ${CLI_TIMEOUT_MS / 60000} min y se canceló (PR muy grande). ` +
              "Reintenta, o exporta ANTHROPIC_API_KEY para usar la API directa (más rápida).",
          ),
        );
      }
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) return reject(new Error(`claude CLI error: ${String(envelope.result).slice(0, 300)}`));
        resolve(extractJson(envelope.result));
      } catch (err) {
        reject(new Error(`Could not parse claude CLI output: ${err.message}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Tolerante con cercos ```json y prosa accidental alrededor del objeto. */
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in the model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/* ---------- dispatch común ---------- */

// Lanza el prompt contra el backend disponible (SDK si hay API key, si no el CLI) y devuelve
// el JSON ya parseado + qué backend/modelo se usó. El schema solo lo aplica el SDK; el CLI
// lo cumple por el prompt y se parsea de forma tolerante (extractJson).
async function runStructured(prompt, schema, override) {
  const { model, effort } = resolveAi(override);
  if (process.env.ANTHROPIC_API_KEY) {
    return { data: await generateViaSdk(prompt, model, effort, schema), backend: "anthropic-sdk", model, effort };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    return { data: await generateViaCli(prompt, cliPath, model, effort), backend: "claude-cli", model, effort };
  }
  throw new Error(
    "Sin backend de IA: exporta ANTHROPIC_API_KEY o instala/loguea el CLI de Claude Code (`claude`).",
  );
}

/* ---------- API pública ---------- */

async function generateReview({ title, body, files }) {
  const { diffText, truncated } = buildDiffText(files);
  if (!diffText) throw new Error("La PR no tiene diff revisable (¿binarios?)");
  const prompt = buildPrompt({ title, body, diffText, truncated });
  const { data, backend, model, effort } = await runStructured(prompt, REVIEW_SCHEMA);
  return { review: normalize(data), backend, model, effort };
}

function normalize(review) {
  return {
    summary: typeof review.summary === "string" ? review.summary : "",
    comments: (Array.isArray(review.comments) ? review.comments : [])
      .filter((c) => c && typeof c.path === "string" && Number.isInteger(c.line) && typeof c.body === "string")
      .map((c) => ({ path: c.path, line: c.line, side: c.side === "LEFT" ? "LEFT" : "RIGHT", body: c.body }))
      .slice(0, 12),
  };
}

/* ---------- resumen de milestone para correo ---------- */

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index (in brackets) of the source item this refers to." },
          headline: { type: "string", description: "Short non-technical title in Spanish." },
          relevance: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "How relevant this is for a team-wide, non-technical email.",
          },
        },
        required: ["index", "headline", "relevance"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildSummaryPrompt(milestoneTitle, items) {
  const lines = items.map((it, i) => {
    if (it.kind === "epic") {
      const kids = (it.children || []).slice(0, 12).join("; ");
      return `[${i}] (EPIC) ${it.title}${kids ? ` — incluye: ${kids}` : ""}`;
    }
    const labels = (it.labels || []).join(", ");
    const desc = stripHtml(it.desc).slice(0, 400);
    const kids = (it.children || []).slice(0, 12).join("; ");
    return `[${i}] ${it.title}${labels ? ` (etiquetas: ${labels})` : ""}${desc ? ` — ${desc}` : ""}${kids ? ` — subtareas: ${kids}` : ""}`;
  });
  return `Eres un asistente que prepara un resumen de novedades de un milestone para enviarlo por CORREO a todo el equipo, incluida gente NO técnica.

Te paso una lista numerada de tareas (issues) y epics del milestone "${milestoneTitle}". Cada línea empieza por su índice entre corchetes.

Tu trabajo:
- Clasifica TODOS los items por relevancia para el equipo. NO descartes ninguno: el usuario los revisará y decidirá cuáles enviar.
- Para cada uno escribe un "headline" corto y claro en ESPAÑOL, en lenguaje que entienda alguien no técnico (qué cambia o mejora, no el detalle técnico).
- Asigna a cada uno una "relevance": "high", "medium" o "low" según lo relevante que sea para un correo no técnico a todo el equipo. Lo trivial e interno (chores, refactors menores, typos, mantenimiento sin impacto visible) → "low".
- Una EPIC representa un conjunto de tareas: resúmela como UNA sola novedad, sin desglosar sus hijas.
- Devuelve el índice original de cada item.

Responde SOLO con un objeto JSON con esta forma (sin prosa ni cercos):
{"items": [{"index": number, "headline": string, "relevance": "high"|"medium"|"low"}]}

# Items
${lines.join("\n")}`;
}

const RELEVANCE_RANK = { high: 0, medium: 1, low: 2 };

// Recibe los items ya con las epics colapsadas (gitlab.collapseMilestoneEpics) y devuelve TODOS
// clasificados por relevancia (con titular no técnico + enlace a GitLab); el usuario los curará en
// la UI. kind/title/url se copian del item original por índice (nunca del modelo); los que la IA
// omita o devuelva inválidos caen a relevance "low" con el title como headline para no perderlos.
async function summarizeMilestone({ milestoneTitle, items }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new Error("No hay tareas asignadas que resumir en este milestone.");
  const prompt = buildSummaryPrompt(milestoneTitle || "", list);
  const { data, backend, model, effort } = await runStructured(prompt, SUMMARY_SCHEMA);

  // Indexa la respuesta de la IA por índice de item (última gana si hay duplicados).
  const byIndex = new Map();
  for (const it of Array.isArray(data.items) ? data.items : []) {
    const index = Number(it && it.index);
    if (!Number.isInteger(index) || !list[index]) continue;
    const headline = typeof it.headline === "string" ? it.headline.trim() : "";
    const relevance = RELEVANCE_RANK[it.relevance] !== undefined ? it.relevance : "low";
    byIndex.set(index, { headline, relevance });
  }

  // Un item de salida por cada item de entrada, con fallback para los que falten o sean inválidos.
  const result = list.map((item, index) => {
    const ai = byIndex.get(index);
    return {
      kind: item.kind,
      title: item.title,
      url: item.url,
      headline: ai && ai.headline ? ai.headline : item.title,
      relevance: ai ? ai.relevance : "low",
    };
  });
  result.sort((a, b) => RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance]);

  return { items: result, backend, model, effort };
}

/* ---------- propuesta de tarea (Trabajo local → GitLab) ---------- */

// Etiquetas que la IA puede sugerir: SOLO tipo de usuario afectado + prioridad (el usuario añade el
// resto a mano desde las disponibles del grupo).
const SUGGESTED_LABELS = ["patient user", "professional user", "center user", "high priority", "medium priority", "low priority"];
const labelsSchema = { type: "array", items: { type: "string", enum: SUGGESTED_LABELS }, description: "Etiquetas que apliquen, SOLO de la lista permitida. Como mucho un tipo de usuario y una prioridad." };
const labelsGuide = `- "labels": elige SOLO de esta lista las que apliquen — tipo de usuario afectado: "patient user", "professional user", "center user"; prioridad: "high priority", "medium priority", "low priority". Como mucho un tipo de usuario y una prioridad. Si no estás seguro, deja la lista vacía.`;

const TASK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Título conciso de la tarea, en español (estilo issue)." },
    description: { type: "string", description: "Descripción en español (markdown) de qué hace el cambio y por qué." },
    checklist: {
      type: "array",
      items: { type: "string", description: "Un punto a comprobar/validar del flujo introducido, en español." },
      description: "Puntos a comprobar del flujo (QA). Entre 2 y 8.",
    },
    commitMessage: { type: "string", description: "Mensaje de commit conciso en español (una línea, estilo imperativo). SIN el ID de la issue." },
    labels: labelsSchema,
  },
  required: ["title", "description", "checklist", "commitMessage", "labels"],
  additionalProperties: false,
};

function buildTaskPrompt({ diffText, repoName, branch, truncated }) {
  return `Eres un ingeniero senior preparando una tarea (issue) y su merge request en GitLab a partir de un cambio ya desarrollado en local.

Te paso el diff de la rama "${branch}" del repo "${repoName}". A partir de él:
- "title": un título conciso y claro en ESPAÑOL para la issue.
- "description": en ESPAÑOL (markdown), el PROPÓSITO de la tarea a nivel general (qué se busca conseguir y por qué). NO describas el detalle de implementación del código: NO menciones servicios, funciones, clases ni ficheros concretos. Si hace falta algún detalle técnico, exprésalo a nivel de ENDPOINTS a implementar (p.ej. "POST /pedidos"), nunca servicios o funciones concretas — salvo que el propósito mismo de la tarea SEA ese servicio/función.
- "checklist": entre 2 y 8 PUNTOS A COMPROBAR del flujo introducido (QA), en ESPAÑOL, concretos y verificables (no genéricos).
- "commitMessage": un mensaje de commit conciso en ESPAÑOL (una línea, imperativo, p.ej. "Añade exportación de pedidos a CSV"). NO incluyas el ID de la issue (se añade aparte).
${labelsGuide}
${truncated ? "- Nota: el diff se truncó por longitud; tenlo en cuenta.\n" : ""}
Responde SOLO con un objeto JSON con esta forma (sin prosa ni cercos):
{"title": string, "description": string, "checklist": [string], "commitMessage": string, "labels": [string]}

# Diff
${diffText || "(sin diff disponible: infiere lo que puedas del nombre de la rama)"}`;
}

// Genera título + descripción + checklist para una tarea a partir del diff de una rama local.
async function proposeTask({ diffText, repoName, branch }) {
  const truncated = (diffText || "").length > MAX_DIFF_CHARS;
  const prompt = buildTaskPrompt({ diffText: (diffText || "").slice(0, MAX_DIFF_CHARS), repoName, branch, truncated });
  const { data, backend, model, effort } = await runStructured(prompt, TASK_SCHEMA);
  return {
    title: typeof data.title === "string" ? data.title.trim() : "",
    description: typeof data.description === "string" ? data.description : "",
    checklist: (Array.isArray(data.checklist) ? data.checklist : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 8),
    commitMessage: typeof data.commitMessage === "string" ? data.commitMessage.trim() : "",
    labels: (Array.isArray(data.labels) ? data.labels : []).filter((x) => SUGGESTED_LABELS.includes(x)),
    backend,
    model,
    effort,
  };
}

const EPIC_SCHEMA = {
  type: "object",
  properties: {
    epicTitle: { type: "string", description: "Título conciso de la Epic, en español, que englobe el cambio en todos los proyectos." },
    projects: {
      type: "array",
      description: "Una entrada por proyecto, EN EL MISMO ORDEN que la lista de entrada.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Título de la tarea para ESE proyecto, en español." },
          description: { type: "string", description: "Descripción (markdown) del cambio en ESE proyecto, en español." },
          checklist: { type: "array", items: { type: "string" }, description: "2 a 8 puntos a comprobar de ese proyecto." },
          commitMessage: { type: "string", description: "Mensaje de commit conciso (una línea, imperativo) de ese proyecto, SIN el ID de la issue." },
        },
        required: ["title", "description", "checklist", "commitMessage"],
        additionalProperties: false,
      },
    },
    labels: labelsSchema,
  },
  required: ["epicTitle", "projects", "labels"],
  additionalProperties: false,
};

function buildEpicPrompt(projects) {
  const blocks = projects
    .map((p, i) => `## [${i}] Proyecto: ${p.name} (rama ${p.branch})\n${(p.diff || "(sin diff disponible)").slice(0, Math.floor(MAX_DIFF_CHARS / projects.length))}`)
    .join("\n\n");
  return `Eres un ingeniero senior preparando una EPIC en GitLab que agrupa un mismo cambio repartido en ${projects.length} proyectos.

Para cada proyecto te paso su diff (encabezado con su índice entre corchetes). Devuelve:
- "epicTitle": un título en ESPAÑOL para la Epic que englobe el cambio completo.
- "projects": un objeto por proyecto, EN EL MISMO ORDEN, con "title" (título de la tarea de ese proyecto), "description" y "checklist", todo en ESPAÑOL.
La "description" debe ser el PROPÓSITO de la tarea a nivel general (qué se busca y por qué), NO el detalle de implementación: NO menciones servicios, funciones, clases ni ficheros concretos. Si hace falta detalle técnico, exprésalo a nivel de ENDPOINTS a implementar, nunca servicios/funciones concretas — salvo que el propósito de la tarea SEA ese servicio/función. El "checklist" son 2-8 puntos a comprobar concretos. El "commitMessage" es un mensaje de commit conciso (una línea, imperativo) SIN el ID de la issue.
Además, a nivel raíz:
${labelsGuide} (aplican a toda la Epic)

Responde SOLO con un objeto JSON con esta forma (sin prosa ni cercos):
{"epicTitle": string, "labels": [string], "projects": [{"title": string, "description": string, "checklist": [string], "commitMessage": string}]}

${blocks}`;
}

// Propuesta IA para una Epic multiproyecto: título de Epic + título/descripción/checklist por proyecto.
// Devuelve siempre `projects` alineado por índice con la entrada (rellena huecos para no descuadrar la UI).
async function proposeEpic({ projects }) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) throw new Error("No hay proyectos que proponer.");
  const { data, backend, model, effort } = await runStructured(buildEpicPrompt(list), EPIC_SCHEMA);
  const out = Array.isArray(data.projects) ? data.projects : [];
  return {
    epicTitle: typeof data.epicTitle === "string" ? data.epicTitle.trim() : "",
    labels: (Array.isArray(data.labels) ? data.labels : []).filter((x) => SUGGESTED_LABELS.includes(x)),
    projects: list.map((_, i) => {
      const p = out[i] || {};
      return {
        title: typeof p.title === "string" ? p.title.trim() : "",
        description: typeof p.description === "string" ? p.description : "",
        checklist: (Array.isArray(p.checklist) ? p.checklist : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 8),
        commitMessage: typeof p.commitMessage === "string" ? p.commitMessage.trim() : "",
      };
    }),
    backend,
    model,
    effort,
  };
}

/* ---------- plan de "Empezar tarea" (OPE-20) ---------- */

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    objectives: { type: "array", items: { type: "string" }, description: "Objetivos de la tarea, en español. 2 a 6." },
    requirements: { type: "array", items: { type: "string" }, description: "Requisitos a cumplir para darla por hecha, en español. 2 a 8." },
    tests: { type: "array", items: { type: "string" }, description: "Pruebas a realizar tras el desarrollo para verificar el trabajo, en español. 2 a 8." },
    projects: {
      type: "array",
      description: "Proyectos que hay que tocar. Si el usuario fijó una lista, úsala TAL CUAL; si no, INFIÉRELOS de la descripción.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Path o nombre del proyecto GitLab a tocar." },
          tasks: { type: "array", items: { type: "string" }, description: "Tareas concretas a hacer en ESE proyecto, en español." },
        },
        required: ["name", "tasks"],
        additionalProperties: false,
      },
    },
  },
  required: ["objectives", "requirements", "tests", "projects"],
  additionalProperties: false,
};

function buildPlanPrompt({ title, description, isEpic, indications, repos, available }) {
  // El conjunto PERMITIDO de proyectos: si el usuario fijó una lista, esa; si no, los disponibles
  // (clonados en local Y seleccionables en la app). El "name" de cada project DEBE salir de aquí.
  const allowed = (repos && repos.length ? repos.map((p) => ({ path: p, name: p })) : available || []);
  const projBlock = allowed.length
    ? `PROYECTOS PERMITIDOS (clonados en local y seleccionables en la app). El campo "name" de CADA entrada de "projects" DEBE ser EXACTAMENTE uno de estos paths — agrupa todo el trabajo bajo ellos, sin inventar nombres ni descripciones. Si de verdad algún trabajo no encaja en NINGUNO, ponle un "name" descriptivo y corto (el usuario lo asignará a mano):\n${allowed.map((p) => `- ${p.path}${p.name && p.name !== p.path ? `  (${p.name})` : ""}`).join("\n")}`
    : `No hay lista de proyectos disponibles: INFIERE de la descripción cuáles hay que tocar y usa su path de GitLab "grupo/proyecto" como "name".`;
  return `Eres un tech lead senior. Vas a redactar el PLAN de trabajo de una ${isEpic ? "Epic (cambio repartido en varios proyectos)" : "tarea"} de GitLab, que el usuario deberá APROBAR antes de lanzar a los agentes. El plan debe ser claro y accionable, en ESPAÑOL.

Devuelve:
- "objectives": objetivos de la tarea (qué se busca conseguir).
- "requirements": requisitos que se deben cumplir para darla por terminada.
- "tests": pruebas a realizar TRAS el desarrollo para verificar el trabajo (concretas y verificables, no genéricas).
- "projects": por cada proyecto a tocar, su "name" (un path de la lista permitida) y la lista de "tasks" concretas en ese proyecto.

${projBlock}

# Tarea
Título: ${title}
${description ? `Descripción:\n${description}` : "(sin descripción)"}
${indications ? `\n# Indicaciones adicionales del usuario\n${indications}` : ""}

Responde SOLO con un objeto JSON con esta forma (sin prosa ni cercos):
{"objectives":[string],"requirements":[string],"tests":[string],"projects":[{"name":string,"tasks":[string]}]}`;
}

// Plan aprobable de "Empezar tarea". SIEMPRE permite forzar modelo/esfuerzo (el usuario lo elige;
// por defecto el más alto). Nada se ejecuta con esto: es solo la propuesta que el usuario aprueba.
// `available` = proyectos candidatos {path,name} (local ∩ remotos) para que el "name" sea un path real.
async function proposePlan({ title, description, isEpic, indications, repos, available, model, effort }) {
  if (!String(title || "").trim()) throw new Error("La tarea no tiene título.");
  const prompt = buildPlanPrompt({ title, description, isEpic, indications, repos, available });
  const res = await runStructured(prompt, PLAN_SCHEMA, { model, effort });
  const d = res.data || {};
  const arr = (x) => (Array.isArray(x) ? x : []).filter((s) => typeof s === "string" && s.trim());
  return {
    objectives: arr(d.objectives),
    requirements: arr(d.requirements),
    tests: arr(d.tests),
    projects: (Array.isArray(d.projects) ? d.projects : []).map((p) => ({
      name: typeof p.name === "string" ? p.name.trim() : "",
      tasks: arr(p.tasks),
    })).filter((p) => p.name),
    backend: res.backend,
    model: res.model,
    effort: res.effort,
  };
}

/* ---------- orquestador: elige modelo/esfuerzo por proyecto (OPE-20 fase 3) ---------- */

const AGENTS_SCHEMA = {
  type: "object",
  properties: {
    projects: {
      type: "array",
      description: "Una entrada por proyecto, EN EL MISMO ORDEN que la entrada.",
      items: {
        type: "object",
        properties: {
          model: { type: "string", enum: Object.keys(AI_MODELS), description: "Modelo adecuado al trabajo de ese proyecto." },
          effort: { type: "string", enum: ["", ...ALL_EFFORTS], description: "Esfuerzo de razonamiento (vacío si el modelo no lo soporta)." },
          rationale: { type: "string", description: "Una frase, en español, justificando la elección." },
        },
        required: ["model", "effort", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["projects"],
  additionalProperties: false,
};

// El "agente orquestador": dado el plan, asigna a CADA proyecto el modelo/esfuerzo adecuado (no
// siempre hace falta Opus/max). Devuelve la elección + el porqué, que queda registrado en los logs
// del run. Se sanea contra el catálogo (un modelo/effort inválido cae al default).
async function planAgents({ title, projects }) {
  const list = (Array.isArray(projects) ? projects : []).map((p) => ({ name: p.name, tasks: p.tasks || [] }));
  if (!list.length) throw new Error("No hay proyectos que orquestar.");
  const blocks = list.map((p, i) => `## [${i}] ${p.name}\n${(p.tasks || []).map((t) => `- ${t}`).join("\n") || "- (sin tareas)"}`).join("\n\n");
  const catalog = Object.entries(AI_MODELS).map(([id, m]) => `- ${id} (${m.label})${m.efforts.length ? ` esfuerzos: ${m.efforts.join("/")}` : " sin esfuerzo"}`).join("\n");
  const prompt = `Eres un tech lead que reparte trabajo entre agentes de IA. Para la tarea "${title}", asigna a CADA proyecto el modelo y esfuerzo ADECUADOS al tamaño/dificultad de su parte. No malgastes: usa Opus/esfuerzo alto SOLO si el trabajo lo merece; tareas sencillas → modelos más baratos (Sonnet/Haiku) y esfuerzo bajo/medio.

Modelos disponibles:
${catalog}

Proyectos (en orden):
${blocks}

Responde SOLO con JSON: {"projects":[{"model":string,"effort":string,"rationale":string}]} (un objeto por proyecto, mismo orden; "effort" vacío si el modelo no soporta esfuerzo).`;
  const { data, backend } = await runStructured(prompt, AGENTS_SCHEMA);
  const out = Array.isArray(data.projects) ? data.projects : [];
  return {
    backend,
    projects: list.map((p, i) => {
      const choice = out[i] || {};
      const model = AI_MODELS[choice.model] ? choice.model : DEFAULT_MODEL;
      const efforts = AI_MODELS[model].efforts;
      const effort = efforts.includes(choice.effort) ? choice.effort : efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null;
      return { name: p.name, model, effort, rationale: typeof choice.rationale === "string" ? choice.rationale.trim() : "" };
    }),
  };
}

/** Estado del backend de IA, para onboarding y ajustes. */
function backendStatus() {
  const { model, effort } = aiSettings();
  const base = {
    model,
    effort,
    models: Object.entries(AI_MODELS).map(([id, m]) => ({ id, label: m.label, efforts: m.efforts })),
  };
  if (process.env.ANTHROPIC_API_KEY) {
    return { ...base, backend: "anthropic-sdk", detail: "ANTHROPIC_API_KEY presente — SDK oficial" };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    let version = "";
    try {
      version = execFileSync(cliPath, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    } catch {
      /* la versión es decorativa */
    }
    return { ...base, backend: "claude-cli", detail: `Claude Code CLI en ${cliPath}${version ? ` (${version})` : ""}` };
  }
  return { ...base, backend: null, detail: "Sin backend: exporta ANTHROPIC_API_KEY o instala Claude Code y haz login" };
}

/** Prueba ligera del backend (para el botón "Probar IA" de Ajustes). */
async function ping() {
  const status = backendStatus();
  if (!status.backend) return { ...status, ok: false };
  const { model, effort } = aiSettings();
  try {
    if (status.backend === "anthropic-sdk") {
      const Anthropic = require("@anthropic-ai/sdk").default;
      await new Anthropic().models.retrieve(model);
      return { ...status, ok: true };
    }
    const result = await generateViaCli(
      'Reply with ONLY this JSON and nothing else: {"ok": true}',
      claudeCliPath(),
      model,
      effort,
    );
    return { ...status, ok: result.ok === true };
  } catch (err) {
    return { ...status, ok: false, detail: `${status.detail} — fallo: ${String(err.message || err).slice(0, 200)}` };
  }
}

function isAiModel(id) {
  return Boolean(AI_MODELS[id]);
}

function isAiEffort(level) {
  return ALL_EFFORTS.includes(level);
}

module.exports = { generateReview, summarizeMilestone, proposeTask, proposeEpic, proposePlan, planAgents, backendStatus, ping, isAiModel, isAiEffort };
