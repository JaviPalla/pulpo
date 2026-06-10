"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification } = require("electron");
const config = require("./config");
const drafts = require("./drafts");
const github = require("./github");

const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_SHOT = "/tmp/pulpo-selftest.png";
const SELFTEST_TIMEOUT_MS = 20000;

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
  const routeArg = process.argv.find((a) => a.startsWith("--selftest-route="));
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: {
      selftest: SELFTEST ? "1" : "0",
      selftest_route: routeArg ? routeArg.split("=")[1] : "list",
      seed_draft: process.argv.includes("--seed-draft") ? "1" : "0",
    },
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function wireIpc() {
  ipcMain.handle("auth:status", async () => {
    const { token, source } = github.resolveToken();
    if (!token) return { ok: false, source: null, login: null };
    try {
      const me = await github.viewer();
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
    if (Array.isArray(partial.repos)) allowed.repos = partial.repos.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
    if (Number.isInteger(partial.pollSeconds) && partial.pollSeconds >= 15) allowed.pollSeconds = partial.pollSeconds;
    if (typeof partial.token === "string") {
      allowed.token = partial.token.trim() || null;
      github.invalidateTokenCache();
    }
    const { token, ...rest } = config.save(allowed);
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("prs:list", async (_event, { repo, states }) => github.listPRs(repo, states));
  ipcMain.handle("pr:detail", async (_event, { repo, number }) => github.prDetail(repo, number));
  ipcMain.handle("pr:merge", async (_event, { repo, number, deleteBranch, headRefName, isCrossRepository }) =>
    github.mergePR(repo, number, { deleteBranch, headRefName, isCrossRepository }),
  );
  ipcMain.handle("pr:updateBranch", async (_event, { nodeId }) => github.updateBranchRebase(nodeId));

  ipcMain.handle("pr:files", async (_event, { repo, number }) => github.prFiles(repo, number));
  ipcMain.handle("pr:conversation", async (_event, { repo, number }) => github.prConversation(repo, number));
  ipcMain.handle("pr:commentIssue", async (_event, { repo, number, body }) =>
    github.addIssueComment(repo, number, body),
  );
  ipcMain.handle("pr:commentInline", async (_event, { repo, number, comment }) =>
    github.addInlineComment(repo, number, comment),
  );
  ipcMain.handle("pr:replyThread", async (_event, { repo, number, commentDatabaseId, body }) =>
    github.replyToThread(repo, number, commentDatabaseId, body),
  );
  ipcMain.handle("pr:submitReview", async (_event, { repo, number, review }) =>
    github.submitReview(repo, number, review),
  );

  ipcMain.handle("drafts:list", (_event, { key }) => drafts.listFor(key));
  ipcMain.handle("drafts:save", (_event, { key, items }) => drafts.saveFor(key, items));

  ipcMain.handle("history:branches", async (_event, { repo }) => github.defaultBranch(repo));
  ipcMain.handle("history:graph", async (_event, { repo, branchSpecs }) => github.branchHistories(repo, branchSpecs));
  const BRANCH_RE = /^[\w./-]{1,200}$/;
  ipcMain.handle("git:createBranch", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return github.createBranch(repo, branch, sha);
  });
  ipcMain.handle("git:forceUpdate", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return github.forceUpdateBranch(repo, branch, sha);
  });
  ipcMain.handle("pr:revert", async (_event, { repo, number }) => {
    const nodeId = await github.prNodeId(repo, number);
    return github.revertPullRequest(nodeId);
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
