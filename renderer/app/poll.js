"use strict";

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
  window.monstro.dockBadge(String([...snapshot.values()].filter((s) => s.reviewMe).length || ""));
  if (!previous) return; // primera carga: sin spam

  for (const [number, now] of snapshot) {
    const before = previous.get(number);
    if (now.reviewMe && !(before?.reviewMe)) {
      window.monstro.notify(t("Te piden review · #{number}", { number }), now.title);
    }
    if (!before || !now.mine) continue;
    if (now.reviewDecision === "APPROVED" && before.reviewDecision !== "APPROVED") {
      window.monstro.notify(t("✅ Aprobada · #{number}", { number }), now.title);
    }
    if (now.reviewDecision === "CHANGES_REQUESTED" && before.reviewDecision !== "CHANGES_REQUESTED") {
      window.monstro.notify(t("± Cambios pedidos · #{number}", { number }), now.title);
    }
    if (["FAILURE", "ERROR"].includes(now.checks) && !["FAILURE", "ERROR"].includes(before.checks)) {
      window.monstro.notify(t("✗ Checks en rojo · #{number}", { number }), now.title);
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
      ? await window.monstro.searchPRs(state.config.repos, bucketStates())
      : await window.monstro.listPRs(state.repo, bucketStates());
    state.prs = prs;
    if (bucketStates()[0] === "OPEN") {
      state.openPrs = prs;
      detectAndNotify(prs);
    } else if (!state.openPrs.length) {
      window.monstro.listPRs(state.repo, ["OPEN"]).then((open) => {
        state.openPrs = open;
        renderCounts();
      }).catch(() => {});
    }
    state.loading = false;
    renderCounts();
    renderList();
    // la ruta merged del selftest notifica aquí: con los datos del bucket ya pintados
    if (IS_SELFTEST && SELFTEST_ROUTE === "merged" && state.bucket === "merged") notifySelftestOnce();
    refreshOpenDetailSilently();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="error-box">${t("No pude cargar {repo}", { repo: esc(state.repo) })}:<br>${esc(String(err.message || err))}</div>`;
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
      window.monstro.prDetail(detailRepo(), state.selected),
      window.monstro.prConversation(detailRepo(), state.selected),
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

/** Tarjeta de Ajustes para el cherry-pick de hotfix (solo GitLab). */
