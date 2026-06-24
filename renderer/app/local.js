"use strict";

async function enterLocal(tab) {
  if (!isGitlab()) {
    toast(t("Trabajo local solo está disponible en GitLab"), "");
    return;
  }
  state.view = "local";
  if (tab) state.local.tab = tab;
  state.local.form = null;
  state.local.linkForm = null;
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  const bucketByTab = { empezar: "#bucket-local-empezar", vincular: "#bucket-local-vincular", historico: "#bucket-local-historico", crear: "#bucket-local-crear" };
  $(bucketByTab[state.local.tab] || "#bucket-local-crear")?.classList.add("active");
  if (state.local.tab === "historico") await loadLocalHistory();
  else if (state.local.tab === "empezar") await loadLocalStart();
  else await loadLocal();
}

async function loadLocalHistory() {
  const l = state.local;
  l.loading = true;
  l.historyDetail = null;
  renderLocal();
  try {
    l.history = await window.monstro.localHistoryList();
  } catch {
    l.history = [];
  }
  l.loading = false;
  renderLocal();
  if (!IS_SELFTEST) refreshHistoryStatuses(); // #4b: estado en vivo (merged / etiquetas), best-effort
}

// Reúne los items (MRs + issues/tareas) del histórico y pide su estado real a GitLab para los badges.
async function refreshHistoryStatuses() {
  const items = [];
  for (const e of state.local.history || []) {
    if (e.kind === "tarea") {
      items.push({ type: "mr", projectPath: e.mr.projectPath, iid: e.mr.number }, { type: "issue", projectPath: e.issue.projectPath, iid: e.issue.iid });
    } else if (e.kind === "epic") {
      items.push({ type: "issue", projectPath: e.epic.projectPath, iid: e.epic.iid });
      (e.results || []).forEach((r) => { if (r.ok) { items.push({ type: "mr", projectPath: r.projectPath, iid: r.mr.number }); if (r.task) items.push({ type: "issue", projectPath: r.projectPath, iid: r.task.iid }); } });
    } else {
      items.push({ type: "issue", projectPath: e.issue.projectPath, iid: e.issue.iid });
      (e.results || []).forEach((r) => { if (r.ok) items.push({ type: "mr", projectPath: r.projectPath, iid: r.mr.number }); });
    }
  }
  try {
    state.local.historyStatus = (await window.monstro.localItemStatuses(items)) || {};
  } catch {
    return;
  }
  if (state.view === "local" && state.local.tab === "historico") renderLocal();
}

async function loadLocal() {
  const l = state.local;
  l.loading = true;
  l.info = {};
  renderLocal();
  try {
    const { rootDir, repos } = await window.monstro.localRepos();
    l.rootDir = rootDir;
    l.repos = repos;
    // Estado git (rama actual, ramas, worktrees, sucio) de cada repo, en paralelo: es git local, rápido.
    await Promise.all(
      repos.map(async (r) => {
        try {
          l.info[r.dir] = await window.monstro.localRepoInfo(r.dir);
        } catch (err) {
          l.info[r.dir] = { error: String(err.message || err) };
        }
      }),
    );
    l.loading = false;
    renderLocal();
    // Avatares de proyecto (groupProjects) en 2º plano: la lista se pinta ya con icono-letra y se
    // actualiza al llegar. Best-effort; se omite en selftest (la captura no debe esperar a la red).
    if (!IS_SELFTEST) ensureProjects().then(() => { if (state.view === "local" && state.local.tab !== "historico") renderLocal(); }).catch(() => {});
  } catch (err) {
    l.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

async function pickLocalRoot() {
  const { rootDir } = await window.monstro.localPickRoot();
  if (rootDir) await loadLocal();
}

const KIND_LABEL = { tarea: t("Tarea"), epic: "Epic", vincular: t("Vinculación") };

// Enlace-pill tipado (Issue/Epic/MR/Commit) a GitLab. Reutilizado por la lista y el detalle.
const lhPill = (type, url, label) => `<a href="${esc(url)}" class="lh-pill lh-pill-${type}" data-ext>${esc(label)}</a>`;
// Badges de estado en vivo (#4b): MR merged/closed; issue cerrada + etiquetas importantes.
const IMPORTANT_LABEL_RE = /finished|pending check|needs fixing/i;
const lhMrBadge = (pp, num) => {
  const s = state.local.historyStatus[`mr:${pp}#${num}`];
  return s?.merged ? `<span class="lh-badge merged">merged</span>` : s?.state === "closed" ? `<span class="lh-badge closed">closed</span>` : "";
};
const lhIssueBadges = (pp, iid) => {
  const s = state.local.historyStatus[`issue:${pp}#${iid}`];
  if (!s) return "";
  const out = s.closed ? [`<span class="lh-badge closed">${esc(t("cerrada"))}</span>`] : [];
  for (const lbl of s.labels || []) if (IMPORTANT_LABEL_RE.test(lbl)) out.push(`<span class="lh-badge lbl">${esc(lbl)}</span>`);
  return out.join("");
};
const lhDate = (ts) => { try { return new Date(ts).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }); } catch { return ts || ""; } };
// ¿Algún paso o proyecto falló? (para el aviso ⚠ y que no pase desapercibido un push silencioso).
function entryHasWarning(e) {
  const stepBad = (steps) => (steps || []).some((s) => s && s.ok === false);
  if (e.kind === "tarea") return stepBad(e.steps);
  return (e.results || []).some((r) => !r.ok || stepBad(r.steps));
}

function renderLocalHistory() {
  if (state.local.historyDetail) return renderLocalHistoryDetail();
  const entries = state.local.history || [];
  const head = `
    <div class="local-head">
      <h2>${t("Histórico")}</h2>
      <p class="local-desc">${t("Trabajos creados desde Trabajo local, con los enlaces de GitLab de cada item. Pulsa una tarjeta para ver el detalle y el log de pasos.")}</p>
    </div>`;
  if (!entries.length) {
    list.innerHTML = head + `<div class="local-empty"><p>${t("Aún no has creado ninguna tarea desde aquí.")}</p></div>`;
    notifySelftestOnce();
    return;
  }
  const projRow = (r, withTask) =>
    r.ok
      ? `<div class="lh-proj"><span class="lh-proj-name">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</span><span class="lh-proj-pills">${withTask && r.task ? lhPill("issue", r.task.url, t("Tarea #{n}", { n: r.task.iid })) + lhIssueBadges(r.projectPath, r.task.iid) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${lhMrBadge(r.projectPath, r.mr.number)}${r.commit ? lhPill("commit", r.commit.url, r.commit.sha.slice(0, 8)) : ""}</span></div>`
      : `<div class="lh-proj err"><span class="lh-proj-name">${esc(r.projectPath)}</span><span class="local-err">⚠ ${esc(r.error)}</span></div>`;
  const cards = entries
    .map((e) => {
      let items = "";
      if (e.kind === "tarea") {
        items = `<div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${lhMrBadge(e.mr.projectPath, e.mr.number)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>`;
        if (e.projectPath) items = `<div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>` + items;
      } else if (e.kind === "epic") {
        items = `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid}`)}${lhIssueBadges(e.epic.projectPath, e.epic.iid)}</div>${(e.results || []).map((r) => projRow(r, true)).join("")}`;
      } else {
        items = `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid}`)}${lhIssueBadges(e.issue.projectPath, e.issue.iid)}</div>${(e.results || []).map((r) => projRow(r, false)).join("")}`;
      }
      const warn = entryHasWarning(e) ? `<span class="lh-warn" title="${esc(t("Algún paso no se completó — abre el detalle"))}">⚠</span>` : "";
      return `
        <div class="lh-card lh-k-${esc(e.kind)}">
          <div class="lh-head">
            <span class="lh-kind lh-${esc(e.kind)}">${KIND_LABEL[e.kind] || esc(e.kind)}</span>
            <span class="lh-title">${esc(e.title || t("(sin título)"))}</span>
            ${warn}
            <time class="lh-date">${esc(lhDate(e.ts))}</time>
            <button class="lh-detail" data-id="${esc(e.id)}">${t("Detalle →")}</button>
            <button class="lh-del" data-id="${esc(e.id)}" title="${esc(t("Quitar del histórico"))}" aria-label="${esc(t("Quitar del histórico"))}">✕</button>
          </div>
          <div class="lh-items">${items}</div>
        </div>`;
    })
    .join("");
  list.innerHTML = head + `<div class="lh-toolbar"><span class="muted">${entries.length === 1 ? t("{n} trabajo", { n: entries.length }) : t("{n} trabajos", { n: entries.length })}</span><button class="btn local-change" id="lh-clear">${t("Vaciar histórico")}</button></div><div class="lh-list">${cards}</div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  list.querySelectorAll(".lh-detail").forEach((b) => b.addEventListener("click", () => { state.local.historyDetail = (state.local.history || []).find((x) => x.id === b.dataset.id) || null; renderLocal(); }));
  list.querySelectorAll(".lh-del").forEach((b) => b.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryRemove(b.dataset.id); renderLocal(); }));
  $("#lh-clear")?.addEventListener("click", async () => { state.local.history = await window.monstro.localHistoryClear(); renderLocal(); });
  notifySelftestOnce();
}

// Vista de detalle de una entrada del histórico: items con sus enlaces + el LOG DE PASOS (commit,
// push, rama feature…) por proyecto, para enterarse si algo no se completó (p.ej. un push silencioso).
function renderLocalHistoryDetail() {
  const e = state.local.historyDetail;
  const stepsHtml = (steps) =>
    (steps || []).length
      ? `<ul class="lh-steps">${steps.map((s) => `<li class="${s.ok === false ? "bad" : "good"}">${s.ok === false ? "✕" : "✓"} ${esc(s.text)}</li>`).join("")}</ul>`
      : `<p class="muted lh-nosteps">${t("Sin pasos locales registrados.")}</p>`;
  let body = "";
  let primaryMr = null;
  if (e.kind === "tarea") {
    primaryMr = e.mr;
    body = `
      <div class="lh-d-block">
        <div class="lh-sub">${projectIconHtml(e.projectPath)}${esc(projectMeta(e.projectPath).name)}</div>
        <div class="lh-pills">${lhPill("issue", e.issue.url, `Issue #${e.issue.iid}`)}${lhPill("mr", e.mr.url, `MR !${e.mr.number}`)}${e.commit ? lhPill("commit", e.commit.url, `Commit ${e.commit.sha.slice(0, 8)}`) : ""}</div>
        ${stepsHtml(e.steps)}
      </div>`;
  } else {
    const top = e.kind === "epic"
      ? `<div class="lh-pills">${lhPill("epic", e.epic.url, `Epic #${e.epic.iid} · ${e.epic.title}`)}</div>`
      : `<div class="lh-pills">${lhPill(e.issue.isEpic ? "epic" : "issue", e.issue.url, `${e.issue.isEpic ? "Epic" : "Issue"} ${e.issue.projectPath}#${e.issue.iid} · ${e.issue.title}`)}</div>`;
    primaryMr = (e.results || []).find((r) => r.ok)?.mr || null;
    const blocks = (e.results || [])
      .map((r) => {
        const links = r.ok
          ? `<div class="lh-pills">${r.task ? lhPill("issue", r.task.url, t("Tarea #{n}", { n: r.task.iid })) : ""}${lhPill("mr", r.mr.url, `MR !${r.mr.number}`)}${r.commit ? lhPill("commit", r.commit.url, `Commit ${r.commit.sha.slice(0, 8)}`) : ""}</div>`
          : `<div class="local-err">⚠ ${esc(r.error)}</div>`;
        return `<div class="lh-d-block ${r.ok ? "" : "err"}"><div class="lh-sub">${projectIconHtml(r.projectPath)}${esc(projectMeta(r.projectPath).name)}</div>${links}${stepsHtml(r.steps)}</div>`;
      })
      .join("");
    body = top + blocks;
  }
  list.innerHTML = `
    <div class="local-head">
      <h2>${KIND_LABEL[e.kind] || esc(e.kind)} · ${esc(e.title || "")}</h2>
      <p class="local-desc">${esc(lhDate(e.ts))}</p>
    </div>
    <div class="lh-detail-body">${body}</div>
    <div class="lf-actions" style="margin:0 20px 28px">
      <button class="btn" id="lhd-back">${t("← Volver al histórico")}</button>
      ${primaryMr ? `<button class="btn btn-accent" id="lhd-openmr">${t("Ver MR en Monstro")}</button>` : ""}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  $("#lhd-back").addEventListener("click", () => { state.local.historyDetail = null; renderLocal(); });
  if (primaryMr) $("#lhd-openmr").addEventListener("click", () => { state.local.historyDetail = null; openLocalMrInMonstro(primaryMr); });
  notifySelftestOnce();
}

function renderLocal() {
  if (state.view !== "local") return;
  const l = state.local;
  if (l.loading) {
    list.innerHTML = `<div class="loading">${t("Escaneando repos locales…")}</div>`;
    return;
  }
  if (l.form) return renderLocalForm();
  if (l.linkForm) return renderLocalLinkForm();
  if (l.tab === "historico") return renderLocalHistory();
  if (l.tab === "empezar") return l.runView ? renderLocalRun() : l.planForm ? renderLocalPlanForm() : renderLocalStart();
  const isCrear = l.tab === "crear";
  const desc = isCrear
    ? t("Elige repo y rama/worktree de tu local para crear una <b>Issue/Epic</b> nueva y su <b>MR</b>.")
    : t("Elige repo y rama/worktree de tu local para <b>vincular</b> el trabajo a una Issue/Epic existente y lanzar la <b>MR</b>.");
  const head = `
    <div class="local-head">
      <h2>${isCrear ? t("Crear tarea") : t("Vincular tarea")}</h2>
      <p class="local-desc">${desc}</p>
    </div>`;

  if (!l.rootDir) {
    list.innerHTML =
      head +
      `<div class="local-empty">
        <p>${t("Aún no has indicado el <b>directorio raíz</b> donde tienes clonados tus repos de GitLab.")}</p>
        <button class="btn btn-primary" id="local-pick">${t("Elegir directorio raíz…")}</button>
      </div>`;
    $("#local-pick")?.addEventListener("click", pickLocalRoot);
    notifySelftestOnce();
    return;
  }

  const repos = l.repos || [];
  // Las carpetas se AGRUPAN por su repo base de GitLab (mismo remote origin): varios worktrees/clones
  // del mismo proyecto quedan bajo una cabecera estilo chip de proyecto (icono + nombre). Las carpetas
  // sin remote de GitLab van a un grupo aparte. Seleccionar es por carpeta; 1 marcada = tarea, 2+ = Epic.
  const folderCard = (r) => {
    const info = l.info[r.dir] || {};
    const meta = info.error
      ? `<span class="local-err">${esc(info.error)}</span>`
      : `<span class="local-cur">⎇ ${esc(info.current || "—")}</span>
         ${info.dirty ? `<span class="local-dirty" title="${esc(t("Cambios sin commitear"))}">${t("● sucio")}</span>` : ""}
         <span class="local-count">${t("{n} ramas · {m} worktrees", { n: (info.branches || []).length, m: (info.worktrees || []).length })}</span>`;
    const selectable = Boolean(r.gitlabPath);
    const checked = l.selected.has(r.dir);
    return `
      <div class="local-repo ${selectable ? "selectable" : ""} ${checked ? "checked" : ""}" ${selectable ? `data-dir="${esc(r.dir)}"` : ""}>
        <div class="local-repo-top">
          ${selectable ? `<input type="checkbox" class="local-cb" ${checked ? "checked" : ""} />` : ""}
          <span class="local-name">${esc(r.name)}</span>
        </div>
        <div class="local-repo-meta">${meta}</div>
      </div>`;
  };
  const groups = new Map();
  for (const r of repos) {
    const key = r.gitlabPath || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const cards = [...groups.entries()]
    .sort((a, b) => (a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : projectMeta(a[0]).name.localeCompare(projectMeta(b[0]).name)))
    .map(([key, folders]) => {
      const known = folders[0].known;
      const groupHead =
        key === "__none__"
          ? `<div class="local-group-head"><span class="local-badge none">${t("Sin remote de GitLab")}</span><span class="local-group-count">${folders.length === 1 ? t("{n} carpeta", { n: folders.length }) : t("{n} carpetas", { n: folders.length })}</span></div>`
          : `<div class="local-group-head">
              ${projectIconHtml(key)}
              <span class="ms-proj-name">${esc(projectMeta(key).name)}</span>
              <span class="local-group-path" title="${esc(key)}">${esc(key)}</span>
              ${known ? `<span class="local-badge ok" title="${esc(t("Proyecto configurado en Monstro"))}">✓</span>` : ""}
              ${folders.length > 1 ? `<span class="local-group-count">${t("{n} carpetas", { n: folders.length })}</span>` : ""}
            </div>`;
      return `<div class="local-group">${groupHead}<div class="local-group-folders">${folders.map(folderCard).join("")}</div></div>`;
    })
    .join("");

  const selCount = l.selected.size;
  const btnLabel = isCrear ? (selCount > 1 ? t("Crear épica →") : t("Crear tarea →")) : t("Vincular →");
  const selNote = isCrear && selCount > 1 ? t(" · se creará una Epic") : "";
  const actionBar = repos.some((r) => r.gitlabPath)
    ? `<div class="local-actionbar">
        <span class="local-selcount">${selCount === 1 ? t("{n} seleccionado", { n: selCount }) : t("{n} seleccionados", { n: selCount })}${selNote}</span>
        <button class="btn btn-primary" id="local-continue" ${selCount ? "" : "disabled"}>${btnLabel}</button>
      </div>`
    : "";

  list.innerHTML =
    head +
    `<div class="local-root">
      <span class="local-root-path" title="${esc(l.rootDir)}">📁 ${esc(l.rootDir)}</span>
      <button class="btn local-change" id="local-pick">${t("Cambiar…")}</button>
    </div>
    ${repos.length ? `<div class="local-repos">${cards}</div>` : `<div class="local-empty"><p>${t("No se han encontrado repos git directamente bajo ese directorio.")}</p></div>`}
    ${repos.length ? `<p class="local-legend"><span class="local-dirty">${t("● sucio")}</span> ${t("= el repo tiene cambios sin commitear; se commitearán (con tu mensaje + el #ID de la issue) al crear la tarea.")}</p>` : ""}
    ${actionBar}`;
  $("#local-pick")?.addEventListener("click", pickLocalRoot);
  list.querySelectorAll(".local-repo.selectable").forEach((el) =>
    el.addEventListener("click", () => {
      const dir = el.dataset.dir;
      if (l.selected.has(dir)) l.selected.delete(dir);
      else l.selected.add(dir);
      renderLocal();
    }),
  );
  $("#local-continue")?.addEventListener("click", () => (isCrear ? openLocalForm([...l.selected]) : openLocalLinkForm([...l.selected])));
  notifySelftestOnce();
}

// Abre el formulario para los repos `dirs` (1 = tarea single; 2+ = Epic). Siembra rama origen/destino.
// Milestone activo "actual" por fechas (start_date ≤ hoy ≤ due_date); si ninguno encaja, null.
function pickCurrentMilestoneId(ms) {
  const today = new Date().toISOString().slice(0, 10);
  const cur = (ms || []).find((m) => (!m.startDate || m.startDate <= today) && (!m.dueDate || m.dueDate >= today));
  return cur ? cur.id : null;
}

// Carga (cacheada) milestones del grupo + etiquetas disponibles, para el selector del formulario.
async function ensureLocalMeta() {
  const l = state.local;
  if (IS_SELFTEST) {
    if (!l.milestones) l.milestones = [{ id: 55, title: "Junio 2026", startDate: "2026-06-01", dueDate: "2026-06-30" }, { id: 56, title: "Julio 2026", startDate: "2026-07-01", dueDate: "2026-07-31" }];
    if (!l.groupLabels) l.groupLabels = [
      { name: "patient user", color: "#1f75cb", textColor: "#fff" }, { name: "professional user", color: "#6f42c1", textColor: "#fff" }, { name: "center user", color: "#1a7f37", textColor: "#fff" },
      { name: "high priority", color: "#dc3545", textColor: "#fff" }, { name: "medium priority", color: "#fd7e14", textColor: "#fff" }, { name: "low priority", color: "#6c757d", textColor: "#fff" },
      { name: "finished", color: "#1a7f37", textColor: "#fff" }, { name: "needs fixing", color: "#dc3545", textColor: "#fff" },
    ];
    return;
  }
  if (!l.milestones) l.milestones = await window.monstro.listMilestones().catch(() => []);
  if (!l.groupLabels) l.groupLabels = await window.monstro.groupLabels().catch(() => []);
}

function openLocalForm(dirs) {
  const l = state.local;
  const projects = (Array.isArray(dirs) ? dirs : [dirs])
    .map((dir) => {
      const repo = (l.repos || []).find((r) => r.dir === dir);
      if (!repo) return null;
      const info = l.info[dir] || {};
      const sourceBranch = info.current || (info.branches?.[0]?.name ?? "");
      return { repo, info, sourceBranch, targetBranch: "development", title: "", description: "", checklist: "", commitMessage: "", newBranch: "", createBranch: isBaseBranch(sourceBranch) };
    })
    .filter(Boolean);
  if (!projects.length) return;
  l.form = {
    epic: projects.length > 1,
    epicTitle: "",
    projects,
    mode: "ia", // "ia" | "manual"
    push: true,
    milestoneId: null,
    labels: new Set(),
    aiLoading: false,
    creating: false,
    result: null,
    error: null,
  };
  // Milestones + etiquetas (asíncrono): default = milestone actual por fechas.
  ensureLocalMeta().then(() => {
    if (state.local.form === l.form && l.form.milestoneId == null) l.form.milestoneId = pickCurrentMilestoneId(l.milestones);
    if (state.local.form === l.form) renderLocal();
  }).catch(() => {});
  renderLocal();
}

function closeLocalForm() {
  state.local.form = null;
  renderLocal();
}

// Lee los campos editables del DOM al estado (antes de re-render o de crear).
function syncLocalForm() {
  const f = state.local.form;
  if (!f) return;
  if (f.epic) f.epicTitle = $("#lf-epic-title")?.value ?? f.epicTitle;
  f.push = $("#lf-push") ? $("#lf-push").checked : f.push;
  f.projects.forEach((p, i) => {
    p.sourceBranch = $(`#lf-source-${i}`)?.value ?? p.sourceBranch;
    p.targetBranch = ($(`#lf-target-${i}`)?.value ?? p.targetBranch).trim();
    p.title = $(`#lf-title-${i}`)?.value ?? p.title;
    p.description = $(`#lf-desc-${i}`)?.value ?? p.description;
    p.checklist = $(`#lf-checklist-${i}`)?.value ?? p.checklist;
    p.commitMessage = $(`#lf-commit-${i}`)?.value ?? p.commitMessage;
    if ($(`#lf-nb-on-${i}`)) p.createBranch = $(`#lf-nb-on-${i}`).checked;
    p.newBranch = $(`#lf-nb-${i}`)?.value ?? p.newBranch;
  });
}

// Markdown → HTML SEGURO (subset: headings, listas, task lists, negrita/cursiva, código, enlaces
// http/https). Escapa primero y opera sobre texto ya escapado, así no hay inyección. Dependency-free
// (CSP estricta, sin libs). Solo para el preview del formulario; GitLab renderiza el markdown real.
function mdPreview(md) {
  if (!md || !md.trim()) return "";
  const parts = esc(md).split("```"); // pares = texto normal, impares = bloque de código
  return parts
    .map((part, i) => (i % 2 === 1 ? `<pre><code>${part.replace(/^\n/, "").replace(/\n$/, "")}</code></pre>` : renderMdBlocks(part)))
    .join("");
}

function renderMdBlocks(text) {
  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</ul>"); list = null; } };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { closeList(); const lvl = Math.min(m[1].length + 2, 6); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); }
    else if ((m = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) { if (list !== "task") { closeList(); out.push('<ul class="md-task">'); list = "task"; } out.push(`<li>${m[1].toLowerCase() === "x" ? "☑" : "☐"} ${inline(m[2])}</li>`); }
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join("");
}

// Campo markdown estilo GitLab: pestañas Editar / Vista previa sobre un textarea. `label` es HTML de
// confianza (de nuestro código); el valor se escapa. wireMdFields() cablea el toggle tras el render.
function mdField(id, label, value, rows, placeholder) {
  return `<div class="md-field">
    <div class="md-tabs">
      <span class="md-label">${label}</span>
      <button type="button" class="md-tab on" data-tab="write">${t("Editar")}</button>
      <button type="button" class="md-tab" data-tab="preview">${t("Vista previa")}</button>
    </div>
    <textarea id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
    <div class="md-preview hidden"></div>
  </div>`;
}

function wireMdFields() {
  list.querySelectorAll(".md-field").forEach((f) => {
    const ta = f.querySelector("textarea");
    const pv = f.querySelector(".md-preview");
    f.querySelectorAll(".md-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        const preview = tab.dataset.tab === "preview";
        f.querySelectorAll(".md-tab").forEach((t) => t.classList.toggle("on", t === tab));
        if (preview) pv.innerHTML = mdPreview(ta.value) || `<span class="muted">${t("Nada que previsualizar")}</span>`;
        pv.classList.toggle("hidden", !preview);
        ta.classList.toggle("hidden", preview);
      }),
    );
  });
}

// Ramas "base" sobre las que NO se debería trabajar directamente: sugerimos sacar una rama feature.
function isBaseBranch(name) {
  return ["development", "develop", "main", "master"].includes((name || "").trim());
}

function slug(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

// Extras por proyecto comunes a Crear y Vincular: (1) si la rama origen es una rama base, sugerir
// crear una rama feature; (2) si el repo tiene cambios sin commitear, pedir el mensaje del commit
// (al que el backend añade el "#ID" de la issue). `pfx` = "lf" (crear) | "llf" (vincular).
function localBranchExtras(p, i, pfx) {
  const feat = isBaseBranch(p.sourceBranch)
    ? `<div class="lf-feat">
        <label class="lf-check"><input type="checkbox" id="${pfx}-nb-on-${i}" ${p.createBranch ? "checked" : ""} /> ${t("Estás en <code>{b}</code>: crea una rama <b>feature</b> con estos cambios antes de la MR", { b: esc(p.sourceBranch) })}</label>
        ${p.createBranch ? `<input class="lf-nb" id="${pfx}-nb-${i}" type="text" value="${esc(p.newBranch)}" placeholder="feature/mi-cambio" />` : ""}
      </div>`
    : "";
  const commit = p.info?.dirty
    ? `<label class="lf-field">${t("Mensaje del commit")} <span class="muted">${t("(hay cambios sin commitear · se añadirá el #ID de la issue al final)")}</span><input id="${pfx}-commit-${i}" type="text" value="${esc(p.commitMessage)}" placeholder="${esc(t("Describe el cambio…"))}" /></label>`
    : "";
  return feat + commit;
}

// Bloque de campos de un proyecto dentro del form. En Epic, desc/checklist van en un <details> para
// no hacer el formulario kilométrico; en single van siempre visibles.
function localProjectBlock(p, i, epic) {
  const branches = p.info.branches || [];
  const branchOpts = branches.length
    ? branches.map((b) => `<option value="${esc(b.name)}" ${b.name === p.sourceBranch ? "selected" : ""}>${esc(b.name)}</option>`).join("")
    : `<option value="${esc(p.sourceBranch)}">${esc(p.sourceBranch || "—")}</option>`;
  const fields = `
    <div class="lf-row">
      <label>${t("Rama origen")}<select id="lf-source-${i}">${branchOpts}</select></label>
      <label>${t("Rama destino")}<input id="lf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
    </div>
    ${localBranchExtras(p, i, "lf")}
    <label class="lf-field">${t("Título")}<input id="lf-title-${i}" type="text" value="${esc(p.title)}" placeholder="${esc(t("Título de la tarea"))}" /></label>
    ${mdField(`lf-desc-${i}`, t("Descripción"), p.description, epic ? 4 : 6, t("Propósito de la tarea (markdown)"))}
    ${mdField(`lf-checklist-${i}`, `${t("Puntos a comprobar")} <span class="muted">${t("(uno por línea)")}</span>`, p.checklist, epic ? 3 : 5, t("- Verificar que…"))}`;
  if (!epic) return `<div class="lf-proj">${fields}</div>`;
  return `<details class="lf-proj" open>
    <summary><span class="local-name">${esc(p.repo.name)}</span> <span class="local-badge ok">${esc(p.repo.gitlabPath)}</span></summary>
    ${fields}
  </details>`;
}

// Sección compartida de milestone + etiquetas (se aplican a la Issue/Epic y a todas las tareas).
const USER_LABELS = ["patient user", "professional user", "center user"];
const PRIO_LABELS = ["high priority", "medium priority", "low priority"];
function localMetaSection(f) {
  const l = state.local;
  const labelChip = (name) => {
    const meta = (l.groupLabels || []).find((x) => x.name === name);
    const on = f.labels.has(name);
    const style = on && meta ? ` style="background:${esc(meta.color)};color:${esc(meta.textColor)};border-color:${esc(meta.color)}"` : "";
    return `<button type="button" class="lbl-chip ${on ? "on" : ""}" data-label="${esc(name)}"${style}>${esc(name)}</button>`;
  };
  const others = (l.groupLabels || []).map((x) => x.name).filter((n) => !USER_LABELS.includes(n) && !PRIO_LABELS.includes(n));
  const msOpts = `<option value="">${esc(t("— sin milestone —"))}</option>` + (l.milestones || []).map((m) => `<option value="${m.id}" ${String(m.id) === String(f.milestoneId) ? "selected" : ""}>${esc(m.title)}</option>`).join("");
  return `
    <div class="lf-meta">
      <label class="lf-field">${t("Milestone")} <span class="muted">${t("(por defecto la actual por fechas)")}</span><select id="lf-milestone">${msOpts}</select></label>
      <div class="lf-labels">
        <div class="lbl-group"><span class="lbl-cat">${t("Tipo de usuario")}</span>${USER_LABELS.map(labelChip).join("")}</div>
        <div class="lbl-group"><span class="lbl-cat">${t("Prioridad")}</span>${PRIO_LABELS.map(labelChip).join("")}</div>
        ${others.length ? `<details class="lbl-more"><summary>${t("Más etiquetas ({n})", { n: others.length })}</summary><div class="lbl-group">${others.map(labelChip).join("")}</div></details>` : ""}
      </div>
    </div>`;
}

function renderLocalForm() {
  const f = state.local.form;
  const headTitle = f.epic ? t("Crear épica · {n} proyectos", { n: f.projects.length }) : t("Crear tarea · {name}", { name: esc(f.projects[0].repo.name) });
  const headDesc = f.epic
    ? t("Se creará una <b>Epic</b> y, en cada proyecto, una <b>Issue</b> + una <b>MR</b> vinculadas a la Epic.")
    : `${esc(f.projects[0].repo.gitlabPath)} — ${t("se creará una <b>Issue</b> y una <b>MR</b> con tu rama local.")}`;

  list.innerHTML = `
    <div class="local-head">
      <h2>${headTitle}</h2>
      <p class="local-desc">${headDesc}</p>
    </div>
    <div class="lf">
      <div class="lf-mode">
        <span>${t("Contenido:")}</span>
        <button class="lf-chip ${f.mode === "ia" ? "on" : ""}" id="lf-mode-ia">${t("✨ Generar con IA")}</button>
        <button class="lf-chip ${f.mode === "manual" ? "on" : ""}" id="lf-mode-manual">${t("✍️ A mano")}</button>
        ${f.mode === "ia" ? `<button class="btn" id="lf-suggest" ${f.aiLoading ? "disabled" : ""}>${f.aiLoading ? t("Generando…") : t("Sugerir con IA")}</button>` : ""}
      </div>
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      ${f.epic ? `<label class="lf-field">${t("Título de la Epic")}<input id="lf-epic-title" type="text" value="${esc(f.epicTitle)}" placeholder="${esc(t("Título de la Epic"))}" /></label>` : ""}
      ${f.projects.map((p, i) => localProjectBlock(p, i, f.epic)).join("")}
      ${localMetaSection(f)}
      <label class="lf-check"><input type="checkbox" id="lf-push" ${f.push ? "checked" : ""} /> ${t("Hacer push de las ramas a origin antes de crear las MR")}</label>
      <div class="lf-actions">
        <button class="btn" id="lf-cancel">${t("← Volver")}</button>
        <button class="btn btn-primary" id="lf-create" ${f.creating ? "disabled" : ""}>${f.creating ? t("Creando…") : f.epic ? t("Crear Epic + tareas") : t("Crear Issue + MR")}</button>
      </div>
    </div>`;

  $("#lf-cancel").addEventListener("click", closeLocalForm);
  $("#lf-mode-ia").addEventListener("click", () => { syncLocalForm(); f.mode = "ia"; renderLocal(); });
  $("#lf-mode-manual").addEventListener("click", () => { syncLocalForm(); f.mode = "manual"; renderLocal(); });
  $("#lf-suggest")?.addEventListener("click", suggestLocalTask);
  $("#lf-create").addEventListener("click", confirmCreateLocalTask);
  // Cambiar la rama origen o togglear "crear rama feature" re-renderiza (cambia qué extras se muestran).
  f.projects.forEach((_, i) => {
    $(`#lf-source-${i}`)?.addEventListener("change", () => { syncLocalForm(); renderLocal(); });
    $(`#lf-nb-on-${i}`)?.addEventListener("change", () => { syncLocalForm(); renderLocal(); });
  });
  $("#lf-milestone")?.addEventListener("change", (e) => { f.milestoneId = e.target.value ? Number(e.target.value) : null; });
  list.querySelectorAll(".lbl-chip").forEach((c) => c.addEventListener("click", () => { syncLocalForm(); const n = c.dataset.label; f.labels.has(n) ? f.labels.delete(n) : f.labels.add(n); renderLocal(); }));
  wireMdFields();
  notifySelftestOnce();
}

const checklistToText = (arr) => (Array.isArray(arr) && arr.length ? arr.map((c) => `- ${c}`).join("\n") : "");

// Vuelca una propuesta de IA (title/description/checklist/commitMessage) sobre un proyecto del form,
// y sugiere el nombre de la rama feature a partir del título si aún no se ha tocado.
function applyProposal(p, out) {
  p.title = out.title || p.title;
  p.description = out.description || p.description;
  if (out.checklist?.length) p.checklist = checklistToText(out.checklist);
  if (out.commitMessage) p.commitMessage = out.commitMessage;
  if (p.createBranch && (!p.newBranch || p.newBranch === "feature/") && p.title) p.newBranch = `feature/${slug(p.title)}`;
}

async function suggestLocalTask() {
  const f = state.local.form;
  syncLocalForm();
  f.aiLoading = true;
  f.error = null;
  renderLocal();
  try {
    if (f.epic) {
      const out = await window.monstro.localProposeEpic({
        projects: f.projects.map((p) => ({ dir: p.repo.dir, repoName: p.repo.gitlabPath || p.repo.name, sourceBranch: p.sourceBranch, targetBranch: p.targetBranch })),
      });
      f.epicTitle = out.epicTitle || f.epicTitle;
      out.projects.forEach((pr, i) => {
        if (!f.projects[i]) return;
        applyProposal(f.projects[i], pr);
      });
      (out.labels || []).forEach((n) => f.labels.add(n));
    } else {
      const p = f.projects[0];
      const out = await window.monstro.localProposeTask({ dir: p.repo.dir, repoName: p.repo.gitlabPath || p.repo.name, sourceBranch: p.sourceBranch, targetBranch: p.targetBranch });
      applyProposal(p, out);
      (out.labels || []).forEach((n) => f.labels.add(n));
    }
  } catch (err) {
    f.error = `${t("IA:")} ${String(err.message || err)}`;
  } finally {
    f.aiLoading = false;
    renderLocal();
  }
}

const parseChecklist = (text) => (text || "").split("\n").map((s) => s.replace(/^\s*[-*]\s?/, "").trim()).filter(Boolean);

function confirmCreateLocalTask() {
  const f = state.local.form;
  syncLocalForm();
  if (f.epic && !f.epicTitle.trim()) { f.error = t("El título de la Epic es obligatorio."); renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = t("Cada proyecto necesita un título."); renderLocal(); return; }
  const summary = f.epic
    ? t("Se creará la <b>Epic</b> «{title}» y, en {n} proyectos, una <b>Issue</b> + una <b>MR</b> cada uno{push}. Acción irreversible.", { title: esc(f.epicTitle), n: f.projects.length, push: f.push ? t(", tras <b>pushear</b> las ramas") : "" })
    : t("En <b>{path}</b> se creará una <b>Issue</b> y una <b>MR</b> <code>{src} → {dst}</code>{push}. Acción irreversible.", { path: esc(f.projects[0].repo.gitlabPath), src: esc(f.projects[0].sourceBranch), dst: esc(f.projects[0].targetBranch), push: f.push ? t(", tras <b>pushear</b> la rama") : "" });
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("↗ Crear en GitLab")}</h3>
        <p class="muted">${summary}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Crear en GitLab")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; });
  $("#modal-confirm").addEventListener("click", () => { root.innerHTML = ""; createLocalTask(); });
}

// Payload por proyecto para los orquestadores (incluye mensaje de commit y rama feature opcional).
const localProjPayload = (p, push) => ({
  dir: p.repo.dir,
  projectPath: p.repo.gitlabPath,
  sourceBranch: p.sourceBranch,
  targetBranch: p.targetBranch,
  title: (p.title || "").trim(),
  description: p.description,
  checklist: parseChecklist(p.checklist),
  commitMessage: (p.commitMessage || "").trim(),
  newBranch: p.createBranch ? (p.newBranch || "").trim() : "",
  push,
});

async function createLocalTask() {
  const f = state.local.form;
  f.creating = true;
  f.error = null;
  renderLocal();
  try {
    const labels = [...f.labels];
    if (f.epic) {
      const res = await window.monstro.localCreateEpicTask({ epicTitle: f.epicTitle.trim(), epicDescription: "", labels, milestoneId: f.milestoneId, projects: f.projects.map((p) => localProjPayload(p, f.push)) });
      const ok = res.results.filter((x) => x.ok).length;
      toast(t("Epic + {ok}/{total} tareas creadas", { ok, total: res.results.length }), ok === res.results.length ? "ok" : "warn");
    } else {
      await window.monstro.localCreateTask({ ...localProjPayload(f.projects[0], f.push), labels, milestoneId: f.milestoneId });
      toast(t("Issue + MR creadas ✓"), "ok");
    }
    // #1: al terminar, llevar al histórico actualizado (con el detalle de lo creado y el log de pasos).
    state.local.form = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast(t("Error al crear"), "err");
    renderLocal();
  }
}

const extLink = (url, label) => `<a href="${esc(url)}" class="lf-result-link" data-ext>${esc(label)}</a>`;

// Deep-link interno: salta a la vista de MRs del repo de la MR creada y abre su detalle.
async function openLocalMrInMonstro(mr) {
  state.local.form = null;
  state.view = "prs";
  state.bucket = "open";
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-bucket="open"]')?.classList.add("active");
  if (state.config.repos.includes(mr.projectPath)) {
    state.repo = mr.projectPath;
    renderRepoSelect();
  }
  await refresh();
  try {
    await openDetail(mr.number, "conv", mr.projectPath);
  } catch {
    toast(t("Abre la MR desde la lista (puede tardar en aparecer)"), "");
  }
}

// ----- Vincular tarea: crear MR(s) ligadas a una Issue/Epic existente -----
function openLocalLinkForm(dirs) {
  const l = state.local;
  const projects = (Array.isArray(dirs) ? dirs : [dirs])
    .map((dir) => {
      const repo = (l.repos || []).find((r) => r.dir === dir);
      if (!repo) return null;
      const info = l.info[dir] || {};
      const sourceBranch = info.current || (info.branches?.[0]?.name ?? "");
      return { repo, info, sourceBranch, targetBranch: "development", title: "", commitMessage: "", newBranch: "", createBranch: isBaseBranch(sourceBranch) };
    })
    .filter(Boolean);
  if (!projects.length) return;
  l.linkForm = { projects, issue: null, search: "", searching: false, results: [], push: true, creating: false, result: null, error: null };
  renderLocal();
}

function closeLocalLinkForm() {
  state.local.linkForm = null;
  renderLocal();
}

function syncLocalLinkForm() {
  const f = state.local.linkForm;
  if (!f) return;
  f.search = $("#llf-search")?.value ?? f.search;
  f.push = $("#llf-push") ? $("#llf-push").checked : f.push;
  f.projects.forEach((p, i) => {
    p.sourceBranch = $(`#llf-source-${i}`)?.value ?? p.sourceBranch;
    p.targetBranch = ($(`#llf-target-${i}`)?.value ?? p.targetBranch).trim();
    p.title = $(`#llf-title-${i}`)?.value ?? p.title;
    p.commitMessage = $(`#llf-commit-${i}`)?.value ?? p.commitMessage;
    if ($(`#llf-nb-on-${i}`)) p.createBranch = $(`#llf-nb-on-${i}`).checked;
    p.newBranch = $(`#llf-nb-${i}`)?.value ?? p.newBranch;
  });
}

function renderLocalLinkForm() {
  const f = state.local.linkForm;
  const resultsHtml = f.searching
    ? `<div class="loading">${t("Buscando…")}</div>`
    : f.results.length
      ? f.results
          .map(
            (r) => `<button class="llf-issue ${f.issue && f.issue.url === r.url ? "on" : ""}" data-url="${esc(r.url)}">
            <span class="local-badge ${r.isEpic ? "" : "ok"}">${r.isEpic ? "Epic" : "Issue"}</span>
            <span class="llf-issue-title">${esc(r.title)}</span>
            <span class="muted">${esc(r.projectPath)}#${esc(String(r.iid))}</span>
          </button>`,
          )
          .join("")
      : f.search
        ? `<div class="muted lf-field">${t("Sin resultados.")}</div>`
        : "";
  const projBlocks = f.projects
    .map((p, i) => {
      const branches = p.info.branches || [];
      const opts = branches.length
        ? branches.map((b) => `<option value="${esc(b.name)}" ${b.name === p.sourceBranch ? "selected" : ""}>${esc(b.name)}</option>`).join("")
        : `<option value="${esc(p.sourceBranch)}">${esc(p.sourceBranch || "—")}</option>`;
      return `<div class="lf-proj">
        <div class="lf-proj-name"><span class="local-name">${esc(p.repo.name)}</span> <span class="local-badge ok">${esc(p.repo.gitlabPath)}</span></div>
        <div class="lf-row">
          <label>${t("Rama origen")}<select id="llf-source-${i}">${opts}</select></label>
          <label>${t("Rama destino")}<input id="llf-target-${i}" type="text" value="${esc(p.targetBranch)}" placeholder="development" /></label>
        </div>
        ${localBranchExtras(p, i, "llf")}
        <label class="lf-field">${t("Título de la MR")}<input id="llf-title-${i}" type="text" value="${esc(p.title)}" placeholder="${esc(t("Título de la MR"))}" /></label>
      </div>`;
    })
    .join("");
  list.innerHTML = `
    <div class="local-head">
      <h2>${f.projects.length === 1 ? t("Vincular tarea · {n} proyecto", { n: f.projects.length }) : t("Vincular tarea · {n} proyectos", { n: f.projects.length })}</h2>
      <p class="local-desc">${t("Busca una <b>Issue o Epic</b> existente y crea una <b>MR</b> en cada proyecto vinculada a ella.")}</p>
    </div>
    <div class="lf">
      ${f.error ? `<div class="error-box">${esc(f.error)}</div>` : ""}
      <label class="lf-field">${t("Issue / Epic destino")}<input id="llf-search" type="text" value="${esc(f.search)}" placeholder="${esc(t("Buscar por título… (Enter)"))}" /></label>
      <div class="llf-results">${resultsHtml}</div>
      ${f.issue ? `<div class="llf-chosen">${t("Vinculando a:")} <b>${esc(f.issue.title)}</b> <span class="muted">${esc(f.issue.projectPath)}#${esc(String(f.issue.iid))}</span></div>` : ""}
      ${projBlocks}
      <label class="lf-check"><input type="checkbox" id="llf-push" ${f.push ? "checked" : ""} /> ${t("Hacer push de las ramas antes de crear las MR")}</label>
      <div class="lf-actions">
        <button class="btn" id="llf-cancel">${t("← Volver")}</button>
        <button class="btn btn-primary" id="llf-create" ${f.creating || !f.issue ? "disabled" : ""}>${f.creating ? t("Creando…") : t("Crear MR(s)")}</button>
      </div>
    </div>`;
  $("#llf-cancel").addEventListener("click", closeLocalLinkForm);
  $("#llf-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchLinkIssues(); } });
  list.querySelectorAll(".llf-issue").forEach((b) =>
    b.addEventListener("click", () => {
      syncLocalLinkForm();
      f.issue = f.results.find((r) => r.url === b.dataset.url) || null;
      if (f.issue && f.projects.every((p) => !p.title)) f.projects.forEach((p) => (p.title = f.issue.title));
      renderLocal();
    }),
  );
  $("#llf-create").addEventListener("click", confirmLinkTask);
  f.projects.forEach((_, i) => {
    $(`#llf-source-${i}`)?.addEventListener("change", () => { syncLocalLinkForm(); renderLocal(); });
    $(`#llf-nb-on-${i}`)?.addEventListener("change", () => { syncLocalLinkForm(); renderLocal(); });
  });
  notifySelftestOnce();
}

async function searchLinkIssues() {
  const f = state.local.linkForm;
  syncLocalLinkForm();
  if (!f.search.trim()) { f.results = []; renderLocal(); return; }
  f.searching = true;
  f.error = null;
  renderLocal();
  try {
    f.results = await window.monstro.localSearchIssues(f.search.trim());
  } catch (err) {
    f.error = String(err.message || err);
    f.results = [];
  } finally {
    f.searching = false;
    renderLocal();
  }
}

function confirmLinkTask() {
  const f = state.local.linkForm;
  syncLocalLinkForm();
  if (!f.issue) { f.error = t("Elige una Issue/Epic."); renderLocal(); return; }
  if (f.projects.some((p) => !p.title.trim())) { f.error = t("Cada proyecto necesita un título de MR."); renderLocal(); return; }
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("↗ Vincular en GitLab")}</h3>
        <p class="muted">${t("Se crearán {n} MR vinculadas a <b>{title}</b> ({path}#{iid}){push}. Acción irreversible.", { n: f.projects.length, title: esc(f.issue.title), path: esc(f.issue.projectPath), iid: esc(String(f.issue.iid)), push: f.push ? t(", tras <b>pushear</b> las ramas") : "" })}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Crear en GitLab")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; });
  $("#modal-confirm").addEventListener("click", () => { root.innerHTML = ""; createLinkTask(); });
}

async function createLinkTask() {
  const f = state.local.linkForm;
  f.creating = true;
  f.error = null;
  renderLocal();
  try {
    const res = await window.monstro.localLinkTask({ issue: f.issue, projects: f.projects.map((p) => localProjPayload(p, f.push)) });
    const ok = res.results.filter((x) => x.ok).length;
    toast(t("{ok}/{total} MR creadas", { ok, total: res.results.length }), ok === res.results.length ? "ok" : "warn");
    // #1: al terminar, al histórico actualizado.
    state.local.linkForm = null;
    state.local.selected.clear();
    await enterLocal("historico");
  } catch (err) {
    f.error = String(err.message || err);
    f.creating = false;
    toast(t("Error al vincular"), "err");
    renderLocal();
  }
}

/* ---------- OPE-20: Empezar tarea (picker + plan aprobable) ---------- */

// OPE-20: carga (best-effort) las tareas del grupo asignadas a mí para el picker de "Empezar tarea".
// El picker comparte el `rootDir`/repos con el resto de Trabajo local (para inferir/fijar proyectos
// en el plan), así que también escanea los repos locales si aún no se ha hecho.
async function loadLocalStart() {
  const l = state.local;
  l.planForm = null;
  l.startSel = null;
  l.runView = null;
  if (!l.rootDir) { await loadLocal(); if (!l.rootDir) return; } // sin directorio raíz pinta el picker de raíz
  l.tasksLoading = true;
  renderLocal();
  try {
    l.tasks = await window.monstro.localMyTasks();
  } catch (err) {
    l.tasks = [];
    l.tasksError = String(err.message || err);
  }
  try { l.runs = (await window.monstro.agentsList()) || []; } catch { l.runs = []; }
  l.runsBadge = 0; // visto al entrar
  updateAgentsBadge();
  l.tasksLoading = false;
  renderLocal();
  if (!IS_SELFTEST) ensureProjects().then(() => { if (state.view === "local" && state.local.tab === "empezar" && !state.local.planForm) renderLocal(); }).catch(() => {});
}

// Etiquetas que marcan una tarea como "terminada o casi": se ocultan por defecto en el picker.
const DONE_TASK_RE = /pending check|finished/i;
const PRIORITY_META = ["high", "medium", "low", "none"].map((k, i) => ({ k, i }));
const priorityChip = (p) => {
  const label = { 0: "Alta", 1: "Media", 2: "Baja", 3: "—" }[p] ?? "—";
  const cls = { 0: "pri-high", 1: "pri-med", 2: "pri-low", 3: "pri-none" }[p] || "pri-none";
  return `<span class="ls-pri ${cls}" title="Prioridad ${label}">${label}</span>`;
};

// El picker: tareas (issues abiertas) del grupo asignadas a mí, por defecto sin las terminadas y
// ordenadas por prioridad. Filtros habituales (búsqueda + mostrar terminadas) encima.
function renderLocalStart() {
  const l = state.local;
  const head = `
    <div class="local-head">
      <h2>Empezar tarea</h2>
      <p class="local-desc">Elige una <b>Epic</b> o <b>Issue</b> asignada a ti para preparar un <b>plan</b> y, tras aprobarlo, lanzar a los agentes a trabajar en worktrees.</p>
    </div>`;
  if (!l.rootDir) {
    list.innerHTML = head + `<div class="local-empty"><p>Aún no has indicado el <b>directorio raíz</b> donde tienes clonados tus repos de GitLab.</p><button class="btn btn-primary" id="local-pick">Elegir directorio raíz…</button></div>`;
    $("#local-pick")?.addEventListener("click", async () => { await window.monstro.localPickRoot().then((r) => r.rootDir && loadLocalStart()); });
    notifySelftestOnce();
    return;
  }
  if (l.tasksLoading) { list.innerHTML = head + `<div class="loading">Cargando tus tareas…</div>`; return; }

  const f = l.startFilters;
  const q = f.query.trim().toLowerCase();
  const all = l.tasks || [];
  const tasks = all
    .filter((t) => f.showDone || !t.labels.some((lb) => DONE_TASK_RE.test(lb)))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.projectPath || "").toLowerCase().includes(q))
    .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
  const hiddenDone = all.length - all.filter((t) => f.showDone || !t.labels.some((lb) => DONE_TASK_RE.test(lb))).length;

  const card = (t) => `
    <div class="ls-task" data-iid="${esc(String(t.iid))}" data-proj="${esc(t.projectPath || "")}">
      ${priorityChip(t.priority)}
      <span class="ls-kind ls-${t.isEpic ? "epic" : "issue"}">${t.isEpic ? "Epic" : "Issue"}</span>
      <div class="ls-main">
        <span class="ls-title">${esc(t.title)}</span>
        <span class="ls-proj">${t.projectPath ? projectIconHtml(t.projectPath) + esc(projectMeta(t.projectPath).name) : ""} <span class="muted">#${esc(String(t.iid))}</span></span>
      </div>
      <span class="ls-go">Preparar plan →</span>
    </div>`;

  const toolbar = `
    <div class="ls-toolbar">
      <input id="ls-q" class="ls-search" type="search" placeholder="Buscar por título o proyecto…" value="${esc(f.query)}" />
      <label class="ls-toggle"><input type="checkbox" id="ls-done" ${f.showDone ? "checked" : ""} /> Mostrar terminadas${hiddenDone > 0 && !f.showDone ? ` (${hiddenDone})` : ""}</label>
      <span class="muted ls-count">${tasks.length} tarea${tasks.length === 1 ? "" : "s"}</span>
      <button class="btn local-change" id="ls-refresh">↻ Recargar</button>
    </div>`;

  const body = l.tasksError
    ? `<div class="error-box">${esc(l.tasksError)}</div>`
    : tasks.length
      ? `<div class="ls-list">${tasks.map(card).join("")}</div>`
      : `<div class="local-empty"><p>No hay tareas asignadas a ti${f.showDone ? "" : " sin terminar"}.</p></div>`;

  // Trabajos en curso / recientes (runs persistidos): sobreviven a reiniciar la app y se pueden reanudar.
  const runs = l.runs || [];
  const runsSection = runs.length
    ? `<div class="lr-runs"><div class="lr-runs-head">Trabajos lanzados</div>${runs.slice(0, 8).map(runRowHtml).join("")}</div>`
    : "";

  list.innerHTML = head + runsSection + toolbar + body;
  list.querySelectorAll(".lr-run-row").forEach((el) => el.addEventListener("click", () => openRunView(el.dataset.run)));
  $("#ls-q")?.addEventListener("input", (e) => { f.query = e.target.value; renderLocalStartListOnly(); });
  $("#ls-done")?.addEventListener("change", (e) => { f.showDone = e.target.checked; renderLocal(); });
  $("#ls-refresh")?.addEventListener("click", () => loadLocalStart());
  list.querySelectorAll(".ls-task").forEach((el) => el.addEventListener("click", () => {
    const t = (l.tasks || []).find((x) => String(x.iid) === el.dataset.iid && (x.projectPath || "") === el.dataset.proj);
    if (t) openLocalPlanForm(t);
  }));
  notifySelftestOnce();
}
// Re-pinta solo al teclear en el buscador sin perder foco/caret del input habría sido lo ideal, pero
// el listado es pequeño: un render completo es suficiente. ponytail: full re-render, basta a esta escala.
function renderLocalStartListOnly() { renderLocal(); const i = $("#ls-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }

// Abre el formulario de plan para la tarea elegida. Carga el catálogo de modelos IA y fija por
// defecto el más alto (Opus 4.8 / max), pero el usuario puede cambiarlo (petición explícita).
async function openLocalPlanForm(task) {
  const l = state.local;
  const gitlabPaths = [...new Set((l.repos || []).map((r) => r.gitlabPath).filter(Boolean))];
  l.startSel = task;
  l.planForm = { task, indications: "", inferProjects: true, selectedRepos: new Set(), gitlabPaths, model: "claude-opus-4-8", effort: "max", aiModels: null, generating: false, plan: null, approved: false, error: null };
  renderLocal();
  if (IS_SELFTEST) {
    l.planForm.aiModels = [{ id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "max"] }];
    renderLocal();
    return;
  }
  try {
    const s = await window.monstro.aiStatus();
    if (l.planForm) { l.planForm.aiModels = Array.isArray(s.models) ? s.models : []; renderLocal(); }
  } catch { /* el selector cae a Opus/max por defecto */ }
}

function renderLocalPlanForm() {
  const l = state.local;
  const pf = l.planForm;
  const t = pf.task;
  const head = `
    <div class="local-head">
      <h2>Plan · ${esc(t.title)}</h2>
      <p class="local-desc">${t.isEpic ? "Epic" : "Issue"} ${t.projectPath ? esc(t.projectPath) : ""}#${esc(String(t.iid))} — el plan se genera con el modelo elegido (por defecto el más alto) y <b>tú lo apruebas</b> antes de ejecutar nada.</p>
    </div>`;

  // Selectores de modelo/esfuerzo construidos del catálogo (con fallback a Opus/max).
  const models = pf.aiModels || [{ id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] }];
  const curModel = models.find((m) => m.id === pf.model) || models[0];
  const modelSel = `<select id="pf-model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === pf.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>`;
  const effortSel = curModel.efforts.length
    ? `<select id="pf-effort">${curModel.efforts.map((e) => `<option value="${e}" ${e === pf.effort ? "selected" : ""}>esfuerzo: ${e}</option>`).join("")}</select>`
    : `<select id="pf-effort" disabled><option>esfuerzo: no aplicable</option></select>`;

  const projPicker = `
    <div class="pf-block">
      <label class="pf-label">Proyectos a tocar</label>
      <label class="ls-toggle"><input type="checkbox" id="pf-infer" ${pf.inferProjects ? "checked" : ""} /> Que los infiera la IA según la descripción</label>
      <div class="pf-projects ${pf.inferProjects ? "off" : ""}">
        ${pf.gitlabPaths.length ? pf.gitlabPaths.map((p) => `<label class="pf-proj"><input type="checkbox" class="pf-proj-cb" value="${esc(p)}" ${pf.selectedRepos.has(p) ? "checked" : ""} ${pf.inferProjects ? "disabled" : ""} /> ${projectIconHtml(p)}${esc(projectMeta(p).name)}</label>`).join("") : `<p class="muted">No hay repos locales casados con GitLab bajo el directorio raíz.</p>`}
      </div>
    </div>`;

  if (!pf.plan) {
    list.innerHTML = head + `
      <div class="pf-form">
        <div class="pf-block">
          <label class="pf-label" for="pf-ind">Indicaciones adicionales (opcional)</label>
          <textarea id="pf-ind" class="pf-textarea" rows="4" placeholder="Contexto, restricciones, prioridades… lo que quieras añadir antes de generar el plan.">${esc(pf.indications)}</textarea>
        </div>
        ${projPicker}
        <div class="pf-block pf-ai">
          <label class="pf-label">Modelo para el plan</label>
          <div class="pf-ai-row">${modelSel}${effortSel}</div>
          <p class="muted pf-hint">Para el plan se recomienda el modelo más alto; puedes bajarlo si quieres ahorrar.</p>
        </div>
        ${pf.error ? `<div class="error-box">${esc(pf.error)}</div>` : ""}
        <div class="lf-actions">
          <button class="btn" id="pf-back">← Volver</button>
          <button class="btn btn-primary" id="pf-gen" ${pf.generating ? "disabled" : ""}>${pf.generating ? "Generando plan…" : "Generar plan →"}</button>
        </div>
      </div>`;
    wirePlanFormInputs();
    $("#pf-back")?.addEventListener("click", () => { l.planForm = null; renderLocal(); });
    $("#pf-gen")?.addEventListener("click", generatePlan);
    notifySelftestOnce();
    return;
  }

  // Plan generado: render read-only + gate de aprobación.
  const plan = pf.plan;
  const ul = (items) => `<ul class="pf-ul">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const projs = plan.projects.map((p) => `
    <div class="pf-proj-plan">
      <div class="pf-proj-head">${projectIconHtml(p.name)}${esc(projectMeta(p.name).name || p.name)}</div>
      ${ul(p.tasks)}
    </div>`).join("");
  const meta = `${esc(plan.model)}${plan.effort ? ` · esfuerzo ${esc(plan.effort)}` : ""}${plan.backend ? ` · ${esc(plan.backend)}` : ""}`;

  // Mapeo plan→repo local: auto-asigna si el "name" del plan ES un path disponible; si no, lo deja
  // sin asignar para que el usuario lo elija (feedback: la IA a veces no infiere el proyecto correcto).
  pf.avail = availableLocalProjects();
  if (!pf.mapping) pf.mapping = plan.projects.map((p) => ({ theme: p.name, tasks: p.tasks, repoPath: pf.avail.some((a) => a.path === p.name) ? p.name : "" }));
  const mappedCount = pf.mapping.filter((m) => m.repoPath).length;
  const unresolved = pf.mapping.filter((m) => !m.repoPath).length;
  const mapRows = pf.mapping.map((m, i) => `
    <div class="pf-map-row">
      <span class="pf-map-theme ${m.repoPath ? "" : "unset"}">${esc(projectMeta(m.theme).name || m.theme)}</span>
      <span class="pf-map-arrow">→</span>
      <select class="pf-map-sel" data-i="${i}">
        <option value="">— sin asignar (se omite) —</option>
        ${pf.avail.map((a) => `<option value="${esc(a.path)}" ${m.repoPath === a.path ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
      </select>
    </div>`).join("");
  const mappingHtml = `<div class="pf-sec pf-map"><h3>🔗 Asignar a proyectos locales</h3>
    <p class="muted">Cada bloque se ejecuta en un repo <b>clonado en tu directorio raíz</b> y <b>seleccionable en la app</b>. ${unresolved ? `<b class="local-err">${unresolved} sin asignar</b> — elígelo en cada uno.` : "Todo asignado ✓"}</p>
    ${pf.avail.length ? mapRows : `<p class="local-err">No hay repos locales que casen con tus remotos seleccionables. Añádelos en Ajustes y clónalos bajo el directorio raíz.</p>`}</div>`;

  list.innerHTML = head + `
    <div class="pf-plan ${pf.approved ? "approved" : ""}">
      <div class="pf-plan-meta">Generado con <b>${meta}</b></div>
      ${plan.objectives.length ? `<div class="pf-sec"><h3>🎯 Objetivos</h3>${ul(plan.objectives)}</div>` : ""}
      ${plan.requirements.length ? `<div class="pf-sec"><h3>📋 Requisitos</h3>${ul(plan.requirements)}</div>` : ""}
      ${plan.projects.length ? `<div class="pf-sec"><h3>📦 Trabajo por proyecto</h3>${projs}</div>` : ""}
      ${mappingHtml}
      ${plan.tests.length ? `<div class="pf-sec"><h3>🧪 Pruebas a realizar</h3>${ul(plan.tests)}</div>` : ""}
      ${pf.approved ? `<div class="pf-approved-note">✓ Plan aprobado. Pulsa <b>Lanzar agentes</b>: un worktree + un agente autónomo por proyecto asignado. El plan se guardará como nota en la ${pf.task.isEpic ? "Epic" : "Issue"} de GitLab.${pf.launchError ? `<br><span class="local-err">⚠ ${esc(pf.launchError)}</span>` : ""}</div>` : ""}
    </div>
    <div class="lf-actions">
      <button class="btn" id="pf-edit">← Editar indicaciones</button>
      <button class="btn" id="pf-regen" ${pf.generating ? "disabled" : ""}>↻ Regenerar</button>
      ${pf.approved
        ? `<button class="btn btn-primary" id="pf-launch" ${pf.launching || !mappedCount ? "disabled" : ""} title="${mappedCount ? "" : "Asigna al menos un proyecto"}">${pf.launching ? "Lanzando…" : `🚀 Lanzar agentes${mappedCount ? ` (${mappedCount})` : ""}`}</button>`
        : `<button class="btn btn-primary" id="pf-approve" ${mappedCount ? "" : "disabled"} title="${mappedCount ? "" : "Asigna al menos un proyecto"}">Aprobar plan ✓</button>`}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  list.querySelectorAll(".pf-map-sel").forEach((sel) => sel.addEventListener("change", () => { pf.mapping[+sel.dataset.i].repoPath = sel.value; renderLocal(); }));
  $("#pf-edit")?.addEventListener("click", () => { pf.plan = null; pf.mapping = null; pf.approved = false; renderLocal(); });
  $("#pf-regen")?.addEventListener("click", generatePlan);
  $("#pf-approve")?.addEventListener("click", () => { pf.approved = true; renderLocal(); });
  $("#pf-launch")?.addEventListener("click", launchAgents);
  notifySelftestOnce();
}

// Resuelve el plan a repos locales y arranca el run (worktrees + agentes). Lo de verdad: dispara
// procesos reales. Por eso solo va tras "Aprobar plan" + "Lanzar agentes".
async function launchAgents() {
  const l = state.local;
  const pf = l.planForm;
  const plan = pf.plan;
  // Usa el MAPEO (theme→repo) que el usuario ha revisado/corregido. Cada bloque asignado se agrupa por
  // su repo (un repo puede recibir tareas de varios bloques); los "sin asignar" se omiten.
  const byPath = new Map((l.repos || []).filter((r) => r.gitlabPath).map((r) => [r.gitlabPath, r]));
  const matchedByRepo = new Map();
  const skipped = [];
  for (const m of pf.mapping || []) {
    const repo = m.repoPath && byPath.get(m.repoPath);
    if (!repo) { skipped.push(m.theme); continue; }
    if (!matchedByRepo.has(m.repoPath)) matchedByRepo.set(m.repoPath, { dir: repo.dir, name: m.repoPath, gitlabPath: m.repoPath, tasks: [], sourceBranch: "development" });
    matchedByRepo.get(m.repoPath).tasks.push(...(m.tasks || []));
  }
  const matched = [...matchedByRepo.values()];
  if (!matched.length) { pf.launchError = "Asigna al menos un bloque a un proyecto local antes de lanzar."; renderLocal(); return; }
  pf.launching = true;
  pf.launchError = skipped.length ? `Se omiten (sin asignar): ${skipped.join(", ")}` : null;
  renderLocal();
  try {
    const run = await window.monstro.agentsStart({
      title: pf.task.title, url: pf.task.url, isEpic: pf.task.isEpic, indications: pf.indications,
      objectives: plan.objectives, requirements: plan.requirements, tests: plan.tests, projects: matched,
      taskProjectPath: pf.task.projectPath, taskIid: pf.task.iid,
    });
    if (run.planNote && run.planNote.error) toast(`Run lanzado, pero no se pudo guardar el plan en GitLab: ${run.planNote.error}`, "err");
    else if (run.planNote) toast("Run lanzado · plan guardado en GitLab", "ok");
    l.runView = run;
    l.planForm = null;
    renderLocal();
  } catch (err) {
    pf.launching = false;
    pf.launchError = String(err.message || err);
    renderLocal();
  }
}

function wirePlanFormInputs() {
  const pf = state.local.planForm;
  $("#pf-ind")?.addEventListener("input", (e) => { pf.indications = e.target.value; });
  $("#pf-infer")?.addEventListener("change", (e) => { pf.inferProjects = e.target.checked; renderLocal(); });
  list.querySelectorAll(".pf-proj-cb").forEach((cb) => cb.addEventListener("change", () => { cb.checked ? pf.selectedRepos.add(cb.value) : pf.selectedRepos.delete(cb.value); }));
  $("#pf-model")?.addEventListener("change", (e) => { pf.model = e.target.value; const m = (pf.aiModels || []).find((x) => x.id === pf.model); pf.effort = m && m.efforts.length ? (m.efforts.includes("max") ? "max" : m.efforts[m.efforts.length - 1]) : null; renderLocal(); });
  $("#pf-effort")?.addEventListener("change", (e) => { pf.effort = e.target.value || null; });
}

// Proyectos candidatos para el plan/mapeo: repos LOCALES (bajo el directorio raíz, con remote GitLab)
// que ADEMÁS sean seleccionables en la app (config.repos). Dedup por gitlabPath. (Feedback del usuario.)
function availableLocalProjects() {
  const cfg = new Set(state.config?.repos || []);
  const seen = new Set();
  const out = [];
  for (const r of state.local.repos || []) {
    if (!r.gitlabPath || !cfg.has(r.gitlabPath) || seen.has(r.gitlabPath)) continue;
    seen.add(r.gitlabPath);
    out.push({ path: r.gitlabPath, name: projectMeta(r.gitlabPath).name || r.gitlabPath, dir: r.dir });
  }
  return out;
}

async function generatePlan() {
  const pf = state.local.planForm;
  if (!pf) return;
  // Captura el estado de los inputs antes de re-pintar (el textarea no dispara render en cada tecla).
  const ind = $("#pf-ind"); if (ind) pf.indications = ind.value;
  pf.generating = true;
  pf.error = null;
  pf.mapping = null; // se recalcula con el nuevo plan
  renderLocal();
  try {
    const repos = pf.inferProjects ? [] : [...pf.selectedRepos];
    pf.plan = await window.monstro.localProposePlan({
      title: pf.task.title,
      description: pf.task.description || "",
      isEpic: pf.task.isEpic,
      indications: pf.indications,
      repos,
      available: availableLocalProjects(),
      model: pf.model,
      effort: pf.effort,
    });
  } catch (err) {
    pf.error = String(err.message || err);
  } finally {
    pf.generating = false;
    renderLocal();
    notifySelftestOnce();
  }
}

/* ---------- OPE-20 fase 3: vista del run en vivo ---------- */

const RUN_STATUS = {
  starting: { label: "Arrancando", cls: "st-run" }, running: { label: "Trabajando", cls: "st-run" },
  done: { label: "Hecho", cls: "st-done" }, failed: { label: "Falló", cls: "st-fail" }, stopped: { label: "Parado", cls: "st-stop" }, idle: { label: "—", cls: "st-stop" },
};
const runStatusBadge = (s) => { const m = RUN_STATUS[s] || RUN_STATUS.idle; return `<span class="lr-status ${m.cls}">${m.label}</span>`; };
const TL_ICON = { say: "💬", tool: "▸", blocked: "⛔", result: "✓" };
const tlEntryHtml = (e) => `<li class="tl-${esc(e.kind)}"><span class="tl-ic">${e.kind === "result" ? (e.ok ? "✓" : "✗") : TL_ICON[e.kind] || "·"}</span><span class="tl-tx">${esc(e.text || "")}</span></li>`;

function runRowHtml(run) {
  const pend = (run.projects || []).reduce((n, p) => n + (p.pending || 0), 0);
  return `<div class="lr-run-row" data-run="${esc(run.id)}">
    ${runStatusBadge(run.status)}
    <span class="lr-run-title">${esc(run.title)}</span>
    <span class="muted lr-run-meta">${(run.projects || []).length} proyecto${(run.projects || []).length === 1 ? "" : "s"}${pend ? ` · ⛔ ${pend} pendiente${pend === 1 ? "" : "s"}` : ""}</span>
    <span class="ls-go">Ver →</span>
  </div>`;
}

async function openRunView(runId) {
  const l = state.local;
  try { l.runView = (await window.monstro.agentsGet(runId)) || l.runs.find((r) => r.id === runId) || null; }
  catch { l.runView = l.runs.find((r) => r.id === runId) || null; }
  if (l.runView) renderLocal();
}

function renderLocalRun() {
  const l = state.local;
  const run = l.runView;
  const projCard = (p, i) => {
    const running = p.status === "running" || p.status === "starting";
    const mrMerged = (l.mrStatuses[p.dir] || {}).merged;
    const modelChip = `<span class="lr-model" title="${esc(p.rationale || "")}">${esc(p.model || "")}${p.effort ? ` · ${esc(p.effort)}` : ""}</span>`;
    const timeline = (p.timeline || []).map(tlEntryHtml).join("") || `<li class="muted tl-empty">Sin actividad todavía…</li>`;
    return `
      <div class="lr-proj" data-dir="${esc(p.dir)}">
        <div class="lr-proj-head">
          ${projectIconHtml(p.gitlabPath || p.name)}<span class="lr-proj-name">${esc(projectMeta(p.gitlabPath || p.name).name || p.name)}</span>
          ${runStatusBadge(p.status)} ${modelChip} ${p.pending ? `<span class="lr-pend" title="Comandos peligrosos bloqueados">⛔ ${p.pending}</span>` : ""}
        </div>
        ${p.branch ? `<div class="lr-proj-sub">⎇ ${esc(p.branch)}${p.worktree ? ` · <span class="muted" title="${esc(p.worktree)}">.worktrees/${esc(p.worktree.split("/").pop())}</span>` : ""}</div>` : ""}
        ${p.error ? `<div class="local-err">⚠ ${esc(p.error)}</div>` : ""}
        <ul class="lr-timeline">${timeline}</ul>
        ${p.mr ? `<div class="lr-mr"><a href="${esc(p.mr.url)}" data-ext class="lh-pill lh-pill-mr">MR !${esc(String(p.mr.number))}</a>${mrMerged ? `<span class="lh-badge merged">merged</span>` : ""}</div>` : ""}
        <div class="lr-proj-actions">
          ${p.worktree && !p.worktreeRemoved ? `<button class="btn lr-open" data-dir="${esc(p.dir)}" data-wt="${esc(p.worktree)}">Abrir en editor</button>` : ""}
          ${p.worktree && !p.worktreeRemoved ? `<button class="btn lr-diff" data-dir="${esc(p.dir)}" data-wt="${esc(p.worktree)}" data-base="${esc(p.sourceBranch || "development")}" data-branch="${esc(p.branch || "")}">Ver cambios</button>` : ""}
          ${running
            ? `<button class="btn lr-stop" data-dir="${esc(p.dir)}">Parar</button>`
            : `${(p.status === "failed" || p.status === "stopped") && p.worktree ? `<button class="btn lr-retry" data-dir="${esc(p.dir)}" title="Vuelve a lanzar el agente en este worktree">↻ Reintentar</button>` : ""}<button class="btn lr-resume" data-dir="${esc(p.dir)}">Comentar y reanudar</button>`}
          ${!running && p.worktree && !p.finalized && p.gitlabPath ? `<button class="btn btn-primary lr-finalize" data-dir="${esc(p.dir)}">Finalizar (commit · push · MR)</button>` : ""}
          ${p.finalized && mrMerged && !p.worktreeRemoved ? `<button class="btn lr-clean" data-dir="${esc(p.dir)}" title="La MR está fusionada: limpia el worktree">🧹 Limpiar worktree</button>` : ""}
          ${p.worktreeRemoved ? `<span class="muted lr-cleaned">✓ worktree limpiado</span>` : ""}
        </div>
      </div>`;
  };
  list.innerHTML = `
    <div class="local-head">
      <h2>${esc(run.title)} ${runStatusBadge(run.status)}</h2>
      <p class="local-desc">Un agente autónomo trabaja en cada proyecto, en su worktree. Sigue su línea de tiempo en directo; los comandos peligrosos se bloquean (⛔) y requieren tu permiso.</p>
    </div>
    <div class="lr-grid">${(run.projects || []).map(projCard).join("")}</div>
    <div class="lf-actions" style="margin:0 20px 28px">
      <button class="btn" id="lr-back">← Volver</button>
      ${run.url ? `<a class="btn" href="${esc(run.url)}" data-ext>Ver la tarea en GitLab</a>` : ""}
      ${(run.projects || []).some((p) => (p.status === "failed" || p.status === "stopped") && p.worktree) ? `<button class="btn btn-primary" id="lr-retry-all">↻ Reintentar los que fallaron</button>` : ""}
    </div>`;
  list.querySelectorAll("a[data-ext]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(a.getAttribute("href")); }));
  $("#lr-back")?.addEventListener("click", () => { l.runView = null; loadLocalStart(); });
  list.querySelectorAll(".lr-open").forEach((b) => b.addEventListener("click", async () => { const r = await window.monstro.agentsOpenEditor(b.dataset.dir, b.dataset.wt); toast(r.ok ? `Abriendo en ${r.stack === "dotnet" ? "Rider" : "VSCode"}…` : `No se pudo abrir: ${r.error || ""}`, r.ok ? "ok" : "err"); }));
  list.querySelectorAll(".lr-stop").forEach((b) => b.addEventListener("click", async () => { await window.monstro.agentsStop(run.id, b.dataset.dir); }));
  list.querySelectorAll(".lr-resume").forEach((b) => b.addEventListener("click", async () => {
    const guidance = prompt("Feedback para el agente (opcional). Lo retoma en el mismo worktree:");
    if (guidance === null) return;
    try { await window.monstro.agentsResume(run.id, b.dataset.dir, guidance.trim()); }
    catch (err) { toast(String(err.message || err), "err"); }
  }));
  list.querySelectorAll(".lr-retry").forEach((b) => b.addEventListener("click", () => retryProject(run.id, b.dataset.dir)));
  $("#lr-retry-all")?.addEventListener("click", async () => {
    const failed = (run.projects || []).filter((p) => (p.status === "failed" || p.status === "stopped") && p.worktree);
    for (const p of failed) await retryProject(run.id, p.dir);
  });
  list.querySelectorAll(".lr-diff").forEach((b) => b.addEventListener("click", () => openAgentDiff(b.dataset.dir, b.dataset.wt, b.dataset.base, b.dataset.branch)));
  list.querySelectorAll(".lr-finalize").forEach((b) => b.addEventListener("click", () => finalizeProject(b.dataset.dir, b)));
  list.querySelectorAll(".lr-clean").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await window.monstro.agentsCleanupWorktree(run.id, b.dataset.dir); const p = run.projects.find((x) => x.dir === b.dataset.dir); if (p) p.worktreeRemoved = true; renderLocal(); toast("Worktree limpiado ✓", "ok"); }
    catch (err) { b.disabled = false; toast(String(err.message || err), "err"); }
  }));
  // Autoscroll de cada timeline al final.
  list.querySelectorAll(".lr-timeline").forEach((ul) => { ul.scrollTop = ul.scrollHeight; });
  // Estado de las MRs (merged?) para el icono de limpiar worktree — best-effort, no en selftest.
  if (!IS_SELFTEST && (run.projects || []).some((p) => p.mr)) {
    window.monstro.agentsMrStatuses(run.id).then((m) => { l.mrStatuses = { ...l.mrStatuses, ...(m || {}) }; if (state.local.runView === run) renderLocal(); }).catch(() => {});
  }
  notifySelftestOnce();
}

// Reintenta un proyecto que falló o se paró: vuelve a lanzar el agente en su mismo worktree (sin
// feedback). Si el agente llegó a tener sesión, se reanuda; si no (p.ej. crash al arrancar), arranca
// de cero. La timeline conserva el intento anterior como historial.
async function retryProject(runId, dir) {
  const run = state.local.runView;
  const p = run && run.projects.find((x) => x.dir === dir);
  if (p) { p.status = "starting"; p.error = null; renderLocal(); }
  try { await window.monstro.agentsResume(runId, dir, ""); toast("Reintentando…", "ok"); }
  catch (err) { if (p) p.status = "failed"; renderLocal(); toast(String(err.message || err), "err"); }
}

// Finaliza un proyecto: commit (si hay cambios) + push + crea la MR. Acción real → confirma vía botón.
async function finalizeProject(dir, btn) {
  const run = state.local.runView;
  if (btn) { btn.disabled = true; btn.textContent = "Finalizando…"; }
  try {
    const res = await window.monstro.agentsFinalize(run.id, dir);
    const p = run.projects.find((x) => x.dir === dir);
    if (p) { p.mr = res.mr; p.finalized = true; }
    renderLocal();
    toast(`MR creada: !${res.mr.number}`, "ok");
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Finalizar (commit · push · MR)"; }
    toast(String(err.message || err), "err");
  }
}

// Muestra el diff de los cambios del agente DENTRO de la app (modal con coloreado +/- básico).
async function openAgentDiff(dir, worktree, base, branch) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal modal-wide"><h3>Cambios · ${esc(branch)}</h3><div class="agent-diff loading">Cargando diff…</div><div class="modal-actions"><button class="btn" id="modal-cancel">Cerrar</button></div></div></div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") close(); });
  try {
    const { diff } = await window.monstro.agentsDiff(dir, worktree, base, branch);
    const box = root.querySelector(".agent-diff");
    if (!box) return;
    box.classList.remove("loading");
    box.innerHTML = diff && diff.trim() ? `<pre class="agent-diff-pre">${renderDiffLines(diff)}</pre>` : `<p class="muted">Sin cambios respecto a ${esc(base)}.</p>`;
  } catch (err) {
    const box = root.querySelector(".agent-diff");
    if (box) { box.classList.remove("loading"); box.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`; }
  }
}

// Diff a HTML con clases por tipo de línea (+/-/hunk/cabecera). Escapado siempre.
function renderDiffLines(diff) {
  return String(diff).split("\n").map((ln) => {
    let cls = "d-ctx";
    if (/^diff --git|^index |^--- |^\+\+\+ /.test(ln)) cls = "d-meta";
    else if (ln.startsWith("@@")) cls = "d-hunk";
    else if (ln.startsWith("+")) cls = "d-add";
    else if (ln.startsWith("-")) cls = "d-del";
    return `<span class="${cls}">${esc(ln) || "&nbsp;"}</span>`;
  }).join("\n");
}

// Cuenta de runs que requieren atención (terminados/fallados desde la última visita o con pendientes).
function updateAgentsBadge() {
  const n = state.local.runsBadge || 0;
  const el = $("#bucket-local-empezar");
  if (!el) return;
  let dot = el.querySelector(".nav-dot");
  if (n > 0) { if (!dot) { dot = document.createElement("span"); dot.className = "nav-dot"; el.appendChild(dot); } dot.textContent = n > 9 ? "9+" : String(n); }
  else if (dot) dot.remove();
}

// Suscripción única a los eventos de los agentes: actualiza la vista del run en vivo + badge + avisos.
function wireAgentEvents() {
  window.monstro.onAgentEvent("agents:event", (p) => {
    const run = state.local.runView;
    const inView = run && run.id === p.runId;
    if (inView) {
      const proj = run.projects.find((x) => x.dir === p.projectDir);
      if (proj) {
        if (p.entries) { proj.timeline = (proj.timeline || []).concat(p.entries); if (p.entries.some((e) => e.kind === "blocked")) proj.pending = (proj.pending || 0) + p.entries.filter((e) => e.kind === "blocked").length; }
        if (p.status) proj.status = p.status;
        if (p.error) proj.error = p.error;
        if (p.mr) proj.mr = p.mr;
        if (p.finalized) proj.finalized = true;
        if (p.worktreeRemoved) proj.worktreeRemoved = true;
        // Append incremental al DOM si la vista está montada (evita perder scroll). Cambios de estado
        // que no son timeline (status/mr/finalized/limpieza) → re-render completo.
        const ul = list.querySelector(`.lr-proj[data-dir="${CSS.escape(p.projectDir)}"] .lr-timeline`);
        if (ul && p.entries && !p.status && !p.mr && !p.finalized && !p.worktreeRemoved) { ul.querySelector(".tl-empty")?.remove(); ul.insertAdjacentHTML("beforeend", p.entries.map(tlEntryHtml).join("")); ul.scrollTop = ul.scrollHeight; }
        else renderLocal();
      }
    }
  });
  window.monstro.onAgentEvent("agents:run", (p) => {
    if (state.local.runView && state.local.runView.id === p.runId) { state.local.runView.status = p.status; if (state.view === "local" && state.local.tab === "empezar" && state.local.runView) { const h = list.querySelector(".local-head h2 .lr-status"); if (h) h.outerHTML = runStatusBadge(p.status); } }
  });
  window.monstro.onAgentEvent("agents:notify", (p) => {
    const verb = p.status === "done" ? "terminó" : "falló";
    // Solo avisamos si NO estás mirando ese run (evita ruido), con burbuja + notificación OS.
    if (!(state.view === "local" && state.local.tab === "empezar" && state.local.runView && state.local.runView.id === p.runId)) {
      state.local.runsBadge = (state.local.runsBadge || 0) + 1;
      updateAgentsBadge();
      if (!IS_SELFTEST) window.monstro.notify(`Agente ${verb}`, `${p.projectName} · ${p.title}`);
    }
    toast(`Agente ${verb}: ${p.projectName}`, p.status === "done" ? "ok" : "err");
  });
}

/* ---------- Releases · pestaña Publicar (tag + release) ---------- */

// CalVer base a partir de la rama rb/: "rb/062026" -> "2026.06". Si la rama no es rb/MMAAAA,
// se cae al mes actual (AAAA.MM). El patch (.0, .1…) lo resuelve el backend por proyecto.
