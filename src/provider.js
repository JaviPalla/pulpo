"use strict";

// Router de proveedor: el renderer no sabe si detrás hay GitHub o GitLab.
// Ambos módulos exponen la MISMA interfaz pública y devuelven datos con la
// forma de GitHub (la que consume el renderer). Se elige por config.provider.
const config = require("./config");
const github = require("./github");
const gitlab = require("./gitlab");

// Se resuelve en CADA llamada (no se cachea el módulo) para reaccionar a
// cambios de proveedor en Ajustes sin reiniciar la app.
function current() {
  return config.load().provider === "gitlab" ? gitlab : github;
}

module.exports = { current };
