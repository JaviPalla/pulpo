"use strict";

/**
 * Review con IA: analiza el diff de una PR y devuelve comentarios de review
 * estructurados (en inglés) que Pulpo convierte en BORRADORES locales — nunca
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

const MODEL = "claude-opus-4-8";
const MAX_DIFF_CHARS = 70_000;
const CLI_TIMEOUT_MS = 5 * 60 * 1000;

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

async function generateViaSdk(prompt) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Empty response from the Anthropic API");
  return JSON.parse(text);
}

/* ---------- backend 2: CLI de Claude Code (sesión del usuario) ---------- */

function claudeCliPath() {
  try {
    return execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function generateViaCli(prompt, cliPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["-p", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
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

/* ---------- API pública ---------- */

async function generateReview({ title, body, files }) {
  const { diffText, truncated } = buildDiffText(files);
  if (!diffText) throw new Error("La PR no tiene diff revisable (¿binarios?)");
  const prompt = buildPrompt({ title, body, diffText, truncated });

  if (process.env.ANTHROPIC_API_KEY) {
    return { review: normalize(await generateViaSdk(prompt)), backend: "anthropic-sdk" };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    return { review: normalize(await generateViaCli(prompt, cliPath)), backend: "claude-cli" };
  }
  throw new Error(
    "Sin backend de IA: exporta ANTHROPIC_API_KEY o instala/loguea el CLI de Claude Code (`claude`).",
  );
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

/** Estado del backend de IA, para onboarding y ajustes. */
function backendStatus() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { backend: "anthropic-sdk", detail: "ANTHROPIC_API_KEY presente — SDK oficial (claude-opus-4-8)" };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    let version = "";
    try {
      version = execFileSync(cliPath, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    } catch {
      /* la versión es decorativa */
    }
    return { backend: "claude-cli", detail: `Claude Code CLI en ${cliPath}${version ? ` (${version})` : ""}` };
  }
  return { backend: null, detail: "Sin backend: exporta ANTHROPIC_API_KEY o instala Claude Code y haz login" };
}

/** Prueba ligera del backend (para el botón "Probar IA" de Ajustes). */
async function ping() {
  const status = backendStatus();
  if (!status.backend) return { ...status, ok: false };
  try {
    if (status.backend === "anthropic-sdk") {
      const Anthropic = require("@anthropic-ai/sdk").default;
      await new Anthropic().models.retrieve(MODEL);
      return { ...status, ok: true };
    }
    const result = await generateViaCli(
      'Reply with ONLY this JSON and nothing else: {"ok": true}',
      claudeCliPath(),
    );
    return { ...status, ok: result.ok === true };
  } catch (err) {
    return { ...status, ok: false, detail: `${status.detail} — fallo: ${String(err.message || err).slice(0, 200)}` };
  }
}

module.exports = { generateReview, backendStatus, ping };
