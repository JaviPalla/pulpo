"use strict";

function draftsKey() {
  return `${detailRepo()}#${state.selected}`;
}

async function saveDrafts() {
  state.drafts = await window.monstro.draftsSave(draftsKey(), state.drafts);
  state.draftKeys = new Set(await window.monstro.draftsKeys());
}

async function addDraft(draft) {
  const id = globalThis.crypto?.randomUUID?.() || `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.drafts.push({ id, createdAt: new Date().toISOString(), ...draft });
  await saveDrafts();
  toast(t("Borrador guardado (solo en tu Mac)"), "ok");
}

async function removeDraft(id) {
  state.drafts = state.drafts.filter((d) => d.id !== id);
  await saveDrafts();
}

function draftCard(draft) {
  const where = draft.kind === "inline"
    ? `<code>${esc(draft.path)}</code> · ${t("línea {line} ({side})", { line: draft.line, side: draft.side === "LEFT" ? t("anterior") : t("nueva") })}`
    : t("comentario general");
  if (state.editingDraftId === draft.id) {
    return `
      <div class="draft-card ${draft.ai ? "ai" : ""} editing" data-draft="${draft.id}">
        <div class="draft-head">✏️ ${t("EDITANDO")} <span class="muted">· ${where}</span></div>
        <textarea class="draft-editor" rows="5">${esc(draft.body)}</textarea>
        <div class="composer-actions">
          <button class="btn draft-edit-cancel">${t("Cancelar")}</button>
          <button class="btn btn-accent draft-edit-save">${t("Guardar")}</button>
        </div>
      </div>`;
  }
  const aiMeta = draft.ai && draft.aiModel
    ? ` · ${esc(draft.aiModel)}${draft.aiEffort ? ` · ${t("esfuerzo")} ${esc(draft.aiEffort)}` : ""}`
    : "";
  return `
    <div class="draft-card ${draft.ai ? "ai" : ""}" data-draft="${draft.id}">
      <div class="draft-head">${draft.ai ? `🤖 ${t("BORRADOR (IA)")}` : `📝 ${t("BORRADOR")}`} <span class="muted">· ${where}${aiMeta}</span>
        <button class="draft-edit" title="${t("Editar borrador")}">✏️</button>
        <button class="draft-pub" title="${t("Publicar solo este borrador en GitHub")}">↗ ${t("Publicar")}</button>
        <button class="draft-del" title="${t("Eliminar borrador")}">🗑</button>
      </div>
      <div class="draft-body">${esc(draft.body)}</div>
    </div>`;
}

/* ============ review con IA ============ */
async function generateAiReview(pr) {
  if (state.aiGenerating) return;
  state.aiGenerating = pr.number;
  renderDetail(); // pinta el botón en loading; persiste aunque cambies de pestaña
  toast(t("Generando review con IA… esto puede tardar un par de minutos"), "");
  const repoKey = `${detailRepo()}#${pr.number}`;
  try {
    const files = state.selected === pr.number && state.files
      ? state.files
      : await window.monstro.prFiles(repoKey.split("#")[0], pr.number);
    if (state.selected === pr.number) state.files = files;
    const { review, backend, model, effort } = await window.monstro.aiReview(pr.title, pr.body || "", files);

    const anchors = new Set();
    for (const file of files) {
      if (!file.patch) continue;
      for (const line of parsePatch(file.patch)) {
        if (line.type === "add" || line.type === "ctx") anchors.add(`${file.filename}::RIGHT::${line.new}`);
        if (line.type === "del" || line.type === "ctx") anchors.add(`${file.filename}::LEFT::${line.old}`);
      }
    }
    const newDrafts = [];
    const orphaned = [];
    for (const comment of review.comments) {
      if (anchors.has(`${comment.path}::${comment.side}::${comment.line}`)) {
        newDrafts.push({
          id: `ai-${Date.now()}-${newDrafts.length}`,
          createdAt: new Date().toISOString(),
          kind: "inline",
          ai: true,
          aiModel: model,
          aiEffort: effort || null,
          path: comment.path,
          side: comment.side,
          line: comment.line,
          body: comment.body,
        });
      } else {
        orphaned.push(comment);
      }
    }
    const summaryParts = [];
    if (review.summary) summaryParts.push(review.summary);
    if (orphaned.length) {
      summaryParts.push(
        "Comments that could not be anchored to a diff line:\n" +
          orphaned.map((c) => `- **${c.path}:${c.line}** — ${c.body}`).join("\n"),
      );
    }
    if (summaryParts.length) {
      newDrafts.push({
        id: `ai-${Date.now()}-summary`,
        createdAt: new Date().toISOString(),
        kind: "general",
        ai: true,
        aiModel: model,
        aiEffort: effort || null,
        body: summaryParts.join("\n\n---\n\n"),
      });
    }

    // Guarda en la PR que pidió la review, aunque ya estés mirando otra.
    if (state.selected === pr.number) {
      state.drafts.push(...newDrafts);
      await saveDrafts();
      state.detailTab = "changes";
    } else {
      const existing = await window.monstro.draftsList(repoKey);
      await window.monstro.draftsSave(repoKey, [...existing, ...newDrafts]);
      state.draftKeys = new Set(await window.monstro.draftsKeys());
      renderList();
    }
    toast(`${t("IA")} (${backend} · ${model}${effort ? ` · ${effort}` : ""}): ${t("{n} comentario(s) en línea + resumen, en borradores de #{num}", { n: newDrafts.length - (summaryParts.length ? 1 : 0), num: pr.number })}`, "ok");
  } catch (err) {
    toast(t("Review con IA falló: {err}", { err: String(err.message || err) }), "err");
  } finally {
    state.aiGenerating = null;
    // re-render solo si sigues mirando esa PR (puede haber cambiado mientras generaba)
    if (state.selected === pr.number && state.detailPR) renderDetail();
  }
}

function wireDraftCards(container) {
  container.querySelectorAll(".draft-card .draft-del").forEach((btn) =>
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await removeDraft(btn.closest(".draft-card").dataset.draft);
      renderDetail();
    }),
  );
  container.querySelectorAll(".draft-card .draft-pub").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const draft = state.drafts.find((d) => d.id === btn.closest(".draft-card").dataset.draft);
      if (draft) confirmPublishSingle(draft);
    }),
  );
  container.querySelectorAll(".draft-card .draft-edit").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingDraftId = btn.closest(".draft-card").dataset.draft;
      renderDetail();
      detailContent.querySelector(".draft-editor")?.focus();
    }),
  );
  container.querySelectorAll(".draft-card.editing").forEach((card) => {
    const id = card.dataset.draft;
    card.querySelector(".draft-edit-cancel").addEventListener("click", () => {
      state.editingDraftId = null;
      renderDetail();
    });
    card.querySelector(".draft-edit-save").addEventListener("click", async () => {
      const body = card.querySelector(".draft-editor").value.trim();
      const draft = state.drafts.find((d) => d.id === id);
      if (draft && body) {
        draft.body = body;
        await saveDrafts();
        toast(t("Borrador actualizado"), "ok");
      }
      state.editingDraftId = null;
      renderDetail();
    });
  });
}

function confirmPublishSingle(draft) {
  const root = $("#modal-root");
  const where = draft.kind === "inline" ? `${draft.path}:${draft.line}` : t("comentario general");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↗ ${t("Publicar este borrador")}</h3>
        <p class="muted">${esc(where)} — ${t("se publica como comentario (sin veredicto). El resto de borradores no se tocan.")}</p>
        <div class="draft-card ${draft.ai ? "ai" : ""}" style="max-height:180px;overflow-y:auto"><div class="draft-body">${esc(draft.body)}</div></div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Publicar en GitHub")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      state.conversation = await window.monstro.prConversation(detailRepo(), state.selected);
      await window.monstro.submitReview(detailRepo(), state.selected, {
        commitId: state.conversation.headRefOid,
        event: "COMMENT",
        body: draft.kind === "general" ? draft.body : undefined,
        comments: draft.kind === "inline" ? [draft] : [],
      });
      await removeDraft(draft.id);
      toast(t("Borrador publicado ✓"), "ok");
      state.conversation = await window.monstro.prConversation(detailRepo(), state.selected);
      renderDetail();
    } catch (err) {
      toast(t("No se pudo publicar (el borrador sigue guardado): {err}", { err: String(err.message || err) }), "err");
    }
  });
}

function draftsBar() {
  if (!state.drafts.length) return "";
  return `
    <div class="drafts-bar">
      <button class="drafts-count" id="drafts-view" title="${t("Ver todos los borradores")}">📝 <b>${state.drafts.length}</b> ${state.drafts.length > 1 ? t("borradores sin publicar") : t("borrador sin publicar")}</button>
      <button class="icon-btn" id="drafts-prev" title="${t("Borrador anterior")}">↑</button>
      <button class="icon-btn" id="drafts-next" title="${t("Borrador siguiente")}">↓</button>
      <span style="flex:1"></span>
      <button class="btn" id="drafts-discard">${t("Descartar todos")}</button>
      <button class="btn btn-primary" id="drafts-publish">${t("Publicar…")}</button>
    </div>`;
}

function wireDraftsBar() {
  $("#drafts-publish")?.addEventListener("click", openPublishModal);
  $("#drafts-view")?.addEventListener("click", openDraftsViewer);
  $("#drafts-prev")?.addEventListener("click", () => navigateDrafts(-1));
  $("#drafts-next")?.addEventListener("click", () => navigateDrafts(1));
  $("#drafts-discard")?.addEventListener("click", async () => {
    state.drafts = [];
    await saveDrafts();
    toast(t("Borradores descartados"), "");
    renderDetail();
  });
}

/* ============ navegación y visor de borradores ============ */
function orderedDrafts() {
  const fileOrder = new Map((state.files || []).map((f, i) => [f.filename, i]));
  return [...state.drafts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "inline" ? -1 : 1;
    if (a.kind === "inline") {
      const byFile = (fileOrder.get(a.path) ?? 999) - (fileOrder.get(b.path) ?? 999);
      if (byFile) return byFile;
      return (a.line || 0) - (b.line || 0);
    }
    return 0;
  });
}

async function scrollToDraft(id) {
  const draft = state.drafts.find((d) => d.id === id);
  if (!draft) return;
  const wantedTab = draft.kind === "inline" ? "changes" : "conv";
  if (state.detailTab !== wantedTab) {
    state.detailTab = wantedTab;
    renderDetail();
  }
  // el tab de cambios puede estar cargando el diff: reintenta hasta encontrar la tarjeta
  for (let attempt = 0; attempt < 25; attempt++) {
    const node = detailContent.querySelector(`[data-draft="${CSS.escape(id)}"]`);
    if (node) {
      const fold = node.closest("details");
      if (fold && !fold.open) fold.open = true;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1600);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function navigateDrafts(direction) {
  const drafts = orderedDrafts();
  if (!drafts.length) return;
  state.draftNavIndex = (state.draftNavIndex + direction + drafts.length) % drafts.length;
  const target = drafts[state.draftNavIndex];
  toast(t("Borrador {pos} de {total}", { pos: state.draftNavIndex + 1, total: drafts.length }), "");
  scrollToDraft(target.id);
}

function openDraftsViewer() {
  const root = $("#modal-root");
  const drafts = orderedDrafts();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>📝 ${t("Borradores de #{num} ({count})", { num: state.selected, count: drafts.length })}</h3>
        <div class="drafts-viewer">
          ${drafts.map((d) => `
            <div class="viewer-row" data-id="${d.id}">
              <div class="viewer-where">${d.ai ? "🤖" : "📝"} ${d.kind === "inline"
                ? `<code>${esc(d.path)}</code>:${d.line} <span class="muted">(${d.side === "LEFT" ? t("anterior") : t("nueva")})</span>`
                : `<span class="muted">${t("comentario general")}</span>`}</div>
              <div class="viewer-body">${esc(d.body.length > 220 ? `${d.body.slice(0, 220)}…` : d.body)}</div>
              <div class="viewer-actions">
                <button class="btn viewer-go" data-id="${d.id}">${t("Ir ↗")}</button>
                <button class="btn viewer-edit" data-id="${d.id}" title="${t("Editar borrador")}">✏️</button>
                <button class="btn viewer-pub" data-id="${d.id}" title="${t("Publicar solo este borrador")}">${t("Publicar")}</button>
                <button class="btn viewer-del" data-id="${d.id}">🗑</button>
              </div>
            </div>`).join("")}
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cerrar")}</button>
          <button class="btn" id="viewer-discard">${t("Descartar todos")}</button>
          <button class="btn btn-primary" id="viewer-publish">${t("Publicar…")}</button>
        </div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#viewer-publish").addEventListener("click", () => {
    close();
    openPublishModal();
  });
  $("#viewer-discard").addEventListener("click", async () => {
    close();
    state.drafts = [];
    await saveDrafts();
    toast(t("Borradores descartados"), "");
    renderDetail();
  });
  root.querySelectorAll(".viewer-go").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      scrollToDraft(btn.dataset.id);
    }),
  );
  root.querySelectorAll(".viewer-pub").forEach((btn) =>
    btn.addEventListener("click", () => {
      const draft = state.drafts.find((d) => d.id === btn.dataset.id);
      close();
      if (draft) confirmPublishSingle(draft);
    }),
  );
  root.querySelectorAll(".viewer-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      state.editingDraftId = btn.dataset.id;
      scrollToDraft(btn.dataset.id);
    }),
  );
  root.querySelectorAll(".viewer-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await removeDraft(btn.dataset.id);
      renderDetail();
      if (state.drafts.length) openDraftsViewer();
      else close();
    }),
  );
}

function openPublishModal() {
  const root = $("#modal-root");
  const inline = state.drafts.filter((d) => d.kind === "inline");
  const general = state.drafts.filter((d) => d.kind === "general");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${state.drafts.length > 1 ? t("Publicar {n} borradores como review", { n: state.drafts.length }) : t("Publicar {n} borrador como review", { n: state.drafts.length })}</h3>
        <p class="muted">${t("{inline} en línea · {general}", { inline: inline.length, general: general.length === 1 ? t("{n} general", { n: general.length }) : t("{n} generales", { n: general.length }) })} — ${t("se publican en una sola review.")}</p>
        <div class="verdict">
          <label><input type="radio" name="verdict" value="COMMENT" checked /> 💬 ${t("Comentar")}</label>
          <label><input type="radio" name="verdict" value="APPROVE" /> ✅ ${t("Aprobar")}</label>
          <label><input type="radio" name="verdict" value="REQUEST_CHANGES" /> ± ${t("Pedir cambios")}</label>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Publicar en GitHub")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const event = root.querySelector('input[name="verdict"]:checked').value;
    root.innerHTML = "";
    await publishDrafts(event);
  });
}

async function publishDrafts(event) {
  const pr = state.detailPR;
  try {
    // headRefOid fresco: si la rama avanzó, los comentarios se anclan al último commit
    state.conversation = await window.monstro.prConversation(detailRepo(), pr.number);
    const inline = state.drafts.filter((d) => d.kind === "inline");
    const general = state.drafts.filter((d) => d.kind === "general");
    await window.monstro.submitReview(detailRepo(), pr.number, {
      commitId: state.conversation.headRefOid,
      event,
      body: general.map((d) => d.body).join("\n\n---\n\n") || undefined,
      comments: inline,
    });
    state.drafts = [];
    await saveDrafts();
    toast(t("Review publicada ({verdict})", { verdict: event === "APPROVE" ? t("aprobada ✅") : event === "REQUEST_CHANGES" ? t("cambios pedidos") : t("comentarios") }), "ok");
    state.conversation = await window.monstro.prConversation(detailRepo(), pr.number);
    renderDetail();
  } catch (err) {
    toast(t("No se pudo publicar (tus borradores siguen guardados): {err}", { err: String(err.message || err) }), "err");
  }
}

/* ============ chips ============ */
