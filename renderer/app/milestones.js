"use strict";

async function enterMilestones() {
  if (!isGitlab()) {
    toast(t("La vista de Milestones solo está disponible en GitLab"), "");
    return;
  }
  state.view = "milestones";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-milestones")?.classList.add("active");
  await loadMilestones();
}

async function loadMilestones() {
  const m = state.milestones;
  // Por defecto, las labels "terminada no cerrada" arrancan ocultas (chip en "excluir").
  if (!m.filters.seeded) {
    for (const label of state.config?.milestones?.doneLabels || []) m.filters.status.set(label, "exclude");
    m.filters.seeded = true;
  }
  m.loading = true;
  renderMilestones();
  try {
    if (!m.list.length) m.list = await window.monstro.listMilestones();
    if (!m.labels.length) m.labels = await window.monstro.groupLabels().catch(() => []);
    if (!m.selectedTitle && m.list.length) m.selectedTitle = pickCurrentMilestone(m.list);
    // Traemos SIEMPRE todo (incl. cerradas): las métricas To do / pending check se calculan
    // contra las cerradas/terminadas, así que las necesitamos aunque no se muestren. El filtro
    // "Mostrar cerradas" pasa a ser solo de visualización. Limitado por milestone, no es el grupo
    // entero. ponytail: si un milestone supera el cap de 500 (apiAll), las métricas se quedan cortas.
    m.issues = m.selectedTitle ? await window.monstro.milestoneIssues(m.selectedTitle, true) : [];
    m.loading = false;
    renderMilestones();
  } catch (err) {
    m.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

// Milestone "vigente": descartamos los claramente futuros (empiezan después de hoy) y
// pasados (vencieron antes de hoy); entre los que quedan, el que contiene hoy en su rango,
// si no el primero vigente, y como último recurso el primero de la lista. Fechas ISO
// (YYYY-MM-DD) se comparan como string sin problema.
function pickCurrentMilestone(list) {
  const today = new Date().toISOString().slice(0, 10);
  const live = list.filter((ms) => {
    if (ms.startDate && ms.startDate > today) return false; // futuro
    if (ms.dueDate && ms.dueDate < today) return false; // pasado
    return true;
  });
  const containing = live.find((ms) => (!ms.startDate || ms.startDate <= today) && (!ms.dueDate || ms.dueDate >= today));
  return (containing || live[0] || list[0])?.title || null;
}

// Reparte cada issue en sus asignados (un issue con N asignados aparece en N personas:
// cada quien ve su tarea pendiente). Los huérfanos caen en "Sin asignar".
function groupIssuesByAssignee(issues) {
  const UNASSIGNED = "__unassigned__";
  const groups = new Map();
  for (const iss of issues) {
    const targets = iss.assignees.length ? iss.assignees : [{ username: UNASSIGNED, name: t("Sin asignar"), avatarUrl: null }];
    for (const a of targets) {
      if (!groups.has(a.username)) groups.set(a.username, { ...a, issues: [] });
      groups.get(a.username).issues.push(iss);
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.username === UNASSIGNED) return 1;
    if (b.username === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

// Clave estable de un issue (los issues se leen del grupo, así que combinamos proyecto+iid).
function issueKey(iss) {
  return `${iss.projectId}#${iss.iid}`;
}

function milestoneCard(iss, statusSet) {
  const chips = iss.labels
    .map((l) => {
      const isStatus = statusSet.has(l.name);
      const style = l.color ? `style="background:${l.color};color:${l.textColor || "#fff"}"` : "";
      return `<span class="ms-label ${isStatus ? "status" : ""}" ${style}>${esc(l.name)}</span>`;
    })
    .join("");
  const key = issueKey(iss);
  const selected = state.milestones.selected.has(key);
  return `
    <div class="ms-task ${iss.state === "closed" ? "closed" : ""} ${selected ? "selected" : ""}" draggable="true"
         data-key="${esc(key)}" data-project="${iss.projectId}" data-iid="${iss.iid}">
      <div class="ms-task-top">
        <input type="checkbox" class="ms-task-check" ${selected ? "checked" : ""} title="${t("Seleccionar")}" />
        <button class="ms-task-title" data-url="${esc(iss.webUrl)}" title="${t("Abrir en GitLab")}">
          ${esc(iss.title)} <span class="ms-iid">#${iss.iid}</span>
        </button>
      </div>
      ${chips ? `<div class="ms-task-labels">${chips}</div>` : ""}
    </div>`;
}

// Las "pending check*" (comprobación) y "finished" (terminada) viven ambas en doneLabels;
// las separamos por nombre: las que contienen "pending check" son comprobación, el resto (finished) terminada.
function splitDoneLabels(doneLabels) {
  const pendingCheck = new Set();
  const finished = new Set();
  for (const l of doneLabels) (l.toLowerCase().includes("pending check") ? pendingCheck : finished).add(l);
  return { pendingCheck, finished };
}

// Métricas sobre un conjunto de issues (todas las que se le pasen; el llamador filtra a las
// ASIGNADAS). Categorías mutuamente excluyentes:
//   C = cerradas · F = abiertas con "finished" · P = abiertas con "pending check*" · T = abiertas resto (to do)
// Indicadores de AVANCE (cuánto se ha completado, no cuánto falta), base "hecho" = C + F:
//   Terminadas  = base / (base + T)   cerradas/finished sobre el total a hacer
//   Comprobadas = base / (base + P)   ya comprobadas sobre comprobadas + las que esperan comprobación
function milestoneMetrics(issues, pendingCheckSet, finishedSet) {
  let C = 0, F = 0, P = 0, T = 0;
  for (const iss of issues) {
    if (iss.state === "closed") { C++; continue; }
    const names = iss.labels.map((l) => l.name);
    if (names.some((n) => finishedSet.has(n))) F++;
    else if (names.some((n) => pendingCheckSet.has(n))) P++;
    else T++;
  }
  const base = C + F;
  const pct = (count, total) => (total ? Math.round((100 * count) / total) : 0);
  return {
    doneCount: base, doneTotal: base + T, donePct: pct(base, base + T),
    checkedCount: base, checkedTotal: base + P, checkedPct: pct(base, base + P),
  };
}

// Info del filtro de estado: explica los tres estados (sin filtro → solo estas → ocultas) con
// una animación que va resaltando cada uno en orden, mostrando el ciclo del clic.
function statusFilterHelp() {
  return `<span class="ms-filter-info" tabindex="0" title="${t("Cómo funciona el filtro de etiquetas")}"><span class="ms-filter-i">i</span><div class="ms-filter-pop">
      <div class="msfh-title">${t("Clic en una etiqueta para ciclar el filtro:")}</div>
      <div class="msfh-states">
        <span class="msfh-state st1">
          <span class="msfh-chip neutral"><span class="lbl">${t("etiqueta")}</span></span>
          <span class="msfh-cap">${t("Sin filtro")}</span>
        </span>
        <span class="msfh-arr">→</span>
        <span class="msfh-state st2">
          <span class="msfh-chip inc"><span class="chk">✓</span> <span class="lbl">${t("etiqueta")}</span></span>
          <span class="msfh-cap">${t("Solo estas")}</span>
        </span>
        <span class="msfh-arr">→</span>
        <span class="msfh-state st3">
          <span class="msfh-chip exc"><span class="ex">✕</span> <span class="lbl">${t("etiqueta")}</span></span>
          <span class="msfh-cap">${t("Ocultas")}</span>
        </span>
      </div>
    </div></span>`;
}

// Negro o blanco según la luminancia del color de fondo, para que el texto SIEMPRE se lea
// encima del color del label (sea cual sea). Fórmula perceptual (rec. 601).
function readableText(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length < 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#fff";
}

// Indicadores Terminadas/Comprobadas como pastillas. En la cabecera del milestone se muestra
// también el número (showCount); en la de cada persona solo el % (n/m en el tooltip).
function metricChips(mm, showCount = false) {
  const chip = (cls, icon, count, total, pct, name) => {
    const num = showCount ? `<span class="ms-chip-n">${count}/${total}</span> ` : "";
    return `<span class="ms-chip ${cls}" title="${name} ${count}/${total}">${icon} ${num}${pct}%</span>`;
  };
  return (
    chip("term", "✓", mm.doneCount, mm.doneTotal, mm.donePct, t("Terminadas")) +
    chip("check", "◉", mm.checkedCount, mm.checkedTotal, mm.checkedPct, t("Comprobadas"))
  );
}

function renderMilestones() {
  if (state.view !== "milestones") return;
  const m = state.milestones;
  if (m.loading) {
    list.innerHTML = `<div class="loading">${t("Cargando milestone…")}</div>`;
    return;
  }

  const statusLabels = state.config?.milestones?.statusLabels || [];
  const statusSet = new Set(statusLabels);
  const { pendingCheck: pendingCheckSet, finished: finishedSet } = splitDoneLabels(state.config?.milestones?.doneLabels || []);
  const search = state.search.trim().toLowerCase();

  // Filtros tri-estado: incluir (solo estas) y excluir (ocultar estas).
  const includes = [];
  const excludes = new Set();
  for (const [label, mode] of m.filters.status) {
    if (mode === "include") includes.push(label);
    else if (mode === "exclude") excludes.add(label);
  }

  const visible = m.issues.filter((iss) => {
    if (!m.filters.showClosed && iss.state === "closed") return false;
    if (!m.filters.showUnassigned && !iss.assignees.length) return false;
    const names = iss.labels.map((l) => l.name);
    if (excludes.size && names.some((n) => excludes.has(n))) return false;
    if (includes.length && !names.some((n) => includes.includes(n))) return false;
    if (search && !`${iss.title} ${names.join(" ")}`.toLowerCase().includes(search)) return false;
    return true;
  });

  // Las métricas se calculan SIEMPRE sobre el conjunto completo de ASIGNADAS (no sobre lo
  // filtrado ni sobre las sin asignar): ocultar un estado no debe poner su % a cero.
  const assignedIssues = m.issues.filter((iss) => iss.assignees.length);
  const allByMember = new Map(groupIssuesByAssignee(m.issues).map((g) => [g.username, g.issues]));
  const milestoneMM = milestoneMetrics(assignedIssues, pendingCheckSet, finishedSet);

  // Chips de estado con el color real del label: neutro = solo borde; incluir = relleno + ✓ verde;
  // excluir = sin relleno, ✕ roja y texto tachado.
  const labelColors = new Map(m.labels.map((l) => [l.name, l]));
  const statusChips = statusLabels
    .map((label) => {
      const mode = m.filters.status.get(label);
      const lab = labelColors.get(label);
      const color = lab?.color || "var(--text-muted)";
      const cls = mode === "include" ? "on" : mode === "exclude" ? "off" : "";
      // Relleno: texto en blanco/negro según contraste con el color. Sin relleno: texto en --text
      // (siempre legible sobre el fondo del tema), el color queda en el borde.
      const style =
        mode === "include"
          ? `background:${color};color:${readableText(lab?.color)};border-color:${color}`
          : `background:transparent;color:var(--text);border-color:${color}`;
      const icon = mode === "include" ? `<span class="chk">✓</span> ` : mode === "exclude" ? `<span class="ex">✕</span> ` : "";
      const hint = mode === "include" ? t("Solo estas · clic: ocultar") : mode === "exclude" ? t("Ocultas · clic: quitar filtro") : t("Clic: solo estas");
      return `<button class="ms-status-chip ${cls}" data-label="${esc(label)}" style="${style}" title="${hint}">${icon}<span class="lbl">${esc(label)}</span></button>`;
    })
    .join("");

  const groups = groupIssuesByAssignee(visible);
  const boardHtml = groups.length
    ? groups
        .map((g) => {
          const gm = milestoneMetrics(allByMember.get(g.username) || [], pendingCheckSet, finishedSet);
          return `
        <section class="ms-group ms-drop" data-username="${esc(g.username)}" data-userid="${g.id || ""}">
          <header class="ms-group-head">
            ${g.avatarUrl ? `<img class="ms-avatar" src="${esc(g.avatarUrl)}" alt="" />` : `<span class="ms-avatar ph">∅</span>`}
            <span class="ms-group-name">${esc(g.name)}</span>
            <span class="ms-group-chips">${metricChips(gm)}</span>
            <span class="ms-group-count">${g.issues.length}</span>
          </header>
          <div class="ms-tasks">${g.issues.map((iss) => milestoneCard(iss, statusSet)).join("")}</div>
        </section>`;
        })
        .join("")
    : `<div class="empty">${t("No hay tareas que mostrar con estos filtros.")}</div>`;

  // Solo seguimos contando como seleccionadas las que siguen visibles.
  const visibleKeys = new Set(visible.map(issueKey));
  for (const k of [...m.selected]) if (!visibleKeys.has(k)) m.selected.delete(k);
  const selCount = m.selected.size;

  const railHtml = m.list
    .map((ms) => {
      const current = ms.title === m.selectedTitle;
      // Los chips de métricas (genéricos del milestone) van bajo el nombre, solo en el actual.
      const metrics = current ? `<span class="ms-rail-metrics">${metricChips(milestoneMM, true)}</span>` : "";
      const due = ms.dueDate ? `<span class="ms-rail-due">${t("vence")} ${esc(ms.dueDate)}</span>` : "";
      return `<button class="ms-rail-item ms-drop-ms ${current ? "current" : ""}" data-msid="${ms.id}" data-title="${esc(ms.title)}" title="${t("Clic: ver este milestone · soltar issues aquí para moverlas")}">
        <span class="ms-rail-name">${esc(ms.title)}</span>
        ${metrics || due ? `<span class="ms-rail-sub">${metrics}${due}</span>` : ""}
      </button>`;
    })
    .join("");

  // Sub-pestañas (Tareas | Resumen): el rail se mantiene en ambas para poder cambiar de milestone.
  const tab = m.tab === "summary" ? "summary" : "tasks";
  const tabsHtml = `
    <div class="ms-tabs">
      <button class="ms-tab ${tab === "tasks" ? "active" : ""}" data-mstab="tasks">${t("Tareas")}</button>
      <button class="ms-tab ${tab === "summary" ? "active" : ""}" data-mstab="summary">${t("Resumen")}</button>
    </div>`;

  const tasksBodyHtml = `
    <div class="ms-filters">
      ${statusFilterHelp()}
      ${statusChips ? `<div class="ms-status-bar">${statusChips}</div>` : ""}
      <div class="ms-toggles">
        <label class="ms-closed-toggle"><input type="checkbox" id="ms-show-closed" ${m.filters.showClosed ? "checked" : ""} /> ${t("Mostrar cerradas")}</label>
        <label class="ms-closed-toggle"><input type="checkbox" id="ms-show-unassigned" ${m.filters.showUnassigned ? "checked" : ""} /> ${t("Mostrar sin asignar")}</label>
        <span class="ms-counter">${visible.length === 1 ? t("{n} tarea", { n: visible.length }) : t("{n} tareas", { n: visible.length })}</span>
        <button class="icon-btn" id="ms-refresh" title="${t("Recargar")}">⟳</button>
      </div>
    </div>
    <div class="ms-bulk-bar ${selCount ? "" : "hidden"}">
      <span class="ms-bulk-count">${selCount === 1 ? t("{n} seleccionada", { n: selCount }) : t("{n} seleccionadas", { n: selCount })}</span>
      <button class="btn" id="ms-bulk-labels">${t("Etiquetas…")}</button>
      <button class="btn" id="ms-bulk-milestone">${t("Milestone…")}</button>
      <button class="btn ghost" id="ms-bulk-clear">${t("Quitar selección")}</button>
    </div>
    <div class="ms-board">${boardHtml}</div>`;

  list.innerHTML = `
    <div class="ms-rail">${railHtml || `<span class="muted">${t("Sin milestones activos")}</span>`}</div>
    ${tabsHtml}
    ${tab === "summary" ? milestoneSummaryHtml() : tasksBodyHtml}`;

  list.querySelectorAll(".ms-tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = btn.dataset.mstab;
      if (m.tab === next) return;
      m.tab = next;
      renderMilestones();
    }),
  );

  // Clic en una tarjeta del rail = ver ese milestone (además de ser drop target para mover issues).
  list.querySelectorAll(".ms-drop-ms").forEach((item) =>
    item.addEventListener("click", () => {
      if (item.dataset.title === m.selectedTitle) return;
      m.selectedTitle = item.dataset.title;
      m.issues = [];
      m.selected.clear();
      loadMilestones();
    }),
  );
  if (tab === "summary") {
    wireMilestoneSummary();
    notifySelftestOnce();
    return;
  }

  $("#ms-show-closed")?.addEventListener("change", (event) => {
    // Las cerradas ya están en m.issues (se traen siempre para las métricas): solo es display.
    m.filters.showClosed = event.target.checked;
    renderMilestones();
  });
  $("#ms-show-unassigned")?.addEventListener("change", (event) => {
    m.filters.showUnassigned = event.target.checked;
    renderMilestones();
  });
  $("#ms-refresh")?.addEventListener("click", () => {
    m.list = [];
    m.issues = [];
    loadMilestones();
  });
  list.querySelectorAll(".ms-status-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      // Ciclo tri-estado: neutro → incluir → excluir → neutro.
      const label = chip.dataset.label;
      const mode = m.filters.status.get(label);
      if (!mode) m.filters.status.set(label, "include");
      else if (mode === "include") m.filters.status.set(label, "exclude");
      else m.filters.status.delete(label);
      renderMilestones();
    }),
  );
  list.querySelectorAll(".ms-task-title").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation(); // no seleccionar la tarjeta al abrir en GitLab
      window.monstro.openExternal(btn.dataset.url);
    }),
  );

  // Selección múltiple: checkbox por issue.
  list.querySelectorAll(".ms-task-check").forEach((box) =>
    box.addEventListener("change", (event) => {
      const key = event.target.closest(".ms-task").dataset.key;
      if (event.target.checked) m.selected.add(key);
      else m.selected.delete(key);
      renderMilestones();
    }),
  );

  wireMilestoneDragDrop(list);

  $("#ms-bulk-clear")?.addEventListener("click", () => {
    m.selected.clear();
    renderMilestones();
  });
  $("#ms-bulk-labels")?.addEventListener("click", openBulkLabelsModal);
  $("#ms-bulk-milestone")?.addEventListener("click", openBulkMilestoneModal);

  notifySelftestOnce();
}

// Aplica un patch (objeto, o función issue→patch) a un conjunto de issues por su clave.
// Secuencial y NO atómico: si falla a medias, unas quedan aplicadas y otras no (se reporta).
async function applyIssuePatch(keys, patchOrFn) {
  const m = state.milestones;
  let ok = 0;
  let fail = 0;
  for (const key of keys) {
    const iss = m.issues.find((i) => issueKey(i) === key);
    if (!iss) continue;
    const patch = typeof patchOrFn === "function" ? patchOrFn(iss) : patchOrFn;
    if (!patch) continue;
    try {
      await window.monstro.updateIssue(iss.projectId, iss.iid, patch);
      ok++;
    } catch {
      fail++;
    }
  }
  m.selected.clear();
  m.issues = []; // fuerza refetch de las tareas del milestone actual
  await loadMilestones();
  if (fail) toast(ok === 1 ? t("{ok} aplicada, {fail} fallaron", { ok, fail }) : t("{ok} aplicadas, {fail} fallaron", { ok, fail }), "err");
  else if (ok) toast(ok === 1 ? t("{ok} tarea actualizada", { ok }) : t("{ok} tareas actualizadas", { ok }), "ok");
}

/* ============ resumen de novedades (sub-pestaña Resumen, solo GitLab) ============ */
// Persistencia del resumen generado por IA en localStorage para no re-gastar tokens al reabrir.
// ponytail: localStorage vive en el app-data de esta instalación (no portable entre máquinas/perfiles);
// si algún día hace falta portabilidad, mover a un fichero en userData vía IPC como los borradores.
