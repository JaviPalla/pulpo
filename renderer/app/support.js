"use strict";

// Vista de Soporte (solo GitLab): board "tareas por persona" IDÉNTICO a Milestones pero para un
// proyecto suelto del namespace soporte (no hay milestone: sin métricas/epics/edición). Dos apartados,
// Support (incidencias) y Ops (operaciones), comparten esta vista parametrizada por state.support.kind
// (= clave de config.support). Reutiliza groupIssuesByAssignee/labelChips/prioRank/wireTaskButtons de
// milestones.js para que las columnas y tarjetas sean exactamente las mismas.

const SUPPORT_BUCKET = { incidencias: "bucket-support", operaciones: "bucket-ops" };

async function enterSupport(kind) {
  if (!isGitlab()) {
    toast(t("El soporte solo está disponible en GitLab"), "");
    return;
  }
  state.view = "support";
  state.support.kind = kind;
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $(`#${SUPPORT_BUCKET[kind]}`)?.classList.add("active");
  await loadSupport();
}

async function loadSupport() {
  const s = state.support;
  const project = state.config?.support?.[s.kind];
  if (!project) {
    list.innerHTML = `<div class="empty">${t("Configura el proyecto de soporte en Ajustes.")}</div>`;
    notifySelftestOnce();
    return;
  }
  s.loading = true;
  renderSupport();
  try {
    s.issues = await window.monstro.projectIssues(project);
    s.loading = false;
    renderSupport();
  } catch (err) {
    s.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

// Issues visibles tras los filtros: cerradas ocultas por defecto (toggle "Mostrar cerradas") y
// filtro de etiqueta (substring, case-insensitive sobre los labels).
function filteredSupport() {
  const s = state.support;
  const f = s.labelFilter.trim().toLowerCase();
  return s.issues.filter((iss) => {
    if (!s.showClosed && iss.state === "closed") return false;
    if (f && !iss.labels.some((l) => l.name.toLowerCase().includes(f))) return false;
    return true;
  });
}

// Tarjeta IDÉNTICA a la de Milestones (milestoneCard, rama no-epic) sin checkbox/MR/epic: el soporte
// no tiene jerarquía ni selección múltiple. Sí es draggable (data-key) para reasignar de persona.
function supportCard(iss) {
  const chips = labelChips(iss.labels);
  return `
    <div class="ms-task ${iss.state === "closed" ? "closed" : ""}" draggable="true" data-key="${esc(issueKey(iss))}">
      <div class="ms-task-top">
        <button class="ms-task-title" data-url="${esc(iss.webUrl)}" title="${t("Abrir en GitLab")}">
          ${esc(iss.title)} <span class="ms-iid">#${iss.iid}</span>
        </button>
        <button class="ms-task-copy" data-url="${esc(iss.webUrl)}" title="${t("Copiar enlace")}">⧉</button>
      </div>
      ${chips ? `<div class="ms-task-labels">${chips}</div>` : ""}
    </div>`;
}

// Columna de una persona, con el MISMO markup que Milestones (.ms-group/.ms-group-head/.ms-tasks),
// sin lo que no aplica al soporte: drag&drop (ms-drop/data-*), chips de métricas. Placeholder ∅ para
// "Sin asignar", igual que milestones.
function supportColumn(g) {
  const sorted = [...g.issues].sort((a, b) => prioRank(a) - prioRank(b));
  const avatar = g.avatarUrl ? `<img class="ms-avatar" src="${esc(g.avatarUrl)}" alt="" />` : `<span class="ms-avatar ph">∅</span>`;
  return `
    <section class="ms-group ms-drop" data-username="${esc(g.username)}" data-userid="${g.id || ""}">
      <header class="ms-group-head">
        ${avatar}
        <span class="ms-group-name">${esc(g.name)}</span>
        <span class="ms-group-count">${g.issues.length}</span>
      </header>
      <div class="ms-tasks">${sorted.map(supportCard).join("")}</div>
    </section>`;
}

// Reasigna por arrastre, igual que Milestones: quita al asignado de origen, añade al destino, conserva
// co-asignados. Drop en "Sin asignar" (data-userid="" → targetId null) desasigna. Aplica con
// updateIssue (project-scoped) y refresca. ponytail: secuencial, una issue por drop (sin multi-selección).
async function applySupportPatch(key, patchFn) {
  const iss = state.support.issues.find((i) => issueKey(i) === key);
  if (!iss) return;
  const patch = patchFn(iss);
  if (!patch) return;
  try {
    await window.monstro.updateIssue(iss.projectId, iss.iid, patch);
    await loadSupport();
    toast(t("Tarea reasignada"), "ok");
  } catch (err) {
    toast(esc(String(err.message || err)), "err");
  }
}

function wireSupportDnd(board) {
  board.querySelectorAll(".ms-task").forEach((card) =>
    card.addEventListener("dragstart", (event) => {
      const fromUserId = card.closest(".ms-drop")?.dataset.userid || "";
      event.dataTransfer.setData("text/plain", JSON.stringify({ key: card.dataset.key, fromUserId }));
      event.dataTransfer.effectAllowed = "move";
    }),
  );
  board.querySelectorAll(".ms-drop").forEach((col) => {
    col.addEventListener("dragover", (event) => {
      event.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (event) => {
      event.preventDefault();
      col.classList.remove("drag-over");
      let payload;
      try {
        payload = JSON.parse(event.dataTransfer.getData("text/plain"));
      } catch {
        return;
      }
      if (!payload) return;
      const fromId = Number(payload.fromUserId) || null;
      const targetId = col.dataset.userid ? Number(col.dataset.userid) : null;
      if (fromId === targetId) return; // misma columna (incl. Sin asignar → Sin asignar)
      applySupportPatch(payload.key, (iss) => {
        let ids = iss.assignees.map((a) => a.id);
        if (fromId) ids = ids.filter((id) => id !== fromId);
        if (targetId && !ids.includes(targetId)) ids.push(targetId);
        return { assigneeIds: ids };
      });
    });
  });
}

// Pinta solo el board (columnas) + el contador, sin tocar la barra de filtros: así el input de
// etiqueta no pierde el foco al teclear.
function renderSupportBoard() {
  const issues = filteredSupport();
  const cols = groupIssuesByAssignee(issues).map(supportColumn).join("");
  const board = list.querySelector(".support-board");
  if (board) {
    board.innerHTML = cols || `<div class="empty">${t("Sin tareas")}</div>`;
    wireTaskButtons(board);
    wireSupportDnd(board);
  }
  const count = list.querySelector(".support-count");
  if (count) count.textContent = issues.length;
}

function renderSupport() {
  if (state.view !== "support") return;
  const s = state.support;
  if (s.loading) {
    list.innerHTML = `<div class="loading">${t("Cargando tareas…")}</div>`;
    return;
  }
  list.innerHTML = `
    <div class="ms-filters support-filters">
      <input id="support-label-filter" class="support-label-filter" type="search" placeholder="${t("Filtrar por etiqueta…")}" value="${esc(s.labelFilter)}" />
      <label class="ms-closed-toggle"><input type="checkbox" id="support-show-closed" ${s.showClosed ? "checked" : ""} /> ${t("Mostrar cerradas")}</label>
      <span class="ms-count"><span class="support-count">0</span> ${t("tareas")}</span>
      <button id="support-refresh" class="icon-btn" title="${t("Refrescar")}">⟳</button>
    </div>
    <div class="ms-board support-board"></div>`;

  const filter = $("#support-label-filter");
  filter?.addEventListener("input", () => {
    s.labelFilter = filter.value;
    renderSupportBoard();
  });
  $("#support-show-closed")?.addEventListener("change", (event) => {
    s.showClosed = event.target.checked;
    renderSupportBoard();
  });
  $("#support-refresh")?.addEventListener("click", loadSupport);

  renderSupportBoard();
  notifySelftestOnce();
}
