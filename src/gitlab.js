"use strict";

// Implementación del proveedor GitLab. Expone la MISMA interfaz pública que
// src/github.js y normaliza Merge Requests -> forma de "Pull Request" de GitHub,
// que es la que consume el renderer. Soporta gitlab.com y self-hosted (la base
// se lee de config.gitlabBaseUrl). Ver el contrato de enums más abajo: el
// renderer ramifica sobre valores literales exactos, no sobre la forma.

const { execFileSync } = require("child_process");
const config = require("./config");

let cachedToken = null;
let cachedTokenSource = null;

function settings() {
  const cfg = config.load();
  const base = (cfg.gitlabBaseUrl || "https://gitlab.com").replace(/\/+$/, "");
  return { base, apiBase: `${base}/api/v4`, host: new URL(base).host };
}

function resolveToken() {
  if (cachedToken) return { token: cachedToken, source: cachedTokenSource };

  if (process.env.GITLAB_TOKEN) {
    cachedToken = process.env.GITLAB_TOKEN.trim();
    cachedTokenSource = "env:GITLAB_TOKEN";
    return { token: cachedToken, source: cachedTokenSource };
  }
  try {
    const { host } = settings();
    // OJO: en glab el flag es --host; -h es --help (devolvería el texto de ayuda).
    const out = execFileSync("glab", ["config", "get", "token", "--host", host], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out) {
      cachedToken = out;
      cachedTokenSource = "glab CLI";
      return { token: cachedToken, source: cachedTokenSource };
    }
  } catch {
    /* glab no disponible o sin login: probamos config */
  }
  const stored = config.load().token;
  if (stored) {
    cachedToken = stored;
    cachedTokenSource = "config.json";
    return { token: cachedToken, source: cachedTokenSource };
  }
  return { token: null, source: null };
}

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenSource = null;
}

async function api(method, path, body) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const { apiBase } = settings();
  const headers = { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

/** Recorre todas las páginas (per_page=100) de un endpoint que devuelve un array. */
async function apiAll(path) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 5; page++) {
    const batch = await api("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return out;
}

const proj = (repoFullName) => encodeURIComponent(repoFullName);

/* ---------- normalización (forma GitHub) ---------- */

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// GitLab da markdown crudo (no HTML sanitizado). Lo escapamos y respetamos
// saltos de línea: no es markdown renderizado pero es seguro y legible.
function mdToSafeHtml(body) {
  if (!body) return "";
  return `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
}

function mapUser(u) {
  return u ? { login: u.username, avatarUrl: u.avatar_url } : null;
}

function mapState(mrState) {
  if (mrState === "merged") return "MERGED";
  if (mrState === "closed" || mrState === "locked") return "CLOSED";
  return "OPEN";
}

// El renderer habilita el botón merge SOLO si mergeable==="MERGEABLE" y
// mergeStateStatus ∈ {CLEAN,UNSTABLE,HAS_HOOKS}. Traducimos detailed_merge_status
// (GitLab 15.6+) a esos tokens; si no está, caemos a merge_status.
function mapMergeStatus(mr) {
  const detailed = mr.detailed_merge_status;
  const byDetailed = {
    mergeable: ["MERGEABLE", "CLEAN"],
    conflict: ["CONFLICTING", "DIRTY"],
    broken_status: ["CONFLICTING", "DIRTY"],
    need_rebase: ["MERGEABLE", "BEHIND"],
    ci_must_pass: ["MERGEABLE", "BLOCKED"],
    ci_still_running: ["MERGEABLE", "BLOCKED"],
    not_approved: ["MERGEABLE", "BLOCKED"],
    blocked_status: ["MERGEABLE", "BLOCKED"],
    discussions_not_resolved: ["MERGEABLE", "BLOCKED"],
    draft_status: ["MERGEABLE", "BLOCKED"],
    external_status_checks: ["MERGEABLE", "BLOCKED"],
    requested_changes: ["MERGEABLE", "BLOCKED"],
    not_open: ["MERGEABLE", "BLOCKED"],
  };
  if (detailed && byDetailed[detailed]) {
    const [mergeable, mergeStateStatus] = byDetailed[detailed];
    return { mergeable, mergeStateStatus };
  }
  // Fallback: merge_status (can_be_merged / cannot_be_merged / checking / unchecked)
  if (mr.merge_status === "cannot_be_merged") return { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  if (mr.merge_status === "can_be_merged") return { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  return { mergeable: "UNKNOWN", mergeStateStatus: "UNSTABLE" };
}

// head_pipeline.status (GitLab) -> statusCheckRollup.state (GitHub).
function mapPipeline(pipeline) {
  if (!pipeline || !pipeline.status) return null;
  const map = {
    success: "SUCCESS",
    failed: "FAILURE",
    canceled: "ERROR",
    skipped: "SUCCESS",
    manual: "PENDING",
    running: "PENDING",
    pending: "PENDING",
    created: "PENDING",
    preparing: "PENDING",
    scheduled: "PENDING",
    waiting_for_resource: "PENDING",
  };
  const state = map[pipeline.status] || "EXPECTED";
  return { state, contexts: { nodes: [] } };
}

// approvals (/approvals) + reviewers -> reviewDecision, latestReviews (facepile),
// reviewRequests (dock badge "awaiting my review").
function mapReviews(mr, approvals) {
  const approvedBy = approvals?.approved_by || [];
  const approvedLogins = new Set(approvedBy.map((a) => a.user?.username));
  const latestReviews = {
    // databaseId (id de usuario) sólo para que el renderer sepa que la review es "desaprobable";
    // dismissReview en GitLab no lo usa (unapprove actúa sobre la MR, no sobre una review).
    nodes: approvedBy.map((a) => ({ databaseId: a.user?.id || null, author: mapUser(a.user), state: "APPROVED" })),
  };
  // Reviewers asignados que aún no han aprobado = revisión pendiente.
  const reviewRequests = {
    nodes: (mr.reviewers || [])
      .filter((u) => !approvedLogins.has(u.username))
      .map((u) => ({ requestedReviewer: { __typename: "User", login: u.username } })),
  };
  let reviewDecision = null;
  if (mr.detailed_merge_status === "requested_changes") reviewDecision = "CHANGES_REQUESTED";
  else if (approvals && approvals.approved === true) reviewDecision = "APPROVED";
  else if ((mr.reviewers || []).length || (approvals && approvals.approvals_required > 0)) reviewDecision = "REVIEW_REQUIRED";
  return { latestReviews, reviewRequests, reviewDecision };
}

function mapLabels(mr) {
  // GitLab da nombres de label; el color real exige otra llamada. Color neutro.
  const details = mr.labels_with_details || mr.label_details;
  if (Array.isArray(details) && details.length && typeof details[0] === "object") {
    return { nodes: details.slice(0, 6).map((l) => ({ name: l.name, color: (l.color || "#888888").replace(/^#/, "") })) };
  }
  return { nodes: (mr.labels || []).slice(0, 6).map((name) => ({ name, color: "888888" })) };
}

// Forma base MR -> PR. `approvals` opcional (enriquecimiento para facepile/decision).
function mapMr(mr, approvals) {
  const repoPath = mr.references?.full ? mr.references.full.split("!")[0] : null;
  const { mergeable, mergeStateStatus } = mapMergeStatus(mr);
  const { latestReviews, reviewRequests, reviewDecision } = mapReviews(mr, approvals);
  const changedFiles = Number.parseInt(mr.changes_count, 10) || 0;
  return {
    id: encodeId(repoPath || projectPathFromRefs(mr), mr.iid),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    isDraft: Boolean(mr.draft || mr.work_in_progress),
    state: mapState(mr.state),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    isCrossRepository: mr.source_project_id !== mr.target_project_id,
    repository: { nameWithOwner: repoPath || projectPathFromRefs(mr) },
    headRepository: { nameWithOwner: repoPath || projectPathFromRefs(mr) },
    author: mapUser(mr.author),
    mergeable,
    mergeStateStatus,
    reviewDecision,
    additions: 0,
    deletions: 0,
    changedFiles,
    comments: { totalCount: mr.user_notes_count ?? 0 },
    labels: mapLabels(mr),
    reviewRequests,
    latestReviews,
    commits: { nodes: [{ commit: { statusCheckRollup: mapPipeline(mr.head_pipeline) } }] },
  };
}

function projectPathFromRefs(mr) {
  // Cuando no viene references.full intentamos sacar el path de web_url.
  try {
    const u = new URL(mr.web_url);
    return u.pathname.replace(/^\//, "").split("/-/")[0];
  } catch {
    return "";
  }
}

/* ---------- id codificado para mutaciones (renderer pasa pr.id) ---------- */

function encodeId(repoFullName, iid) {
  return `gl:${encodeURIComponent(repoFullName)}#${iid}`;
}

function decodeId(id) {
  const m = /^gl:([^#]+)#(\d+)$/.exec(id || "");
  if (!m) throw new Error(`id GitLab no válido: ${id}`);
  return { repo: decodeURIComponent(m[1]), iid: Number(m[2]) };
}

/* ---------- interfaz pública ---------- */

async function viewer() {
  const me = await api("GET", "/user");
  return { id: me.id, login: me.username, avatarUrl: me.avatar_url };
}

async function viewerRepos() {
  // Sin simple=true: necesitamos `visibility` para el chip "privado".
  const projects = await api(
    "GET",
    "/projects?membership=true&order_by=last_activity_at&archived=false&per_page=50",
  );
  return projects.map((p) => ({ nameWithOwner: p.path_with_namespace, isPrivate: p.visibility !== "public" }));
}

const GL_STATE = { OPEN: "opened", MERGED: "merged", CLOSED: "closed" };

async function listPRs(repoFullName, states) {
  const glState = GL_STATE[states[0]] || "opened";
  const mrs = await api(
    "GET",
    `/projects/${proj(repoFullName)}/merge_requests?state=${glState}&order_by=updated_at&per_page=50`,
  );
  // Enriquecemos solo las abiertas con approvals (facepile + decisión de review).
  if (glState === "opened") {
    const approvals = await Promise.all(
      mrs.map((mr) =>
        api("GET", `/projects/${proj(repoFullName)}/merge_requests/${mr.iid}/approvals`).catch(() => null),
      ),
    );
    return mrs.map((mr, i) => mapMr(mr, approvals[i]));
  }
  return mrs.map((mr) => mapMr(mr));
}

async function searchPRs(repoFullNames, states) {
  const lists = await Promise.all(repoFullNames.map((r) => listPRs(r, states).catch(() => [])));
  return lists.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function prDetail(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  const approvals = await api(
    "GET",
    `/projects/${proj(repoFullName)}/merge_requests/${number}/approvals`,
  ).catch(() => null);
  const pr = mapMr(mr, approvals);
  pr.body = mr.description || "";
  pr.bodyHTML = mdToSafeHtml(mr.description);
  return pr;
}

/** Merge SIEMPRE con merge commit (squash:false). Squash no existe en esta casa. */
async function mergePR(repoFullName, number, { deleteBranch, isCrossRepository }) {
  const removeSource = Boolean(deleteBranch) && !isCrossRepository;
  const result = await api("PUT", `/projects/${proj(repoFullName)}/merge_requests/${number}/merge`, {
    squash: false,
    should_remove_source_branch: removeSource,
  });
  return { merged: result.state === "merged", sha: result.merge_commit_sha, branchDeleted: removeSource };
}

/** Update branch SIEMPRE con rebase. */
async function updateBranchRebase(encodedId) {
  const { repo, iid } = decodeId(encodedId);
  await api("PUT", `/projects/${proj(repo)}/merge_requests/${iid}/rebase`);
  return { number: iid };
}

/* ---------- histórico (grafo de commits) ---------- */

async function defaultBranch(repoFullName) {
  const project = await api("GET", `/projects/${proj(repoFullName)}`);
  return project.default_branch || "main";
}

async function branchHistories(repoFullName, branchSpecs) {
  const branches = [];
  const commitsByOid = new Map();
  for (const spec of branchSpecs) {
    const commits = await api(
      "GET",
      `/projects/${proj(repoFullName)}/repository/commits?ref_name=${encodeURIComponent(spec.name)}&per_page=${spec.depth}`,
    ).catch(() => []);
    if (!commits.length) continue;
    branches.push({ name: spec.name, headOid: commits[0].id });
    for (const c of commits) {
      if (commitsByOid.has(c.id)) continue;
      commitsByOid.set(c.id, {
        oid: c.id,
        abbreviatedOid: c.short_id,
        messageHeadline: c.title,
        committedDate: c.committed_date,
        author: { name: c.author_name, user: null },
        parents: { nodes: (c.parent_ids || []).map((oid) => ({ oid })) },
        associatedPullRequests: { nodes: [] },
      });
    }
  }
  return { branches, commits: [...commitsByOid.values()] };
}

/* ---------- diff + conversación ---------- */

function countDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of (diff || "").split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

async function prFiles(repoFullName, number) {
  const diffs = await apiAll(`/projects/${proj(repoFullName)}/merge_requests/${number}/diffs`);
  return diffs.map((d) => {
    const { additions, deletions } = countDiff(d.diff);
    return {
      filename: d.new_path,
      previousFilename: d.renamed_file ? d.old_path : null,
      status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
      additions,
      deletions,
      patch: d.diff || null,
    };
  });
}

async function prConversation(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  const discussions = await apiAll(`/projects/${proj(repoFullName)}/merge_requests/${number}/discussions`);
  const comments = [];
  const reviewThreads = [];
  for (const d of discussions) {
    const notes = (d.notes || []).filter((n) => !n.system);
    if (!notes.length) continue;
    const positioned = notes[0].position;
    if (positioned) {
      const pos = notes[0].position;
      reviewThreads.push({
        // id propio (glthread:) para resolver/reabrir la discussion vía setThreadResolved.
        id: `glthread:${encodeURIComponent(repoFullName)}#${number}#${encodeURIComponent(d.id)}`,
        viewerCanResolve: true,
        viewerCanUnresolve: true,
        path: pos.new_path || pos.old_path,
        line: pos.new_line ?? pos.old_line,
        startLine: pos.line_range?.start?.new_line ?? null,
        isResolved: Boolean(notes[0].resolved),
        isOutdated: false,
        // databaseId = id de la DISCUSSION (lo que necesita el reply de GitLab).
        comments: {
          nodes: notes.map((n) => ({
            databaseId: d.id,
            author: mapUser(n.author),
            bodyHTML: mdToSafeHtml(n.body),
            createdAt: n.created_at,
          })),
        },
      });
    } else {
      for (const n of notes) {
        comments.push({ author: mapUser(n.author), bodyHTML: mdToSafeHtml(n.body), createdAt: n.created_at });
      }
    }
  }
  return {
    headRefOid: mr.diff_refs?.head_sha || mr.sha,
    comments: { totalCount: comments.length, nodes: comments },
    reviewThreads: { nodes: reviewThreads },
  };
}

async function addIssueComment(repoFullName, number, body) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/notes`, { body });
}

/** Resuelve/reabre una discussion de la MR (equivalente GitLab del resolve thread de GitHub). */
async function setThreadResolved(threadId, resolved) {
  const m = /^glthread:([^#]+)#(\d+)#(.+)$/.exec(threadId || "");
  if (!m) throw new Error(`id de hilo GitLab no válido: ${threadId}`);
  return api("PUT", `/projects/${m[1]}/merge_requests/${m[2]}/discussions/${m[3]}`, { resolved });
}

/** "Quitar aprobación": GitLab no tiene dismissal de reviews; equivale a unapprove de la MR. */
async function dismissReview(repoFullName, number) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/unapprove`);
}

async function diffRefs(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  return mr.diff_refs || {};
}

function buildPosition(refs, { path, side, line }) {
  const position = {
    position_type: "text",
    base_sha: refs.base_sha,
    head_sha: refs.head_sha,
    start_sha: refs.start_sha,
    new_path: path,
    old_path: path,
  };
  if (side === "LEFT") position.old_line = line;
  else position.new_line = line;
  return position;
}

async function addInlineComment(repoFullName, number, { body, path, side, line }) {
  const refs = await diffRefs(repoFullName, number);
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/discussions`, {
    body,
    position: buildPosition(refs, { path, side, line }),
  });
}

async function replyToThread(repoFullName, number, discussionId, body) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/discussions/${discussionId}/notes`, {
    body,
  });
}

/**
 * Publica de golpe todos los borradores. GitLab no tiene "review batch" como
 * GitHub: emitimos las notas inline (discussions) + nota general + veredicto.
 * APPROVE -> /approve. COMMENT -> solo notas. REQUEST_CHANGES -> nota (caveat).
 */
async function submitReview(repoFullName, number, { event, body, comments }) {
  const base = `/projects/${proj(repoFullName)}/merge_requests/${number}`;
  if (comments?.length) {
    const refs = await diffRefs(repoFullName, number);
    for (const c of comments) {
      await api("POST", `${base}/discussions`, {
        body: c.body,
        position: buildPosition(refs, { path: c.path, side: c.side, line: c.line }),
      });
    }
  }
  if (body) await api("POST", `${base}/notes`, { body });
  if (event === "APPROVE") await api("POST", `${base}/approve`);
  if (event === "REQUEST_CHANGES" && !body) {
    await api("POST", `${base}/notes`, { body: "Se solicitan cambios." });
  }
  return { submitted: true };
}

/* ---------- acciones sobre el grafo ---------- */

async function createBranch(repoFullName, branchName, sha) {
  return api("POST", `/projects/${proj(repoFullName)}/repository/branches`, { branch: branchName, ref: sha });
}

/**
 * GitLab no tiene force-update de ref (a diferencia del PATCH atómico de GitHub).
 * Lo simulamos con borrar+recrear, que NO es atómico: si el POST falla tras el
 * DELETE, la rama queda borrada. Para minimizar el riesgo verificamos que el SHA
 * destino existe ANTES de borrar, y si la recreación falla informamos del SHA
 * para poder recrearla a mano.
 */
async function forceUpdateBranch(repoFullName, branchName, sha) {
  // Falla pronto (sin tocar la rama) si el SHA no existe.
  await api("GET", `/projects/${proj(repoFullName)}/repository/commits/${encodeURIComponent(sha)}`);
  await api("DELETE", `/projects/${proj(repoFullName)}/repository/branches/${encodeURIComponent(branchName)}`);
  try {
    return await api("POST", `/projects/${proj(repoFullName)}/repository/branches`, { branch: branchName, ref: sha });
  } catch (err) {
    throw new Error(`Rama "${branchName}" borrada pero no se pudo recrear en ${sha}: ${err.message}. Recréala a mano.`);
  }
}

/**
 * Cherry-pick del contenido de una MR (el merge commit) sobre otra rama.
 * GitLab acepta el SHA del merge commit y replica el rango completo de la MR,
 * igual que el botón "Cherry-pick" de la UI de la MR.
 * Con dryRun no escribe: sirve para anticipar conflictos antes de ofrecerlo.
 * No lanza: devuelve {branch, ok, error?} para poder reportar por-rama (no atómico entre N ramas).
 */
async function cherryPick(repoFullName, sha, branch, { dryRun = false } = {}) {
  const body = { branch };
  if (dryRun) body.dry_run = true;
  try {
    const res = await api("POST", `/projects/${proj(repoFullName)}/repository/commits/${encodeURIComponent(sha)}/cherry_pick`, body);
    return { branch, ok: true, sha: res && res.id };
  } catch (err) {
    return { branch, ok: false, error: String(err.message || err) };
  }
}

// Commits PROPIOS de la MR (los de la pestaña Commits/Changes), del más viejo al más nuevo.
// El cherry-pick replica estos, NO el merge commit: el merge commit arrastra la resolución
// del merge y commits ajenos a la rama destino → "commits fantasma". Estos son lo exclusivo de la MR.
async function mrCommits(repoFullName, number) {
  const commits = await apiAll(`/projects/${proj(repoFullName)}/merge_requests/${number}/commits`);
  return commits.map((c) => ({ sha: c.id, shortSha: c.short_id, title: c.title })).reverse();
}

/* ---------- releases (generar release branches rb/<version>) ---------- */

// Valores por defecto de la generación de release branches. Los PROYECTOS ya NO se hardcodean:
// el renderer los saca del grupo (groupProjects). Aquí solo van rama origen, prefijo y la config
// de Ouicare (AppDate del Web.config), que es específica y no derivable del listado de proyectos.
function releaseDefaults() {
  const cfg = config.load();
  return {
    sourceBranch: cfg.releases?.sourceBranch || "development",
    branchPrefix: cfg.releases?.branchPrefix || "rb/",
    // Selección por defecto (ids) y última recordada (paths) para que la vista la siembre/restaure.
    defaultProjectIds: Array.isArray(cfg.releases?.defaultProjectIds) ? cfg.releases.defaultProjectIds.map(String) : [],
    selectedProjects: Array.isArray(cfg.releases?.selectedProjects) ? cfg.releases.selectedProjects : null,
    ouicare: cfg.releases?.ouicare || null,
  };
}

/**
 * Actualiza la appSetting `AppDate` del Web.config de Ouicare (cache-buster del appcache: el valor
 * alimenta el "App Markup Date" del CACHE MANIFEST, así que hay que bumpearlo en cada release) y la
 * commitea en `sourceBranch` ANTES de crear la release branch — réplica del paso manual del script
 * ("Change AppDate in Ouicare before creating branch"). `date` = "DDMMYYYY". Si ya vale eso, no
 * commitea (GitLab rechaza commits sin cambios). NO lanza: devuelve {ok, skipped?, error?, date}.
 */
async function updateOuicareAppDate({ projectPath, webConfigPath, appDateKey }, sourceBranch, date) {
  try {
    if (!projectPath || !webConfigPath || !appDateKey) return { ok: false, error: "Ouicare sin configurar" };
    const fileApi = `/projects/${proj(projectPath)}/repository/files/${encodeURIComponent(webConfigPath)}`;
    const file = await api("GET", `${fileApi}?ref=${encodeURIComponent(sourceBranch)}`);
    const content = Buffer.from(file.content, "base64").toString("utf8");
    // <add key="AppDate" value="04022026"/> (comillas dobles, key antes que value, cierre con o sin espacio)
    const re = new RegExp(`(<add\\s+key="${appDateKey}"\\s+value=")([^"]*)("\\s*/>)`, "i");
    const m = content.match(re);
    if (!m) return { ok: false, error: `No se encontró la clave ${appDateKey} en ${webConfigPath}` };
    if (m[2] === date) return { ok: true, skipped: true, date, previous: m[2] };
    const next = content.replace(re, `$1${date}$3`);
    await api("POST", `/projects/${proj(projectPath)}/repository/commits`, {
      branch: sourceBranch,
      commit_message: `chore(ouicare): AppDate ${date} (release)`,
      actions: [{ action: "update", file_path: webConfigPath, content: next }],
    });
    return { ok: true, date, previous: m[2] };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * Crea la release branch `${branchPrefix}${version}` en cada proyecto pedido, a partir de
 * `sourceBranch` (POST repository/branches con {branch, ref}). Replica auto-rb-branches.py.
 * `projects` = [{id,name}] donde id = path (o id numérico) del proyecto en el grupo. Si `ouicare`
 * viene con {enabled,date,...}, antes de ramificar se actualiza el AppDate en la rama origen.
 * NO atómico entre N proyectos: se aplican en serie y se reporta por-proyecto {id,name,ok,error?,
 * webUrl?}; un fallo a medias deja unos creados y otros no (igual que cherryPick). El token NUNCA
 * se hardcodea (a diferencia del script legacy): sale de resolveToken. Solo GitLab.
 */
async function generateReleaseBranches({ projects, version, sourceBranch, ouicare }) {
  const branch = `${releaseDefaults().branchPrefix}${version}`;
  const ref = sourceBranch || releaseDefaults().sourceBranch;
  // Paso previo: AppDate de Ouicare en la rama origen, para que la nueva rama ya lo herede.
  const appDate = ouicare && ouicare.enabled ? await updateOuicareAppDate(ouicare, ref, ouicare.date) : null;
  const results = [];
  for (const p of projects || []) {
    try {
      const created = await api("POST", `/projects/${proj(String(p.id))}/repository/branches`, { branch, ref });
      results.push({ id: p.id, name: p.name || String(p.id), ok: true, branch, webUrl: created.web_url || null });
    } catch (err) {
      results.push({ id: p.id, name: p.name || String(p.id), ok: false, branch, error: String(err.message || err) });
    }
  }
  return { branch, ref, appDate, results };
}

/* ---------- publicar releases (tag + release por proyecto) ---------- */

/**
 * Siguiente tag CalVer para un proyecto dado un `base` (p.ej. "2026.06"): mira las releases
 * existentes, busca los tags `^<base>\.(\d+)$` y devuelve `<base>.<max+1>` (o `<base>.0` si no hay).
 * Así el patch se autoincrementa POR PROYECTO sin tener que teclear el semver a mano.
 */
async function nextReleaseTag(projectId, base) {
  const releases = await api("GET", `/projects/${proj(String(projectId))}/releases?per_page=100`);
  const re = new RegExp(`^${base.replace(/\./g, "\\.")}\\.(\\d+)$`);
  let max = -1;
  for (const r of releases || []) {
    const m = (r.tag_name || "").match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base}.${max + 1}`;
}

/**
 * Publica una release (tag + release en UNA llamada: POST /releases crea el tag si no existe) en
 * cada proyecto. `ref` = la rama rb/… de la que se publica; `base` = CalVer "AAAA.MM" (el patch lo
 * resuelve nextReleaseTag por proyecto). `milestones` = array de TÍTULOS (la API los acepta de
 * proyecto o de grupo ancestro). NO atómico entre N proyectos (igual que generateReleaseBranches):
 * se aplica en serie y se reporta por-proyecto {id,name,ok,tag,releaseUrl?,error?}. Solo GitLab.
 */
async function createReleases({ projects, ref, base, milestones, description, name }) {
  const results = [];
  for (const p of projects || []) {
    try {
      const tag = await nextReleaseTag(p.id, base);
      const body = { tag_name: tag, ref };
      if (Array.isArray(milestones) && milestones.length) body.milestones = milestones;
      if (description) body.description = description;
      body.name = name ? name.replace(/\{tag\}/g, tag) : tag;
      const created = await api("POST", `/projects/${proj(String(p.id))}/releases`, body);
      results.push({ id: p.id, name: p.name || String(p.id), ok: true, tag, releaseUrl: created._links?.self || null });
    } catch (err) {
      results.push({ id: p.id, name: p.name || String(p.id), ok: false, error: String(err.message || err) });
    }
  }
  return { base, ref, milestones: milestones || [], results };
}

/**
 * Estado de despliegue de un proyecto para un ref/tag: pipeline (estado normalizado a la forma
 * GitHub vía mapPipeline) + entornos. Para "saber si se ha desplegado correctamente esta versión".
 * NO lanza: cada parte se captura por separado y cae a null/[] para que el panel sea estable.
 */
async function releaseStatus(projectId, ref) {
  const id = proj(String(projectId));
  let pipeline = null;
  try {
    const pipes = await api("GET", `/projects/${id}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`);
    const p = (pipes || [])[0];
    if (p) pipeline = { state: mapPipeline({ status: p.status })?.state || "EXPECTED", webUrl: p.web_url || null };
  } catch {
    pipeline = null;
  }
  let environments = [];
  try {
    const envs = await api("GET", `/projects/${id}/environments?per_page=20`);
    environments = (envs || []).map((e) => ({
      name: e.name,
      state: e.state, // "available" | "stopped"
      lastDeploy: e.last_deployment?.created_at || null,
      webUrl: e.external_url || null,
    }));
  } catch {
    environments = [];
  }
  return { pipeline, environments };
}

/**
 * Pipelines de despliegue de un proyecto, ancladas a sus releases (OPE-25). Devuelve la lista de
 * releases recientes (para el selector "ver anteriores") y, para el `ref`/tag pedido (o la última
 * release si no se pasa), su pipeline + jobs. Los jobs `manual` son lanzables; cada job lleva su
 * web_url para abrir el log en GitLab. NO atómico por proyecto: el renderer llama uno por proyecto.
 * Solo GitLab.
 */
async function releasePipeline(projectId, ref) {
  const id = proj(String(projectId));
  // Una sola llamada para el selector de releases.
  const rels = await api("GET", `/projects/${id}/releases?per_page=20`);
  const releases = (rels || []).map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    createdAt: r.released_at || r.created_at || null,
    webUrl: r._links?.self || null,
  }));
  const tag = ref || releases[0]?.tag || null;
  let pipeline = null;
  if (tag) {
    try {
      const pipes = await api("GET", `/projects/${id}/pipelines?ref=${encodeURIComponent(tag)}&per_page=1`);
      const p = (pipes || [])[0];
      if (p) {
        const jobsRaw = await api("GET", `/projects/${id}/pipelines/${p.id}/jobs?per_page=100`).catch(() => []);
        const jobs = (jobsRaw || []).map((j) => ({
          id: j.id,
          name: j.name,
          stage: j.stage,
          status: j.status, // GitLab raw (success/failed/manual/running/…): el renderer lo mapea a icono.
          manual: j.status === "manual",
          webUrl: j.web_url || null,
        }));
        pipeline = { id: p.id, state: mapPipeline({ status: p.status })?.state || "EXPECTED", webUrl: p.web_url || null, jobs };
      }
    } catch {
      pipeline = null;
    }
  }
  return { releases, tag, pipeline };
}

/** Lanza un job manual de CI (▶). Devuelve el job actualizado. Solo GitLab. */
async function playJob(projectId, jobId) {
  const id = proj(String(projectId));
  const j = await api("POST", `/projects/${id}/jobs/${encodeURIComponent(String(jobId))}/play`);
  return { id: j.id, name: j.name, status: j.status, webUrl: j.web_url || null };
}

/** GitLab revierte creando un commit directo en la rama destino (no abre MR). */
async function revertPullRequest(encodedId) {
  const { repo, iid } = decodeId(encodedId);
  const mr = await api("GET", `/projects/${proj(repo)}/merge_requests/${iid}`);
  const sha = mr.merge_commit_sha || mr.sha;
  const commit = await api("POST", `/projects/${proj(repo)}/repository/commits/${sha}/revert`, {
    branch: mr.target_branch,
  });
  return { number: null, url: commit.web_url };
}

/** Alterna entre borrador y listo vía prefijo "Draft: " en el título. */
async function setPrDraft(encodedId, toDraft) {
  const { repo, iid } = decodeId(encodedId);
  const mr = await api("GET", `/projects/${proj(repo)}/merge_requests/${iid}`);
  const stripped = mr.title.replace(/^(\[?draft\]?:?\s*|\[?wip\]?:?\s*)/i, "");
  const title = toDraft ? `Draft: ${stripped}` : stripped;
  const updated = await api("PUT", `/projects/${proj(repo)}/merge_requests/${iid}`, { title });
  return { number: iid, isDraft: Boolean(updated.draft || updated.work_in_progress) };
}

/** El renderer pasa repo+number; devolvemos el id codificado que usan las mutaciones. */
async function prNodeId(repoFullName, number) {
  return encodeId(repoFullName, number);
}

/* ---------- milestones (vista de tareas por persona) ---------- */

// Grupo del que leer milestones e issues. Si no hay uno explícito en config,
// se deriva del primer segmento del primer repo (group/sub/project -> group).
function milestonesGroup() {
  const cfg = config.load();
  const explicit = cfg.milestones?.group;
  if (explicit) return explicit;
  const first = (cfg.repos || [])[0] || "";
  return first.split("/")[0] || null;
}

function mapMilestone(m) {
  return {
    id: m.id,
    iid: m.iid,
    title: m.title,
    description: m.description || "",
    dueDate: m.due_date || null,
    startDate: m.start_date || null,
    state: m.state, // "active" | "closed"
    webUrl: m.web_url,
  };
}

function mapAssignee(u) {
  // id numérico necesario para assignee_ids al reasignar; el resto es para pintar.
  return { id: u.id, username: u.username, name: u.name || u.username, avatarUrl: u.avatar_url || null };
}

// Con with_labels_details=true, `labels` llega como objetos {name,color,text_color}.
function mapIssue(issue) {
  const labels = (issue.labels || []).map((l) =>
    typeof l === "string" ? { name: l, color: null, textColor: null } : { name: l.name, color: l.color, textColor: l.text_color },
  );
  const description = issue.description || "";
  return {
    id: issue.id, // id global (= WorkItem id en GraphQL), para resolver la jerarquía padre
    iid: issue.iid,
    projectId: issue.project_id,
    issueType: issue.issue_type, // "issue" | "task" (work item) | ...
    // references.full = "group/project#iid"; nos quedamos con el path del proyecto.
    projectPath: (issue.references?.full || "").replace(/#\d+$/, ""),
    title: issue.title,
    descriptionHtml: mdToSafeHtml(description), // markdown crudo -> HTML seguro (no inyectar sin escapar)
    hasDescription: Boolean(description.trim()),
    state: issue.state, // "opened" | "closed"
    webUrl: issue.web_url,
    labels,
    assignees: (issue.assignees || []).map(mapAssignee),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

async function listMilestones() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const ms = await apiAll(`/groups/${encodeURIComponent(group)}/milestones?state=active&include_ancestors=true`);
  return ms.map(mapMilestone);
}

// OJO: el parámetro de la API de issues es `milestone` (título), NO `milestone_title`
// (ese es para el endpoint de milestones); si te equivocas, GitLab lo ignora en silencio
// y te devuelve TODOS los issues del grupo. Por defecto solo abiertas: las cerradas
// (que pueden ser miles en un grupo activo) no deben comerse el límite de paginación.
async function milestoneIssues(milestoneTitle, { includeClosed = false } = {}) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const enc = encodeURIComponent(group);
  const mt = encodeURIComponent(milestoneTitle);
  const state = includeClosed ? "all" : "opened";
  const issues = await apiAll(`/groups/${enc}/issues?milestone=${mt}&state=${state}&with_labels_details=true`);
  const mapped = issues.map(mapIssue);
  for (const iss of mapped) iss.isEpic = isEpicUrl(iss.webUrl);
  // Botones de MR (solo de cierre, batch rápido) para las issues normales ABIERTAS. Las cerradas
  // se saltan en la carga (rendimiento) y se piden bajo demanda al activar "Mostrar cerradas"
  // (issueMRs); marcadas con mrsPending. Las Epics no tienen MR propia: sus MRs son las de sus
  // hijas, que se cargan al desplegar el caret (milestoneEpicChildren).
  const openNonEpics = mapped.filter((iss) => !iss.isEpic && iss.state !== "closed");
  let mrs = new Map();
  try {
    mrs = await developmentMRs(openNonEpics.map((iss) => `gid://gitlab/WorkItem/${iss.id}`));
  } catch {
    /* sin widget Development: cargan sin MR */
  }
  for (const iss of mapped) {
    if (iss.isEpic) iss.mrs = [];
    else if (iss.state === "closed") {
      iss.mrs = [];
      iss.mrsPending = true; // closing + related se piden al mostrar cerradas
    } else {
      iss.mrs = mrs.get(`gid://gitlab/WorkItem/${iss.id}`) || []; // ya tiene las de cierre
      iss.relatedPending = true; // las referenciadas (1 query/issue) se traen en 2º plano
    }
  }
  return mapped;
}

// Issues de UN proyecto suelto (no del grupo): para la vista de Incidencias, que apunta a un
// proyecto que puede vivir en otro namespace (p.ej. soporte/incidencias, fuera del grupo de
// milestones). Trae abiertas + cerradas; el filtrado (etiqueta, estado) es de visualización.
async function projectIssues(projectPath) {
  const enc = proj(projectPath);
  const issues = await apiAll(`/projects/${enc}/issues?state=all&with_labels_details=true&scope=all`);
  return issues.map(mapIssue);
}

// MRs (cierre + referenciadas) de un conjunto de work items por id, bajo demanda. Para las issues
// cerradas cuando el usuario activa "Mostrar cerradas". Devuelve { [id]: [{webUrl,state,title}] }.
async function issueMRs(workItemIds) {
  const ids = (workItemIds || []).map(String);
  const map = await developmentMRs(ids.map((id) => `gid://gitlab/WorkItem/${id}`), { withRelated: true });
  const out = {};
  for (const id of ids) out[id] = map.get(`gid://gitlab/WorkItem/${id}`) || [];
  return out;
}

// Tareas hijas de UNA Epic (issue) con sus MRs (cierre + referenciadas), bajo demanda al desplegar
// el caret. Devuelve [] si no tiene hijos o la instancia no expone la jerarquía.
async function milestoneEpicChildren(workItemId) {
  const gid = `gid://gitlab/WorkItem/${workItemId}`;
  const map = await workItemChildren([gid]);
  const children = map.get(gid) || [];
  if (children.length) {
    const mrs = await developmentMRs(children.map((c) => c.gid), { withRelated: true });
    for (const c of children) c.mrs = mrs.get(c.gid) || [];
  }
  return children;
}

// Aplica fn a cada item con concurrencia limitada (las related van 1 query por work item: sin tope
// dispararíamos decenas de requests a la vez). Conserva el orden de entrada en el resultado.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Trocea un array en lotes de tamaño n (para no reventar el límite de complejidad de GraphQL
// de GitLab: una query con decenas de alias + connections anidados se rechaza entera).
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const MR_RANK = { opened: 0, merged: 1, locked: 2, closed: 3 };

// MRs que CIERRAN cada work item (widget Development), en lotes paralelos. Devuelve Map<gid,[mr]>.
// Es lo barato: closingMergeRequests SÍ admite batch (a diferencia de relatedMergeRequests).
async function closingMRs(gids) {
  const out = new Map();
  const build = (batch) =>
    batch
      .map(
        (gid, i) =>
          `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetDevelopment {
            closingMergeRequests { nodes { mergeRequest { webUrl state title } } }
          } } }`,
      )
      .join("\n");
  const runBatch = async (batch) => {
    let data;
    try {
      data = await graphql(`query{ ${build(batch)} }`);
    } catch (e) {
      console.error("[monstro] closingMRs lote falló:", e.message);
      return batch.map((gid) => [gid, []]);
    }
    return batch.map((gid, i) => {
      const widget = (data?.[`a${i}`]?.widgets || []).find((w) => w && "closingMergeRequests" in w);
      const list = [];
      for (const n of widget?.closingMergeRequests?.nodes || []) if (n.mergeRequest) list.push(n.mergeRequest);
      return [gid, list];
    });
  };
  const batches = await Promise.all(chunk(gids, 15).map(runBatch));
  for (const entries of batches) for (const [gid, mrs] of entries) out.set(gid, mrs);
  return out;
}

// MRs solo-referenciadas (no de cierre) de UN work item. GitLab limita relatedMergeRequests a
// 1 work item por query, así que va de uno en uno (úsalo solo con pocos: hijos de una Epic).
async function relatedMRsOne(gid) {
  try {
    const data = await graphql(
      `query{ wi: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetDevelopment { relatedMergeRequests { nodes { webUrl state title } } } } } }`,
    );
    const widget = (data?.wi?.widgets || []).find((w) => w && "relatedMergeRequests" in w);
    return (widget?.relatedMergeRequests?.nodes || []).filter(Boolean);
  } catch (e) {
    console.error("[monstro] relatedMRsOne falló:", e.message);
    return [];
  }
}

// MRs del apartado Development de varios work items. Por defecto SOLO las de cierre (rápido, batch).
// Con {withRelated:true} añade las solo-referenciadas (1 query por work item — GitLab no deja batch);
// usar solo con pocos (hijos de una Epic al desplegar). Devuelve Map<gid,[{webUrl,state,title}]>.
async function developmentMRs(gids, { withRelated = false } = {}) {
  const closing = await closingMRs(gids);
  const related = withRelated ? await mapLimit(gids, 8, relatedMRsOne) : [];
  const out = new Map();
  gids.forEach((gid, i) => {
    const list = [...(closing.get(gid) || []), ...(withRelated ? related[i] : [])];
    const seen = new Set();
    const deduped = list.filter((mr) => mr.webUrl && !seen.has(mr.webUrl) && seen.add(mr.webUrl));
    deduped.sort((a, b) => (MR_RANK[a.state] ?? 9) - (MR_RANK[b.state] ?? 9)); // abiertas primero
    out.set(gid, deduped);
  });
  return out;
}

// Tareas hijas (work items) de varias Epics. Devuelve Map<gid, [child]> con cada hijo normalizado a
// la forma de issue del board: {gid, iid, title, state("opened"|"closed"), webUrl, labels}.
// En lotes pequeños (el connection de hijos + labels anidados pesa) y tolerante a fallo por lote.
async function workItemChildren(gids) {
  const out = new Map();
  const build = (batch) =>
    batch
      .map(
        (gid, i) =>
          `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{
            ... on WorkItemWidgetHierarchy { children { nodes {
              id iid title state webUrl
              widgets { ... on WorkItemWidgetLabels { labels { nodes { title color textColor } } } }
            } } }
          } }`,
      )
      .join("\n");
  for (const batch of chunk(gids, 8)) {
    let data;
    try {
      data = await graphql(`query{ ${build(batch)} }`);
    } catch (e) {
      console.error("[monstro] workItemChildren lote falló:", e.message);
      for (const gid of batch) out.set(gid, []);
      continue;
    }
    batch.forEach((gid, i) => {
      const widget = (data?.[`a${i}`]?.widgets || []).find((w) => w && "children" in w);
      const children = (widget?.children?.nodes || []).map((c) => {
        const labelsWidget = (c.widgets || []).find((w) => w && "labels" in w);
        return {
          gid: c.id,
          iid: c.iid,
          title: c.title,
          state: String(c.state).toLowerCase().includes("clos") ? "closed" : "opened",
          webUrl: c.webUrl,
          labels: (labelsWidget?.labels?.nodes || []).map((l) => ({ name: l.title, color: l.color, textColor: l.textColor })),
          mrs: [],
        };
      });
      out.set(gid, children);
    });
  }
  return out;
}

// Descarga un avatar (privado, requiere token) y lo devuelve como data-URI para que el renderer
// pueda pintarlo (las imágenes /uploads/-/system de una instancia privada dan 401 sin auth).
async function fetchAvatarDataUri(url) {
  try {
    const { token } = resolveToken();
    if (!token) return null;
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Proyectos del grupo (incl. subgrupos) con su icono ya resuelto a data-URI, para el filtro
// por proyecto del resumen. ponytail: trae todos los del grupo y proxea los que tengan avatar
// (una vez, el renderer cachea); si el grupo fuese enorme, limitar a los presentes en el milestone.
async function groupProjects() {
  const group = milestonesGroup();
  if (!group) return [];
  const projects = await apiAll(`/groups/${encodeURIComponent(group)}/projects?include_subgroups=true`);
  return Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      path: p.path_with_namespace,
      name: p.name,
      archived: Boolean(p.archived),
      icon: p.avatar_url ? await fetchAvatarDataUri(p.avatar_url) : null,
    })),
  );
}

// Labels del grupo, para poder asignar cualquiera (no solo las de estado configuradas).
async function groupLabels() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const labels = await apiAll(`/groups/${encodeURIComponent(group)}/labels?with_counts=false`);
  return labels.map((l) => ({ name: l.name, color: l.color, textColor: l.text_color }));
}

// Edita un issue (etiquetas / milestone / asignados). Los issues se leen del grupo
// pero las mutaciones van por proyecto. NO es atómico entre varios issues: el llamador
// (renderer) aplica en serie y reporta; un fallo a medias deja unos hechos y otros no.
// patch: { addLabels?, removeLabels?, milestoneId?, assigneeIds? }.
async function updateIssue(projectId, iid, patch) {
  const body = {};
  if (patch.addLabels?.length) body.add_labels = patch.addLabels.join(",");
  if (patch.removeLabels?.length) body.remove_labels = patch.removeLabels.join(",");
  // milestone_id: 0 desasigna el milestone; un id real lo asigna (los de grupo valen).
  if ("milestoneId" in patch) body.milestone_id = patch.milestoneId == null ? 0 : patch.milestoneId;
  if (patch.assigneeIds) body.assignee_ids = patch.assigneeIds.length ? patch.assigneeIds : [0];
  const updated = await api("PUT", `/projects/${projectId}/issues/${iid}`, body);
  return mapIssue(updated);
}

// Crea una issue en un proyecto. Devuelve {iid, projectPath, url, title} (forma mínima que consume
// el flujo de Trabajo local; no normaliza a la forma de PR porque una issue no es una MR).
async function createIssue(repoFullName, { title, description, labels, milestoneId, assigneeIds }) {
  const body = { title };
  if (description) body.description = description;
  if (labels?.length) body.labels = labels.join(",");
  if (milestoneId) body.milestone_id = milestoneId;
  if (assigneeIds?.length) body.assignee_ids = assigneeIds;
  const issue = await api("POST", `/projects/${proj(repoFullName)}/issues`, body);
  return { iid: issue.iid, projectPath: repoFullName, projectId: issue.project_id, url: issue.web_url, title: issue.title };
}

// Vincula `targetIid` (en targetProjectId) como linked item de la issue iid. target_project_id acepta
// id numérico o path URL-encoded. Best-effort para el flujo de Epic (no debe tumbar la creación).
async function createIssueLink(projectPath, iid, targetProjectId, targetIid) {
  return api("POST", `/projects/${proj(projectPath)}/issues/${iid}/links`, { target_project_id: targetProjectId, target_issue_iid: targetIid });
}

// Estado en vivo de una MR / issue para el histórico (#4b).
async function mrStatus(projectPath, iid) {
  const mr = await api("GET", `/projects/${proj(projectPath)}/merge_requests/${iid}`);
  return { state: mr.state, merged: mr.state === "merged" };
}
async function issueStatus(projectPath, iid) {
  const it = await api("GET", `/projects/${proj(projectPath)}/issues/${iid}`);
  return { state: it.state, closed: it.state === "closed", labels: it.labels || [] };
}

// Crea una Merge Request sourceBranch -> targetBranch. squash:false y remove_source_branch:false
// por decisión de producto (merge = merge commit, nunca squash). Devuelve forma mínima para que el
// renderer pueda enlazar a la vista de MRs (projectPath + number) y abrir el web_url.
async function createMergeRequest(repoFullName, { sourceBranch, targetBranch, title, description, removeSourceBranch = false }) {
  const mr = await api("POST", `/projects/${proj(repoFullName)}/merge_requests`, {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    title,
    description: description || "",
    squash: false,
    remove_source_branch: Boolean(removeSourceBranch),
  });
  return { number: mr.iid, projectPath: repoFullName, url: mr.web_url, title: mr.title };
}

// Crea una "Epic": en esta instancia las epics son issues del proyecto `${group}/epics`. Devuelve la
// misma forma mínima que createIssue (iid, projectPath, url, title).
async function createEpic({ title, description, labels, milestoneId, assigneeIds }) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para epics (revisa repos o config.milestones.group).");
  return createIssue(`${group}/epics`, { title, description, labels, milestoneId, assigneeIds });
}

// Busca issues abiertas en el grupo (incluye las del proyecto `epics` = epics) para el flujo de
// Vincular tarea. Devuelve forma mínima: {iid, projectPath, title, url, isEpic}. projectPath sale de
// references.full ("group/proj#iid") porque el endpoint de grupo solo trae project_id numérico.
async function searchGroupIssues(query) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado (revisa repos o config.milestones.group).");
  const q = encodeURIComponent(String(query || "").trim());
  const issues = await api("GET", `/groups/${encodeURIComponent(group)}/issues?search=${q}&state=opened&order_by=updated_at&per_page=20`);
  return (Array.isArray(issues) ? issues : []).map((it) => ({
    iid: it.iid,
    projectPath: (it.references?.full || "").split("#")[0] || null,
    title: it.title,
    url: it.web_url,
    isEpic: isEpicUrl(it.web_url),
  }));
}

// Tareas (issues abiertas del grupo) asignadas al usuario, para el flujo "Empezar tarea" (OPE-20).
// Devuelve la forma mínima + `labels` y `priority` para que el renderer ordene por prioridad y
// oculte por defecto las terminadas (pending check / finished). El estado closed ya se excluye con
// state=opened; el filtrado fino por etiqueta lo hace el renderer (filtros habituales encima).
async function listMyTasks() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado (revisa repos o config.milestones.group).");
  const me = await viewer();
  const issues = await apiAll(
    `/groups/${encodeURIComponent(group)}/issues?scope=all&assignee_username=${encodeURIComponent(me.login)}&state=opened&order_by=updated_at`,
  );
  return (Array.isArray(issues) ? issues : []).map((it) => {
    const labels = Array.isArray(it.labels) ? it.labels : [];
    const lower = labels.map((l) => l.toLowerCase());
    const priority = lower.includes("high priority") ? 0 : lower.includes("medium priority") ? 1 : lower.includes("low priority") ? 2 : 3;
    return {
      iid: it.iid,
      projectPath: (it.references?.full || "").split("#")[0] || null,
      title: it.title,
      description: it.description || "",
      url: it.web_url,
      isEpic: isEpicUrl(it.web_url),
      labels,
      priority,
    };
  });
}

// Las Epics viven como issues en el proyecto "epics" del grupo: las detectamos por el último
// segmento del path del proyecto en su URL.
// ponytail: nombre de proyecto "epics" hardcodeado; si vuestra instancia lo llama distinto,
// parametrizar en config.milestones.epicsProject.
function isEpicUrl(webUrl) {
  const path = (webUrl || "").replace(/\/-\/(issues|work_items)\/\d+.*$/, "");
  return path.split("/").pop()?.toLowerCase() === "epics";
}

// Consulta GraphQL contra /api/graphql (REST no expone la jerarquía padre de work items).
async function graphql(query, variables) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const { base } = settings();
  const res = await fetch(`${base}/api/graphql`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "User-Agent": "monstro-app", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message || `GraphQL HTTP ${res.status}`);
  return json.data;
}

// Padre (jerarquía de work items) de varios work items en UNA sola query con alias. Devuelve
// Map<gid, parent|null> donde parent = {id, title, webUrl, workItemType:{name}}.
async function workItemParents(gids) {
  if (!gids.length) return new Map();
  const fields = gids
    .map((gid, i) => `a${i}: workItem(id:${JSON.stringify(gid)}){ widgets{ ... on WorkItemWidgetHierarchy { parent { id title webUrl workItemType { name } } } } }`)
    .join("\n");
  const data = await graphql(`query{ ${fields} }`);
  const out = new Map();
  gids.forEach((gid, i) => {
    const node = data?.[`a${i}`];
    const widget = (node?.widgets || []).find((w) => w && "parent" in w);
    out.set(gid, widget?.parent || null);
  });
  return out;
}

// Colapsa la jerarquía para el resumen: cada work item de tipo "task" SUBE a su ancestro no-task
// más cercano (normalmente la Epic —issue del proyecto "epics"—, a veces un issue padre); los
// issues normales se quedan como están. Los items que comparten ancestro se funden en uno (los
// títulos de sus hijos quedan como contexto para la IA). Las tasks sin ancestro no-task se
// DESCARTAN: nunca deben aparecer en el resumen. Solo GitLab (github tiene stub de paridad).
// ponytail: subida nivel a nivel en lotes (1-2 requests GraphQL); si la jerarquía fuese muy
// profunda subiría el nº de niveles, no el de requests.
async function collapseMilestoneEpics(issues) {
  const list = Array.isArray(issues) ? issues : [];
  // Estado por item: arranca en sí mismo; los "issue" ya están resueltos, los "task" deben subir.
  const states = list.map((iss) => ({
    done: iss.issueType !== "task",
    orphan: false,
    gid: `gid://gitlab/WorkItem/${iss.id}`,
    title: iss.title,
    url: iss.webUrl,
  }));
  for (let level = 0; level < 6; level++) {
    const pending = states.filter((s) => !s.done && !s.orphan);
    if (!pending.length) break;
    let parents;
    try {
      parents = await workItemParents(pending.map((s) => s.gid));
    } catch {
      // Sin GraphQL no podemos subir: descartamos las tasks pendientes (nunca deben colarse).
      for (const s of pending) s.orphan = true;
      break;
    }
    for (const s of pending) {
      const parent = parents.get(s.gid);
      if (!parent) {
        s.orphan = true; // task sin padre
        continue;
      }
      s.gid = parent.id;
      s.title = parent.title;
      s.url = parent.webUrl;
      if ((parent.workItemType?.name || "").toLowerCase() !== "task") s.done = true;
    }
  }

  const byUrl = new Map();
  const items = [];
  list.forEach((iss, i) => {
    const s = states[i];
    if (s.orphan || !s.done) return; // task descartada (sin ancestro no-task)
    let item = byUrl.get(s.url);
    if (!item) {
      item = { kind: isEpicUrl(s.url) ? "epic" : "issue", title: s.title, url: s.url, children: [], labels: [], desc: "" };
      byUrl.set(s.url, item);
      items.push(item);
    }
    if (s.url === iss.webUrl) {
      // El representante es el propio item: aporta sus etiquetas/descripción como contexto.
      item.labels = (iss.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      item.desc = iss.descriptionHtml || "";
    } else {
      // Un hijo (task) subió hasta este ancestro: su título da contexto a la IA.
      item.children.push(iss.title);
    }
  });
  return items;
}

/**
 * Crea un snippet personal de GitLab con el resumen en Markdown y devuelve su URL
 * compartible. GitLab renderiza el .md (enlaces y refs vivos), así el correo pasa de
 * pegar títulos a pegar UN enlace. Visibilidad `internal`: cualquiera logueado en la
 * instancia puede verlo (no público, no privado al autor). Solo GitLab.
 */
async function createSnippet({ title, contentMarkdown }) {
  const snippet = await api("POST", "/snippets", {
    title: title || "Novedades",
    visibility: "internal",
    files: [{ file_path: "novedades.md", content: contentMarkdown || "" }],
  });
  return { url: snippet.web_url };
}

module.exports = {
  resolveToken,
  invalidateTokenCache,
  viewer,
  viewerRepos,
  listPRs,
  searchPRs,
  prDetail,
  mergePR,
  updateBranchRebase,
  defaultBranch,
  branchHistories,
  prFiles,
  prConversation,
  addIssueComment,
  addInlineComment,
  replyToThread,
  setThreadResolved,
  dismissReview,
  submitReview,
  createBranch,
  forceUpdateBranch,
  cherryPick,
  mrCommits,
  revertPullRequest,
  setPrDraft,
  prNodeId,
  listMilestones,
  milestoneIssues,
  milestoneEpicChildren,
  projectIssues,
  issueMRs,
  groupLabels,
  groupProjects,
  updateIssue,
  createIssue,
  createMergeRequest,
  createEpic,
  createIssueLink,
  mrStatus,
  issueStatus,
  searchGroupIssues,
  listMyTasks,
  collapseMilestoneEpics,
  releaseDefaults,
  generateReleaseBranches,
  nextReleaseTag,
  createReleases,
  releaseStatus,
  releasePipeline,
  playJob,
  createSnippet,
};
