"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  // Sin repos de fábrica: el onboarding ofrece los repos accesibles del usuario.
  repos: [],
  pollSeconds: 60,
  lastRepo: null,
  lastBucket: null,
  // Token manual SOLO como último recurso; lo normal es gh CLI o GITHUB_TOKEN.
  token: null,
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = { load, save, configPath };
