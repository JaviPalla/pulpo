"use strict";

/* ============ estado ============ */
const IS_SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";
const SELFTEST_ROUTE = new URLSearchParams(location.search).get("selftest_route") || "list";

// Mascota = el mismo icono del dock (scripts/make-icon.js), inline en SVG porque el CSP
// (img-src https: data:) no deja cargar el PNG local. Fuente única para brand/welcome/empty.
function mascot(size = 24) {
  return `<svg class="mascot" width="${size}" height="${size}" viewBox="0 0 1024 1024" aria-hidden="true">
  <defs>
    <linearGradient id="m-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6573ef"/><stop offset="1" stop-color="#7f3df0"/></linearGradient>
    <linearGradient id="m-shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
    <linearGradient id="m-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ff0b8"/><stop offset="1" stop-color="#23c98c"/></linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#m-bg)"/>
  <rect x="64" y="64" width="896" height="448" rx="200" fill="url(#m-shine)"/>
  <path d="M 372 332 L 322 196 L 452 312 Z" fill="#2b2f55"/>
  <path d="M 652 332 L 702 196 L 572 312 Z" fill="#2b2f55"/>
  <rect x="292" y="296" width="440" height="452" rx="158" fill="url(#m-body)"/>
  <ellipse cx="392" cy="748" rx="62" ry="40" fill="#23c98c"/>
  <ellipse cx="632" cy="748" rx="62" ry="40" fill="#23c98c"/>
  <circle cx="512" cy="468" r="126" fill="#ffffff"/>
  <circle cx="512" cy="480" r="60" fill="#2b2f55"/>
  <circle cx="542" cy="452" r="22" fill="#ffffff"/>
  <path d="M 416 606 Q 512 700 608 606 Z" fill="#2b2f55"/>
  <path d="M 466 612 L 502 612 L 484 660 Z" fill="#ffffff"/>
  <path d="M 540 612 L 576 612 L 558 654 Z" fill="#ffffff"/>
</svg>`;
}

const state = {
  config: null,
  me: null,
  authSource: null,
  repo: null,
  view: "prs", // "prs" | "history" | "milestones" | "releases" | "local"
  bucket: "open",
  prs: [],
  openPrs: [],
  selected: null,
  detailRepo: null, // repo real del PR abierto (difiere de state.repo en la vista "Todos")
  detailTab: "conv", // "conv" | "changes"
  detailPR: null,
  conversation: null,
  files: null,
  drafts: [], // borradores locales del PR abierto (no tocan GitHub hasta publicar)
  search: "",
  loading: false,
  pollTimer: null,
  selftestNotified: false,
  selftestOpenedDetail: false,
  history: { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null },
  // Vista de Milestones (solo GitLab): tareas (issues) del milestone agrupadas por persona.
  // filters.status: Map<label, "include"|"exclude"> (chip tri-estado); se siembra con doneLabels en "exclude".
  milestones: { list: [], selectedTitle: null, issues: [], loading: false, labels: [], selected: new Set(), filters: { status: new Map(), showClosed: false, showUnassigned: false, seeded: false }, tab: "tasks", summaryLoading: false, summaryPreviewExpanded: false, projects: null },
  // Vista de Releases (solo GitLab): genera la release branch rb/<version>. `defaults` =
  // {branchPrefix, sourceBranch, ouicare} del backend; `projects` = proyectos del grupo (groupProjects,
  // con icono) entre los que elegir; `selected` = paths elegidos; `appDate` = ISO (YYYY-MM-DD) para
  // el input nativo, se convierte a DDMMYYYY al enviar; `results` = reporte de la última generación.
  releases: { defaults: null, projects: [], loading: false, running: false, seeded: false, selected: new Set(), version: "", sourceBranch: "", appDateEnabled: true, appDate: "", results: null, tab: "branches", publish: { ref: "", milestone: "", description: "", milestonesList: null, milestonesLoading: false, running: false, results: null, status: new Map(), poll: null } },
  // Vista de Trabajo local (solo GitLab, OPE-19): publica trabajo de ramas/worktrees locales como
  // Issues/Epics + MRs. `tab`: "crear" (Issue/Epic nuevos) | "vincular" (a una tarea existente).
  // `rootDir` = directorio raíz donde conviven los clones; `repos` = lo escaneado por local:repos.
  // `form` = formulario de "Crear tarea" abierto para un repo (null = listado). Ver openLocalForm.
  // OPE-20 "Empezar tarea": `tasks` = issues del grupo asignadas a mí; `startFilters` = filtros del
  // picker; `startSel` = tarea elegida; `planForm` = form/plan aprobable (null = picker visible).
  local: { tab: "crear", rootDir: null, repos: [], loading: false, info: {}, selected: new Set(), form: null, linkForm: null, history: [], historyDetail: null, milestones: null, groupLabels: null, historyStatus: {}, tasks: null, tasksLoading: false, startFilters: { query: "", showDone: false }, startSel: null, planForm: null, runView: null, runs: [], runsBadge: 0, mrStatuses: {} },
  prSnapshot: null, // nº → {reviewDecision, checks, reviewMe} para detectar cambios y notificar
  cursor: -1, // selección con teclado (j/k) en la lista
  draftKeys: new Set(), // "owner/repo#n" con borradores guardados → badge 📝 en la lista
  aiGenerating: null, // nº de PR con review IA en curso → el botón persiste en loading entre pestañas
  draftNavIndex: -1, // navegación ↑↓ entre borradores
  editingDraftId: null, // borrador en edición → su tarjeta se pinta como editor
};

const $ = (sel) => document.querySelector(sel);
const list = $("#pr-list");
const detailPane = $("#detail-pane");
const detailContent = $("#detail-content");

/* ============ utilidades ============ */
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

/* ============ proveedor (GitHub | GitLab) ============ */
const isGitlab = () => state.config?.provider === "gitlab";
const providerName = () => (isGitlab() ? "GitLab" : "GitHub");
// GitLab admite paths anidados (group/sub/project); GitHub solo owner/repo.
const repoRe = () => (isGitlab() ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/);
const repoPlaceholder = () => (isGitlab() ? "group/subgroup/project" : "owner/repo");
// Pre-validación de nombres de rama (UX); el backend valida con la misma regla en main.js.
const BRANCH_RE = /^[\w./-]{1,200}$/;

function timeAgo(iso) {
  const seconds = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [[31536000, "a"], [2592000, "mes"], [604800, "sem"], [86400, "d"], [3600, "h"], [60, "min"]];
  for (const [div, label] of units) {
    if (seconds >= div) {
      const v = Math.floor(seconds / div);
      return `hace ${v} ${label}${label === "mes" && v > 1 ? "es" : ""}`;
    }
  }
  return "ahora";
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copiado", "ok"),
    () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copiado", "ok");
    },
  );
}

// Copia HTML enriquecido (para pegar en Gmail/Outlook con enlaces vivos) con fallback a texto
// plano si el navegador no permite ClipboardItem.
function copyRich(html, plain) {
  try {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    });
    navigator.clipboard.write([item]).then(() => toast("Copiado para el correo", "ok"), () => copyText(plain));
  } catch {
    copyText(plain);
  }
}

function notifySelftestOnce() {
  if (!state.selftestNotified) {
    state.selftestNotified = true;
    window.monstro.selftestRenderComplete();
  }
}

const ALL_REPOS = "__all__";

function detailRepo() {
  return state.detailRepo || state.repo;
}

/* ============ borradores ============ */
