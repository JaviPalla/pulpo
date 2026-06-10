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
  detailTab: "conv", // "conv" | "changes"
  detailPR: null,
  conversation: null,
  files: null,
  search: "",
  loading: false,
  pollTimer: null,
  selftestNotified: false,
  selftestOpenedDetail: false,
  history: { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null },
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
      <article class="pr-row ${state.selected === pr.number ? "selected" : ""}" data-number="${pr.number}">
        <img class="avatar" src="${esc(pr.author?.avatarUrl || "")}" alt="" />
        <div class="pr-title-line">
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
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · 💬 ${pr.comments?.totalCount ?? 0}</span>
        </div>
      </article>`,
    )
    .join("");
  list.querySelectorAll(".pr-row").forEach((row) =>
    row.addEventListener("click", () => openDetail(Number(row.dataset.number))),
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

async function openDetail(number, tab = "conv") {
  state.selected = number;
  state.detailTab = tab;
  state.files = null;
  state.conversation = null;
  renderList();
  detailPane.classList.remove("hidden");
  detailPane.classList.toggle("wide", tab === "changes");
  detailContent.innerHTML = `<div class="detail-inner"><div class="loading">Cargando #${number}…</div></div>`;
  try {
    const [pr, conversation] = await Promise.all([
      window.pulpo.prDetail(state.repo, number),
      window.pulpo.prConversation(state.repo, number),
    ]);
    state.detailPR = pr;
    state.conversation = conversation;
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
      </div>
      ${blockReason && pr.state === "OPEN" ? `<p class="muted">⚠️ ${esc(blockReason)}</p>` : ""}

      <div class="tabs">
        <button class="tab ${state.detailTab === "conv" ? "active" : ""}" data-tab="conv">
          Conversación <span class="count">${pr.comments?.totalCount ?? 0}</span>
        </button>
        <button class="tab ${state.detailTab === "changes" ? "active" : ""}" data-tab="changes">
          Cambios <span class="count">${pr.changedFiles} ficheros · ${threadCount} hilos</span>
        </button>
      </div>

      <div id="tab-body"></div>
    </div>`;

  $("#detail-close").addEventListener("click", closeDetail);
  $("#act-update").addEventListener("click", () => updateBranch(pr));
  $("#act-merge").addEventListener("click", () => confirmMerge(pr));
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
  $("#tab-body").innerHTML = `
    <div class="section-h">Descripción</div>
    <div class="pr-body">${pr.bodyHTML || "<p class='muted'>Sin descripción.</p>"}</div>
    <div class="section-h">Comentarios (${comments.length})</div>
    ${comments.map(commentBlock).join("") || `<p class="muted">Nadie ha dicho nada todavía.</p>`}
    <div class="composer">
      <textarea id="new-comment" rows="3" placeholder="Escribe un comentario… (markdown soportado)"></textarea>
      <div class="composer-actions">
        <button class="btn btn-accent" id="send-comment">Comentar</button>
      </div>
    </div>`;
  wireExternalLinks();
  $("#send-comment").addEventListener("click", async () => {
    const body = $("#new-comment").value.trim();
    if (!body) return;
    $("#send-comment").disabled = true;
    try {
      await window.pulpo.commentIssue(state.repo, pr.number, body);
      toast("Comentario publicado", "ok");
      state.conversation = await window.pulpo.prConversation(state.repo, pr.number);
      renderDetail();
    } catch (err) {
      toast(`No se pudo comentar: ${String(err.message || err)}`, "err");
      $("#send-comment").disabled = false;
    }
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
  return `
    <tr class="diff-line ${cls}" data-path="${esc(file.filename)}" data-line="${commentLine ?? ""}" data-side="${side}">
      <td class="gutter">${line.old ?? ""}</td>
      <td class="gutter">${line.new ?? ""}<button class="add-comment" title="Comentar esta línea">+</button></td>
      <td class="code"><span class="sign">${sign}</span>${esc(line.text)}</td>
    </tr>${threadsHtml}`;
}

function renderChangesTab() {
  const files = state.files;
  if (!files) {
    $("#tab-body").innerHTML = `<div class="loading">Cargando diff…</div>`;
    window.pulpo.prFiles(state.repo, state.detailPR.number).then((loaded) => {
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
        await window.pulpo.replyThread(state.repo, state.detailPR.number, Number(btn.dataset.reply), body);
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
        <div class="muted" style="margin-bottom:6px">Comentando <code>${esc(path)}</code> línea ${esc(line)} (${side === "LEFT" ? "versión anterior" : "versión nueva"})</div>
        <textarea rows="3" placeholder="Tu comentario…"></textarea>
        <div class="composer-actions">
          <button class="btn cancel">Cancelar</button>
          <button class="btn btn-accent send">Comentar</button>
        </div>
      </div>
    </td>`;
  tr.after(row);
  row.querySelector("textarea").focus();
  row.querySelector(".cancel").addEventListener("click", () => row.remove());
  row.querySelector(".send").addEventListener("click", async () => {
    const body = row.querySelector("textarea").value.trim();
    if (!body) return;
    row.querySelector(".send").disabled = true;
    try {
      await window.pulpo.commentInline(state.repo, state.detailPR.number, {
        body,
        commitId: state.conversation.headRefOid,
        path,
        side,
        line: Number(line),
      });
      toast("Comentario publicado en la línea", "ok");
      state.conversation = await window.pulpo.prConversation(state.repo, state.detailPR.number);
      renderChangesTab();
    } catch (err) {
      toast(`No se pudo comentar: ${String(err.message || err)}`, "err");
      row.querySelector(".send").disabled = false;
    }
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
        repo: state.repo,
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
    const prs = await window.pulpo.listPRs(state.repo, bucketStates());
    state.prs = prs;
    if (bucketStates()[0] === "OPEN") state.openPrs = prs;
    else if (!state.openPrs.length) {
      window.pulpo.listPRs(state.repo, ["OPEN"]).then((open) => {
        state.openPrs = open;
        renderCounts();
      }).catch(() => {});
    }
    state.loading = false;
    renderCounts();
    renderList();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="error-box">No pude cargar ${esc(state.repo)}:<br>${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
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
}

/* ============ arranque ============ */
function renderRepoSelect() {
  const select = $("#repo-select");
  select.innerHTML = (state.config?.repos || [])
    .map((r) => `<option value="${esc(r)}" ${r === state.repo ? "selected" : ""}>${esc(r)}</option>`)
    .join("");
}

async function boot() {
  state.config = await window.pulpo.getConfig();
  state.repo = state.repo && state.config.repos.includes(state.repo) ? state.repo : state.config.repos[0] || null;
  renderRepoSelect();

  const auth = await window.pulpo.authStatus();
  state.authSource = auth.source;
  if (auth.ok) {
    state.me = { login: auth.login, avatarUrl: auth.avatarUrl };
    $("#me").innerHTML = `<img src="${esc(auth.avatarUrl)}" alt="" /> ${esc(auth.login)}`;
  } else {
    $("#me").innerHTML = "";
    list.innerHTML = `<div class="error-box">Sin token de GitHub válido.<br>
      <span class="muted">Haz <code>gh auth login</code>, exporta <code>GITHUB_TOKEN</code>, o guarda un token en Ajustes ⚙.</span></div>`;
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
  state.repo = event.target.value;
  state.openPrs = [];
  state.history = { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null };
  closeDetail();
  if (state.view === "history") loadHistory();
  else refresh();
});
$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
document.querySelectorAll(".bucket[data-bucket]").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.view = "prs";
    state.bucket = btn.dataset.bucket;
    closeDetail();
    refresh();
  }),
);
$("#bucket-history").addEventListener("click", enterHistory);
document.addEventListener("keydown", (event) => {
  if (event.key === "r" && !event.metaKey && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") refresh();
  if (event.key === "Escape") closeDetail();
});

boot();
