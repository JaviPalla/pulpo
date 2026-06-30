"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  // Proveedor: "github" | "gitlab". null = el onboarding aún no ha preguntado.
  provider: null,
  // Base de la API de GitLab (gitlab.com o instancia self-hosted). Solo se usa con provider "gitlab".
  gitlabBaseUrl: "https://gitlab.com",
  // Sin repos de fábrica: el onboarding ofrece los repos accesibles del usuario.
  repos: [],
  pollSeconds: 60,
  // Tema de resaltado de sintaxis del diff (pantalla Cambios): "one-dark" | "dracula" | "github-light".
  theme: "one-dark",
  // Tema visual de la interfaz: "default" | "liquid-glass".
  uiTheme: "default",
  // Idioma de la interfaz: "es" | "en". null = seguir el idioma del sistema (app.getLocale()).
  language: null,
  // Comprobar al iniciar si hay una versión nueva en GitHub Releases (solo informa + enlace, no instala).
  checkUpdates: true,
  aiModel: "claude-opus-4-8",
  aiEffort: "high",
  lastRepo: null,
  lastBucket: null,
  // Apartados del menú habilitados (elegidos en el onboarding, editables en Ajustes).
  // null = aún no elegido → se muestran todos los disponibles del proveedor (retrocompat).
  sections: null,
  // Token manual SOLO como último recurso; lo normal es el CLI (gh/glab) o la env var.
  token: null,
  // Cherry-pick de hotfix tras merge (solo GitLab). Las MR de hotfix/* van a la release branch;
  // su contenido se replica a otras ramas (development + la rama hermana -mx, derivada del destino).
  cherryPick: {
    // Prefijo de rama origen que dispara el ofrecimiento de cherry-pick.
    prefix: "hotfix/",
    // Ramas destino fijas que siempre se proponen.
    branches: ["development"],
    // Además, proponer la rama hermana de la release branch destino (mx ⇄ sin mx).
    siblingMx: true,
  },
  // Vista de Milestones (solo GitLab): foto por persona de las tareas (issues) de un milestone de grupo.
  milestones: {
    // Grupo de GitLab del que leer milestones e issues. null = derivar del primer segmento de repos[].
    group: null,
    // Labels que representan el ESTADO del flujo de trabajo (se muestran como chips de filtro).
    // El resto de labels del issue se tratan como categorías/prioridades y no filtran el flujo.
    statusLabels: [
      "in development",
      "checking",
      "pending check",
      "pending check by issuer",
      "pending check in pruebas",
      "waiting",
      "needs fixing",
      "needs enhancements",
      "finished",
    ],
    // Labels de "terminada pero no cerrada" (la fase de comprobación): se ocultan por
    // defecto (chip en modo "ocultar") y alimentan la métrica "En comprobar". Un issue
    // abierto con cualquiera de estas no cuenta como pendiente. Editable por instancia.
    doneLabels: ["finished", "pending check", "pending check by issuer", "pending check in pruebas"],
  },
  // Vista de Releases (solo GitLab): genera la release branch rb/<version> replicando el script
  // legacy auto-rb-branches.py. El selector de proyectos se puebla del grupo en vivo (groupProjects),
  // pero la SELECCIÓN por defecto y la última usada se guardan aquí (configurable + recordada).
  releases: {
    // Rama origen por defecto de la que sale la release branch (ref del POST de creación).
    sourceBranch: "development",
    // Prefijo de la rama de salida; el nombre final es `${branchPrefix}${version}` (p.ej. rb/062026).
    branchPrefix: "rb/",
    // Selección por defecto (los 8 proyectos del script, por ID numérico estable: los nombres ya no
    // coinciden con el script). Se usa la PRIMERA vez (cuando aún no hay selección recordada).
    defaultProjectIds: ["12", "42", "25", "4", "11", "13", "19", "58"],
    // Última selección del usuario (paths de proyecto), recordada entre sesiones. null = usar los
    // defaultProjectIds. La vista la reescribe cada vez que cambias la selección.
    selectedProjects: null,
    // Ouicare: el AppDate es una appSetting del Web.config (cache-buster del appcache) que hay que
    // bumpear en cada release. Se actualiza en la rama origen antes de crear la release branch.
    ouicare: {
      projectPath: "OpenSaludGroup/opensalud",
      webConfigPath: "Ouicare/Web.config",
      appDateKey: "AppDate",
    },
  },
  // Vista de Soporte (solo GitLab): boards "tareas por persona" de proyectos sueltos del namespace
  // soporte (fuera del grupo de milestones). Cada clave = un apartado de la sidebar → su path de
  // proyecto. "" = sin configurar (el apartado avisa de configurarlo).
  support: {
    incidencias: "soporte/incidencias", // apartado "Support"
    operaciones: "soporte/operaciones", // apartado "Ops"
  },
  // Trabajo local → GitLab (OPE-19): publicar trabajo de ramas/worktrees locales como Issues/Epics + MRs.
  local: {
    // Directorio raíz donde conviven todos los clones de GitLab (un nivel). null = sin configurar.
    rootDir: null,
  },
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    const cfg = { ...DEFAULTS, ...parsed };
    // Merge profundo de cherryPick: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.cherryPick = { ...DEFAULTS.cherryPick, ...(parsed.cherryPick || {}) };
    // Merge profundo de milestones: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.milestones = { ...DEFAULTS.milestones, ...(parsed.milestones || {}) };
    // Merge profundo de releases (incl. la clave anidada ouicare): un guardado parcial no debe pisar defaults.
    cfg.releases = { ...DEFAULTS.releases, ...(parsed.releases || {}) };
    cfg.releases.ouicare = { ...DEFAULTS.releases.ouicare, ...(parsed.releases?.ouicare || {}) };
    // Merge profundo de local: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.local = { ...DEFAULTS.local, ...(parsed.local || {}) };
    cfg.support = { ...DEFAULTS.support, ...(parsed.support || {}) };
    return cfg;
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
