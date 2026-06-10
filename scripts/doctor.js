#!/usr/bin/env node
"use strict";

/**
 * `npm run doctor` — diagnóstico de puesta en marcha de Pulpo.
 * Comprueba cada dependencia y dice exactamente cómo arreglar lo que falte,
 * para que cualquiera pueda levantar el proyecto sin ayuda.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
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
  }, { fix: "gh auth login" });
} else {
  check("GITHUB_TOKEN exportado (alternativa a gh)", () => {
    if (!process.env.GITHUB_TOKEN) throw new Error("Sin gh CLI ni GITHUB_TOKEN");
    return "presente";
  }, { fix: "exporta GITHUB_TOKEN o instala gh y haz `gh auth login` (también puedes pegar un token en Ajustes ⚙ de la app)" });
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
