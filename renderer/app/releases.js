"use strict";

async function enterReleases(tab = "branches") {
  if (!isGitlab()) {
    toast(t("La vista de Releases solo está disponible en GitLab"), "");
    return;
  }
  state.view = "releases";
  state.releases.tab = tab;
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $(tab === "publish" ? "#bucket-releases-publish" : "#bucket-releases")?.classList.add("active");
  await loadReleases();
}

async function loadReleases() {
  const r = state.releases;
  r.loading = true;
  renderReleases();
  try {
    if (!r.defaults) r.defaults = await window.monstro.releasesDefaults();
    // Proyectos: del grupo en vivo (mismos datos + iconos que el filtro del resumen). No archivados.
    await ensureProjects();
    if (!r.projects.length) {
      r.projects = [...(state.milestones.projects?.values() || [])]
        .filter((p) => !p.archived)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    // Selección: la última recordada (paths, persistida en config) si la hay; si no, el set por
    // defecto (los 8 del script, por ID). Solo se siembra una vez por sesión (seeded), para no pisar
    // lo que el usuario vaya cambiando al navegar dentro de la sesión.
    if (!r.seeded) {
      const existing = new Set(r.projects.map((p) => p.path));
      const saved = r.defaults.selectedProjects;
      if (Array.isArray(saved)) {
        for (const path of saved) if (existing.has(path)) r.selected.add(path);
      } else {
        const defIds = new Set((r.defaults.defaultProjectIds || []).map(String));
        for (const p of r.projects) if (defIds.has(String(p.id))) r.selected.add(p.path);
      }
      r.seeded = true;
    }
    if (!r.version) r.version = suggestedReleaseVersion(); // por defecto: mes+año actual (p.ej. 062026)
    if (!r.sourceBranch) r.sourceBranch = r.defaults.sourceBranch || "development";
    if (!r.appDate) r.appDate = new Date().toISOString().slice(0, 10); // hoy (YYYY-MM-DD) para el input
    r.loading = false;
    renderReleases();
  } catch (err) {
    r.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

// Versión por defecto: MMAAAA del mes actual (p.ej. 062026), como pidió el usuario.
function suggestedReleaseVersion() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, "0")}${now.getFullYear()}`;
}

// ISO (YYYY-MM-DD del input nativo) -> DDMMYYYY (formato del AppDate en el Web.config de Ouicare).
function isoToAppDate(iso) {
  const [y, m, d] = (iso || "").split("-");
  return y && m && d ? `${d}${m}${y}` : "";
}

// Persiste la selección de proyectos (paths) en config para recordarla entre sesiones.
function saveReleaseSelection() {
  if (IS_SELFTEST) return;
  window.monstro.setConfig({ releases: { selectedProjects: [...state.releases.selected] } }).catch(() => {});
}

// Nombre de rama final válido (prefijo + versión) con la misma regla que valida el backend.
function releaseBranchValid(version) {
  const prefix = state.releases.defaults?.branchPrefix || "rb/";
  return Boolean(version) && BRANCH_RE.test(`${prefix}${version}`);
}

function renderReleases() {
  if (state.view !== "releases") return;
  const r = state.releases;
  if (r.loading || !r.defaults) {
    list.innerHTML = `<div class="loading">${t("Cargando configuración de releases…")}</div>`;
    if (!r.loading) notifySelftestOnce();
    return;
  }
  if (r.tab === "publish") return renderReleasePublish();
  const prefix = r.defaults.branchPrefix || "rb/";
  const projects = r.projects || [];
  const ouicarePath = r.defaults.ouicare?.projectPath || null;
  const ouicareSelected = Boolean(ouicarePath && r.selected.has(ouicarePath));

  // Chips de proyecto: mismo diseño que el filtro por proyecto del resumen (.ms-proj-chip + icono).
  // Aquí seleccionado = normal, deseleccionado = .off (tachado). Clic alterna.
  const chipsHtml = projects
    .map((p) => {
      const off = !r.selected.has(p.path);
      return `<button class="ms-proj-chip ${off ? "off" : ""}" data-path="${esc(p.path)}" ${r.running ? "disabled" : ""}
        title="${off ? t("Excluido · clic para incluir") : t("Incluido · clic para excluir")}">
        ${projectIconHtml(p.path)}<span class="ms-proj-name">${esc(p.name)}</span>
      </button>`;
    })
    .join("");

  const selCount = projects.filter((p) => r.selected.has(p.path)).length;
  const allOn = selCount === projects.length && projects.length > 0;
  const valid = releaseBranchValid(r.version);
  const canRun = valid && selCount > 0 && !r.running;
  const branchPreview = `${prefix}${r.version || ""}`;

  // Panel AppDate de Ouicare: solo visible si Ouicare está entre los seleccionados.
  const appDateHtml = ouicareSelected
    ? `<div class="rel-appdate">
        <label class="rel-appdate-toggle">
          <input type="checkbox" id="rel-appdate-on" ${r.appDateEnabled ? "checked" : ""} ${r.running ? "disabled" : ""} />
          ${t("Actualizar")} <code>AppDate</code> ${t("de Ouicare")} (<code>${esc(r.defaults.ouicare.webConfigPath)}</code>)
        </label>
        <input type="date" id="rel-appdate-date" value="${esc(r.appDate)}" ${r.appDateEnabled && !r.running ? "" : "disabled"} />
        <span class="muted">${t("Se commitea en")} <code>${esc(r.sourceBranch)}</code> ${t("antes de crear la rama.")}</span>
      </div>`
    : "";

  // Bloque de resultados de la última generación (AppDate + por-proyecto).
  let resultsHtml = "";
  if (r.results) {
    const ok = r.results.results.filter((x) => x.ok).length;
    const fail = r.results.results.length - ok;
    const cls = fail ? (ok ? "warn" : "err") : "ok";
    const ad = r.results.appDate;
    const adHtml = ad
      ? ad.ok
        ? `<div class="rel-res-row ok">📝 Ouicare AppDate ${ad.skipped ? `${t("ya estaba en")} <b>${esc(ad.date)}</b>` : `→ <b>${esc(ad.date)}</b>`}</div>`
        : `<div class="rel-res-row err">📝 Ouicare AppDate: ${esc(ad.error || t("error"))}</div>`
      : "";
    const rowsHtml = r.results.results
      .map((res) =>
        res.ok
          ? `<div class="rel-res-row ok">✓ ${esc(res.name)} ${res.webUrl ? `<a data-url="${esc(res.webUrl)}" href="#">${t("ver rama")}</a>` : ""}</div>`
          : `<div class="rel-res-row err" title="${esc(res.error || "")}">✕ ${esc(res.name)}: ${esc(res.error || t("error"))}</div>`,
      )
      .join("");
    resultsHtml = `
      <div class="rel-summary ${cls}">${t("Rama")} <code>${esc(r.results.branch)}</code> ${t("desde")} <code>${esc(r.results.ref)}</code> · ${ok} ${ok === 1 ? t("creada") : t("creadas")}${fail ? ` · ${t("{fail} con error", { fail })}` : ""}</div>
      <div class="rel-results">${adHtml}${rowsHtml}</div>`;
  }

  list.innerHTML = `
    <div class="rel-view">
      <header class="rel-head">
        <h2>${t("Generar release branches")}</h2>
        <p class="rel-sub">${t("Crea la rama")} <code>${esc(prefix)}&lt;versión&gt;</code> ${t("en los proyectos seleccionados, a partir de una rama origen. Réplica del script")} <code>auto-rb-branches.py</code>.</p>
      </header>

      <div class="rel-form">
        <label class="rel-field">
          <span class="rel-label">${t("Versión")}</span>
          <input type="text" id="rel-version" value="${esc(r.version)}" placeholder="${t("p.ej. {ej}", { ej: esc(suggestedReleaseVersion()) })}" ${r.running ? "disabled" : ""} autocomplete="off" />
        </label>
        <label class="rel-field">
          <span class="rel-label">${t("Rama origen")}</span>
          <input type="text" id="rel-source" value="${esc(r.sourceBranch)}" placeholder="development" ${r.running ? "disabled" : ""} autocomplete="off" />
        </label>
        <div class="rel-preview-box">
          <span class="rel-label">${t("Rama a crear")}</span>
          <code class="rel-branch-preview ${valid ? "" : "invalid"}" id="rel-branch-preview">${esc(branchPreview)}</code>
        </div>
      </div>

      <div class="rel-projects-head">
        <span>${t("Proyectos")} <span class="rel-count" id="rel-sel-count">${selCount}/${projects.length}</span></span>
        <button class="btn ghost" id="rel-toggle-all" ${r.running ? "disabled" : ""}>${allOn ? t("Ninguno") : t("Todos")}</button>
      </div>
      <div class="rel-projects ms-proj-filter">${chipsHtml || `<span class="muted">${t("No se han podido cargar los proyectos del grupo.")}</span>`}</div>

      ${appDateHtml}
      ${resultsHtml}

      <div class="rel-actions">
        <button class="btn btn-primary" id="rel-generate" ${canRun ? "" : "disabled"}>${r.running ? t("Generando…") : t("Generar release branches")}</button>
      </div>
    </div>`;

  const versionInput = $("#rel-version");
  const preview = $("#rel-branch-preview");
  const genBtn = $("#rel-generate");
  const syncControls = () => {
    const v = releaseBranchValid(r.version);
    const sel = projects.filter((p) => r.selected.has(p.path)).length;
    preview.textContent = `${prefix}${r.version || ""}`;
    preview.classList.toggle("invalid", !v);
    $("#rel-sel-count").textContent = `${sel}/${projects.length}`;
    genBtn.disabled = !(v && sel > 0 && !r.running);
  };
  versionInput?.addEventListener("input", () => {
    r.version = versionInput.value.trim();
    syncControls();
  });
  $("#rel-source")?.addEventListener("input", (event) => {
    r.sourceBranch = event.target.value.trim();
  });
  // Clic en chip = alternar selección. Re-render (la visibilidad del panel AppDate depende de Ouicare).
  list.querySelectorAll(".ms-proj-chip[data-path]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const path = chip.dataset.path;
      if (r.selected.has(path)) r.selected.delete(path);
      else r.selected.add(path);
      saveReleaseSelection();
      renderReleases();
    }),
  );
  $("#rel-toggle-all")?.addEventListener("click", () => {
    if (allOn) r.selected.clear();
    else for (const p of projects) r.selected.add(p.path);
    saveReleaseSelection();
    renderReleases();
  });
  $("#rel-appdate-on")?.addEventListener("change", (event) => {
    r.appDateEnabled = event.target.checked;
    renderReleases();
  });
  $("#rel-appdate-date")?.addEventListener("change", (event) => {
    r.appDate = event.target.value;
  });
  list.querySelectorAll(".rel-results a[data-url]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (a.dataset.url) window.monstro.openExternal(a.dataset.url);
    }),
  );
  $("#rel-generate")?.addEventListener("click", confirmAndGenerateReleases);
  notifySelftestOnce();
}

// Confirmación antes de crear (operación de escritura sobre N proyectos, no atómica): mostramos
// la rama, el origen y la lista de destinos. Nunca dispara sin confirmar.
function confirmAndGenerateReleases() {
  const r = state.releases;
  if (!releaseBranchValid(r.version)) return;
  const prefix = r.defaults.branchPrefix || "rb/";
  const branch = `${prefix}${r.version}`;
  const source = r.sourceBranch || r.defaults.sourceBranch || "development";
  const targets = r.projects.filter((p) => r.selected.has(p.path));
  if (!targets.length) return;
  const ouicarePath = r.defaults.ouicare?.projectPath || null;
  const appDateOn = Boolean(ouicarePath && r.selected.has(ouicarePath) && r.appDateEnabled);
  const appDateStr = isoToAppDate(r.appDate);
  const noteHtml = appDateOn
    ? `<div class="rel-confirm-notes"><div class="rel-confirm-note">📝 <b>Ouicare</b>: AppDate → <b>${esc(appDateStr)}</b> ${t("en")} <code>${esc(source)}</code> (${t("commit a")} <code>${esc(r.defaults.ouicare.webConfigPath)}</code>) ${t("antes de ramificar.")}</div></div>`
    : "";
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("Crear")} <code>${esc(branch)}</code> ${targets.length === 1 ? t("en 1 proyecto") : t("en {n} proyectos", { n: targets.length })}</h3>
        <p class="muted">${t("Desde la rama")} <code>${esc(source)}</code>. ${t("Se aplica proyecto a proyecto (no atómico): si alguno falla, el resto sí se crea.")}</p>
        <ul class="rel-confirm-list">${targets.map((p) => `<li>${esc(p.name)} <span class="muted">${esc(p.path)}</span></li>`).join("")}</ul>
        ${noteHtml}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Crear ramas")}</button>
        </div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-confirm").addEventListener("click", () => {
    close();
    runReleaseGeneration();
  });
}

async function runReleaseGeneration() {
  const r = state.releases;
  r.running = true;
  r.results = null;
  renderReleases();
  try {
    const projects = r.projects.filter((p) => r.selected.has(p.path)).map((p) => ({ id: p.path, name: p.name }));
    const ouicarePath = r.defaults.ouicare?.projectPath || null;
    const ouicare =
      ouicarePath && r.selected.has(ouicarePath) && r.appDateEnabled
        ? { enabled: true, date: isoToAppDate(r.appDate) }
        : { enabled: false };
    r.results = await window.monstro.generateReleaseBranches({ version: r.version, sourceBranch: r.sourceBranch, projects, ouicare });
    const ok = r.results.results.filter((x) => x.ok).length;
    const fail = r.results.results.length - ok;
    toast(fail ? t("{ok} creada(s), {fail} con error", { ok, fail }) : t("{ok} release branch(es) creada(s)", { ok }), fail ? "warn" : "ok");
  } catch (err) {
    toast(String(err.message || err), "err");
  } finally {
    r.running = false;
    renderReleases();
  }
}

/* ============ Trabajo local → GitLab (OPE-19) ============ */
// Sección que publica trabajo de ramas/worktrees LOCALES como Issues/Epics + MRs. Dos pestañas
// (buckets en el nav): "crear" (Issue/Epic nuevos) y "vincular" (a una tarea existente). Esta fase
// monta el descubrimiento local (repos bajo el directorio raíz + sus ramas/worktrees/estado); los
// formularios de creación/vinculación llegan en las fases siguientes.
