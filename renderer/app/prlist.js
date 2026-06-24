"use strict";

function stateChip(pr) {
  if (pr.state === "MERGED") return `<span class="chip chip-merged">${t("Fusionada")}</span>`;
  if (pr.state === "CLOSED") return `<span class="chip chip-closed">${t("Cerrada")}</span>`;
  if (pr.isDraft) return `<span class="chip chip-draft">${t("Borrador")}</span>`;
  return `<span class="chip chip-open">${t("Abierta")}</span>`;
}

function reviewChip(pr) {
  if (pr.state !== "OPEN") return "";
  switch (pr.reviewDecision) {
    case "APPROVED": return `<span class="chip chip-approved">✓ ${t("Aprobada")}</span>`;
    case "CHANGES_REQUESTED": return `<span class="chip chip-changes">± ${t("Cambios pedidos")}</span>`;
    case "REVIEW_REQUIRED": return `<span class="chip chip-review">${t("Falta revisión")}</span>`;
    default: return "";
  }
}

function mergeStateChip(pr) {
  if (pr.state !== "OPEN") return "";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return `<span class="chip chip-conflict">${t("Conflictos")}</span>`;
  if (pr.mergeStateStatus === "BEHIND") return `<span class="chip chip-behind">${t("Rama atrasada")}</span>`;
  return "";
}

function checksIcon(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return "";
  const map = {
    SUCCESS: ["✓", "checks-success", t("Checks en verde")],
    FAILURE: ["✗", "checks-failure", t("Checks fallando")],
    ERROR: ["✗", "checks-failure", t("Checks con error")],
    PENDING: ["●", "checks-pending", t("Checks en curso")],
    EXPECTED: ["●", "checks-pending", t("Checks esperados")],
  };
  const [icon, cls, title] = map[rollup.state] || ["", "", ""];
  return icon ? `<span class="checks ${cls}" title="${title}">${icon}</span>` : "";
}

/** Avatares con tick verde de quienes han aprobado (estilo Bitbucket). */
function approvalFaces(pr) {
  const approvers = [];
  const seen = new Set();
  for (const review of pr.latestReviews?.nodes || []) {
    if (review.state !== "APPROVED" || !review.author || seen.has(review.author.login)) continue;
    seen.add(review.author.login);
    approvers.push(review.author);
  }
  if (!approvers.length) return "";
  const MAX_FACES = 4;
  const shown = approvers.slice(0, MAX_FACES);
  const extra = approvers.length - shown.length;
  return `
    <span class="facepile" title="${t("Aprobada por {who}", { who: esc(approvers.map((a) => a.login).join(", ")) })}">
      ${shown.map((a) => `
        <span class="face">
          <img src="${esc(a.avatarUrl)}" alt="${esc(a.login)}" />
          <span class="face-tick">✓</span>
        </span>`).join("")}
      ${extra > 0 ? `<span class="face face-more">+${extra}</span>` : ""}
    </span>`;
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
    list.innerHTML = `<div class="empty"><span class="big">${mascot(48)}</span>${t("Nada por aquí. Todo tranquilo.")}</div>`;
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
          ${approvalFaces(pr)} ${checksIcon(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)} ${stateChip(pr)}
        </div>
        <div class="pr-sub">
          <span class="branches">
            <span class="branch" title="${esc(pr.headRefName)}">${esc(pr.headRefName)}</span>
            <span class="arrow">→</span>
            <span class="branch" title="${esc(pr.baseRefName)}">${esc(pr.baseRefName)}</span>
          </span>
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · <span class="checks-success">+${pr.additions ?? 0}</span>/<span class="checks-failure">−${pr.deletions ?? 0}</span> · 💬 ${pr.comments?.totalCount ?? 0}${state.draftKeys.has(`${pr.repository?.nameWithOwner || state.repo}#${pr.number}`) ? ` · 📝 ${t("borradores")}` : ""}</span>
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
  if (pr.state !== "OPEN") return t("La PR no está abierta");
  if (pr.isDraft) return t("Es un borrador");
  if (pr.mergeable === "CONFLICTING") return t("Tiene conflictos con la base");
  if (pr.mergeStateStatus === "BEHIND") return t("La rama está atrasada: actualiza primero (rebase)");
  if (pr.mergeStateStatus === "BLOCKED") return t("Bloqueada por checks o revisiones requeridas");
  return "";
}
