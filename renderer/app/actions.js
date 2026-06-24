"use strict";

async function updateBranch(pr) {
  const btn = $("#act-update");
  btn.disabled = true;
  btn.textContent = t("Rebasando…");
  try {
    await window.monstro.updateBranch(pr.id);
    toast(t("#{n}: rama actualizada con rebase", { n: pr.number }), "ok");
    await refresh();
    openDetail(pr.number, state.detailTab);
  } catch (err) {
    toast(t("Update falló: {err}", { err: String(err.message || err) }), "err");
    btn.disabled = false;
    btn.textContent = t("⤴ Update branch (rebase)");
  }
}

/** Mi review APPROVED más reciente en la PR, si existe (para poder retirarla). */
function myApprovedReview(pr) {
  return (
    (pr.latestReviews?.nodes || []).find(
      (review) => review.author?.login === state.me?.login && review.state === "APPROVED",
    ) || null
  );
}

function confirmUnapprove(pr) {
  const review = myApprovedReview(pr);
  if (!review?.databaseId) return toast(t("No encuentro tu review aprobada (refresca e inténtalo)"), "err");
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↩︎ ${t("Quitar aprobación de #{n}", { n: pr.number })}</h3>
        <p>${esc(pr.title)}</p>
        <p class="muted">${t("Tu review aprobada se descarta: la PR deja de contar con tu ✓. GitHub lo registra en la conversación junto al motivo.")}</p>
        <input type="text" id="dismiss-reason" placeholder="${t("Motivo (opcional)")}" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Quitar aprobación")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const message = $("#dismiss-reason").value.trim() || "Aprobación retirada desde Monstro";
    root.innerHTML = "";
    try {
      await window.monstro.dismissReview(detailRepo(), pr.number, review.databaseId, message);
      toast(t("Aprobación retirada de #{n}", { n: pr.number }), "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(t("No se pudo retirar: {err}", { err: String(err.message || err) }), "err");
    }
  });
}

function confirmApprove(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>✅ ${t("Aprobar #{n}", { n: pr.number })}</h3>
        <p>${esc(pr.title)}</p>
        <p class="muted">${t("Publica una review de aprobación sin comentarios. Si tienes borradores pendientes, no se tocan.")}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Aprobar")}</button>
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
      await window.monstro.submitReview(detailRepo(), pr.number, { event: "APPROVE" });
      toast(t("#{n} aprobada ✅", { n: pr.number }), "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(t("No se pudo aprobar: {err}", { err: String(err.message || err) }), "err");
    }
  });
}

function confirmMerge(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t("Merge de #{n}", { n: pr.number })}</h3>
        <p><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b> ${t("con <b>merge commit</b>.")}</p>
        <p class="muted">${t("Squash no es una opción. Nunca lo fue.")}</p>
        ${pr.isCrossRepository ? "" : `<label><input type="checkbox" id="del-branch" checked /> ${t("Borrar la rama tras el merge")}</label>`}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Confirmar merge")}</button>
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
      const res = await window.monstro.mergePR({
        repo: detailRepo(),
        number: pr.number,
        deleteBranch,
        headRefName: pr.headRefName,
        isCrossRepository: pr.isCrossRepository,
      });
      toast(res.merged ? `${t("#{n} fusionada (merge commit)", { n: pr.number })}${res.branchDeleted ? t(" · rama borrada") : ""}` : t("Merge no completado"), res.merged ? "ok" : "err");
      // Tras un merge de hotfix/* (solo GitLab), ofrecer replicar el contenido a otras ramas.
      // En su propio try: un fallo aquí no debe mostrar "Merge falló" (el merge ya fue bien).
      if (res.merged && res.sha && shouldOfferCherryPick(pr)) {
        try {
          await offerCherryPick(pr, res.sha);
        } catch (cpErr) {
          toast(t("No se pudo ofrecer el cherry-pick: {err}", { err: String(cpErr.message || cpErr) }), "err");
        }
      }
      closeDetail();
      await refresh();
    } catch (err) {
      toast(t("Merge falló: {err}", { err: String(err.message || err) }), "err");
    }
  });
}

/* ============ cherry-pick de hotfix tras merge (solo GitLab) ============ */

/** ¿Esta MR mergeada dispara el ofrecimiento de cherry-pick? */
function shouldOfferCherryPick(pr) {
  if (!isGitlab()) return false;
  const base = String(pr.baseRefName || "");
  // Dispara si la rama destino es una release branch (rb/ o rb/-mx)
  if (/(^|\/)rb\//.test(base) || base.endsWith("-mx")) return true;
  // Dispara si la rama origen lleva el prefijo hotfix/
  const cp = state.config?.cherryPick;
  const prefix = cp?.prefix?.trim();
  return !!prefix && String(pr.headRefName || "").startsWith(prefix);
}

/** Deriva la rama hermana de una release branch: mx ⇄ sin mx. null si no aplica. */
function siblingMxBranch(base) {
  if (!base) return null;
  // Solo tiene sentido sobre release branches (convención rb/…) o ramas ya -mx.
  if (!(/(^|\/)rb\//.test(base) || base.endsWith("-mx"))) return null;
  return base.endsWith("-mx") ? base.slice(0, -"-mx".length) : `${base}-mx`;
}

/** Ramas destino propuestas para el cherry-pick, derivadas de la config y del destino del merge. */
function cherryPickTargets(pr) {
  const cp = state.config?.cherryPick || {};
  const base = pr.baseRefName;
  const targets = [...(cp.branches || [])];
  if (cp.siblingMx) {
    const sibling = siblingMxBranch(base);
    if (sibling) targets.push(sibling);
  }
  // Sin duplicados y sin la propia rama destino del merge (ya tiene el contenido).
  return [...new Set(targets)].filter((b) => b && b !== base);
}

/**
 * Pregunta como precaución (nunca auto-dispara): hace dry-run de cada rama destino,
 * muestra el resultado por-rama y deja confirmar/desmarcar antes de aplicar de verdad.
 */
async function offerCherryPick(pr, sha) {
  const repo = detailRepo();
  const targets = cherryPickTargets(pr);
  if (!targets.length) return;

  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="cp-backdrop">
      <div class="modal">
        <h3>${t("Cherry-pick de #{n}", { n: pr.number })}</h3>
        <p class="muted"><b>${esc(pr.headRefName)}</b> ${t("se mergeó en")} <b>${esc(pr.baseRefName)}</b>. ${t("¿Replico su contenido a estas ramas?")}</p>
        <p class="muted">${t("Comprobando conflictos…")}</p>
      </div>
    </div>`;

  // Dry-run en paralelo: anticipa conflictos / ramas protegidas antes de escribir nada.
  const checks = await Promise.all(
    targets.map((branch) => window.monstro.cherryPick(repo, sha, branch, true)),
  );

  await new Promise((resolve) => {
    const rows = checks
      .map((c, i) => {
        const ok = c.ok;
        const id = `cp-b-${i}`;
        const status = ok
          ? `<span class="checks-success">✓ ${t("aplica limpio")}</span>`
          : `<span class="checks-failure">✗ ${esc(c.error || t("conflicto"))}</span>`;
        return `<label class="cp-row"><input type="checkbox" id="${id}" data-branch="${esc(c.branch)}" ${ok ? "checked" : ""} /> <b>${esc(c.branch)}</b> — ${status}</label>`;
      })
      .join("");
    root.innerHTML = `
      <div class="modal-backdrop" id="cp-backdrop">
        <div class="modal">
          <h3>${t("Cherry-pick de #{n}", { n: pr.number })}</h3>
          <p class="muted"><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b>. ${t("Replica el contenido a:")}</p>
          <div class="cp-targets">${rows}</div>
          <div class="modal-actions">
            <button class="btn" id="cp-skip">${t("Ahora no")}</button>
            <button class="btn btn-primary" id="cp-go">${t("Hacer cherry-pick")}</button>
          </div>
        </div>
      </div>`;

    const close = () => {
      root.innerHTML = "";
      resolve();
    };
    $("#cp-skip").addEventListener("click", close);
    $("#cp-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "cp-backdrop") close();
    });
    $("#cp-go").addEventListener("click", async () => {
      const branches = [...root.querySelectorAll(".cp-targets input:checked")].map((el) => el.dataset.branch);
      root.innerHTML = "";
      if (!branches.length) return resolve();
      // No atómico entre ramas: aplicamos en secuencia y reportamos por-rama.
      const results = [];
      for (const branch of branches) {
        results.push(await window.monstro.cherryPick(repo, sha, branch, false));
      }
      const ok = results.filter((r) => r.ok).map((r) => r.branch);
      const failed = results.filter((r) => !r.ok);
      if (ok.length) toast(t("Cherry-pick OK: {branches}", { branches: ok.join(", ") }), "ok");
      for (const f of failed) toast(t("Cherry-pick falló en {branch}: {err}", { branch: f.branch, err: f.error }), "err");
      resolve();
    });
  });
}

/* ============ vista histórico ============ */
