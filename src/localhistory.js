"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Histórico LOCAL de los trabajos creados desde "Trabajo local" (OPE-19): tareas, epics y
 * vinculaciones, con los enlaces de GitLab de cada item (issue/MR/epic/commit). 100% local,
 * solo para que el usuario consulte lo que ha ido generando con la herramienta.
 * Array (más reciente primero) de entradas:
 *   { id, ts, kind: "tarea"|"epic"|"vincular", title, ...payload }
 */
const CAP = 300; // tope para que el fichero no crezca sin límite

function historyPath() {
  return path.join(app.getPath("userData"), "local-history.json");
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(arr) {
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
  fs.writeFileSync(historyPath(), JSON.stringify(arr, null, 2), { mode: 0o600 });
}

// Añade una entrada al principio (más reciente primero) y recorta al tope. Best-effort: si falla la
// escritura, no rompe el flujo de creación (el histórico es secundario).
function add(entry) {
  try {
    const all = load();
    all.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), ...entry });
    write(all.slice(0, CAP));
  } catch {
    /* el histórico no debe tumbar la creación */
  }
}

function remove(id) {
  write(load().filter((e) => e.id !== id));
  return load();
}

function clear() {
  write([]);
  return [];
}

module.exports = { load, add, remove, clear };
