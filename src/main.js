"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification, dialog } = require("electron");
const ai = require("./ai");
const config = require("./config");
const drafts = require("./drafts");
const local = require("./local");
const provider = require("./provider");

// Proveedor activo (GitHub o GitLab) según config; se resuelve en cada llamada.
const gh = () => provider.current();

const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_SHOT = "/tmp/pulpo-selftest.png";
const SELFTEST_ROUTE = (process.argv.find((a) => a.startsWith("--selftest-route=")) || "").split("=")[1] || "list";
// La ruta de resumen espera a una IA (lenta con Opus); la de releases proxea los avatares del grupo
// entero (groupProjects). Ambas necesitan más margen que los 20s por defecto.
const SELFTEST_TIMEOUT_MS =
  SELFTEST_ROUTE === "milestones-summary" ? 240000 : SELFTEST_ROUTE === "releases" || SELFTEST_ROUTE === "local" ? 60000 : 20000;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    title: "Pulpo",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1f24" : "#f6f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sin throttling en background: el polling sigue vivo y capturePage (selftest)
      // siempre obtiene un frame fresco aunque la ventana no esté en primer plano.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: {
      selftest: SELFTEST ? "1" : "0",
      selftest_route: SELFTEST_ROUTE,
      seed_draft: process.argv.includes("--seed-draft") ? "1" : "0",
    },
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// rootDir efectivo (config, o ~/repositories bajo selftest para la captura) + valida que `dir`
// cuelgue de él. Seguridad: el renderer nunca puede pedir una ruta arbitraria fuera del raíz.
function localRootGuard(dir) {
  const root = config.load().local.rootDir || (SELFTEST ? path.join(app.getPath("home"), "repositories") : null);
  if (!root || !dir || !path.resolve(dir).startsWith(path.resolve(root) + path.sep)) {
    throw new Error("Ruta fuera del directorio raíz configurado");
  }
  return root;
}

function wireIpc() {
  ipcMain.handle("auth:status", async () => {
    const { token, source } = gh().resolveToken();
    if (!token) return { ok: false, source: null, login: null };
    try {
      const me = await gh().viewer();
      return { ok: true, source, login: me.login, avatarUrl: me.avatarUrl };
    } catch (err) {
      return { ok: false, source, login: null, error: String(err.message || err) };
    }
  });

  ipcMain.handle("config:get", () => {
    const { token, ...rest } = config.load();
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("config:set", (_event, partial) => {
    const allowed = {};
    // GitLab admite paths anidados (group/sub/project); GitHub solo owner/repo.
    const current = config.load();
    const nextProvider = partial.provider === "github" || partial.provider === "gitlab" ? partial.provider : current.provider;
    const repoRe = nextProvider === "gitlab" ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/;
    if (Array.isArray(partial.repos)) allowed.repos = partial.repos.filter((r) => repoRe.test(r));
    if (Number.isInteger(partial.pollSeconds) && partial.pollSeconds >= 15) allowed.pollSeconds = partial.pollSeconds;
    if (["one-dark", "dracula", "github-light"].includes(partial.theme)) allowed.theme = partial.theme;
    if (partial.provider === "github" || partial.provider === "gitlab") {
      allowed.provider = partial.provider;
      // Cambiar de proveedor invalida el token: era de otro sitio.
      if (partial.provider !== current.provider) {
        allowed.token = null;
        gh().invalidateTokenCache();
      }
    }
    if (typeof partial.gitlabBaseUrl === "string" && /^https:\/\/[\w.-]+/.test(partial.gitlabBaseUrl.trim())) {
      allowed.gitlabBaseUrl = partial.gitlabBaseUrl.trim().replace(/\/+$/, "");
      gh().invalidateTokenCache();
    }
    if (typeof partial.aiModel === "string" && ai.isAiModel(partial.aiModel)) allowed.aiModel = partial.aiModel;
    if (typeof partial.aiEffort === "string" && ai.isAiEffort(partial.aiEffort)) allowed.aiEffort = partial.aiEffort;
    if (typeof partial.token === "string") {
      allowed.token = partial.token.trim() || null;
      gh().invalidateTokenCache();
    }
    if (typeof partial.lastRepo === "string") allowed.lastRepo = partial.lastRepo;
    if (typeof partial.lastBucket === "string") allowed.lastBucket = partial.lastBucket;
    if (partial.cherryPick && typeof partial.cherryPick === "object") {
      const cp = partial.cherryPick;
      const branchRe = /^[\w./-]{1,200}$/;
      const next = { ...current.cherryPick };
      if (typeof cp.prefix === "string" && cp.prefix.trim()) next.prefix = cp.prefix.trim();
      if (Array.isArray(cp.branches)) next.branches = cp.branches.filter((b) => typeof b === "string" && branchRe.test(b));
      if (typeof cp.siblingMx === "boolean") next.siblingMx = cp.siblingMx;
      allowed.cherryPick = next;
    }
    if (partial.milestones && typeof partial.milestones === "object") {
      const m = partial.milestones;
      const next = { ...current.milestones };
      if (typeof m.group === "string") next.group = m.group.trim() || null;
      else if (m.group === null) next.group = null;
      if (Array.isArray(m.statusLabels)) {
        next.statusLabels = m.statusLabels.filter((l) => typeof l === "string" && l.trim());
      }
      if (Array.isArray(m.doneLabels)) {
        next.doneLabels = m.doneLabels.filter((l) => typeof l === "string" && l.trim());
      }
      allowed.milestones = next;
    }
    if (partial.releases && typeof partial.releases === "object") {
      const r = partial.releases;
      const next = { ...current.releases };
      const branchRe = /^[\w./-]{1,200}$/;
      if (typeof r.sourceBranch === "string" && branchRe.test(r.sourceBranch.trim())) next.sourceBranch = r.sourceBranch.trim();
      if (typeof r.branchPrefix === "string" && /^[\w./-]{0,40}$/.test(r.branchPrefix)) next.branchPrefix = r.branchPrefix;
      // Proyectos: ids del set por defecto (strings) y la última selección recordada (paths/ids).
      const projId = /^[\w.-]+(\/[\w.-]+)*$/;
      if (Array.isArray(r.defaultProjectIds)) {
        next.defaultProjectIds = r.defaultProjectIds.filter((id) => (typeof id === "string" || typeof id === "number") && projId.test(String(id))).map(String);
      }
      if (Array.isArray(r.selectedProjects)) {
        next.selectedProjects = r.selectedProjects.filter((p) => typeof p === "string" && projId.test(p));
      } else if (r.selectedProjects === null) {
        next.selectedProjects = null;
      }
      if (r.ouicare && typeof r.ouicare === "object") {
        const o = { ...current.releases.ouicare };
        if (typeof r.ouicare.projectPath === "string" && r.ouicare.projectPath.trim()) o.projectPath = r.ouicare.projectPath.trim();
        if (typeof r.ouicare.webConfigPath === "string" && r.ouicare.webConfigPath.trim()) o.webConfigPath = r.ouicare.webConfigPath.trim();
        if (typeof r.ouicare.appDateKey === "string" && r.ouicare.appDateKey.trim()) o.appDateKey = r.ouicare.appDateKey.trim();
        next.ouicare = o;
      }
      allowed.releases = next;
    }
    if (partial.local && typeof partial.local === "object") {
      const next = { ...current.local };
      // rootDir: ruta absoluta existente o null para limpiar. La validación real es que exista en disco.
      if (typeof partial.local.rootDir === "string" && partial.local.rootDir.trim()) {
        const p = partial.local.rootDir.trim();
        if (path.isAbsolute(p) && fs.existsSync(p)) next.rootDir = p;
      } else if (partial.local.rootDir === null) {
        next.rootDir = null;
      }
      allowed.local = next;
    }
    const { token, ...rest } = config.save(allowed);
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("repos:suggest", async () => gh().viewerRepos());

  // Trabajo local → GitLab (OPE-19). Lectura de repos locales bajo config.local.rootDir.
  ipcMain.handle("local:pickRoot", async () => {
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Directorio raíz de tus repos" });
    if (res.canceled || !res.filePaths[0]) return { rootDir: config.load().local.rootDir };
    const { local: l } = config.save({ local: { ...config.load().local, rootDir: res.filePaths[0] } });
    return { rootDir: l.rootDir };
  });
  ipcMain.handle("local:repos", async () => {
    const cfg = config.load();
    // Selftest: si no hay rootDir configurado, escanea ~/repositories para que la captura muestre repos reales.
    const rootDir = cfg.local.rootDir || (SELFTEST ? path.join(app.getPath("home"), "repositories") : null);
    const repos = await local.scanRepos(rootDir);
    const known = new Set(cfg.repos);
    return { rootDir, repos: repos.map((r) => ({ ...r, known: r.gitlabPath ? known.has(r.gitlabPath) : false })) };
  });
  ipcMain.handle("local:repoInfo", async (_event, { dir }) => {
    localRootGuard(dir);
    return local.repoInfo(dir);
  });
  // Propuesta IA (título + descripción + checklist) desde el diff de la rama local vs la rama destino.
  ipcMain.handle("local:proposeTask", async (_event, { dir, sourceBranch, targetBranch, repoName }) => {
    localRootGuard(dir);
    const diffText = await local.branchDiff(dir, targetBranch, sourceBranch);
    return ai.proposeTask({ diffText, repoName, branch: sourceBranch });
  });
  // Orquesta el flujo Crear tarea (single-project): push de la rama → crea Issue → crea MR (Closes #iid).
  // Secuencial y NO atómico: si falla la MR tras crear la issue, la issue queda creada (se reporta).
  ipcMain.handle("local:createTask", async (_event, { dir, projectPath, sourceBranch, targetBranch, title, description, checklist, labels, push }) => {
    localRootGuard(dir);
    const branchRe = /^[\w./-]{1,200}$/;
    const projRe = /^[\w.-]+(\/[\w.-]+)*$/;
    if (!projRe.test(projectPath || "")) throw new Error("Proyecto no válido");
    if (!branchRe.test(sourceBranch || "") || !branchRe.test(targetBranch || "")) throw new Error("Rama no válida");
    if (!title || !String(title).trim()) throw new Error("El título es obligatorio");
    const checkItems = (Array.isArray(checklist) ? checklist : []).filter((c) => typeof c === "string" && c.trim());
    const checklistMd = checkItems.length ? `\n\n## Puntos a comprobar\n${checkItems.map((c) => `- [ ] ${c.trim()}`).join("\n")}` : "";
    const safeLabels = (Array.isArray(labels) ? labels : []).filter((l) => typeof l === "string" && l.trim());
    const pushResult = push ? await local.pushBranch(dir, sourceBranch) : null;
    const issue = await gh().createIssue(projectPath, { title: String(title).trim(), description: `${description || ""}${checklistMd}`, labels: safeLabels });
    const mr = await gh().createMergeRequest(projectPath, {
      sourceBranch,
      targetBranch,
      title: String(title).trim(),
      description: `Closes #${issue.iid}\n\n${description || ""}${checklistMd}`,
    });
    return { push: pushResult, issue, mr };
  });

  ipcMain.handle("prs:list", async (_event, { repo, states }) => gh().listPRs(repo, states));
  ipcMain.handle("prs:search", async (_event, { repos, states }) => gh().searchPRs(repos, states));
  ipcMain.handle("pr:detail", async (_event, { repo, number }) => gh().prDetail(repo, number));
  ipcMain.handle("pr:merge", async (_event, { repo, number, deleteBranch, headRefName, isCrossRepository }) =>
    gh().mergePR(repo, number, { deleteBranch, headRefName, isCrossRepository }),
  );
  ipcMain.handle("pr:updateBranch", async (_event, { nodeId }) => gh().updateBranchRebase(nodeId));

  ipcMain.handle("pr:files", async (_event, { repo, number }) => gh().prFiles(repo, number));
  ipcMain.handle("pr:conversation", async (_event, { repo, number }) => gh().prConversation(repo, number));
  ipcMain.handle("pr:commentIssue", async (_event, { repo, number, body }) =>
    gh().addIssueComment(repo, number, body),
  );
  ipcMain.handle("pr:commentInline", async (_event, { repo, number, comment }) =>
    gh().addInlineComment(repo, number, comment),
  );
  ipcMain.handle("pr:replyThread", async (_event, { repo, number, commentDatabaseId, body }) =>
    gh().replyToThread(repo, number, commentDatabaseId, body),
  );
  ipcMain.handle("pr:resolveThread", async (_event, { threadId, resolved }) =>
    gh().setThreadResolved(String(threadId), Boolean(resolved)),
  );
  ipcMain.handle("pr:submitReview", async (_event, { repo, number, review }) =>
    gh().submitReview(repo, number, review),
  );
  ipcMain.handle("pr:dismissReview", async (_event, { repo, number, reviewId, message }) =>
    gh().dismissReview(repo, number, reviewId, String(message || "")),
  );

  ipcMain.handle("ai:review", async (_event, { title, body, files }) => ai.generateReview({ title, body, files }));
  ipcMain.handle("ai:status", () => ai.backendStatus());
  ipcMain.handle("ai:ping", async () => ai.ping());

  ipcMain.handle("drafts:list", (_event, { key }) => drafts.listFor(key));
  ipcMain.handle("drafts:save", (_event, { key, items }) => drafts.saveFor(key, items));
  ipcMain.handle("drafts:keys", () => drafts.allKeys());

  ipcMain.handle("history:branches", async (_event, { repo }) => gh().defaultBranch(repo));
  ipcMain.handle("history:graph", async (_event, { repo, branchSpecs }) => gh().branchHistories(repo, branchSpecs));
  const BRANCH_RE = /^[\w./-]{1,200}$/;
  ipcMain.handle("git:createBranch", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().createBranch(repo, branch, sha);
  });
  ipcMain.handle("git:forceUpdate", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().forceUpdateBranch(repo, branch, sha);
  });
  ipcMain.handle("pr:cherryPick", async (_event, { repo, sha, branch, dryRun }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().cherryPick(repo, sha, branch, { dryRun: Boolean(dryRun) });
  });
  ipcMain.handle("pr:revert", async (_event, { repo, number }) => {
    const nodeId = await gh().prNodeId(repo, number);
    return gh().revertPullRequest(nodeId);
  });
  ipcMain.handle("pr:setDraft", async (_event, { nodeId, toDraft }) => gh().setPrDraft(nodeId, Boolean(toDraft)));

  ipcMain.handle("milestones:list", async () => gh().listMilestones());
  ipcMain.handle("milestones:issues", async (_event, { title, includeClosed }) =>
    gh().milestoneIssues(title, { includeClosed: Boolean(includeClosed) }),
  );
  ipcMain.handle("issues:groupLabels", async () => gh().groupLabels());
  ipcMain.handle("issues:groupProjects", async () => gh().groupProjects());
  ipcMain.handle("issues:update", async (_event, { projectId, iid, patch }) =>
    gh().updateIssue(projectId, iid, patch || {}),
  );
  ipcMain.handle("milestones:summary", async (_event, { milestoneTitle, issues }) => {
    const items = await gh().collapseMilestoneEpics(issues || []);
    return ai.summarizeMilestone({ milestoneTitle, items });
  });
  ipcMain.handle("milestones:publishSnippet", async (_event, { title, contentMarkdown }) =>
    gh().createSnippet({ title, contentMarkdown }),
  );

  ipcMain.handle("releases:defaults", async () => gh().releaseDefaults());
  ipcMain.handle("releases:generate", async (_event, { version, sourceBranch, projects, ouicare }) => {
    const { branchPrefix, sourceBranch: defSource, ouicare: cfgOuicare } = await gh().releaseDefaults();
    const v = typeof version === "string" ? version.trim() : "";
    if (!v) throw new Error("Falta el nombre de versión");
    // Validamos el nombre de rama FINAL (prefijo + versión) con la misma regla que el resto de ramas.
    if (!BRANCH_RE.test(`${branchPrefix}${v}`)) throw new Error("Nombre de versión no válido");
    const src = typeof sourceBranch === "string" && sourceBranch.trim() ? sourceBranch.trim() : defSource;
    if (!BRANCH_RE.test(src)) throw new Error("Rama origen no válida");
    // Los proyectos los elige el renderer del grupo (paths). Validamos el FORMATO del id (path
    // anidado o id numérico); los permisos del token en GitLab son el límite real de a qué proyecto
    // se puede escribir. ponytail: no re-fetch del grupo solo para validar (groupProjects proxea
    // avatares = caro); path-format + perms bastan.
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    const selected = (projects || [])
      .filter((p) => p && typeof p.id === "string" && PATH_RE.test(p.id))
      .map((p) => ({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id }));
    if (!selected.length) throw new Error("No hay proyectos seleccionados");
    // Ouicare AppDate: projectPath/webConfigPath/appDateKey salen de CONFIG (no del renderer);
    // del renderer solo enabled + date (DDMMYYYY, validada aquí).
    let ouicareArg = null;
    if (ouicare && ouicare.enabled && cfgOuicare) {
      const date = typeof ouicare.date === "string" ? ouicare.date : "";
      if (!/^\d{8}$/.test(date)) throw new Error("Fecha de AppDate no válida (DDMMYYYY)");
      ouicareArg = { ...cfgOuicare, enabled: true, date };
    }
    return gh().generateReleaseBranches({ projects: selected, version: v, sourceBranch: src, ouicare: ouicareArg });
  });

  ipcMain.handle("shell:open", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("notify", (_event, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
  ipcMain.handle("dock:badge", (_event, text) => {
    app.dock?.setBadge(typeof text === "string" ? text : "");
  });
}

function wireSelftest() {
  let done = false;
  const finish = async (reason) => {
    if (done || !win) return;
    done = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300)); // deja asentar fuentes/avatares
      const bodyLength = await win.webContents.executeJavaScript("document.body.innerHTML.length");
      // doble rAF: garantiza que el último DOM se ha pintado/compuesto antes de capturar
      await win.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const image = await win.webContents.capturePage();
      fs.writeFileSync(SELFTEST_SHOT, image.toPNG());
      console.log(`[selftest] screenshot: ${SELFTEST_SHOT} (reason=${reason}, bodyHTML=${bodyLength} chars)`);
    } catch (err) {
      console.error("[selftest] capture failed:", err);
    } finally {
      app.quit();
    }
  };
  ipcMain.once("selftest:render-complete", () => finish("render-complete"));
  setTimeout(() => finish("timeout"), SELFTEST_TIMEOUT_MS);
}

app.whenReady().then(() => {
  const dockIcon = path.join(__dirname, "..", "assets", "icon-512.png");
  if (process.platform === "darwin" && fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  wireIpc();
  if (SELFTEST) wireSelftest();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
