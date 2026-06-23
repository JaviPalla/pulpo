#!/usr/bin/env node
"use strict";

/**
 * `npm test` — corre el selftest de las tres vistas (lista, cambios, histórico)
 * contra la API real y verifica que cada una renderiza y se captura.
 * Pensado para validar cambios de UI sin interacción manual.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// En Windows el binario de electron es electron.cmd (.bin) y spawnSync no lo lanza sin extensión.
const ELECTRON = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const SHOT = path.join(os.tmpdir(), "monstro-selftest.png");
const ROUTES = ["list", "changes", "history"];

let failed = 0;
for (const route of ROUTES) {
  fs.rmSync(SHOT, { force: true });
  const res = spawnSync(ELECTRON, [".", "--selftest", `--selftest-route=${route}`], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 90_000,
  });
  const output = `${res.stdout}\n${res.stderr}`;
  const reason = /reason=([a-z-]+)/.exec(output)?.[1];
  const ok = fs.existsSync(SHOT) && reason === "render-complete";
  console.log(`${ok ? "✓" : "✗"} selftest:${route}  (reason=${reason || "?"}, screenshot=${fs.existsSync(SHOT) ? "sí" : "no"})`);
  if (!ok) failed++;
}

process.exit(failed ? 1 : 0);
