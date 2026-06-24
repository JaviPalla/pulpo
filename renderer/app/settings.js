"use strict";

function cherryPickSettingsCard(cfg) {
  const cp = cfg.cherryPick || {};
  const branches = cp.branches || [];
  return `
    <div class="settings-card">
      <h4>${t("Cherry-pick de hotfix")} 🍒</h4>
      <p class="muted">${t("Las MR cuya rama origen empiece por el prefijo y vayan a la release branch ofrecen, tras el merge, replicar su contenido a otras ramas (te pregunta primero, nunca automático).")}</p>
      <div class="add-repo">
        <input type="text" id="cp-prefix" value="${esc(cp.prefix || "")}" placeholder="hotfix/" />
        <span class="muted" style="align-self:center">${t("prefijo de rama origen")}</span>
      </div>
      <label style="display:block;margin:8px 0">
        <input type="checkbox" id="cp-sibling" ${cp.siblingMx ? "checked" : ""} />
        ${t("Añadir también la rama hermana de la release branch destino (mx ⇄ sin mx)")}
      </label>
      <p class="muted">${t("Ramas destino fijas (además de la hermana -mx):")}</p>
      <div id="cp-branch-lines">
        ${branches.map((b) => `<div class="repo-line">${esc(b)} <button class="btn" data-cp-del="${esc(b)}">${t("Quitar")}</button></div>`).join("") || `<p class="muted">${t("— ninguna —")}</p>`}
      </div>
      <div class="add-repo">
        <input type="text" id="cp-new-branch" placeholder="development" />
        <button class="btn btn-accent" id="cp-add-branch">${t("Añadir rama")}</button>
      </div>
      <div class="add-repo">
        <button class="btn" id="cp-save">${t("Guardar prefijo y opción")}</button>
      </div>
    </div>`;
}

const THEMES = [
  { id: "one-dark", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "github-light", label: "GitHub Light" },
];

/** Filas de muestra (con add/del/ctx) para previsualizar el tema de sintaxis en Ajustes. */
function themePreviewRows() {
  const hl = (code, family) =>
    window.monstroHL ? window.monstroHL.highlightLine(code, family) : esc(code);
  const rows = [
    { cls: "diff-ctx", sign: " ", fam: "c", code: `// Suma dos números y devuelve el total` },
    { cls: "diff-del", sign: "−", fam: "c", code: `function add(a, b) { return a - b; }` },
    { cls: "diff-add", sign: "+", fam: "c", code: `const add = (a, b) => a + b; // 42, "ok", true` },
    { cls: "diff-ctx", sign: " ", fam: "c", code: `class Calc extends Base { value = 3.14; }` },
    { cls: "diff-ctx", sign: " ", fam: "hash", code: `def total(items): return sum(items)  # Python` },
  ];
  return rows
    .map(
      (r) =>
        `<tr class="diff-line ${r.cls}"><td class="code"><span class="sign">${r.sign}</span>${hl(r.code, r.fam)}</td></tr>`,
    )
    .join("");
}

function openSettings() {
  const root = $("#settings-root");
  root.classList.remove("hidden");
  const cfg = state.config;
  root.innerHTML = `
    <div class="settings-inner">
      <button class="btn" id="settings-back">← ${t("Volver")}</button>
      <h2 style="margin-top:14px">${t("Ajustes")}</h2>
      <div class="settings-card">
        <h4>${t("Proveedor")}</h4>
        <p class="muted">${t("Actual:")} <b>${providerName()}</b>${isGitlab() ? ` · <code>${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}</code>` : ""}.</p>
        ${isGitlab() ? `<div class="add-repo">
          <input type="text" id="gitlab-base" placeholder="${t("URL base (self-hosted)")}" value="${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}" />
          <button class="btn" id="save-gitlab-base">${t("Guardar URL")}</button>
        </div>` : ""}
        <div class="add-repo">
          <button class="btn" id="switch-provider" data-target="${isGitlab() ? "github" : "gitlab"}">${t("Cambiar a {name}", { name: isGitlab() ? "GitHub 🐙" : "GitLab 🦊" })}</button>
        </div>
        <p class="muted">${t("Cambiar de proveedor reinicia el onboarding (repos y token se piden de nuevo).")}</p>
      </div>
      <div class="settings-card">
        <h4>${t("Repositorios")}</h4>
        <div id="repo-lines">
          ${cfg.repos.map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">${t("Quitar")}</button></div>`).join("")}
        </div>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="${repoPlaceholder()}" />
          <button class="btn btn-accent" id="add-repo">${t("Añadir")}</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("Token de {name}", { name: providerName() })}</h4>
        <p class="muted">${t("Origen actual:")} <b>${esc(state.authSource || t("ninguno"))}</b>. ${t("Orden:")} <code>${isGitlab() ? "GITLAB_TOKEN" : "GITHUB_TOKEN"}</code> → <code>${isGitlab() ? "glab CLI" : "gh auth token"}</code> → ${t("token manual.")}</p>
        <div class="add-repo">
          <input type="password" id="manual-token" placeholder="${cfg.hasManualToken ? t("•••••••• (guardado)") : isGitlab() ? t("glpat-… (opcional)") : t("ghp_… (opcional)")}" />
          <button class="btn" id="save-token">${t("Guardar")}</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("IA (Review con IA 🤖)")}</h4>
        <p class="muted" id="ai-status-line">${t("Comprobando backend…")}</p>
        <div class="add-repo">
          <select id="ai-model" disabled><option>${t("Cargando modelos…")}</option></select>
          <select id="ai-effort" disabled></select>
        </div>
        <p class="muted">${t("Modelo y esfuerzo se aplican a cada review (API directa o CLI de Claude Code). Cada borrador queda etiquetado con lo que lo generó.")}</p>
        <button class="btn" id="test-ai">${t("Probar conexión con Claude")}</button>
      </div>
      <div class="settings-card">
        <h4>${t("Refresco automático")}</h4>
        <div class="add-repo">
          <input type="number" id="poll-seconds" min="15" value="${cfg.pollSeconds}" />
          <span class="muted" style="align-self:center">${t("segundos")}</span>
        </div>
      </div>
      ${isGitlab() ? cherryPickSettingsCard(cfg) : ""}
      <div class="settings-card">
        <h4>${t("Idioma")} 🌐</h4>
        <p class="muted">${t("Idioma de la interfaz. Por defecto sigue el idioma del sistema.")}</p>
        <div class="add-repo">
          <select id="app-language">
            <option value="system" ${!cfg.language ? "selected" : ""}>${t("Sistema")}</option>
            <option value="es" ${cfg.language === "es" ? "selected" : ""}>Español</option>
            <option value="en" ${cfg.language === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("Tema de interfaz")} ✦</h4>
        <p class="muted">${t("Aspecto visual general de la aplicación.")}</p>
        <div class="add-repo">
          <select id="ui-theme">
            <option value="default" ${(cfg.uiTheme || "default") === "default" ? "selected" : ""}>${t("Por defecto")}</option>
            <option value="liquid-glass" ${(cfg.uiTheme || "default") === "liquid-glass" ? "selected" : ""}>Liquid Glass</option>
          </select>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("Tema de sintaxis")} 🎨</h4>
        <p class="muted">${t("Colores del resaltado de código en la pantalla de Cambios.")}</p>
        <div class="add-repo">
          <select id="syntax-theme">
            ${THEMES.map((th) => `<option value="${th.id}" ${(cfg.theme || "one-dark") === th.id ? "selected" : ""}>${esc(th.label)}</option>`).join("")}
          </select>
        </div>
        <div class="theme-preview" data-syntax-theme="${esc(cfg.theme || "one-dark")}" id="theme-preview">
          <table class="diff-table">${themePreviewRows()}</table>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("Reglas de la casa")}</h4>
        <p class="muted">pull → <b>rebase</b> · merge → <b>merge commit</b> · squash → <b style="text-decoration:line-through">${t("jamás")}</b>. ${t("No configurable. A propósito.")}</p>
      </div>
    </div>`;

  $("#settings-back").addEventListener("click", async () => {
    const pollSeconds = parseInt($("#poll-seconds").value, 10);
    if (Number.isInteger(pollSeconds) && pollSeconds >= 15 && pollSeconds !== cfg.pollSeconds) {
      state.config = await window.monstro.setConfig({ pollSeconds });
      schedulePoll();
    }
    root.classList.add("hidden");
    root.innerHTML = "";
    // Si el usuario quitó todos los repos, volvemos al picker del onboarding.
    if (!state.config.repos.length) boot();
  });
  $("#add-repo").addEventListener("click", async () => {
    const value = $("#new-repo").value.trim();
    if (!repoRe().test(value)) return toast(t("Formato esperado: {fmt}", { fmt: repoPlaceholder() }), "err");
    state.config = await window.monstro.setConfig({ repos: [...cfg.repos, value] });
    renderRepoSelect();
    openSettings();
  });
  $("#switch-provider")?.addEventListener("click", async () => {
    const target = $("#switch-provider").dataset.target;
    // Cambiar de proveedor vacía repos y token: el onboarding los pedirá de nuevo.
    state.config = await window.monstro.setConfig({ provider: target, repos: [] });
    state.repo = null;
    root.classList.add("hidden");
    root.innerHTML = "";
    boot();
  });
  $("#save-gitlab-base")?.addEventListener("click", async () => {
    const base = $("#gitlab-base").value.trim();
    if (!/^https:\/\/[\w.-]+/.test(base)) return toast(t("URL no válida (https://…)"), "err");
    state.config = await window.monstro.setConfig({ gitlabBaseUrl: base });
    toast(t("URL base guardada"), "ok");
    boot();
  });
  root.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      state.config = await window.monstro.setConfig({ repos: cfg.repos.filter((r) => r !== btn.dataset.del) });
      if (state.repo === btn.dataset.del) state.repo = state.config.repos[0] || null;
      renderRepoSelect();
      openSettings();
    }),
  );
  $("#save-token").addEventListener("click", async () => {
    state.config = await window.monstro.setConfig({ token: $("#manual-token").value });
    toast(t("Token guardado"), "ok");
    boot();
  });
  $("#app-language").addEventListener("change", (event) => {
    const value = event.target.value;
    setLanguage(value === "system" ? null : value);
  });
  $("#ui-theme").addEventListener("change", async (event) => {
    const uiTheme = event.target.value;
    state.config = await window.monstro.setConfig({ uiTheme });
    applyUiTheme(uiTheme);
  });
  $("#syntax-theme").addEventListener("change", async (event) => {
    const theme = event.target.value;
    // Preview instantáneo antes de persistir.
    $("#theme-preview").dataset.syntaxTheme = theme;
    state.config = await window.monstro.setConfig({ theme });
    applyTheme(theme);
  });

  // --- Cherry-pick de hotfix (solo GitLab) ---
  const saveCherryPick = async (partial) => {
    const cp = { ...(state.config.cherryPick || {}), ...partial };
    state.config = await window.monstro.setConfig({ cherryPick: cp });
  };
  $("#cp-save")?.addEventListener("click", async () => {
    const prefix = $("#cp-prefix").value.trim();
    if (!prefix) return toast(t("El prefijo no puede estar vacío"), "err");
    await saveCherryPick({ prefix, siblingMx: $("#cp-sibling").checked });
    toast(t("Cherry-pick configurado"), "ok");
    openSettings();
  });
  $("#cp-add-branch")?.addEventListener("click", async () => {
    const value = $("#cp-new-branch").value.trim();
    if (!BRANCH_RE.test(value)) return toast(t("Nombre de rama no válido"), "err");
    const branches = [...new Set([...(cfg.cherryPick?.branches || []), value])];
    await saveCherryPick({ branches });
    openSettings();
  });
  root.querySelectorAll("[data-cp-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const branches = (cfg.cherryPick?.branches || []).filter((b) => b !== btn.dataset.cpDel);
      await saveCherryPick({ branches });
      openSettings();
    }),
  );

  window.monstro.aiStatus().then((s) => {
    const line = $("#ai-status-line");
    if (line) line.innerHTML = s.backend
      ? `✓ <b>${esc(s.backend)}</b> — ${esc(s.detail)}`
      : `✗ ${esc(s.detail)}`;

    const modelSel = $("#ai-model");
    const effortSel = $("#ai-effort");
    if (!modelSel || !effortSel || !Array.isArray(s.models)) return;
    let currentEffort = s.effort;
    const renderEfforts = (modelId) => {
      const info = s.models.find((m) => m.id === modelId);
      if (!info || !info.efforts.length) {
        effortSel.innerHTML = `<option value="">${t("esfuerzo: no aplicable")}</option>`;
        effortSel.disabled = true;
        return;
      }
      const selected = info.efforts.includes(currentEffort) ? currentEffort : "high";
      effortSel.innerHTML = info.efforts
        .map((e) => `<option value="${e}" ${e === selected ? "selected" : ""}>${t("esfuerzo: {level}", { level: e })}</option>`)
        .join("");
      effortSel.disabled = false;
    };
    modelSel.innerHTML = s.models
      .map((m) => `<option value="${esc(m.id)}" ${m.id === s.model ? "selected" : ""}>${esc(m.label)}</option>`)
      .join("");
    modelSel.disabled = false;
    renderEfforts(s.model);
    modelSel.addEventListener("change", async () => {
      renderEfforts(modelSel.value);
      const payload = { aiModel: modelSel.value };
      if (effortSel.value) payload.aiEffort = effortSel.value;
      state.config = await window.monstro.setConfig(payload);
      toast(`${t("Review con IA:")} ${modelSel.value}${effortSel.value ? ` · ${t("esfuerzo {level}", { level: effortSel.value })}` : ""}`, "ok");
    });
    effortSel.addEventListener("change", async () => {
      if (!effortSel.value) return;
      currentEffort = effortSel.value;
      state.config = await window.monstro.setConfig({ aiEffort: effortSel.value });
      toast(`${t("Review con IA:")} ${t("esfuerzo {level}", { level: effortSel.value })}`, "ok");
    });
  }).catch(() => {});
  $("#test-ai").addEventListener("click", async () => {
    const btn = $("#test-ai");
    btn.disabled = true;
    btn.textContent = t("Probando… (puede tardar ~30s)");
    try {
      const result = await window.monstro.aiPing();
      toast(result.ok ? t("IA OK vía {backend}", { backend: result.backend }) : t("IA no disponible: {detail}", { detail: result.detail }), result.ok ? "ok" : "err");
      const line = $("#ai-status-line");
      if (line) line.innerHTML = `${result.ok ? "✓" : "✗"} <b>${esc(result.backend || t("sin backend"))}</b> — ${esc(result.detail)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = t("Probar conexión con Claude");
    }
  });
}

/* ============ bienvenida / onboarding ============ */

/** Primer paso del onboarding: elegir proveedor (GitHub o GitLab). */
async function renderProviderChooser() {
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("¿Con qué trabajas?")}</h2>
      <p class="muted">${t("Elige tu proveedor. Podrás cambiarlo luego en Ajustes ⚙.")}</p>
      <div class="provider-choice">
        <button class="repo-option provider-option" data-provider="github">
          <span class="repo-name">🐙 GitHub</span>
        </button>
        <button class="repo-option provider-option" data-provider="gitlab">
          <span class="repo-name">🦊 GitLab</span>
        </button>
      </div>
      <div class="add-repo picker-manual" id="gitlab-base-row" style="display:none">
        <input type="text" id="gitlab-base-input" placeholder="${t("URL de GitLab (self-hosted): https://gitlab.miempresa.com")}" />
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="provider-continue" disabled>${t("Continuar")}</button>
      </div>
    </div>`;

  let chosen = null;
  const baseRow = $("#gitlab-base-row");
  const continueBtn = $("#provider-continue");
  list.querySelectorAll("[data-provider]").forEach((btn) =>
    btn.addEventListener("click", () => {
      chosen = btn.dataset.provider;
      list.querySelectorAll(".provider-option").forEach((b) => b.classList.toggle("selected", b === btn));
      baseRow.style.display = chosen === "gitlab" ? "" : "none";
      continueBtn.disabled = false;
    }),
  );
  continueBtn.addEventListener("click", async () => {
    if (!chosen) return;
    const partial = { provider: chosen };
    if (chosen === "gitlab") {
      const base = $("#gitlab-base-input").value.trim();
      if (base) {
        if (!/^https:\/\/[\w.-]+/.test(base)) return toast(t("URL no válida (https://…)"), "err");
        partial.gitlabBaseUrl = base;
      }
    }
    state.config = await window.monstro.setConfig(partial);
    boot();
  });
  notifySelftestOnce();
}

async function renderWelcome() {
  const aiStatus = await window.monstro.aiStatus().catch(() => ({ backend: null, detail: "" }));
  const aiOk = Boolean(aiStatus.backend);
  const gitlab = isGitlab();
  const cliCmd = gitlab ? "brew install glab && glab auth login" : "brew install gh && gh auth login";
  const cliName = gitlab ? t("CLI oficial de GitLab (glab)") : t("CLI oficial de GitHub");
  const envVar = gitlab ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("Bienvenido a Monstro")}</h2>
      <p class="muted">${t("Dos pasos y listo. Monstro no guarda credenciales: usa las sesiones que ya tienes.")}</p>

      <div class="setup-step bad">
        <div class="setup-mark">1</div>
        <div>
          <b>${t("Conecta {name}", { name: providerName() })}</b> <span class="chip chip-closed">${t("pendiente")}</span>
          <p class="muted">${t("La vía fácil es el {cli} — Monstro coge el token de ahí:", { cli: cliName })}</p>
          <pre class="setup-cmd">${cliCmd}</pre>
          <p class="muted">${t("Alternativas: exporta")} <code>${envVar}</code>${t(", o pega un token en Ajustes ⚙.")}</p>
        </div>
      </div>

      <div class="setup-step ${aiOk ? "ok" : ""}">
        <div class="setup-mark">2</div>
        <div>
          <b>${t("Conecta Claude")}</b> <span class="chip ${aiOk ? "chip-open" : "chip-draft"}">${aiOk ? t("listo") : t("opcional")}</span>
          <p class="muted">${aiOk
            ? t("Detectado: {detail} — el botón 🤖 Review con IA ya funciona.", { detail: esc(aiStatus.detail) })
            : `${t("Para el botón 🤖 Review con IA: instala")} <a href="#" data-ext="https://claude.com/claude-code">Claude Code</a> ${t("y ábrelo una vez para autenticarte (Monstro usará tu sesión), o exporta")} <code>ANTHROPIC_API_KEY</code>.`}</p>
        </div>
      </div>

      <div class="welcome-actions">
        <button class="btn btn-accent" id="welcome-retry">${t("He hecho login — Reintentar")}</button>
        <button class="btn" id="welcome-settings">${t("Abrir Ajustes ⚙")}</button>
      </div>
      <p class="muted small-print">${t("¿Dudas?")} <code>npm run doctor</code> ${t("en la terminal diagnostica todo esto por ti.")}</p>
    </div>`;
  $("#welcome-retry").addEventListener("click", boot);
  $("#welcome-settings").addEventListener("click", openSettings);
  list.querySelectorAll("[data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      window.monstro.openExternal(a.dataset.ext);
    }),
  );
}

/** Paso final del onboarding: GitHub conectado pero sin repos elegidos todavía. */
async function renderRepoPicker() {
  const selected = new Set();
  let suggestions = [];
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("¿Qué repositorios quieres ver?")}</h2>
      <p class="muted">${t("Conectado como")} <b>${esc(state.me?.login || "?")}</b>. ${t("Marca los repos que Monstro vigilará — podrás cambiarlos cuando quieras en Ajustes ⚙.")}</p>
      <div id="repo-picker" class="repo-picker"><div class="empty">${t("Buscando tus repositorios…")}</div></div>
      <div class="add-repo picker-manual">
        <input type="text" id="picker-manual-input" placeholder="${t("¿Falta alguno? Escríbelo: {fmt}", { fmt: repoPlaceholder() })}" />
        <button class="btn" id="picker-manual-add">${t("Añadir")}</button>
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="picker-start" disabled>${t("Empezar")}</button>
      </div>
    </div>`;

  const rowsEl = $("#repo-picker");
  const startBtn = $("#picker-start");

  const renderRows = () => {
    const names = [...new Set([...suggestions.map((s) => s.nameWithOwner), ...selected])];
    if (!names.length) {
      rowsEl.innerHTML = `<div class="empty">${t("No encontré repos accesibles con tu token — añade uno a mano abajo.")}</div>`;
    } else {
      const isPrivate = new Map(suggestions.map((s) => [s.nameWithOwner, s.isPrivate]));
      rowsEl.innerHTML = names
        .map(
          (name) => `
        <button class="repo-option ${selected.has(name) ? "selected" : ""}" data-repo="${esc(name)}">
          <span class="repo-check">${selected.has(name) ? "✓" : ""}</span>
          <span class="repo-name">${esc(name)}</span>
          ${isPrivate.get(name) ? `<span class="chip chip-draft">${t("privado")}</span>` : ""}
        </button>`,
        )
        .join("");
      rowsEl.querySelectorAll("[data-repo]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const name = btn.dataset.repo;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          renderRows();
        }),
      );
    }
    startBtn.disabled = !selected.size;
    startBtn.textContent = selected.size
      ? t("Empezar con {n} {unit}", { n: selected.size, unit: selected.size === 1 ? t("repositorio") : t("repositorios") })
      : t("Empezar");
  };

  startBtn.addEventListener("click", async () => {
    if (!selected.size) return;
    state.config = await window.monstro.setConfig({ repos: [...selected] });
    state.repo = null;
    boot();
  });
  const addManual = () => {
    const input = $("#picker-manual-input");
    const value = input.value.trim();
    if (!repoRe().test(value)) return toast(t("Formato esperado: {fmt}", { fmt: repoPlaceholder() }), "err");
    selected.add(value);
    input.value = "";
    renderRows();
  };
  $("#picker-manual-add").addEventListener("click", addManual);
  $("#picker-manual-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addManual();
  });

  try {
    suggestions = await window.monstro.suggestRepos();
  } catch {
    /* sin sugerencias no pasa nada: queda la entrada manual */
  }
  renderRows();
  notifySelftestOnce();
}

/* ============ vista milestones (solo GitLab) ============ */
