#!/usr/bin/env node
"use strict";

/**
 * `npm run doctor` — diagnóstico de puesta en marcha de Pulpo.
 * Comprueba cada dependencia y dice exactamente cómo arreglar lo que falte,
 * para que cualquiera pueda levantar el proyecto sin ayuda.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let failures = 0;

function check(label, fn, { optional = false, fix = "" } = {}) {
  try {
    const detail = fn();
    console.log(`${GREEN}  ✓${RESET} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ""}`);
    return true;
  } catch (err) {
    const mark = optional ? `${YELLOW}  •${RESET}` : `${RED}  ✗${RESET}`;
    if (!optional) failures++;
    console.log(`${mark} ${label}${optional ? ` ${DIM}(opcional)${RESET}` : ""}`);
    console.log(`      ${DIM}${String(err.message || err).split("\n")[0]}${RESET}`);
    if (fix) console.log(`      → ${fix}`);
    return false;
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function which(bin) {
  return run("/bin/sh", ["-lc", `command -v ${bin}`]);
}

console.log("\n🐙 Pulpo doctor\n");

console.log("Imprescindible:");
check("Node.js ≥ 18", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error(`Node ${process.versions.node} es demasiado viejo`);
  return `v${process.versions.node}`;
});

check("Dependencias instaladas (node_modules)", () => {
  const electronPath = path.join(__dirname, "..", "node_modules", "electron");
  if (!fs.existsSync(electronPath)) throw new Error("Electron no está instalado");
  return require(path.join(electronPath, "package.json")).version;
}, { fix: "npm install" });

// Pulpo guarda la config en userData; replicamos esa ruta para saber el proveedor.
function loadPulpoConfig() {
  const dir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Pulpo")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || "", "Pulpo")
        : path.join(os.homedir(), ".config", "Pulpo");
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const cfg = loadPulpoConfig();
const provider = cfg.provider || "github";
const hasManualToken = Boolean(cfg.token);

if (provider === "gitlab") {
  const base = (cfg.gitlabBaseUrl || "https://gitlab.com").replace(/\/+$/, "");
  let host = "gitlab.com";
  try {
    host = new URL(base).host;
  } catch {
    /* base no válida: avisamos abajo */
  }
  console.log(`\nGitLab (necesario para ver y gestionar MRs) — ${base}:`);
  const hasGlab = check("GitLab CLI (glab) instalado", () => which("glab"), {
    optional: true,
    fix: "brew install glab",
  });
  let tokenOk = false;
  if (hasGlab) {
    tokenOk = check(`glab autenticado en ${host} (de aquí sale tu token)`, () => {
      // OJO: el flag es --host; -h es --help en glab.
      const token = run("glab", ["config", "get", "token", "--host", host]);
      if (!token) throw new Error(`glab no tiene token para ${host}`);
      return "token disponible";
    }, { optional: hasManualToken || Boolean(process.env.GITLAB_TOKEN), fix: `glab auth login --hostname ${host}` });
  }
  if (!tokenOk) {
    check("GITLAB_TOKEN exportado o token manual en Ajustes", () => {
      if (process.env.GITLAB_TOKEN) return "GITLAB_TOKEN presente";
      if (hasManualToken) return "token manual guardado en config.json";
      throw new Error("Sin token de GitLab");
    }, {
      fix: `exporta GITLAB_TOKEN, o \`glab auth login --hostname ${host}\`, o pega un token (scope \`api\`) en Ajustes ⚙ de la app`,
    });
  }
} else {
  console.log("\nGitHub (necesario para ver y gestionar PRs):");
  const hasGhCli = check("GitHub CLI (gh) instalado", () => which("gh"), {
    optional: true,
    fix: "brew install gh",
  });
  if (hasGhCli) {
    check("gh autenticado (de aquí sale tu token)", () => {
      const token = run("gh", ["auth", "token"]);
      if (!token) throw new Error("gh auth token devolvió vacío");
      return "token disponible";
    }, { optional: hasManualToken || Boolean(process.env.GITHUB_TOKEN), fix: "gh auth login" });
  } else {
    check("GITHUB_TOKEN exportado o token manual (alternativa a gh)", () => {
      if (process.env.GITHUB_TOKEN) return "GITHUB_TOKEN presente";
      if (hasManualToken) return "token manual guardado en config.json";
      throw new Error("Sin gh CLI ni GITHUB_TOKEN");
    }, { fix: "exporta GITHUB_TOKEN o instala gh y haz `gh auth login` (también puedes pegar un token en Ajustes ⚙ de la app)" });
  }
}

console.log("\nIA (opcional — para el botón 🤖 Review con IA):");
const sdkKey = check("ANTHROPIC_API_KEY", () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("No exportada");
  return "presente (usará el SDK oficial)";
}, { optional: true });
if (!sdkKey) {
  check("Claude Code CLI autenticado", () => {
    const cli = which("claude");
    const version = run("claude", ["--version"]).split("\n")[0];
    return `${cli} (${version})`;
  }, {
    optional: true,
    fix: "instala Claude Code (https://claude.com/claude-code) y ábrelo una vez para autenticarte — Pulpo usará tu sesión automáticamente",
  });
}

console.log("");
if (failures) {
  console.log(`${RED}✗ ${failures} comprobación(es) imprescindible(s) fallaron.${RESET} Arregla lo de arriba y vuelve a correr: npm run doctor\n`);
  process.exit(1);
}
console.log(`${GREEN}✓ Todo listo.${RESET} Arranca con: npm start\n`);
