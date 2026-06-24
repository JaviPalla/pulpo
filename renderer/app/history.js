"use strict";

async function enterHistory() {
  if (state.repo === ALL_REPOS) {
    toast(t("El histórico es por repositorio: elige uno en el selector"), "");
    return;
  }
  state.view = "history";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-history").classList.add("active");
  await loadHistory();
}

function historyBranchSpecs() {
  const enabled = [...state.history.enabled];
  return enabled.map((name) => ({ name, depth: ["main", "master", "develop"].includes(name) ? 80 : 30 }));
}

async function loadHistory() {
  const h = state.history;
  h.loading = true;
  renderHistory();
  try {
    if (!h.branches.length) {
      const def = await window.monstro.defaultBranch(state.repo);
      const candidates = new Set([def, "develop"]);
      for (const pr of state.openPrs.slice(0, 10)) {
        if (!pr.isCrossRepository) candidates.add(pr.headRefName);
        candidates.add(pr.baseRefName);
      }
      h.branches = [...candidates].slice(0, 14);
      h.enabled = new Set([def, "develop"].filter((b) => h.branches.includes(b)));
      if (!h.enabled.size) h.enabled = new Set(h.branches.slice(0, 2));
    }
    const { branches, commits } = await window.monstro.historyGraph(state.repo, historyBranchSpecs());
    h.layout = window.MonstroGraph.computeLayout(commits, branches);
    h.loading = false;
    renderHistory();
  } catch (err) {
    h.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

function renderHistory() {
  if (state.view !== "history") return;
  const h = state.history;
  if (h.loading) {
    list.innerHTML = `<div class="loading">${t("Tejiendo el grafo…")}</div>`;
    return;
  }
  if (!h.layout) return;

  const chips = h.branches
    .map(
      (name) => `<button class="branch-chip ${h.enabled.has(name) ? "on" : ""}" data-branch="${esc(name)}">${esc(name)}</button>`,
    )
    .join("");
  const { svg, width } = window.MonstroGraph.renderSVG(h.layout);
  const rowsHtml = h.layout.rows
    .map((row, i) => {
      const c = row.commit;
      const pr = c.associatedPullRequests?.nodes?.[0];
      const author = c.author?.user?.login || c.author?.name || "?";
      return `
      <div class="graph-row ${h.selectedOid === c.oid ? "selected" : ""}" data-oid="${c.oid}" data-row="${i}">
        ${row.refs.map((r) => `<span class="branch ref-pill">${esc(r)}</span>`).join("")}
        <span class="graph-msg" title="${esc(c.messageHeadline)}">${esc(c.messageHeadline)}</span>
        ${pr ? `<button class="pr-pill" data-pr="${pr.number}" title="${esc(pr.title)}">#${pr.number}</button>` : ""}
        <span class="graph-meta">${esc(author)} · ${timeAgo(c.committedDate)} · <code>${c.abbreviatedOid}</code></span>
      </div>`;
    })
    .join("");

  list.innerHTML = `
    <div class="history-toolbar">
      <div class="branch-chips">${chips}</div>
      <button class="icon-btn" id="history-refresh" title="${t("Recargar grafo")}">⟳</button>
    </div>
    <div class="graph-wrap">
      <div class="graph-svg" style="width:${width}px">${svg}</div>
      <div class="graph-rows">${rowsHtml}</div>
    </div>`;

  list.querySelectorAll(".branch-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const name = chip.dataset.branch;
      if (h.enabled.has(name)) h.enabled.delete(name);
      else h.enabled.add(name);
      if (!h.enabled.size) h.enabled.add(name);
      loadHistory();
    }),
  );
  $("#history-refresh").addEventListener("click", () => loadHistory());
  list.querySelectorAll(".graph-row").forEach((row) =>
    row.addEventListener("click", () => openCommitPanel(row.dataset.oid)),
  );
  list.querySelectorAll(".pr-pill").forEach((pill) =>
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      exitHistoryToPR(Number(pill.dataset.pr));
    }),
  );
  notifySelftestOnce();
}

function exitHistoryToPR(number) {
  state.view = "prs";
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-bucket="open"]').classList.add("active");
  state.bucket = "open";
  refresh().then(() => openDetail(number));
}

function openCommitPanel(oid) {
  const h = state.history;
  h.selectedOid = oid;
  const row = h.layout.rows.find((r) => r.commit.oid === oid);
  if (!row) return;
  const c = row.commit;
  const pr = c.associatedPullRequests?.nodes?.[0];
  renderHistory();
  detailPane.classList.remove("hidden", "wide");
  detailContent.innerHTML = `
    <div class="detail-inner">
      <button class="detail-close" id="detail-close">✕</button>
      <div class="detail-title">${esc(c.messageHeadline)}</div>
      <div class="detail-sub">
        ${row.refs.map((r) => `<span class="branch">${esc(r)}</span>`).join("")}
        ${row.isMerge ? `<span class="chip chip-merged">merge</span>` : ""}
        <code>${c.abbreviatedOid}</code>
      </div>
      <dl class="meta-grid">
        <dt>${t("Autor")}</dt><dd>${esc(c.author?.user?.login || c.author?.name || "?")}</dd>
        <dt>${t("Fecha")}</dt><dd>${new Date(c.committedDate).toLocaleString("es-ES")}</dd>
        <dt>SHA</dt><dd><code>${c.oid}</code></dd>
        ${pr ? `<dt>PR</dt><dd><button class="pr-pill" id="commit-pr">#${pr.number} · ${esc(pr.title)}</button></dd>` : ""}
      </dl>

      <div class="section-h">${t("Acciones")}</div>
      <div class="actions" style="flex-direction:column;align-items:stretch">
        <button class="btn" id="cp-copy">📋 ${t("Copiar SHA")}</button>
        <button class="btn" id="cp-branch">🌱 ${t("Crear rama desde aquí…")}</button>
        <button class="btn" id="cp-reset">⏪ ${t("Mover una rama a este commit…")}</button>
        ${pr && pr.state === "MERGED" ? `<button class="btn btn-danger" id="cp-revert">↩️ ${t("Revertir #{n} ({mode})", { n: pr.number, mode: isGitlab() ? t("commit de revert") : t("crea PR de revert") })}</button>` : ""}
      </div>
      <p class="muted">${t("“Mover una rama” reescribe la punta de la rama (force). Monstro te pedirá confirmación escrita; aún así, úsalo sabiendo lo que haces.")}</p>
    </div>`;

  $("#detail-close").addEventListener("click", () => {
    h.selectedOid = null;
    detailPane.classList.add("hidden");
    renderHistory();
  });
  $("#cp-copy").addEventListener("click", () => copyText(c.oid));
  $("#cp-branch").addEventListener("click", () => createBranchModal(c));
  $("#cp-reset").addEventListener("click", () => resetBranchModal(c));
  $("#commit-pr")?.addEventListener("click", () => exitHistoryToPR(pr.number));
  $("#cp-revert")?.addEventListener("click", () => revertPRModal(pr));
}

function createBranchModal(commit) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>🌱 ${t("Crear rama en")} <code>${commit.abbreviatedOid}</code></h3>
        <input type="text" id="nb-name" placeholder="feature/mi-rama" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-accent" id="modal-confirm">${t("Crear rama")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const name = $("#nb-name").value.trim();
    if (!name) return;
    root.innerHTML = "";
    try {
      await window.monstro.createBranch(state.repo, name, commit.oid);
      toast(t("Rama {name} creada en {sha}", { name, sha: commit.abbreviatedOid }), "ok");
      state.history.branches = [];
      loadHistory();
    } catch (err) {
      toast(`${t("No se pudo crear:")} ${String(err.message || err)}`, "err");
    }
  });
}

function resetBranchModal(commit) {
  const root = $("#modal-root");
  const options = state.history.branches
    .map((b) => `<option value="${esc(b)}">${esc(b)}</option>`)
    .join("");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>⏪ ${t("Mover rama a")} <code>${commit.abbreviatedOid}</code></h3>
        <p class="muted">${t("Esto hace un <b>force update</b> de la referencia: la rama pasará a apuntar a este commit y lo que tenga por delante se pierde de la rama. Las ramas protegidas lo rechazarán.")}</p>
        <select id="rb-branch" class="modal-input" style="width:100%;margin-top:8px">${options}</select>
        <input type="text" id="rb-confirm" placeholder="${t("Escribe el nombre exacto de la rama para confirmar")}" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-danger" id="modal-confirm">${t("Mover rama (force)")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const branch = $("#rb-branch").value;
    const typed = $("#rb-confirm").value.trim();
    if (typed !== branch) return toast(t("El nombre no coincide: no muevo nada"), "err");
    root.innerHTML = "";
    try {
      await window.monstro.forceUpdateBranch(state.repo, branch, commit.oid);
      toast(t("{branch} ahora apunta a {sha}", { branch, sha: commit.abbreviatedOid }), "ok");
      loadHistory();
    } catch (err) {
      toast(`${t("Force update falló:")} ${String(err.message || err)}`, "err");
    }
  });
}

function revertPRModal(pr) {
  const root = $("#modal-root");
  // GitLab no abre MR de revert: crea un commit de revert directo en la rama destino.
  const gitlab = isGitlab();
  const desc = gitlab
    ? t("Crea un <b>commit de revert</b> directo en la rama destino (GitLab no abre una MR de revert).")
    : t("Crea una <b>PR de revert</b> (no toca la rama directamente). La revisas y la fusionas como cualquier otra.");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↩️ ${t("Revertir #{n}", { n: pr.number })}</h3>
        <p>${desc}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-danger" id="modal-confirm">${gitlab ? t("Crear commit de revert") : t("Crear PR de revert")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      const revert = await window.monstro.revertPR(state.repo, pr.number);
      if (revert.number) {
        toast(t("PR de revert creada: #{n}", { n: revert.number }), "ok");
        exitHistoryToPR(revert.number);
      } else {
        toast(t("Commit de revert creado"), "ok");
        if (revert.url) window.monstro.openExternal(revert.url);
      }
    } catch (err) {
      toast(`${t("Revert falló:")} ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ notificaciones (estilo Gitify) ============ */
