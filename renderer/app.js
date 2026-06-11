"use strict";

/* ============ estado ============ */
const IS_SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";
const SELFTEST_ROUTE = new URLSearchParams(location.search).get("selftest_route") || "list";

const state = {
  config: null,
  me: null,
  authSource: null,
  repo: null,
  view: "prs", // "prs" | "history"
  bucket: "open",
  prs: [],
  openPrs: [],
  selected: null,
  detailRepo: null, // repo real del PR abierto (difiere de state.repo en la vista "Todos")
  detailTab: "conv", // "conv" | "changes"
  detailPR: null,
  conversation: null,
  files: null,
  drafts: [], // borradores locales del PR abierto (no tocan GitHub hasta publicar)
  search: "",
  loading: false,
  pollTimer: null,
  selftestNotified: false,
  selftestOpenedDetail: false,
  history: { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null },
  prSnapshot: null, // nº → {reviewDecision, checks, reviewMe} para detectar cambios y notificar
  cursor: -1, // selección con teclado (j/k) en la lista
  draftKeys: new Set(), // "owner/repo#n" con borradores guardados → badge 📝 en la lista
  aiGenerating: null, // nº de PR con review IA en curso → el botón persiste en loading entre pestañas
  draftNavIndex: -1, // navegación ↑↓ entre borradores
};

const $ = (sel) => document.querySelector(sel);
const list = $("#pr-list");
const detailPane = $("#detail-pane");
const detailContent = $("#detail-content");

/* ============ utilidades ============ */
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function timeAgo(iso) {
  const seconds = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [[31536000, "a"], [2592000, "mes"], [604800, "sem"], [86400, "d"], [3600, "h"], [60, "min"]];
  for (const [div, label] of units) {
    if (seconds >= div) {
      const v = Math.floor(seconds / div);
      return `hace ${v} ${label}${label === "mes" && v > 1 ? "es" : ""}`;
    }
  }
  return "ahora";
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copiado", "ok"),
    () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copiado", "ok");
    },
  );
}

function notifySelftestOnce() {
  if (!state.selftestNotified) {
    state.selftestNotified = true;
    window.pulpo.selftestRenderComplete();
  }
}

const ALL_REPOS = "__all__";

function detailRepo() {
  return state.detailRepo || state.repo;
}

/* ============ borradores ============ */
function draftsKey() {
  return `${detailRepo()}#${state.selected}`;
}

async function saveDrafts() {
  state.drafts = await window.pulpo.draftsSave(draftsKey(), state.drafts);
  state.draftKeys = new Set(await window.pulpo.draftsKeys());
}

async function addDraft(draft) {
  const id = globalThis.crypto?.randomUUID?.() || `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.drafts.push({ id, createdAt: new Date().toISOString(), ...draft });
  await saveDrafts();
  toast("Borrador guardado (solo en tu Mac)", "ok");
}

async function removeDraft(id) {
  state.drafts = state.drafts.filter((d) => d.id !== id);
  await saveDrafts();
}

function draftCard(draft) {
  const where = draft.kind === "inline"
    ? `<code>${esc(draft.path)}</code> · línea ${draft.line} (${draft.side === "LEFT" ? "anterior" : "nueva"})`
    : "comentario general";
  return `
    <div class="draft-card ${draft.ai ? "ai" : ""}" data-draft="${draft.id}">
      <div class="draft-head">${draft.ai ? "🤖 BORRADOR (IA)" : "📝 BORRADOR"} <span class="muted">· ${where}</span>
        <button class="draft-pub" title="Publicar solo este borrador en GitHub">↗ Publicar</button>
        <button class="draft-del" title="Eliminar borrador">🗑</button>
      </div>
      <div class="draft-body">${esc(draft.body)}</div>
    </div>`;
}

/* ============ review con IA ============ */
async function generateAiReview(pr) {
  if (state.aiGenerating) return;
  state.aiGenerating = pr.number;
  renderDetail(); // pinta el botón en loading; persiste aunque cambies de pestaña
  toast("Generando review con IA… esto puede tardar un par de minutos", "");
  const repoKey = `${detailRepo()}#${pr.number}`;
  try {
    const files = state.selected === pr.number && state.files
      ? state.files
      : await window.pulpo.prFiles(repoKey.split("#")[0], pr.number);
    if (state.selected === pr.number) state.files = files;
    const { review, backend } = await window.pulpo.aiReview(pr.title, pr.body || "", files);

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
        body: summaryParts.join("\n\n---\n\n"),
      });
    }

    // Guarda en la PR que pidió la review, aunque ya estés mirando otra.
    if (state.selected === pr.number) {
      state.drafts.push(...newDrafts);
      await saveDrafts();
      state.detailTab = "changes";
    } else {
      const existing = await window.pulpo.draftsList(repoKey);
      await window.pulpo.draftsSave(repoKey, [...existing, ...newDrafts]);
      state.draftKeys = new Set(await window.pulpo.draftsKeys());
      renderList();
    }
    toast(`IA (${backend}): ${newDrafts.length - (summaryParts.length ? 1 : 0)} comentario(s) en línea + resumen, en borradores de #${pr.number}`, "ok");
  } catch (err) {
    toast(`Review con IA falló: ${String(err.message || err)}`, "err");
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
}

function confirmPublishSingle(draft) {
  const root = $("#modal-root");
  const where = draft.kind === "inline" ? `${draft.path}:${draft.line}` : "comentario general";
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↗ Publicar este borrador</h3>
        <p class="muted">${esc(where)} — se publica como comentario (sin veredicto). El resto de borradores no se tocan.</p>
        <div class="draft-card ${draft.ai ? "ai" : ""}" style="max-height:180px;overflow-y:auto"><div class="draft-body">${esc(draft.body)}</div></div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Publicar en GitHub</button>
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
      state.conversation = await window.pulpo.prConversation(detailRepo(), state.selected);
      await window.pulpo.submitReview(detailRepo(), state.selected, {
        commitId: state.conversation.headRefOid,
        event: "COMMENT",
        body: draft.kind === "general" ? draft.body : undefined,
        comments: draft.kind === "inline" ? [draft] : [],
      });
      await removeDraft(draft.id);
      toast("Borrador publicado ✓", "ok");
      state.conversation = await window.pulpo.prConversation(detailRepo(), state.selected);
      renderDetail();
    } catch (err) {
      toast(`No se pudo publicar (el borrador sigue guardado): ${String(err.message || err)}`, "err");
    }
  });
}

function draftsBar() {
  if (!state.drafts.length) return "";
  return `
    <div class="drafts-bar">
      <button class="drafts-count" id="drafts-view" title="Ver todos los borradores">📝 <b>${state.drafts.length}</b> borrador${state.drafts.length > 1 ? "es" : ""} sin publicar</button>
      <button class="icon-btn" id="drafts-prev" title="Borrador anterior">↑</button>
      <button class="icon-btn" id="drafts-next" title="Borrador siguiente">↓</button>
      <span style="flex:1"></span>
      <button class="btn" id="drafts-discard">Descartar todos</button>
      <button class="btn btn-primary" id="drafts-publish">Publicar…</button>
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
    toast("Borradores descartados", "");
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
  toast(`Borrador ${state.draftNavIndex + 1} de ${drafts.length}`, "");
  scrollToDraft(target.id);
}

function openDraftsViewer() {
  const root = $("#modal-root");
  const drafts = orderedDrafts();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>📝 Borradores de #${state.selected} (${drafts.length})</h3>
        <div class="drafts-viewer">
          ${drafts.map((d) => `
            <div class="viewer-row" data-id="${d.id}">
              <div class="viewer-where">${d.ai ? "🤖" : "📝"} ${d.kind === "inline"
                ? `<code>${esc(d.path)}</code>:${d.line} <span class="muted">(${d.side === "LEFT" ? "anterior" : "nueva"})</span>`
                : `<span class="muted">comentario general</span>`}</div>
              <div class="viewer-body">${esc(d.body.length > 220 ? `${d.body.slice(0, 220)}…` : d.body)}</div>
              <div class="viewer-actions">
                <button class="btn viewer-go" data-id="${d.id}">Ir ↗</button>
                <button class="btn viewer-pub" data-id="${d.id}" title="Publicar solo este borrador">Publicar</button>
                <button class="btn viewer-del" data-id="${d.id}">🗑</button>
              </div>
            </div>`).join("")}
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cerrar</button>
          <button class="btn" id="viewer-discard">Descartar todos</button>
          <button class="btn btn-primary" id="viewer-publish">Publicar…</button>
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
    toast("Borradores descartados", "");
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
        <h3>Publicar ${state.drafts.length} borrador${state.drafts.length > 1 ? "es" : ""} como review</h3>
        <p class="muted">${inline.length} en línea · ${general.length} general${general.length === 1 ? "" : "es"} — se publican en una sola review.</p>
        <div class="verdict">
          <label><input type="radio" name="verdict" value="COMMENT" checked /> 💬 Comentar</label>
          <label><input type="radio" name="verdict" value="APPROVE" /> ✅ Aprobar</label>
          <label><input type="radio" name="verdict" value="REQUEST_CHANGES" /> ± Pedir cambios</label>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Publicar en GitHub</button>
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
    state.conversation = await window.pulpo.prConversation(detailRepo(), pr.number);
    const inline = state.drafts.filter((d) => d.kind === "inline");
    const general = state.drafts.filter((d) => d.kind === "general");
    await window.pulpo.submitReview(detailRepo(), pr.number, {
      commitId: state.conversation.headRefOid,
      event,
      body: general.map((d) => d.body).join("\n\n---\n\n") || undefined,
      comments: inline,
    });
    state.drafts = [];
    await saveDrafts();
    toast(`Review publicada (${event === "APPROVE" ? "aprobada ✅" : event === "REQUEST_CHANGES" ? "cambios pedidos" : "comentarios"})`, "ok");
    state.conversation = await window.pulpo.prConversation(detailRepo(), pr.number);
    renderDetail();
  } catch (err) {
    toast(`No se pudo publicar (tus borradores siguen guardados): ${String(err.message || err)}`, "err");
  }
}

/* ============ chips ============ */
function stateChip(pr) {
  if (pr.state === "MERGED") return `<span class="chip chip-merged">Fusionada</span>`;
  if (pr.state === "CLOSED") return `<span class="chip chip-closed">Cerrada</span>`;
  if (pr.isDraft) return `<span class="chip chip-draft">Borrador</span>`;
  return `<span class="chip chip-open">Abierta</span>`;
}

function reviewChip(pr) {
  if (pr.state !== "OPEN") return "";
  switch (pr.reviewDecision) {
    case "APPROVED": return `<span class="chip chip-approved">✓ Aprobada</span>`;
    case "CHANGES_REQUESTED": return `<span class="chip chip-changes">± Cambios pedidos</span>`;
    case "REVIEW_REQUIRED": return `<span class="chip chip-review">Falta revisión</span>`;
    default: return "";
  }
}

function mergeStateChip(pr) {
  if (pr.state !== "OPEN") return "";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return `<span class="chip chip-conflict">Conflictos</span>`;
  if (pr.mergeStateStatus === "BEHIND") return `<span class="chip chip-behind">Rama atrasada</span>`;
  return "";
}

function checksIcon(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return "";
  const map = {
    SUCCESS: ["✓", "checks-success", "Checks en verde"],
    FAILURE: ["✗", "checks-failure", "Checks fallando"],
    ERROR: ["✗", "checks-failure", "Checks con error"],
    PENDING: ["●", "checks-pending", "Checks en curso"],
    EXPECTED: ["●", "checks-pending", "Checks esperados"],
  };
  const [icon, cls, title] = map[rollup.state] || ["", "", ""];
  return icon ? `<span class="checks ${cls}" title="${title}">${icon}</span>` : "";
}

function labelPills(pr) {
  return (pr.labels?.nodes || [])
    .map((l) => `<span class="label-pill" style="background:#${l.color}22;color:#${l.color}">${esc(l.name)}</span>`)
    .join("");
}

/* ============ lista de PRs ============ */
function bucketFilter(prs) {
  const login = state.me?.login;
  switch (state.bucket) {
    case "mine": return prs.filter((p) => p.author?.login === login);
    case "review":
      return prs.filter((p) => (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login));
    case "draft": return prs.filter((p) => p.isDraft);
    default: return prs;
  }
}

function searchFilter(prs) {
  const q = state.search.trim().toLowerCase();
  if (!q) return prs;
  return prs.filter((p) =>
    [p.title, p.headRefName, p.baseRefName, p.author?.login, String(p.number)].join(" ").toLowerCase().includes(q),
  );
}

function renderCounts() {
  const open = state.openPrs;
  const login = state.me?.login;
  $("#count-open").textContent = open.length || "";
  $("#count-mine").textContent = open.filter((p) => p.author?.login === login).length || "";
  $("#count-review").textContent =
    open.filter((p) => (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login)).length || "";
  $("#count-draft").textContent = open.filter((p) => p.isDraft).length || "";
}

function renderList() {
  if (state.view !== "prs") return;
  const prs = searchFilter(bucketFilter(state.prs));
  if (state.loading) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  if (!prs.length) {
    list.innerHTML = `<div class="empty"><span class="big">🐙</span>Nada por aquí. Mar en calma.</div>`;
    notifySelftestOnce();
    return;
  }
  list.innerHTML = prs
    .map(
      (pr) => `
      <article class="pr-row ${state.selected === pr.number ? "selected" : ""}" data-number="${pr.number}" data-repo="${esc(pr.repository?.nameWithOwner || state.repo)}">
        <img class="avatar" src="${esc(pr.author?.avatarUrl || "")}" alt="" />
        <div class="pr-title-line">
          ${state.repo === ALL_REPOS ? `<span class="label-pill repo-pill">${esc(pr.repository?.nameWithOwner || "")}</span>` : ""}
          <span class="pr-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></span>
          ${labelPills(pr)}
        </div>
        <div class="pr-right">
          ${checksIcon(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)} ${stateChip(pr)}
        </div>
        <div class="pr-sub">
          <span class="branches">
            <span class="branch" title="${esc(pr.headRefName)}">${esc(pr.headRefName)}</span>
            <span class="arrow">→</span>
            <span class="branch" title="${esc(pr.baseRefName)}">${esc(pr.baseRefName)}</span>
          </span>
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · <span class="checks-success">+${pr.additions ?? 0}</span>/<span class="checks-failure">−${pr.deletions ?? 0}</span> · 💬 ${pr.comments?.totalCount ?? 0}${state.draftKeys.has(`${pr.repository?.nameWithOwner || state.repo}#${pr.number}`) ? " · 📝 borradores" : ""}</span>
        </div>
      </article>`,
    )
    .join("");
  list.querySelectorAll(".pr-row").forEach((row) =>
    row.addEventListener("click", () => openDetail(Number(row.dataset.number), "conv", row.dataset.repo)),
  );

  if (IS_SELFTEST && !state.selftestOpenedDetail && prs.length && (SELFTEST_ROUTE === "list" || SELFTEST_ROUTE === "changes")) {
    state.selftestOpenedDetail = true;
    openDetail(prs[0].number, SELFTEST_ROUTE === "changes" ? "changes" : "conv");
  }
}

/* ============ detalle de PR: shell + tabs ============ */
function canMerge(pr) {
  return (
    pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" &&
    ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)
  );
}

function mergeBlockReason(pr) {
  if (pr.state !== "OPEN") return "La PR no está abierta";
  if (pr.isDraft) return "Es un borrador";
  if (pr.mergeable === "CONFLICTING") return "Tiene conflictos con la base";
  if (pr.mergeStateStatus === "BEHIND") return "La rama está atrasada: actualiza primero (rebase)";
  if (pr.mergeStateStatus === "BLOCKED") return "Bloqueada por checks o revisiones requeridas";
  return "";
}

async function openDetail(number, tab = "conv", repoOverride = null) {
  state.selected = number;
  state.detailRepo = repoOverride && repoOverride !== ALL_REPOS ? repoOverride : state.repo;
  state.detailTab = tab;
  state.files = null;
  state.conversation = null;
  renderList();
  detailPane.classList.remove("hidden");
  detailPane.classList.toggle("wide", tab === "changes");
  detailContent.innerHTML = `<div class="detail-inner"><div class="loading">Cargando #${number}…</div></div>`;
  try {
    const [pr, conversation, drafts] = await Promise.all([
      window.pulpo.prDetail(detailRepo(), number),
      window.pulpo.prConversation(detailRepo(), number),
      window.pulpo.draftsList(`${detailRepo()}#${number}`),
    ]);
    state.detailPR = pr;
    state.conversation = conversation;
    state.drafts = drafts;
    // seed visual para capturas de selftest: no se persiste
    if (IS_SELFTEST && new URLSearchParams(location.search).get("seed_draft") === "1" && !state.drafts.length) {
      state.drafts.push({ id: "seed", kind: "general", body: "Esto es un borrador local: no está en GitHub.", createdAt: new Date().toISOString() });
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
      <button class="detail-close" id="detail-close" title="Cerrar (Esc)">✕</button>
      <div class="detail-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></div>
      <div class="detail-sub">
        ${stateChip(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)}
        <span class="branches">
          <span class="branch">${esc(pr.headRefName)}</span><span class="arrow">→</span><span class="branch">${esc(pr.baseRefName)}</span>
        </span>
      </div>

      <div class="actions">
        <button class="btn btn-accent" id="act-update" ${pr.state !== "OPEN" ? "disabled" : ""}
                title="Actualiza la rama con la base usando rebase">⤴ Update branch (rebase)</button>
        <button class="btn btn-primary" id="act-merge" ${canMerge(pr) ? "" : "disabled"}
                title="${esc(blockReason || "Merge con merge commit")}">⇅ Merge (merge commit)</button>
        ${state.aiGenerating === pr.number
          ? `<button class="btn btn-ai" id="act-ai" disabled><span class="spinner"></span> Generando review…</button>`
          : `<button class="btn btn-ai" id="act-ai" ${pr.state === "OPEN" ? "" : "disabled"}
                title="Genera comentarios de review (en inglés) como borradores: nada se publica hasta que tú lo digas">🤖 Review con IA</button>`}
        <button class="btn" id="act-approve" ${pr.state === "OPEN" && pr.author?.login !== state.me?.login ? "" : "disabled"}
                title="${pr.author?.login === state.me?.login ? "No puedes aprobar tu propia PR" : "Aprobar sin comentarios (pide confirmación)"}">✅ Aprobar</button>
      </div>
      <div class="copy-row">
        <button class="mini-btn" id="copy-branch" title="Copiar nombre de la rama">📋 ${esc(pr.headRefName)}</button>
        <button class="mini-btn" id="copy-checkout" title="Copiar comando para traerte la PR en local">⬇ gh pr checkout ${pr.number}</button>
        <button class="mini-btn" id="copy-url" title="Copiar URL de la PR">🔗 URL</button>
      </div>
      ${blockReason && pr.state === "OPEN" ? `<p class="muted">⚠️ ${esc(blockReason)}</p>` : ""}

      <div class="tabs">
        <button class="tab ${state.detailTab === "conv" ? "active" : ""}" data-tab="conv">
          Conversación <span class="count">${pr.comments?.totalCount ?? 0}</span>
        </button>
        <button class="tab ${state.detailTab === "changes" ? "active" : ""}" data-tab="changes">
          Cambios <span class="count">${pr.changedFiles} ficheros · ${threadCount} hilos${state.drafts.filter((d) => d.kind === "inline").length ? ` · 📝 ${state.drafts.filter((d) => d.kind === "inline").length}` : ""}</span>
        </button>
      </div>

      <div id="tab-body"></div>
      ${draftsBar()}
    </div>`;

  $("#detail-close").addEventListener("click", closeDetail);
  $("#act-update").addEventListener("click", () => updateBranch(pr));
  $("#act-merge").addEventListener("click", () => confirmMerge(pr));
  $("#act-ai").addEventListener("click", () => generateAiReview(pr));
  $("#act-approve").addEventListener("click", () => confirmApprove(pr));
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
      ? `<div class="section-h">Tus borradores (${state.drafts.length})</div>
         ${generalDrafts.map(draftCard).join("")}
         ${inlineDraftCount ? `<p class="muted">…y ${inlineDraftCount} en línea en la pestaña <a href="#" id="goto-changes">Cambios</a>.</p>` : ""}`
      : ""}
    <div class="section-h">Comentarios (${comments.length})</div>
    ${comments.map(commentBlock).join("") || `<p class="muted">Nadie ha dicho nada todavía.</p>`}
    <div class="composer">
      <textarea id="new-comment" rows="3" placeholder="Escribe un comentario… se guarda como borrador hasta que publiques"></textarea>
      <div class="composer-actions">
        <button class="btn btn-accent" id="send-comment">📝 Guardar borrador</button>
      </div>
    </div>
    <details class="desc-fold" ${longDescription ? "" : "open"}>
      <summary class="section-h">Descripción${longDescription ? " (clic para desplegar)" : ""}</summary>
      <div class="pr-body">${pr.bodyHTML || "<p class='muted'>Sin descripción.</p>"}</div>
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
  return `
    <div class="thread ${thread.isResolved ? "resolved" : ""}">
      ${thread.isResolved ? `<div class="thread-tag">✓ Resuelto</div>` : ""}
      ${comments.map(commentBlock).join("")}
      <div class="thread-reply">
        <textarea rows="2" placeholder="Responder…"></textarea>
        <button class="btn" data-reply="${first?.databaseId ?? ""}">Responder</button>
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
      <td class="gutter">${line.new ?? ""}<button class="add-comment" title="Comentar esta línea (borrador)">+</button></td>
      <td class="code"><span class="sign">${sign}</span>${esc(line.text)}</td>
    </tr>${threadsHtml}${draftsHtml}`;
}

function renderChangesTab() {
  const files = state.files;
  if (!files) {
    $("#tab-body").innerHTML = `<div class="loading">Cargando diff…</div>`;
    window.pulpo.prFiles(detailRepo(), state.detailPR.number).then((loaded) => {
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
  $("#tab-body").innerHTML = `
    <div class="diff-summary muted">${files.length} ficheros ·
      <span class="checks-success">+${files.reduce((s, f) => s + f.additions, 0)}</span> /
      <span class="checks-failure">−${files.reduce((s, f) => s + f.deletions, 0)}</span>
    </div>
    ${files
      .map((file, fi) => {
        const orphanThreads = (orphans.get(file.filename) || []).map(threadBlock).join("");
        return `
        <details class="diff-file" ${fi < 6 ? "open" : ""}>
          <summary>
            <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
            <span class="diff-path">${esc(file.previousFilename ? `${file.previousFilename} → ` : "")}${esc(file.filename)}</span>
            <span class="muted"><span class="checks-success">+${file.additions}</span> / <span class="checks-failure">−${file.deletions}</span></span>
          </summary>
          ${file.patch
            ? `<table class="diff-table">${parsePatch(file.patch).map((l) => diffLineRow(file, l, anchored)).join("")}</table>`
            : `<p class="muted" style="padding:10px 14px">Sin diff disponible (binario o demasiado grande).</p>`}
          ${orphanThreads ? `<div class="orphan-threads"><div class="section-h">Hilos en versiones anteriores</div>${orphanThreads}</div>` : ""}
        </details>`;
      })
      .join("")}`;

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
        await window.pulpo.replyThread(detailRepo(), state.detailPR.number, Number(btn.dataset.reply), body);
        toast("Respuesta publicada", "ok");
        state.conversation = await window.pulpo.prConversation(state.repo, state.detailPR.number);
        renderChangesTab();
      } catch (err) {
        toast(`No se pudo responder: ${String(err.message || err)}`, "err");
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
        <div class="muted" style="margin-bottom:6px">📝 Borrador en <code>${esc(path)}</code> línea ${esc(line)} (${side === "LEFT" ? "versión anterior" : "versión nueva"}) — no se publica hasta que tú lo digas</div>
        <textarea rows="3" placeholder="Tu comentario…"></textarea>
        <div class="composer-actions">
          <button class="btn cancel">Cancelar</button>
          <button class="btn btn-accent send">📝 Guardar borrador</button>
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
      if (url?.startsWith("http")) window.pulpo.openExternal(url);
    }),
  );
}

/* ============ acciones PR ============ */
async function updateBranch(pr) {
  const btn = $("#act-update");
  btn.disabled = true;
  btn.textContent = "Rebasando…";
  try {
    await window.pulpo.updateBranch(pr.id);
    toast(`#${pr.number}: rama actualizada con rebase`, "ok");
    await refresh();
    openDetail(pr.number, state.detailTab);
  } catch (err) {
    toast(`Update falló: ${String(err.message || err)}`, "err");
    btn.disabled = false;
    btn.textContent = "⤴ Update branch (rebase)";
  }
}

function confirmApprove(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>✅ Aprobar #${pr.number}</h3>
        <p>${esc(pr.title)}</p>
        <p class="muted">Publica una review de aprobación sin comentarios. Si tienes borradores pendientes, no se tocan.</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Aprobar</button>
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
      await window.pulpo.submitReview(detailRepo(), pr.number, { event: "APPROVE" });
      toast(`#${pr.number} aprobada ✅`, "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(`No se pudo aprobar: ${String(err.message || err)}`, "err");
    }
  });
}

function confirmMerge(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>Merge de #${pr.number}</h3>
        <p><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b> con <b>merge commit</b>.</p>
        <p class="muted">Squash no es una opción. Nunca lo fue.</p>
        ${pr.isCrossRepository ? "" : `<label><input type="checkbox" id="del-branch" checked /> Borrar la rama tras el merge</label>`}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Confirmar merge</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const deleteBranch = $("#del-branch")?.checked ?? false;
    root.innerHTML = "";
    try {
      const res = await window.pulpo.mergePR({
        repo: detailRepo(),
        number: pr.number,
        deleteBranch,
        headRefName: pr.headRefName,
        isCrossRepository: pr.isCrossRepository,
      });
      toast(res.merged ? `#${pr.number} fusionada (merge commit)${res.branchDeleted ? " · rama borrada" : ""}` : "Merge no completado", res.merged ? "ok" : "err");
      closeDetail();
      await refresh();
    } catch (err) {
      toast(`Merge falló: ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ vista histórico ============ */
async function enterHistory() {
  if (state.repo === ALL_REPOS) {
    toast("El histórico es por repositorio: elige uno en el selector", "");
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
      const def = await window.pulpo.defaultBranch(state.repo);
      const candidates = new Set([def, "develop"]);
      for (const pr of state.openPrs.slice(0, 10)) {
        if (!pr.isCrossRepository) candidates.add(pr.headRefName);
        candidates.add(pr.baseRefName);
      }
      h.branches = [...candidates].slice(0, 14);
      h.enabled = new Set([def, "develop"].filter((b) => h.branches.includes(b)));
      if (!h.enabled.size) h.enabled = new Set(h.branches.slice(0, 2));
    }
    const { branches, commits } = await window.pulpo.historyGraph(state.repo, historyBranchSpecs());
    h.layout = window.PulpoGraph.computeLayout(commits, branches);
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
    list.innerHTML = `<div class="loading">Tejiendo el grafo…</div>`;
    return;
  }
  if (!h.layout) return;

  const chips = h.branches
    .map(
      (name) => `<button class="branch-chip ${h.enabled.has(name) ? "on" : ""}" data-branch="${esc(name)}">${esc(name)}</button>`,
    )
    .join("");
  const { svg, width } = window.PulpoGraph.renderSVG(h.layout);
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
      <button class="icon-btn" id="history-refresh" title="Recargar grafo">⟳</button>
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
        <dt>Autor</dt><dd>${esc(c.author?.user?.login || c.author?.name || "?")}</dd>
        <dt>Fecha</dt><dd>${new Date(c.committedDate).toLocaleString("es-ES")}</dd>
        <dt>SHA</dt><dd><code>${c.oid}</code></dd>
        ${pr ? `<dt>PR</dt><dd><button class="pr-pill" id="commit-pr">#${pr.number} · ${esc(pr.title)}</button></dd>` : ""}
      </dl>

      <div class="section-h">Acciones</div>
      <div class="actions" style="flex-direction:column;align-items:stretch">
        <button class="btn" id="cp-copy">📋 Copiar SHA</button>
        <button class="btn" id="cp-branch">🌱 Crear rama desde aquí…</button>
        <button class="btn" id="cp-reset">⏪ Mover una rama a este commit…</button>
        ${pr && pr.state === "MERGED" ? `<button class="btn btn-danger" id="cp-revert">↩️ Revertir PR #${pr.number} (crea PR de revert)</button>` : ""}
      </div>
      <p class="muted">“Mover una rama” reescribe la punta de la rama (force). Pulpo te pedirá confirmación escrita; aún así, úsalo sabiendo lo que haces.</p>
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
        <h3>🌱 Crear rama en <code>${commit.abbreviatedOid}</code></h3>
        <input type="text" id="nb-name" placeholder="feature/mi-rama" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-accent" id="modal-confirm">Crear rama</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const name = $("#nb-name").value.trim();
    if (!name) return;
    root.innerHTML = "";
    try {
      await window.pulpo.createBranch(state.repo, name, commit.oid);
      toast(`Rama ${name} creada en ${commit.abbreviatedOid}`, "ok");
      state.history.branches = [];
      loadHistory();
    } catch (err) {
      toast(`No se pudo crear: ${String(err.message || err)}`, "err");
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
        <h3>⏪ Mover rama a <code>${commit.abbreviatedOid}</code></h3>
        <p class="muted">Esto hace un <b>force update</b> de la referencia: la rama pasará a apuntar a este commit y lo que tenga por delante se pierde de la rama. Las ramas protegidas lo rechazarán.</p>
        <select id="rb-branch" class="modal-input" style="width:100%;margin-top:8px">${options}</select>
        <input type="text" id="rb-confirm" placeholder="Escribe el nombre exacto de la rama para confirmar" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-danger" id="modal-confirm">Mover rama (force)</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const branch = $("#rb-branch").value;
    const typed = $("#rb-confirm").value.trim();
    if (typed !== branch) return toast("El nombre no coincide: no muevo nada", "err");
    root.innerHTML = "";
    try {
      await window.pulpo.forceUpdateBranch(state.repo, branch, commit.oid);
      toast(`${branch} ahora apunta a ${commit.abbreviatedOid}`, "ok");
      loadHistory();
    } catch (err) {
      toast(`Force update falló: ${String(err.message || err)}`, "err");
    }
  });
}

function revertPRModal(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↩️ Revertir PR #${pr.number}</h3>
        <p>Crea una <b>PR de revert</b> (no toca la rama directamente). La revisas y la fusionas como cualquier otra.</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-danger" id="modal-confirm">Crear PR de revert</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      const revert = await window.pulpo.revertPR(state.repo, pr.number);
      toast(`PR de revert creada: #${revert.number}`, "ok");
      exitHistoryToPR(revert.number);
    } catch (err) {
      toast(`Revert falló: ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ notificaciones (estilo Gitify) ============ */
function checksStateOf(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "NONE";
}

function reviewRequestedToMe(pr) {
  return (pr.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === state.me?.login);
}

function detectAndNotify(openPrs) {
  const login = state.me?.login;
  const snapshot = new Map();
  for (const pr of openPrs) {
    snapshot.set(pr.number, {
      reviewDecision: pr.reviewDecision,
      checks: checksStateOf(pr),
      reviewMe: reviewRequestedToMe(pr),
      title: pr.title,
      mine: pr.author?.login === login,
    });
  }
  const previous = state.prSnapshot;
  state.prSnapshot = snapshot;
  window.pulpo.dockBadge(String([...snapshot.values()].filter((s) => s.reviewMe).length || ""));
  if (!previous) return; // primera carga: sin spam

  for (const [number, now] of snapshot) {
    const before = previous.get(number);
    if (now.reviewMe && !(before?.reviewMe)) {
      window.pulpo.notify(`Te piden review · #${number}`, now.title);
    }
    if (!before || !now.mine) continue;
    if (now.reviewDecision === "APPROVED" && before.reviewDecision !== "APPROVED") {
      window.pulpo.notify(`✅ Aprobada · #${number}`, now.title);
    }
    if (now.reviewDecision === "CHANGES_REQUESTED" && before.reviewDecision !== "CHANGES_REQUESTED") {
      window.pulpo.notify(`± Cambios pedidos · #${number}`, now.title);
    }
    if (["FAILURE", "ERROR"].includes(now.checks) && !["FAILURE", "ERROR"].includes(before.checks)) {
      window.pulpo.notify(`✗ Checks en rojo · #${number}`, now.title);
    }
  }
}

/* ============ datos ============ */
function bucketStates() {
  if (state.bucket === "merged") return ["MERGED"];
  if (state.bucket === "closed") return ["CLOSED"];
  return ["OPEN"];
}

async function refresh() {
  if (!state.repo) return;
  if (state.view === "history") return loadHistory();
  state.loading = true;
  renderList();
  try {
    const prs = state.repo === ALL_REPOS
      ? await window.pulpo.searchPRs(state.config.repos, bucketStates())
      : await window.pulpo.listPRs(state.repo, bucketStates());
    state.prs = prs;
    if (bucketStates()[0] === "OPEN") {
      state.openPrs = prs;
      detectAndNotify(prs);
    } else if (!state.openPrs.length) {
      window.pulpo.listPRs(state.repo, ["OPEN"]).then((open) => {
        state.openPrs = open;
        renderCounts();
      }).catch(() => {});
    }
    state.loading = false;
    renderCounts();
    renderList();
    refreshOpenDetailSilently();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="error-box">No pude cargar ${esc(state.repo)}:<br>${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

/** Refresca el detalle abierto en cada poll, sin pisar nada si estás escribiendo. */
async function refreshOpenDetailSilently() {
  if (!state.selected || !state.detailPR || state.view !== "prs") return;
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName) ||
    detailContent.querySelector(".inline-composer-row");
  if (typing) return;
  try {
    const [pr, conversation] = await Promise.all([
      window.pulpo.prDetail(detailRepo(), state.selected),
      window.pulpo.prConversation(detailRepo(), state.selected),
    ]);
    const changed = JSON.stringify([pr.mergeStateStatus, pr.reviewDecision, checksStateOf(pr), conversation.comments.totalCount]) !==
      JSON.stringify([state.detailPR.mergeStateStatus, state.detailPR.reviewDecision, checksStateOf(state.detailPR), state.conversation?.comments?.totalCount]);
    state.detailPR = pr;
    state.conversation = conversation;
    if (changed) renderDetail();
  } catch {
    /* el siguiente poll lo reintenta */
  }
}

function schedulePoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, (state.config?.pollSeconds || 60) * 1000);
}

/* ============ ajustes ============ */
function openSettings() {
  const root = $("#settings-root");
  root.classList.remove("hidden");
  const cfg = state.config;
  root.innerHTML = `
    <div class="settings-inner">
      <button class="btn" id="settings-back">← Volver</button>
      <h2 style="margin-top:14px">Ajustes</h2>
      <div class="settings-card">
        <h4>Repositorios</h4>
        <div id="repo-lines">
          ${cfg.repos.map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">Quitar</button></div>`).join("")}
        </div>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="owner/repo" />
          <button class="btn btn-accent" id="add-repo">Añadir</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>Token de GitHub</h4>
        <p class="muted">Origen actual: <b>${esc(state.authSource || "ninguno")}</b>. Orden: <code>GITHUB_TOKEN</code> → <code>gh auth token</code> → token manual.</p>
        <div class="add-repo">
          <input type="password" id="manual-token" placeholder="${cfg.hasManualToken ? "•••••••• (guardado)" : "ghp_… (opcional)"}" />
          <button class="btn" id="save-token">Guardar</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>IA (Review con IA 🤖)</h4>
        <p class="muted" id="ai-status-line">Comprobando backend…</p>
        <button class="btn" id="test-ai">Probar conexión con Claude</button>
      </div>
      <div class="settings-card">
        <h4>Refresco automático</h4>
        <div class="add-repo">
          <input type="number" id="poll-seconds" min="15" value="${cfg.pollSeconds}" />
          <span class="muted" style="align-self:center">segundos</span>
        </div>
      </div>
      <div class="settings-card">
        <h4>Reglas de la casa</h4>
        <p class="muted">pull → <b>rebase</b> · merge → <b>merge commit</b> · squash → <b style="text-decoration:line-through">jamás</b>. No configurable. A propósito.</p>
      </div>
    </div>`;

  $("#settings-back").addEventListener("click", async () => {
    const pollSeconds = parseInt($("#poll-seconds").value, 10);
    if (Number.isInteger(pollSeconds) && pollSeconds >= 15 && pollSeconds !== cfg.pollSeconds) {
      state.config = await window.pulpo.setConfig({ pollSeconds });
      schedulePoll();
    }
    root.classList.add("hidden");
    root.innerHTML = "";
  });
  $("#add-repo").addEventListener("click", async () => {
    const value = $("#new-repo").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return toast("Formato esperado: owner/repo", "err");
    state.config = await window.pulpo.setConfig({ repos: [...cfg.repos, value] });
    renderRepoSelect();
    openSettings();
  });
  root.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      state.config = await window.pulpo.setConfig({ repos: cfg.repos.filter((r) => r !== btn.dataset.del) });
      if (state.repo === btn.dataset.del) state.repo = state.config.repos[0] || null;
      renderRepoSelect();
      openSettings();
    }),
  );
  $("#save-token").addEventListener("click", async () => {
    state.config = await window.pulpo.setConfig({ token: $("#manual-token").value });
    toast("Token guardado", "ok");
    boot();
  });

  window.pulpo.aiStatus().then((s) => {
    const line = $("#ai-status-line");
    if (line) line.innerHTML = s.backend
      ? `✓ <b>${esc(s.backend)}</b> — ${esc(s.detail)}`
      : `✗ ${esc(s.detail)}`;
  }).catch(() => {});
  $("#test-ai").addEventListener("click", async () => {
    const btn = $("#test-ai");
    btn.disabled = true;
    btn.textContent = "Probando… (puede tardar ~30s)";
    try {
      const result = await window.pulpo.aiPing();
      toast(result.ok ? `IA OK vía ${result.backend}` : `IA no disponible: ${result.detail}`, result.ok ? "ok" : "err");
      const line = $("#ai-status-line");
      if (line) line.innerHTML = `${result.ok ? "✓" : "✗"} <b>${esc(result.backend || "sin backend")}</b> — ${esc(result.detail)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Probar conexión con Claude";
    }
  });
}

/* ============ bienvenida / onboarding ============ */
async function renderWelcome() {
  const aiStatus = await window.pulpo.aiStatus().catch(() => ({ backend: null, detail: "" }));
  const aiOk = Boolean(aiStatus.backend);
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">🐙</div>
      <h2>Bienvenido a Pulpo</h2>
      <p class="muted">Dos pasos y listo. Pulpo no guarda credenciales: usa las sesiones que ya tienes.</p>

      <div class="setup-step bad">
        <div class="setup-mark">1</div>
        <div>
          <b>Conecta GitHub</b> <span class="chip chip-closed">pendiente</span>
          <p class="muted">La vía fácil es el CLI oficial de GitHub — Pulpo coge el token de ahí:</p>
          <pre class="setup-cmd">brew install gh && gh auth login</pre>
          <p class="muted">Alternativas: exporta <code>GITHUB_TOKEN</code>, o pega un token en Ajustes ⚙.</p>
        </div>
      </div>

      <div class="setup-step ${aiOk ? "ok" : ""}">
        <div class="setup-mark">2</div>
        <div>
          <b>Conecta Claude</b> <span class="chip ${aiOk ? "chip-open" : "chip-draft"}">${aiOk ? "listo" : "opcional"}</span>
          <p class="muted">${aiOk
            ? `Detectado: ${esc(aiStatus.detail)} — el botón 🤖 Review con IA ya funciona.`
            : `Para el botón 🤖 Review con IA: instala <a href="#" data-ext="https://claude.com/claude-code">Claude Code</a> y ábrelo una vez para autenticarte (Pulpo usará tu sesión), o exporta <code>ANTHROPIC_API_KEY</code>.`}</p>
        </div>
      </div>

      <div class="welcome-actions">
        <button class="btn btn-accent" id="welcome-retry">He hecho login — Reintentar</button>
        <button class="btn" id="welcome-settings">Abrir Ajustes ⚙</button>
      </div>
      <p class="muted small-print">¿Dudas? <code>npm run doctor</code> en la terminal diagnostica todo esto por ti.</p>
    </div>`;
  $("#welcome-retry").addEventListener("click", boot);
  $("#welcome-settings").addEventListener("click", openSettings);
  list.querySelectorAll("[data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      window.pulpo.openExternal(a.dataset.ext);
    }),
  );
}

/* ============ arranque ============ */
function renderRepoSelect() {
  const select = $("#repo-select");
  const repos = state.config?.repos || [];
  const allOption = repos.length > 1
    ? `<option value="${ALL_REPOS}" ${state.repo === ALL_REPOS ? "selected" : ""}>⭐ Todos los repos</option>`
    : "";
  select.innerHTML = allOption + repos
    .map((r) => `<option value="${esc(r)}" ${r === state.repo ? "selected" : ""}>${esc(r)}</option>`)
    .join("");
}

async function boot() {
  state.config = await window.pulpo.getConfig();
  const remembered = state.config.lastRepo;
  state.repo =
    (state.repo && state.config.repos.includes(state.repo) && state.repo) ||
    (remembered === ALL_REPOS && state.config.repos.length > 1 && ALL_REPOS) ||
    (state.config.repos.includes(remembered) && remembered) ||
    state.config.repos[0] ||
    null;
  if (state.config.lastBucket && !IS_SELFTEST) state.bucket = state.config.lastBucket;
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${state.bucket}"]`)?.classList.add("active");
  state.draftKeys = new Set(await window.pulpo.draftsKeys().catch(() => []));
  renderRepoSelect();

  const auth = await window.pulpo.authStatus();
  state.authSource = auth.source;
  if (auth.ok) {
    state.me = { login: auth.login, avatarUrl: auth.avatarUrl };
    $("#me").innerHTML = `<img src="${esc(auth.avatarUrl)}" alt="" /> ${esc(auth.login)}`;
  } else {
    $("#me").innerHTML = "";
    await renderWelcome();
    notifySelftestOnce();
    return;
  }
  await refresh();
  schedulePoll();
  if (IS_SELFTEST && SELFTEST_ROUTE === "history") enterHistory();
}

$("#refresh").addEventListener("click", refresh);
$("#settings-btn").addEventListener("click", openSettings);
$("#repo-select").addEventListener("change", (event) => {
  if (event.target.value === ALL_REPOS && state.view === "history") {
    state.view = "prs";
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    document.querySelector('[data-bucket="open"]')?.classList.add("active");
    state.bucket = "open";
  }
  switchRepo(event.target.value);
});
$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
document.querySelectorAll(".bucket[data-bucket]").forEach((btn) =>
  btn.addEventListener("click", () => switchBucket(btn.dataset.bucket)),
);
$("#bucket-history").addEventListener("click", enterHistory);
/* ============ paleta de comandos (⌘K) ============ */
function paletteEntries() {
  const entries = [];
  for (const pr of state.openPrs) {
    entries.push({
      label: `#${pr.number} ${pr.title}`,
      hint: `${pr.headRefName} → ${pr.baseRefName}`,
      run: () => exitHistoryToPR(pr.number),
    });
  }
  entries.push({ label: "Ir a: Histórico", hint: "grafo de ramas", run: enterHistory });
  for (const [bucket, label] of [["open", "Abiertas"], ["mine", "Mías"], ["review", "Para revisar"], ["draft", "Borradores"], ["merged", "Fusionadas"], ["closed", "Cerradas"]]) {
    entries.push({ label: `Ir a: ${label}`, hint: "bucket", run: () => switchBucket(bucket) });
  }
  if ((state.config?.repos || []).length > 1) {
    entries.push({ label: "Repo: ⭐ Todos los repos", hint: "vista agregada", run: () => switchRepo(ALL_REPOS) });
  }
  for (const repo of state.config?.repos || []) {
    entries.push({ label: `Repo: ${repo}`, hint: "cambiar repositorio", run: () => switchRepo(repo) });
  }
  entries.push({ label: "Refrescar", hint: "R", run: refresh });
  entries.push({ label: "Ajustes", hint: "⚙", run: openSettings });
  return entries;
}

function switchBucket(bucket) {
  state.view = "prs";
  state.bucket = bucket;
  window.pulpo.setConfig({ lastBucket: bucket }).catch(() => {});
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${bucket}"]`)?.classList.add("active");
  closeDetail();
  refresh();
}

function switchRepo(repo) {
  state.repo = repo;
  window.pulpo.setConfig({ lastRepo: repo }).catch(() => {});
  state.openPrs = [];
  state.prSnapshot = null;
  state.history = { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null };
  renderRepoSelect();
  closeDetail();
  if (state.view === "history") loadHistory();
  else refresh();
}

function openPalette() {
  const root = $("#modal-root");
  let results = [];
  let cursor = 0;
  root.innerHTML = `
    <div class="modal-backdrop" id="palette-backdrop">
      <div class="palette">
        <input type="text" id="palette-input" placeholder="Busca PRs, repos o acciones…  (Esc para cerrar)" autocomplete="off" />
        <div id="palette-results"></div>
      </div>
    </div>`;
  const input = $("#palette-input");
  const resultsBox = $("#palette-results");

  const renderResults = () => {
    const q = input.value.trim().toLowerCase();
    results = paletteEntries().filter((e) => !q || `${e.label} ${e.hint}`.toLowerCase().includes(q)).slice(0, 12);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    resultsBox.innerHTML = results
      .map(
        (e, i) => `<div class="palette-item ${i === cursor ? "active" : ""}" data-i="${i}">
          <span>${esc(e.label)}</span><span class="muted">${esc(e.hint)}</span>
        </div>`,
      )
      .join("") || `<div class="palette-item muted">Sin resultados</div>`;
    resultsBox.querySelectorAll(".palette-item[data-i]").forEach((el) =>
      el.addEventListener("click", () => {
        root.innerHTML = "";
        results[Number(el.dataset.i)]?.run();
      }),
    );
  };

  input.addEventListener("input", () => { cursor = 0; renderResults(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { cursor = Math.min(cursor + 1, results.length - 1); renderResults(); event.preventDefault(); }
    if (event.key === "ArrowUp") { cursor = Math.max(cursor - 1, 0); renderResults(); event.preventDefault(); }
    if (event.key === "Enter") { const entry = results[cursor]; root.innerHTML = ""; entry?.run(); }
    if (event.key === "Escape") root.innerHTML = "";
  });
  $("#palette-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "palette-backdrop") root.innerHTML = "";
  });
  renderResults();
  input.focus();
}

/* ============ atajos de teclado ============ */
function visiblePRRows() {
  return [...list.querySelectorAll(".pr-row")];
}

function moveCursor(delta) {
  const rows = visiblePRRows();
  if (!rows.length) return;
  state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + delta));
  rows.forEach((r, i) => r.classList.toggle("cursor", i === state.cursor));
  rows[state.cursor].scrollIntoView({ block: "nearest" });
}

function openCheatsheet() {
  const root = $("#modal-root");
  const rows = [
    ["⌘K", "Paleta de comandos (PRs, repos, acciones)"],
    ["j / k", "Moverse por la lista"],
    ["Enter", "Abrir la PR seleccionada"],
    ["1 – 6", "Abiertas · Mías · Para revisar · Borradores · Fusionadas · Cerradas"],
    ["h", "Histórico (grafo de ramas)"],
    ["r", "Refrescar"],
    ["Esc", "Cerrar el panel"],
    ["?", "Esta chuleta"],
  ];
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>⌨️ Atajos de teclado</h3>
        <table class="cheatsheet">${rows.map(([key, what]) => `<tr><td><kbd>${key}</kbd></td><td>${what}</td></tr>`).join("")}</table>
        <div class="modal-actions"><button class="btn" id="modal-cancel">Cerrar</button></div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (typing) return;
  if (event.key === "?") return openCheatsheet();
  if (event.key === "Escape") return closeDetail();
  if (event.key === "r") return refresh();
  if (event.key === "j") return moveCursor(1);
  if (event.key === "k") return moveCursor(-1);
  if (event.key === "Enter" && state.view === "prs" && state.cursor >= 0) {
    const row = visiblePRRows()[state.cursor];
    if (row) openDetail(Number(row.dataset.number));
    return;
  }
  if (event.key === "h") return enterHistory();
  const bucketByDigit = { 1: "open", 2: "mine", 3: "review", 4: "draft", 5: "merged", 6: "closed" };
  if (bucketByDigit[event.key]) switchBucket(bucketByDigit[event.key]);
});

boot();
