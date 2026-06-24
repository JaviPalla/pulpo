"use strict";

function calverBase(ref) {
  const m = (ref || "").match(/(\d{2})(\d{4})(?:[^\d].*)?$/);
  if (m) return `${m[2]}.${m[1]}`;
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Icono de estado de pipeline (mismo mapeo SUCCESS/FAILURE/ERROR/PENDING que checksIcon del detalle).
function pipelineDot(state) {
  const map = { SUCCESS: ["✓", "ok"], FAILURE: ["✗", "err"], ERROR: ["✗", "err"], PENDING: ["●", "pending"], EXPECTED: ["●", "pending"] };
  const [icon, cls] = map[state] || ["·", "muted"];
  return `<span class="rel-pipe ${cls}" title="${t("Pipeline")}: ${esc(state || "—")}">${icon}</span>`;
}

function renderReleasePublish() {
  if (state.view !== "releases") return;
  const r = state.releases;
  const p = r.publish;
  if (!p.ref) p.ref = `${r.defaults.branchPrefix || "rb/"}${suggestedReleaseVersion()}`;
  // Milestones (títulos) para el desplegable. Carga perezosa: solo al entrar en esta pestaña.
  if (p.milestonesList === null && !p.milestonesLoading) {
    p.milestonesLoading = true;
    window.monstro
      .listMilestones()
      .then((ms) => {
        p.milestonesList = ms || [];
      })
      .catch(() => {
        p.milestonesList = [];
      })
      .finally(() => {
        p.milestonesLoading = false;
        renderReleasePublish();
      });
  }

  const projects = r.projects || [];
  const chipsHtml = projects
    .map((proj) => {
      const off = !r.selected.has(proj.path);
      return `<button class="ms-proj-chip ${off ? "off" : ""}" data-path="${esc(proj.path)}" ${p.running ? "disabled" : ""}
        title="${off ? t("Excluido · clic para incluir") : t("Incluido · clic para excluir")}">
        ${projectIconHtml(proj.path)}<span class="ms-proj-name">${esc(proj.name)}</span>
      </button>`;
    })
    .join("");
  const selCount = projects.filter((proj) => r.selected.has(proj.path)).length;
  const allOn = selCount === projects.length && projects.length > 0;
  const refValid = Boolean(p.ref) && BRANCH_RE.test(p.ref);
  const base = calverBase(p.ref);
  const canRun = refValid && selCount > 0 && !p.running;

  const msOptions = [`<option value="">${t("Sin milestone")}</option>`]
    .concat((p.milestonesList || []).map((m) => `<option value="${esc(m.title)}" ${p.milestone === m.title ? "selected" : ""}>${esc(m.title)}</option>`))
    .join("");

  // Resultados + panel de estado por proyecto (pipeline + entornos).
  let resultsHtml = "";
  if (p.results) {
    const ok = p.results.results.filter((x) => x.ok).length;
    const fail = p.results.results.length - ok;
    const cls = fail ? (ok ? "warn" : "err") : "ok";
    const rowsHtml = p.results.results
      .map((res) => {
        if (!res.ok) return `<div class="rel-res-row err" title="${esc(res.error || "")}">✕ ${esc(res.name)}: ${esc(res.error || t("error"))}</div>`;
        const st = p.status.get(res.id);
        const pipe = st?.pipeline ? pipelineDot(st.pipeline.state) : `<span class="rel-pipe muted" title="${t("Sin pipeline")}">·</span>`;
        const envs = (st?.environments || [])
          .map((e) => `<span class="rel-env ${e.state === "available" ? "up" : ""}">${esc(e.name)}</span>`)
          .join("");
        const link = st?.pipeline?.webUrl || res.releaseUrl;
        return `<div class="rel-res-row ok">
          ${pipe} ✓ ${esc(res.name)} <code>${esc(res.tag)}</code>
          ${link ? `<a data-url="${esc(link)}" href="#">${t("ver")}</a>` : ""}
          ${envs ? `<span class="rel-envs">${envs}</span>` : ""}
        </div>`;
      })
      .join("");
    resultsHtml = `
      <div class="rel-summary ${cls}">Release <code>${esc(p.results.base)}.x</code> ${t("desde")} <code>${esc(p.results.ref)}</code> · ${ok === 1 ? t("{n} publicada", { n: ok }) : t("{n} publicadas", { n: ok })}${fail ? ` · ${t("{n} con error", { n: fail })}` : ""}</div>
      <div class="rel-results">${rowsHtml}</div>`;
  }

  list.innerHTML = `
    <div class="rel-view">
      <header class="rel-head">
        <h2>${t("Publicar release")}</h2>
        <p class="rel-sub">${t("Crea el <b>tag + release</b> (en un solo paso) en los proyectos seleccionados, desde una rama <code>rb/…</code>. El tag es CalVer <code>AAAA.MM.patch</code>; el patch se autoincrementa por proyecto.")}</p>
      </header>

      <div class="rel-form">
        <label class="rel-field">
          <span class="rel-label">${t("Rama de release")}</span>
          <input type="text" id="rel-pub-ref" value="${esc(p.ref)}" placeholder="rb/${esc(suggestedReleaseVersion())}" ${p.running ? "disabled" : ""} autocomplete="off" />
        </label>
        <label class="rel-field">
          <span class="rel-label">${t("Milestone (opcional)")}</span>
          <select id="rel-pub-milestone" class="modal-input" ${p.running || p.milestonesLoading ? "disabled" : ""}>${msOptions}</select>
        </label>
        <div class="rel-preview-box">
          <span class="rel-label">${t("Tag a crear")}</span>
          <code class="rel-branch-preview ${refValid ? "" : "invalid"}" id="rel-pub-preview">${esc(base)}.x</code>
        </div>
      </div>

      <label class="rel-field rel-field-full">
        <span class="rel-label">${t("Descripción (opcional)")}</span>
        <textarea id="rel-pub-desc" class="modal-input" rows="3" ${p.running ? "disabled" : ""} placeholder="${t("Notas de la release (Markdown). Vale para todos los proyectos.")}">${esc(p.description)}</textarea>
      </label>

      <div class="rel-projects-head">
        <span>${t("Proyectos")} <span class="rel-count" id="rel-pub-count">${selCount}/${projects.length}</span></span>
        <button class="btn ghost" id="rel-pub-toggle-all" ${p.running ? "disabled" : ""}>${allOn ? t("Ninguno") : t("Todos")}</button>
      </div>
      <div class="rel-projects ms-proj-filter">${chipsHtml || `<span class="muted">${t("No se han podido cargar los proyectos del grupo.")}</span>`}</div>

      ${resultsHtml}

      <div class="rel-actions">
        <button class="btn btn-primary" id="rel-publish" ${canRun ? "" : "disabled"}>${p.running ? t("Publicando…") : t("Publicar release")}</button>
      </div>
    </div>`;

  const refInput = $("#rel-pub-ref");
  const preview = $("#rel-pub-preview");
  const pubBtn = $("#rel-publish");
  const sync = () => {
    const valid = Boolean(p.ref) && BRANCH_RE.test(p.ref);
    const sel = projects.filter((proj) => r.selected.has(proj.path)).length;
    preview.textContent = `${calverBase(p.ref)}.x`;
    preview.classList.toggle("invalid", !valid);
    $("#rel-pub-count").textContent = `${sel}/${projects.length}`;
    pubBtn.disabled = !(valid && sel > 0 && !p.running);
  };
  refInput?.addEventListener("input", () => {
    p.ref = refInput.value.trim();
    sync();
  });
  $("#rel-pub-milestone")?.addEventListener("change", (event) => {
    p.milestone = event.target.value;
  });
  $("#rel-pub-desc")?.addEventListener("input", (event) => {
    p.description = event.target.value;
  });
  list.querySelectorAll(".ms-proj-chip[data-path]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const path = chip.dataset.path;
      if (r.selected.has(path)) r.selected.delete(path);
      else r.selected.add(path);
      saveReleaseSelection();
      sync();
      chip.classList.toggle("off");
    }),
  );
  $("#rel-pub-toggle-all")?.addEventListener("click", () => {
    if (allOn) r.selected.clear();
    else for (const proj of projects) r.selected.add(proj.path);
    saveReleaseSelection();
    renderReleasePublish();
  });
  list.querySelectorAll(".rel-results a[data-url]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (a.dataset.url) window.monstro.openExternal(a.dataset.url);
    }),
  );
  $("#rel-publish")?.addEventListener("click", confirmAndPublishReleases);
  notifySelftestOnce();
}

// Confirmación antes de publicar (escritura sobre N proyectos, no atómica): mostramos tag base,
// rama origen, milestone y la lista de destinos. Nunca dispara sin confirmar.
function confirmAndPublishReleases() {
  const r = state.releases;
  const p = r.publish;
  if (!(p.ref && BRANCH_RE.test(p.ref))) return;
  const targets = r.projects.filter((proj) => r.selected.has(proj.path));
  if (!targets.length) return;
  const base = calverBase(p.ref);
  const msNote = p.milestone ? `<div class="rel-confirm-note">🏷️ ${t("Milestone")}: <b>${esc(p.milestone)}</b></div>` : "";
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("Publicar")} <code>${esc(base)}.x</code> ${targets.length === 1 ? t("en {n} proyecto", { n: targets.length }) : t("en {n} proyectos", { n: targets.length })}</h3>
        <p class="muted">${t("Tag + release desde")} <code>${esc(p.ref)}</code>. ${t("El patch (<code>.0</code>, <code>.1</code>…) se calcula por proyecto. No atómico: si alguno falla, el resto sí se publica.")}</p>
        <ul class="rel-confirm-list">${targets.map((proj) => `<li>${esc(proj.name)} <span class="muted">${esc(proj.path)}</span></li>`).join("")}</ul>
        ${msNote ? `<div class="rel-confirm-notes">${msNote}</div>` : ""}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Publicar")}</button>
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
    runReleasePublish();
  });
}

async function runReleasePublish() {
  const r = state.releases;
  const p = r.publish;
  p.running = true;
  p.results = null;
  p.status = new Map();
  if (p.poll) {
    clearInterval(p.poll);
    p.poll = null;
  }
  renderReleasePublish();
  try {
    const projects = r.projects.filter((proj) => r.selected.has(proj.path)).map((proj) => ({ id: proj.path, name: proj.name }));
    p.results = await window.monstro.createReleases({
      projects,
      ref: p.ref,
      base: calverBase(p.ref),
      milestones: p.milestone ? [p.milestone] : [],
      description: p.description,
      name: "{tag}",
    });
    const ok = p.results.results.filter((x) => x.ok).length;
    const fail = p.results.results.length - ok;
    toast(fail ? t("{ok} publicada(s), {fail} con error", { ok, fail }) : t("{ok} release(s) publicada(s)", { ok }), fail ? "warn" : "ok");
    startReleaseStatusPoll();
  } catch (err) {
    toast(String(err.message || err), "err");
  } finally {
    p.running = false;
    renderReleasePublish();
  }
}

// Sondea el estado (pipeline + entornos) de cada release publicada. Notifica (toast + SO) UNA vez
// cuando una pipeline transiciona a FAILURE/ERROR — patrón de detectAndNotify (solo en el cambio).
function startReleaseStatusPoll() {
  const r = state.releases;
  const p = r.publish;
  const ok = (p.results?.results || []).filter((x) => x.ok);
  if (!ok.length || IS_SELFTEST) return;
  const TERMINAL = ["SUCCESS", "FAILURE", "ERROR"];
  let ticks = 0;
  const stop = () => {
    if (p.poll) clearInterval(p.poll);
    p.poll = null;
  };
  const tick = async () => {
    ticks++;
    for (const res of ok) {
      const before = p.status.get(res.id)?.pipeline?.state || null;
      const st = await window.monstro.releaseStatus(res.id, res.tag).catch(() => null);
      if (!st) continue;
      p.status.set(res.id, st);
      const now = st.pipeline?.state || null;
      if (["FAILURE", "ERROR"].includes(now) && !["FAILURE", "ERROR"].includes(before)) {
        toast(`${t("Pipeline en rojo")} · ${res.name} ${res.tag}`, "err");
        window.monstro.notify(t("Pipeline de release falló"), `${res.name} · ${res.tag}`);
      }
    }
    if (state.view === "releases" && r.tab === "publish") renderReleasePublish();
    // Para cuando todas las pipelines llegan a estado terminal, o tras ~5 min (evita sondear sin fin
    // si un proyecto no tiene CI en tags y su pipeline nunca aparece).
    const allDone = ok.every((res) => TERMINAL.includes(p.status.get(res.id)?.pipeline?.state));
    if (allDone || ticks >= 20) stop();
  };
  stop();
  tick();
  p.poll = setInterval(tick, Math.max(15, state.config?.pollSeconds || 60) * 1000);
}

/* ============ arranque ============ */
