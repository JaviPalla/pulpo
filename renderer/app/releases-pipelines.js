"use strict";

/* ============ Releases → Pipelines de despliegue (OPE-25) ============ */
// Vista (pestaña "pipelines") que muestra, de un vistazo, la pipeline de la ÚLTIMA release de cada
// proyecto seleccionado, con un selector para ver releases anteriores. Permite lanzar los jobs
// manuales (▶) y abrir el log de cada job en GitLab. Comparte el picker de proyectos (r.selected)
// con las otras dos pestañas de Releases.

// status crudo de GitLab -> [icono, clase]. `manual` = job sin lanzar (lanzable).
const JOB_ICON = {
  success: ["✓", "ok"],
  failed: ["✗", "err"],
  canceled: ["⊘", "muted"],
  skipped: ["»", "muted"],
  manual: ["▶", "manual"],
  running: ["◐", "pending"],
  pending: ["●", "pending"],
  created: ["○", "muted"],
  preparing: ["●", "pending"],
  scheduled: ["◷", "pending"],
  waiting_for_resource: ["●", "pending"],
};

// Lanza la carga de la pipeline de un proyecto (última release o el tag pedido) y re-renderiza.
function fetchProjectPipeline(path, tag) {
  const pl = state.releases.pipelines;
  pl.loading.add(path);
  renderReleasePipelines();
  window.monstro
    .releasePipeline(path, tag || null)
    .then((data) => {
      pl.data.set(path, data);
    })
    .catch((err) => {
      pl.data.set(path, { error: String(err.message || err), releases: [], tag: null, pipeline: null });
    })
    .finally(() => {
      pl.loading.delete(path);
      renderReleasePipelines();
    });
}

async function playReleaseJob(path, jobId, projectName) {
  const pl = state.releases.pipelines;
  if (pl.busy.has(jobId)) return;
  pl.busy.add(jobId);
  renderReleasePipelines();
  try {
    const job = await window.monstro.playReleaseJob(path, jobId);
    toast(t("Job lanzado: {name}", { name: job.name || jobId }), "ok");
    // Refrescamos la pipeline del proyecto para ver el nuevo estado del job.
    const cur = pl.data.get(path);
    fetchProjectPipeline(path, cur?.tag || null);
  } catch (err) {
    toast(`${projectName || path}: ${String(err.message || err)}`, "err");
  } finally {
    pl.busy.delete(jobId);
    renderReleasePipelines();
  }
}

function jobRowHtml(path, projName, job) {
  const [icon, cls] = JOB_ICON[job.status] || ["·", "muted"];
  const busy = state.releases.pipelines.busy.has(job.id);
  const playBtn = job.manual
    ? `<button class="rel-job-play" data-path="${esc(path)}" data-job="${esc(String(job.id))}" data-name="${esc(projName)}" ${busy ? "disabled" : ""} title="${t("Lanzar job manual")}">${busy ? "…" : "▶"}</button>`
    : "";
  const log = job.webUrl ? `<a class="rel-job-log" data-url="${esc(job.webUrl)}" href="#" title="${t("Ver log en GitLab")}">log</a>` : "";
  return `<div class="rel-job ${cls}">
    <span class="rel-job-ico">${icon}</span>
    <span class="rel-job-name" title="${esc(job.status)}">${esc(job.name)}</span>
    ${playBtn}${log}
  </div>`;
}

function projectCardHtml(p) {
  const pl = state.releases.pipelines;
  const data = pl.data.get(p.path);
  const loading = pl.loading.has(p.path);
  let body;
  if (loading && !data) {
    body = `<div class="rel-pl-loading loading-pulse">${t("Cargando…")}</div>`;
  } else if (!data) {
    body = `<div class="muted rel-pl-empty">${t("Pendiente")}</div>`;
  } else if (data.error) {
    body = `<div class="rel-res-row err">${esc(data.error)}</div>`;
  } else if (!data.releases.length) {
    body = `<div class="muted rel-pl-empty">${t("Sin releases todavía")}</div>`;
  } else {
    const relOptions = data.releases
      .map((r) => `<option value="${esc(r.tag)}" ${r.tag === data.tag ? "selected" : ""}>${esc(r.tag)}</option>`)
      .join("");
    const selector = `<select class="rel-pl-rel" data-path="${esc(p.path)}" ${loading ? "disabled" : ""}>${relOptions}</select>`;
    let pipeBody;
    if (!data.pipeline) {
      pipeBody = `<div class="muted rel-pl-empty">${t("Esta release no tiene pipeline")}</div>`;
    } else {
      const dot = pipelineDot(data.pipeline.state);
      const pipeLink = data.pipeline.webUrl
        ? `<a class="rel-pl-pipelink" data-url="${esc(data.pipeline.webUrl)}" href="#">${t("Ver pipeline")} →</a>`
        : "";
      // Jobs agrupados por stage, en orden de aparición.
      const stages = [];
      const byStage = new Map();
      for (const j of data.pipeline.jobs || []) {
        if (!byStage.has(j.stage)) {
          byStage.set(j.stage, []);
          stages.push(j.stage);
        }
        byStage.get(j.stage).push(j);
      }
      const jobsHtml = stages.length
        ? stages
            .map(
              (s) => `<div class="rel-stage">
                <div class="rel-stage-name">${esc(s || "—")}</div>
                <div class="rel-stage-jobs">${byStage.get(s).map((j) => jobRowHtml(p.path, p.name, j)).join("")}</div>
              </div>`,
            )
            .join("")
        : `<div class="muted rel-pl-empty">${t("Sin jobs")}</div>`;
      pipeBody = `<div class="rel-pl-pipehead">${dot} <span class="rel-pl-state">${esc(data.pipeline.state)}</span> ${pipeLink}</div>
        <div class="rel-stages">${jobsHtml}</div>`;
    }
    body = `<div class="rel-pl-relrow">${selector}${loading ? `<span class="muted">${t("Cargando…")}</span>` : ""}</div>${pipeBody}`;
  }
  return `<div class="rel-pl-card">
    <div class="rel-pl-cardhead">${projectIconHtml(p.path)}<span class="rel-pl-projname">${esc(p.name)}</span></div>
    ${body}
  </div>`;
}

function renderReleasePipelines() {
  if (state.view !== "releases" || state.releases.tab !== "pipelines") return;
  const r = state.releases;
  const projects = r.projects || [];
  const selected = projects.filter((p) => r.selected.has(p.path));

  // Chips de proyecto (mismo selector compartido que las otras pestañas).
  const chipsHtml = projects
    .map((p) => {
      const off = !r.selected.has(p.path);
      return `<button class="ms-proj-chip ${off ? "off" : ""}" data-path="${esc(p.path)}"
        title="${off ? t("Excluido · clic para incluir") : t("Incluido · clic para excluir")}">
        ${projectIconHtml(p.path)}<span class="ms-proj-name">${esc(p.name)}</span>
      </button>`;
    })
    .join("");
  const selCount = selected.length;
  const allOn = selCount === projects.length && projects.length > 0;

  const cardsHtml = selected.length
    ? selected.map((p) => projectCardHtml(p)).join("")
    : `<div class="rel-pl-empty muted">${t("Selecciona al menos un proyecto para ver sus pipelines.")}</div>`;

  list.innerHTML = `
    <div class="rel-view">
      <header class="rel-head">
        <h2>${t("Pipelines de despliegue")}</h2>
        <p class="rel-sub">${t("Estado de la pipeline de la última release de cada proyecto. Cambia el selector para ver releases anteriores, lanza los jobs manuales (▶) o abre el log en GitLab.")}</p>
      </header>

      <div class="rel-projects-head">
        <span>${t("Proyectos")} <span class="rel-count">${selCount}/${projects.length}</span></span>
        <span>
          <button class="btn ghost" id="rel-pl-toggle-all">${allOn ? t("Ninguno") : t("Todos")}</button>
          <button class="btn ghost" id="rel-pl-refresh">${t("Refrescar")}</button>
        </span>
      </div>
      <div class="rel-projects ms-proj-filter">${chipsHtml || `<span class="muted">${t("No se han podido cargar los proyectos del grupo.")}</span>`}</div>

      <div class="rel-pl-board">${cardsHtml}</div>
    </div>`;

  // Auto-carga perezosa: cada proyecto seleccionado sin datos ni carga en curso se pide.
  for (const p of selected) {
    if (!state.releases.pipelines.data.has(p.path) && !state.releases.pipelines.loading.has(p.path)) {
      fetchProjectPipeline(p.path, null);
    }
  }

  list.querySelectorAll(".ms-proj-chip[data-path]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const path = chip.dataset.path;
      if (r.selected.has(path)) r.selected.delete(path);
      else r.selected.add(path);
      saveReleaseSelection();
      renderReleasePipelines();
    }),
  );
  $("#rel-pl-toggle-all")?.addEventListener("click", () => {
    if (allOn) r.selected.clear();
    else for (const p of projects) r.selected.add(p.path);
    saveReleaseSelection();
    renderReleasePipelines();
  });
  $("#rel-pl-refresh")?.addEventListener("click", () => {
    for (const p of selected) fetchProjectPipeline(p.path, state.releases.pipelines.data.get(p.path)?.tag || null);
  });
  list.querySelectorAll(".rel-pl-rel").forEach((sel) =>
    sel.addEventListener("change", (event) => fetchProjectPipeline(sel.dataset.path, event.target.value)),
  );
  list.querySelectorAll(".rel-job-play").forEach((btn) =>
    btn.addEventListener("click", () => playReleaseJob(btn.dataset.path, Number(btn.dataset.job), btn.dataset.name)),
  );
  list.querySelectorAll("a[data-url]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (a.dataset.url) window.monstro.openExternal(a.dataset.url);
    }),
  );
  notifySelftestOnce();
}
