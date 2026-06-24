"use strict";

async function openDetail(number, tab = "conv", repoOverride = null) {
  state.selected = number;
  state.detailRepo = repoOverride && repoOverride !== ALL_REPOS ? repoOverride : state.repo;
  state.detailTab = tab;
  state.files = null;
  state.conversation = null;
  renderList();
  detailPane.classList.remove("hidden");
  detailPane.classList.toggle("wide", tab === "changes");
  detailContent.innerHTML = `<div class="detail-inner"><div class="loading">${t("Cargando #{n}…", { n: number })}</div></div>`;
  try {
    const [pr, conversation, drafts] = await Promise.all([
      window.monstro.prDetail(detailRepo(), number),
      window.monstro.prConversation(detailRepo(), number),
      window.monstro.draftsList(`${detailRepo()}#${number}`),
    ]);
    state.detailPR = pr;
    state.conversation = conversation;
    state.drafts = drafts;
    // seed visual para capturas de selftest: no se persiste
    if (IS_SELFTEST && new URLSearchParams(location.search).get("seed_draft") === "1" && !state.drafts.length) {
      state.drafts.push({ id: "seed", kind: "general", body: "Esto es un borrador local: no está en GitHub.", createdAt: new Date().toISOString() });
      state.drafts.push({ id: "seed-ai", kind: "general", ai: true, aiModel: "claude-opus-4-8", aiEffort: "high", body: "AI draft seeded for screenshots.", createdAt: new Date().toISOString() });
    }
  } catch (err) {
    detailContent.innerHTML = `<div class="detail-inner"><div class="error-box">${esc(String(err.message || err))}</div></div>`;
    notifySelftestOnce();
    return;
  }
  renderDetail();
}

function renderDetail() {
  const pr = state.detailPR;
  if (!pr) return;
  const blockReason = mergeBlockReason(pr);
  const threadCount = state.conversation?.reviewThreads?.nodes?.length ?? 0;
  detailPane.classList.toggle("wide", state.detailTab === "changes");

  detailContent.innerHTML = `
    <div class="detail-inner ${state.detailTab === "changes" ? "detail-full" : ""}">
      <button class="detail-close" id="detail-close" title="${t("Cerrar (Esc)")}">✕</button>
      <div class="detail-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></div>
      <div class="detail-sub">
        ${stateChip(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)}
        <span class="branches">
          <span class="branch">${esc(pr.headRefName)}</span><span class="arrow">→</span><span class="branch">${esc(pr.baseRefName)}</span>
        </span>
      </div>

      <div class="actions">
        <button class="btn btn-accent" id="act-update" ${pr.state !== "OPEN" ? "disabled" : ""}
                title="${t("Actualiza la rama con la base usando rebase")}">⤴ ${t("Update branch (rebase)")}</button>
        <button class="btn btn-primary" id="act-merge" ${canMerge(pr) ? "" : "disabled"}
                title="${esc(blockReason || t("Merge con merge commit"))}">⇅ ${t("Merge (merge commit)")}</button>
        ${state.aiGenerating === pr.number
          ? `<button class="btn btn-ai" id="act-ai" disabled><span class="spinner"></span> ${t("Generando review…")}</button>`
          : `<button class="btn btn-ai" id="act-ai" ${pr.state === "OPEN" ? "" : "disabled"}
                title="${t("Genera comentarios de review (en inglés) como borradores: nada se publica hasta que tú lo digas")}">🤖 ${t("Review con IA")}</button>`}
        ${myApprovedReview(pr) && pr.state === "OPEN"
          ? `<button class="btn" id="act-unapprove"
                title="${t("Descarta tu review aprobada (GitHub lo registra en la PR con el motivo)")}">↩︎ ${t("Quitar aprobación")}</button>`
          : `<button class="btn" id="act-approve" ${pr.state === "OPEN" && pr.author?.login !== state.me?.login ? "" : "disabled"}
                title="${pr.author?.login === state.me?.login ? t("No puedes aprobar tu propia PR") : t("Aprobar sin comentarios (pide confirmación)")}">✅ ${t("Aprobar")}</button>`}
        ${pr.state === "OPEN" && pr.author?.login === state.me?.login
          ? `<button class="btn" id="act-draft-toggle" title="${pr.isDraft ? t("Marca la PR como lista: notifica a los reviewers") : t("Convierte la PR en borrador: deja de pedir reviews")}">${pr.isDraft ? `🚀 ${t("Marcar lista para review")}` : `↩︎ ${t("Convertir a borrador")}`}</button>`
          : ""}
      </div>
      <div class="copy-row">
        <button class="mini-btn" id="copy-branch" title="${t("Copiar nombre de la rama")}">📋 ${esc(pr.headRefName)}</button>
        <button class="mini-btn" id="copy-checkout" title="${t("Copiar comando para traerte la PR en local")}">⬇ gh pr checkout ${pr.number}</button>
        <button class="mini-btn" id="copy-url" title="${t("Copiar URL de la PR")}">🔗 URL</button>
      </div>
      ${blockReason && pr.state === "OPEN" ? `<p class="muted">⚠️ ${esc(blockReason)}</p>` : ""}

      <div class="tabs">
        <button class="tab ${state.detailTab === "conv" ? "active" : ""}" data-tab="conv">
          ${t("Conversación")} <span class="count">${pr.comments?.totalCount ?? 0}</span>
        </button>
        <button class="tab ${state.detailTab === "changes" ? "active" : ""}" data-tab="changes">
          ${t("Cambios")} <span class="count">${t("{n} ficheros", { n: pr.changedFiles })} · ${t("{n} hilos", { n: threadCount })}${state.drafts.filter((d) => d.kind === "inline").length ? ` · 📝 ${state.drafts.filter((d) => d.kind === "inline").length}` : ""}</span>
        </button>
      </div>

      <div id="tab-body"></div>
      ${draftsBar()}
    </div>`;

  $("#detail-close").addEventListener("click", closeDetail);
  $("#act-update").addEventListener("click", () => updateBranch(pr));
  $("#act-merge").addEventListener("click", () => confirmMerge(pr));
  $("#act-ai").addEventListener("click", () => generateAiReview(pr));
  $("#act-approve")?.addEventListener("click", () => confirmApprove(pr));
  $("#act-unapprove")?.addEventListener("click", () => confirmUnapprove(pr));
  $("#act-draft-toggle")?.addEventListener("click", async () => {
    const btn = $("#act-draft-toggle");
    btn.disabled = true;
    try {
      const result = await window.monstro.setPrDraft(pr.id, !pr.isDraft);
      toast(result.isDraft ? t("#{n} convertida a borrador", { n: pr.number }) : t("#{n} lista para review 🚀", { n: pr.number }), "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(t("No se pudo cambiar el estado: {e}", { e: String(err.message || err) }), "err");
      btn.disabled = false;
    }
  });
  $("#copy-branch").addEventListener("click", () => copyText(pr.headRefName));
  $("#copy-checkout").addEventListener("click", () => copyText(`gh pr checkout ${pr.number}`));
  $("#copy-url").addEventListener("click", () => copyText(pr.url));
  wireDraftsBar();
  detailContent.querySelectorAll(".tab").forEach((tabBtn) =>
    tabBtn.addEventListener("click", () => {
      state.detailTab = tabBtn.dataset.tab;
      renderDetail();
    }),
  );

  if (state.detailTab === "conv") renderConversationTab();
  else renderChangesTab();
}

function closeDetail() {
  state.selected = null;
  state.detailPR = null;
  detailPane.classList.add("hidden");
  detailPane.classList.remove("wide");
  renderList();
}

/* ============ tab conversación ============ */
function commentBlock(comment) {
  return `
    <div class="comment">
      <div class="comment-head">
        <img src="${esc(comment.author?.avatarUrl || "")}" alt="" />
        <b>${esc(comment.author?.login || "?")}</b>
        <span class="muted">${timeAgo(comment.createdAt)}</span>
      </div>
      <div class="comment-body pr-body">${comment.bodyHTML || ""}</div>
    </div>`;
}

function renderConversationTab() {
  const pr = state.detailPR;
  const conv = state.conversation;
  const comments = conv?.comments?.nodes || [];
  const generalDrafts = state.drafts.filter((d) => d.kind === "general");
  const inlineDraftCount = state.drafts.length - generalDrafts.length;
  const longDescription = (pr.bodyHTML || "").length > 1500;
  $("#tab-body").innerHTML = `
    ${generalDrafts.length || inlineDraftCount
      ? `<div class="section-h">${t("Tus borradores ({n})", { n: state.drafts.length })}</div>
         ${generalDrafts.map(draftCard).join("")}
         ${inlineDraftCount ? `<p class="muted">${t("…y {n} en línea en la pestaña", { n: inlineDraftCount })} <a href="#" id="goto-changes">${t("Cambios")}</a>.</p>` : ""}`
      : ""}
    <div class="section-h">${t("Comentarios ({n})", { n: comments.length })}</div>
    ${comments.map(commentBlock).join("") || `<p class="muted">${t("Nadie ha dicho nada todavía.")}</p>`}
    <div class="composer">
      <textarea id="new-comment" rows="3" placeholder="${t("Escribe un comentario… se guarda como borrador hasta que publiques")}"></textarea>
      <div class="composer-actions">
        <button class="btn btn-accent" id="send-comment">📝 ${t("Guardar borrador")}</button>
      </div>
    </div>
    <details class="desc-fold" ${longDescription ? "" : "open"}>
      <summary class="section-h">${t("Descripción")}${longDescription ? ` ${t("(clic para desplegar)")}` : ""}</summary>
      <div class="pr-body">${pr.bodyHTML || `<p class='muted'>${t("Sin descripción.")}</p>`}</div>
    </details>`;
  $("#goto-changes")?.addEventListener("click", (event) => {
    event.preventDefault();
    state.detailTab = "changes";
    renderDetail();
  });
  wireExternalLinks();
  wireDraftCards($("#tab-body"));
  $("#send-comment").addEventListener("click", async () => {
    const body = $("#new-comment").value.trim();
    if (!body) return;
    await addDraft({ kind: "general", body });
    renderDetail();
  });
  notifySelftestOnce();
}

/* ============ tab cambios (diff + comentarios inline) ============ */
function parsePatch(patch) {
  const lines = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
      lines.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ type: "add", new: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", old: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      lines.push({ type: "meta", text: raw });
    } else {
      lines.push({ type: "ctx", old: oldLine++, new: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return lines;
}

function threadsByAnchor() {
  const map = new Map();
  const orphans = new Map(); // path -> threads outdated / sin línea
  for (const thread of state.conversation?.reviewThreads?.nodes || []) {
    if (thread.line && !thread.isOutdated) {
      map.set(`${thread.path}::${thread.line}`, [...(map.get(`${thread.path}::${thread.line}`) || []), thread]);
    } else {
      orphans.set(thread.path, [...(orphans.get(thread.path) || []), thread]);
    }
  }
  return { map, orphans };
}

function threadBlock(thread) {
  const comments = thread.comments?.nodes || [];
  const first = comments[0];
  const resolveBtn = !thread.id
    ? ""
    : thread.isResolved
      ? (thread.viewerCanUnresolve ? `<button class="btn thread-resolve" data-resolve-id="${esc(thread.id)}" data-resolved="false" title="${t("Reabre la conversación en GitHub")}">↺ ${t("Reabrir")}</button>` : "")
      : (thread.viewerCanResolve ? `<button class="btn thread-resolve resolve-ok" data-resolve-id="${esc(thread.id)}" data-resolved="true" title="${t("Marca la conversación como resuelta en GitHub")}">✓ ${t("Resolver")}</button>` : "");
  return `
    <div class="thread ${thread.isResolved ? "resolved" : ""}">
      ${thread.isResolved ? `<div class="thread-tag">✓ ${t("Resuelto")}</div>` : ""}
      ${comments.map(commentBlock).join("")}
      <div class="thread-reply">
        <textarea rows="2" placeholder="${t("Responder…")}"></textarea>
        <button class="btn" data-reply="${first?.databaseId ?? ""}">${t("Responder")}</button>
        ${resolveBtn}
      </div>
    </div>`;
}

function diffLineRow(file, line, anchored) {
  if (line.type === "hunk") {
    return `<tr class="diff-hunk"><td colspan="3">${esc(line.text)}</td></tr>`;
  }
  if (line.type === "meta") {
    return `<tr class="diff-meta"><td colspan="3">${esc(line.text)}</td></tr>`;
  }
  const cls = line.type === "add" ? "diff-add" : line.type === "del" ? "diff-del" : "diff-ctx";
  const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
  const commentLine = line.type === "del" ? line.old : line.new;
  const side = line.type === "del" ? "LEFT" : "RIGHT";
  const codeHtml = window.monstroHL
    ? window.monstroHL.highlightLine(line.text, window.monstroHL.familyFromFilename(file.filename))
    : esc(line.text);
  const threadsHtml = (anchored.get(`${file.filename}::${line.new}`) || [])
    .map(threadBlock)
    .map((html) => `<tr class="diff-thread-row"><td colspan="3">${html}</td></tr>`)
    .join("");
  const draftsHtml = state.drafts
    .filter((d) => d.kind === "inline" && d.path === file.filename && d.side === side && d.line === commentLine)
    .map(draftCard)
    .map((html) => `<tr class="diff-thread-row"><td colspan="3">${html}</td></tr>`)
    .join("");
  return `
    <tr class="diff-line ${cls}" data-path="${esc(file.filename)}" data-line="${commentLine ?? ""}" data-side="${side}">
      <td class="gutter">${line.old ?? ""}</td>
      <td class="gutter">${line.new ?? ""}<button class="add-comment" title="${t("Comentar esta línea (borrador)")}">+</button></td>
      <td class="code"><span class="sign">${sign}</span>${codeHtml}</td>
    </tr>${threadsHtml}${draftsHtml}`;
}
