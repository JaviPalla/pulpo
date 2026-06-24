"use strict";

function renderChangesTab() {
  const files = state.files;
  if (!files) {
    $("#tab-body").innerHTML = `<div class="loading">${t("Cargando diff…")}</div>`;
    window.monstro.prFiles(detailRepo(), state.detailPR.number).then((loaded) => {
      state.files = loaded;
      if (state.detailTab === "changes") renderChangesTab();
    }).catch((err) => {
      $("#tab-body").innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
      notifySelftestOnce();
    });
    return;
  }

  const { map: anchored, orphans } = threadsByAnchor();
  const statusIcon = { added: "🟢", removed: "🔴", modified: "🟡", renamed: "🔵" };

  // Comentarios (hilos de GitHub) y borradores locales por fichero, para el índice lateral.
  const commentsPerFile = new Map();
  const unresolvedPerFile = new Map();
  for (const thread of state.conversation?.reviewThreads?.nodes || []) {
    const count = thread.comments?.nodes?.length || 0;
    commentsPerFile.set(thread.path, (commentsPerFile.get(thread.path) || 0) + count);
    if (!thread.isResolved) unresolvedPerFile.set(thread.path, (unresolvedPerFile.get(thread.path) || 0) + count);
  }
  const draftsPerFile = new Map();
  for (const draft of state.drafts) {
    if (draft.kind === "inline") draftsPerFile.set(draft.path, (draftsPerFile.get(draft.path) || 0) + 1);
  }

  const navRows = files
    .map((file, fi) => {
      const comments = commentsPerFile.get(file.filename) || 0;
      const unresolved = unresolvedPerFile.get(file.filename) || 0;
      const draftCount = draftsPerFile.get(file.filename) || 0;
      return `
      <button class="file-nav-row" data-target="diff-f${fi}" title="${esc(file.filename)}">
        <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
        <span class="file-nav-name">${esc(file.filename)}</span>
        ${comments ? `<span class="file-nav-badge badge-comments ${unresolved ? "" : "all-resolved"}" title="${unresolved ? t("{n} comentario(s) sin resolver", { n: unresolved }) : t("Todos los hilos resueltos")}">💬 ${comments}</span>` : ""}
        ${draftCount ? `<span class="file-nav-badge badge-drafts" title="${t("{n} borrador(es) local(es)", { n: draftCount })}">📝 ${draftCount}</span>` : ""}
      </button>`;
    })
    .join("");

  $("#tab-body").innerHTML = `
    <div class="changes-layout">
      <nav class="file-nav">
        <div class="file-nav-h">${t("Ficheros")} (${files.length}) ·
          <span class="checks-success">+${files.reduce((s, f) => s + f.additions, 0)}</span>/<span class="checks-failure">−${files.reduce((s, f) => s + f.deletions, 0)}</span>
        </div>
        ${navRows}
      </nav>
      <div class="changes-body">
    ${files
      .map((file, fi) => {
        const orphanThreads = (orphans.get(file.filename) || []).map(threadBlock).join("");
        const comments = commentsPerFile.get(file.filename) || 0;
        return `
        <details class="diff-file" id="diff-f${fi}" ${fi < 6 ? "open" : ""}>
          <summary>
            <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
            <span class="diff-path">${esc(file.previousFilename ? `${file.previousFilename} → ` : "")}${esc(file.filename)}</span>
            ${comments ? `<span class="file-nav-badge badge-comments">💬 ${comments}</span>` : ""}
            <span class="muted"><span class="checks-success">+${file.additions}</span> / <span class="checks-failure">−${file.deletions}</span></span>
          </summary>
          ${file.patch
            ? `<table class="diff-table">${parsePatch(file.patch).map((l) => diffLineRow(file, l, anchored)).join("")}</table>`
            : `<p class="muted" style="padding:10px 14px">${t("Sin diff disponible (binario o demasiado grande).")}</p>`}
          ${orphanThreads ? `<div class="orphan-threads"><div class="section-h">${t("Hilos en versiones anteriores")}</div>${orphanThreads}</div>` : ""}
        </details>`;
      })
      .join("")}
      </div>
    </div>`;

  // índice lateral: saltar al fichero (abriendo su diff)
  $("#tab-body").querySelectorAll(".file-nav-row").forEach((row) =>
    row.addEventListener("click", () => {
      const target = document.getElementById(row.dataset.target);
      if (!target) return;
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#tab-body").querySelectorAll(".file-nav-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    }),
  );

  // comentar en línea
  $("#tab-body").querySelectorAll(".add-comment").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const tr = btn.closest("tr");
      openInlineComposer(tr);
    }),
  );
  // responder hilos
  $("#tab-body").querySelectorAll("[data-reply]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ta = btn.parentElement.querySelector("textarea");
      const body = ta.value.trim();
      if (!body || !btn.dataset.reply) return;
      btn.disabled = true;
      try {
        await window.monstro.replyThread(detailRepo(), state.detailPR.number, Number(btn.dataset.reply), body);
        toast(t("Respuesta publicada"), "ok");
        state.conversation = await window.monstro.prConversation(detailRepo(), state.detailPR.number);
        renderChangesTab();
      } catch (err) {
        toast(t("No se pudo responder: {err}", { err: String(err.message || err) }), "err");
        btn.disabled = false;
      }
    }),
  );
  // resolver / reabrir hilos
  $("#tab-body").querySelectorAll(".thread-resolve").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const resolved = btn.dataset.resolved === "true";
      btn.disabled = true;
      try {
        await window.monstro.resolveThread(btn.dataset.resolveId, resolved);
        toast(resolved ? t("Conversación resuelta ✓") : t("Conversación reabierta"), "ok");
        state.conversation = await window.monstro.prConversation(detailRepo(), state.detailPR.number);
        renderChangesTab();
      } catch (err) {
        toast(t("No se pudo {action}: {err}", { action: resolved ? t("resolver") : t("reabrir"), err: String(err.message || err) }), "err");
        btn.disabled = false;
      }
    }),
  );
  wireExternalLinks();
  wireDraftCards($("#tab-body"));
  notifySelftestOnce();
}

function openInlineComposer(tr) {
  document.querySelectorAll(".inline-composer-row").forEach((row) => row.remove());
  const { path, line, side } = tr.dataset;
  if (!line) return;
  const row = document.createElement("tr");
  row.className = "inline-composer-row";
  row.innerHTML = `
    <td colspan="3">
      <div class="composer inline">
        <div class="muted" style="margin-bottom:6px">📝 ${t("Borrador en")} <code>${esc(path)}</code> ${t("línea")} ${esc(line)} (${side === "LEFT" ? t("versión anterior") : t("versión nueva")}) — ${t("no se publica hasta que tú lo digas")}</div>
        <textarea rows="3" placeholder="${t("Tu comentario…")}"></textarea>
        <div class="composer-actions">
          <button class="btn cancel">${t("Cancelar")}</button>
          <button class="btn btn-accent send">📝 ${t("Guardar borrador")}</button>
        </div>
      </div>
    </td>`;
  tr.after(row);
  row.querySelector("textarea").focus();
  row.querySelector(".cancel").addEventListener("click", () => row.remove());
  row.querySelector(".send").addEventListener("click", async () => {
    const body = row.querySelector("textarea").value.trim();
    if (!body) return;
    await addDraft({ kind: "inline", path, side, line: Number(line), body });
    renderDetail();
  });
}

function wireExternalLinks() {
  detailContent.querySelectorAll(".pr-body a, [data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      const url = a.dataset.ext || a.href;
      if (url?.startsWith("http")) window.monstro.openExternal(url);
    }),
  );
}

/* ============ acciones PR ============ */
