"use strict";

/**
 * OPE-20 fase 3: orquestación de AGENTES en vivo. Tras aprobar el plan, por cada proyecto se crea un
 * worktree y se lanza un `claude` autónomo (stream-json) que implementa su parte. Esta pieza:
 *  - lanza un proceso por proyecto (en paralelo) en su worktree, modo autónomo + guard de comandos
 *    peligrosos (scripts/agent-guard.js),
 *  - parsea el stream-json a una TIMELINE resumida (estilo Multica) que reenvía al renderer,
 *  - persiste el estado en userData/agent-runs.json para que los runs SOBREVIVAN al reinicio y se
 *    puedan reanudar (`claude --resume <sessionId>`),
 *  - abre el worktree en el editor (VSCode para Vue/Node, Rider para .NET).
 *
 * Las funciones puras (slug/label/parse del stream) se auto-verifican:  node src/agents.js --self-check
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* ---------- helpers puros (sin electron) ---------- */

function slugify(s) {
  return (
    String(s || "tarea")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tarea"
  );
}

const tail = (p, n = 2) => (p ? String(p).split("/").slice(-n).join("/") : "");

// Etiqueta corta y legible para una llamada a herramienta (lo que verá el usuario en la timeline).
function toolLabel(name, input) {
  const i = input || {};
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${name} ${tail(i.file_path || i.notebook_path)}`;
    case "Read":
      return `Lee ${tail(i.file_path)}`;
    case "Bash":
      return `Ejecuta: ${String(i.command || "").replace(/\s+/g, " ").slice(0, 90)}`;
    case "Grep":
      return `Busca «${i.pattern || ""}»`;
    case "Glob":
      return `Glob ${i.pattern || ""}`;
    case "Task":
      return `Subagente: ${i.description || i.subagent_type || ""}`;
    case "TodoWrite":
      return "Actualiza su plan";
    case "WebFetch":
      return `Lee web ${tail(i.url, 1)}`;
    default:
      return name;
  }
}

// Convierte UN objeto del stream-json en 0..n entradas de timeline. Devuelve [] si no aporta nada.
function summarizeEvent(evt) {
  if (!evt || typeof evt !== "object") return [];
  if (evt.type === "assistant") {
    const out = [];
    for (const c of evt.message?.content || []) {
      if (c.type === "text" && String(c.text || "").trim()) out.push({ kind: "say", text: c.text.trim().slice(0, 280) });
      else if (c.type === "tool_use") out.push({ kind: "tool", name: c.name, text: toolLabel(c.name, c.input) });
    }
    return out;
  }
  if (evt.type === "user") {
    const out = [];
    for (const c of evt.message?.content || []) {
      if (c.type !== "tool_result") continue;
      const txt = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || "").join(" ") : "";
      if (txt.includes("BLOQUEADO_MONSTRO")) out.push({ kind: "blocked", text: txt.replace(/^.*BLOQUEADO_MONSTRO:\s*/, "").slice(0, 200) });
    }
    return out;
  }
  if (evt.type === "result") {
    return [{ kind: "result", ok: !evt.is_error, text: String(evt.result || "").slice(0, 500), cost: evt.total_cost_usd || null }];
  }
  return [];
}

/* ---------- estado + persistencia (requiere electron) ---------- */

const MAX_TIMELINE = 400;
let RUNS = null; // cache en memoria de los runs persistidos
let SEND = null; // emisor de eventos al renderer (inyectado por main.js)
const procs = new Map(); // `${runId}:${projectDir}` -> ChildProcess

function init(send) { SEND = send; }

function storePath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "agent-runs.json");
}
function load() {
  if (RUNS) return RUNS;
  try { RUNS = JSON.parse(fs.readFileSync(storePath(), "utf8")); } catch { RUNS = []; }
  if (!Array.isArray(RUNS)) RUNS = [];
  return RUNS;
}
function persist() {
  try { fs.writeFileSync(storePath(), JSON.stringify(load(), null, 2)); } catch { /* best-effort */ }
}
function findRun(runId) { return load().find((r) => r.id === runId); }
function findProj(run, dir) { return run && run.projects.find((p) => p.dir === dir); }
function emit(type, payload) { if (SEND) try { SEND(type, payload); } catch { /* renderer cerrado */ } }

// Fichero de settings con el hook PreToolUse → agent-guard.js. Se escribe una vez en userData.
function guardSettingsPath() {
  const { app } = require("electron");
  const p = path.join(app.getPath("userData"), "monstro-agent-settings.json");
  const guard = path.join(__dirname, "..", "scripts", "agent-guard.js");
  const settings = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${JSON.stringify(guard).slice(1, -1)}` }] }] } };
  try { fs.writeFileSync(p, JSON.stringify(settings, null, 2)); } catch { /* best-effort */ }
  return p;
}

function buildAgentPrompt(run, proj, guidance) {
  if (guidance) {
    return `Continúas trabajando en el proyecto ${proj.name} (rama ${proj.branch}). El usuario te da este feedback adicional; aplícalo y vuelve a dejar todo commiteado:\n\n${guidance}`;
  }
  const bullets = (arr) => (arr || []).map((x) => `- ${x}`).join("\n") || "- (sin detalle)";
  return `Eres un ingeniero senior trabajando de forma AUTÓNOMA en el proyecto ${proj.name}. Estás dentro de un worktree git ya creado, en la rama ${proj.branch}. Implementa el trabajo de abajo y deja TODO commiteado en esta rama al terminar.

# Tarea
${run.title}

# Objetivos
${bullets(run.objectives)}

# A hacer en ESTE proyecto (${proj.name})
${bullets(proj.tasks)}

# Requisitos
${bullets(run.requirements)}

# Pruebas a verificar tras el desarrollo
${bullets(run.tests)}
${run.indications ? `\n# Indicaciones del usuario\n${run.indications}` : ""}

Orquesta subagentes (Task) si te ayuda y elige tú la profundidad adecuada. Los comandos peligrosos (rm -rf, git push --force, sudo…) están BLOQUEADOS por seguridad: si necesitas alguno, NO lo ejecutes — explícalo en tu resumen final para que el usuario lo apruebe. Commitea tus cambios al acabar.`;
}

// Lanza (o reanuda) el proceso claude de un proyecto y conecta su stream a la timeline.
function spawnAgent(run, proj, guidance) {
  const cliPath = claudeCli();
  if (!cliPath) { setProjStatus(run, proj, "failed", "No se encontró el CLI `claude` (instálalo y haz login, o exporta ANTHROPIC_API_KEY)."); return; }
  const prompt = buildAgentPrompt(run, proj, guidance);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", proj.model, "--permission-mode", "bypassPermissions", "--settings", guardSettingsPath()];
  if (proj.effort) args.push("--effort", proj.effort);
  if (guidance && proj.sessionId) args.push("--resume", proj.sessionId);

  proj.status = "running";
  proj.error = null;
  persist();
  emit("agents:event", { runId: run.id, projectDir: proj.dir, status: "running" });

  let buf = "";
  const child = spawn(cliPath, args, { cwd: proj.worktree, stdio: ["pipe", "pipe", "pipe"] });
  procs.set(`${run.id}:${proj.dir}`, child);

  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.session_id && !proj.sessionId) { proj.sessionId = evt.session_id; persist(); }
      const entries = summarizeEvent(evt);
      if (!entries.length) continue;
      proj.timeline.push(...entries.map((e) => ({ ...e, ts: Date.now() })));
      if (proj.timeline.length > MAX_TIMELINE) proj.timeline.splice(0, proj.timeline.length - MAX_TIMELINE);
      if (entries.some((e) => e.kind === "blocked")) proj.pending = (proj.pending || 0) + entries.filter((e) => e.kind === "blocked").length;
      persist();
      emit("agents:event", { runId: run.id, projectDir: proj.dir, entries });
    }
  });
  child.stderr.on("data", (d) => { proj.stderr = (proj.stderr || "") + String(d); });
  child.on("error", (err) => { procs.delete(`${run.id}:${proj.dir}`); setProjStatus(run, proj, "failed", String(err.message || err)); });
  child.on("close", (code) => {
    procs.delete(`${run.id}:${proj.dir}`);
    const lastResult = [...proj.timeline].reverse().find((e) => e.kind === "result");
    if (code === 0 || (lastResult && lastResult.ok)) setProjStatus(run, proj, "done");
    else setProjStatus(run, proj, "failed", (proj.stderr || `claude salió con código ${code}`).slice(0, 300));
  });
  // `claude -p` (--print) espera el prompt por stdin: si no se lo damos, expira a los 3s con
  // "Input must be provided either through stdin or as a prompt argument". Se lo escribimos y cerramos.
  child.stdin.on("error", () => { /* EPIPE si el proceso muere antes de leer stdin: lo ignora el close handler */ });
  child.stdin.write(prompt);
  child.stdin.end();
}

function setProjStatus(run, proj, status, error) {
  proj.status = status;
  if (error) proj.error = error;
  rollupRunStatus(run);
  persist();
  emit("agents:event", { runId: run.id, projectDir: proj.dir, status, error: error || null });
  emit("agents:run", { runId: run.id, status: run.status });
  if (status === "done" || status === "failed") notifyDone(run, proj, status);
}

function rollupRunStatus(run) {
  const st = run.projects.map((p) => p.status);
  if (st.some((s) => s === "running")) run.status = "running";
  else if (st.every((s) => s === "done")) run.status = "done";
  else if (st.some((s) => s === "failed")) run.status = "failed";
  else run.status = "idle";
}

function notifyDone(run, proj, status) {
  emit("agents:notify", { runId: run.id, title: run.title, projectName: proj.name, status });
}

function claudeCli() {
  try { return require("child_process").execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 }).trim() || null; } catch { return null; }
}

/* ---------- API pública (la usa main.js) ---------- */

const local = () => require("./local");

// Arranca un run: crea worktrees y lanza un agente por proyecto, en paralelo. `projects` viene del
// plan + la asignación de modelo/esfuerzo del orquestador. NO es atómico: cada proyecto va por su
// cuenta y se reporta por separado.
async function startRun({ title, url, isEpic, indications, objectives, requirements, tests, projects }) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) throw new Error("No hay proyectos sobre los que trabajar.");
  const slug = slugify(title);
  const run = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(title || "Tarea"), url: url || null, isEpic: Boolean(isEpic),
    indications: indications || "", objectives: objectives || [], requirements: requirements || [], tests: tests || [],
    createdAt: new Date().toISOString(), status: "running", projects: [],
  };
  for (const p of list) {
    const branch = p.branch || `feat/${slug}`;
    const wtSlug = `${slug}-${Date.now().toString(36)}`;
    const proj = { dir: p.dir, name: p.name || p.gitlabPath || p.dir, gitlabPath: p.gitlabPath || null, model: p.model || "claude-sonnet-4-6", effort: p.effort || null, rationale: p.rationale || "", tasks: p.tasks || [], branch, sourceBranch: p.sourceBranch || "development", worktree: null, sessionId: null, status: "starting", error: null, timeline: [], pending: 0 };
    run.projects.push(proj);
    try {
      const wt = await local().addWorktree(p.dir, { branch, slug: wtSlug, sourceBranch: proj.sourceBranch });
      proj.worktree = wt.worktree;
    } catch (err) { proj.status = "failed"; proj.error = `No se pudo crear el worktree: ${String(err.message || err)}`; continue; }
  }
  load().unshift(run);
  persist();
  emit("agents:run", { runId: run.id, status: run.status });
  // Lanzar los agentes (los que tienen worktree) tras persistir, para no bloquear el arranque.
  for (const proj of run.projects) if (proj.worktree) spawnAgent(run, proj);
  rollupRunStatus(run);
  persist();
  return run;
}

function listRuns() { return load(); }
function getRun(runId) { return findRun(runId) || null; }

// Fase 4: fusiona un patch en un proyecto del run (mr, finalized, worktreeRemoved…) y persiste.
function updateProject(runId, dir, patch) {
  const run = findRun(runId);
  const proj = findProj(run, dir);
  if (!proj) throw new Error("Proyecto del run no encontrado.");
  Object.assign(proj, patch || {});
  persist();
  emit("agents:event", { runId, projectDir: dir, ...patch });
  return proj;
}

// Fase 4: quita el worktree de un proyecto (para limpiar stale tras fusionar la MR).
async function cleanupWorktree(runId, dir) {
  const run = findRun(runId);
  const proj = findProj(run, dir);
  if (!proj || !proj.worktree) throw new Error("Worktree del proyecto no encontrado.");
  await local().removeWorktree(proj.dir, proj.worktree);
  proj.worktreeRemoved = true;
  persist();
  emit("agents:event", { runId, projectDir: dir, worktreeRemoved: true });
  return { ok: true };
}

function resumeRun(runId, projectDir, guidance) {
  const run = findRun(runId);
  const proj = findProj(run, projectDir);
  if (!proj || !proj.worktree) throw new Error("Proyecto del run no encontrado.");
  if (procs.has(`${runId}:${projectDir}`)) throw new Error("Ese agente ya está en marcha.");
  proj.timeline.push({ kind: "say", text: guidance ? `↻ Reanudado con feedback: ${guidance}` : (proj.sessionId ? "↻ Reanudado" : "↻ Reintentado tras fallo"), ts: Date.now() });
  spawnAgent(run, proj, guidance);
  return { ok: true };
}

function stopRun(runId, projectDir) {
  const stop = (key) => { const c = procs.get(key); if (c) { c.kill("SIGTERM"); procs.delete(key); } };
  const run = findRun(runId);
  if (!run) return { ok: false };
  for (const proj of run.projects) {
    if (projectDir && proj.dir !== projectDir) continue;
    stop(`${runId}:${proj.dir}`);
    if (proj.status === "running" || proj.status === "starting") setProjStatus(run, proj, "stopped");
  }
  return { ok: true };
}

function removeRun(runId) { RUNS = load().filter((r) => r.id !== runId); persist(); return RUNS; }

// Abre el worktree en el editor adecuado: Rider para .NET (*.sln/*.csproj), VSCode para Vue/Node.
function openEditor(projectDir, worktree) {
  const dir = worktree || projectDir;
  let stack = "node";
  try {
    const files = fs.readdirSync(dir);
    if (files.some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) stack = "dotnet";
    else {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) { const j = JSON.parse(fs.readFileSync(pkg, "utf8")); if ((j.dependencies && j.dependencies.vue) || (j.devDependencies && j.devDependencies.vue)) stack = "vue"; }
    }
  } catch { /* sin pistas → VSCode por defecto */ }
  const cmd = stack === "dotnet" ? ["open", ["-a", "Rider", dir]] : ["code", [dir]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref(); } catch (err) { return { ok: false, stack, error: String(err.message || err) }; }
  return { ok: true, stack };
}

module.exports = { init, startRun, listRuns, getRun, updateProject, cleanupWorktree, resumeRun, stopRun, removeRun, openEditor, slugify, toolLabel, summarizeEvent };

/* ---------- auto-verificación de las funciones puras ---------- */
if (require.main === module && process.argv[2] === "--self-check") {
  const a = require("assert");
  a.strictEqual(slugify("Unificar autenticación SSO!"), "unificar-autenticacion-sso");
  a.strictEqual(toolLabel("Edit", { file_path: "src/foo/bar.js" }), "Edit foo/bar.js");
  a.strictEqual(toolLabel("Bash", { command: "npm   test" }), "Ejecuta: npm test");
  const asst = { type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "Voy a editar el fichero" }, { type: "tool_use", name: "Edit", input: { file_path: "a/b.js" } }] } };
  const e1 = summarizeEvent(asst);
  a.strictEqual(e1.length, 2);
  a.strictEqual(e1[0].kind, "say");
  a.strictEqual(e1[1].kind, "tool");
  const blocked = { type: "user", message: { content: [{ type: "tool_result", content: "BLOQUEADO_MONSTRO: comando peligroso → rm -rf /" }] } };
  a.strictEqual(summarizeEvent(blocked)[0].kind, "blocked");
  const res = { type: "result", is_error: false, result: "Hecho", total_cost_usd: 0.12 };
  a.strictEqual(summarizeEvent(res)[0].kind, "result");
  a.deepStrictEqual(summarizeEvent({ type: "system", subtype: "init" }), []);
  console.log("agents self-check OK");
  process.exit(0);
}
