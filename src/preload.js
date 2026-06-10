"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pulpo", {
  authStatus: () => ipcRenderer.invoke("auth:status"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  listPRs: (repo, states) => ipcRenderer.invoke("prs:list", { repo, states }),
  prDetail: (repo, number) => ipcRenderer.invoke("pr:detail", { repo, number }),
  mergePR: (args) => ipcRenderer.invoke("pr:merge", args),
  updateBranch: (nodeId) => ipcRenderer.invoke("pr:updateBranch", { nodeId }),
  prFiles: (repo, number) => ipcRenderer.invoke("pr:files", { repo, number }),
  prConversation: (repo, number) => ipcRenderer.invoke("pr:conversation", { repo, number }),
  commentIssue: (repo, number, body) => ipcRenderer.invoke("pr:commentIssue", { repo, number, body }),
  commentInline: (repo, number, comment) => ipcRenderer.invoke("pr:commentInline", { repo, number, comment }),
  replyThread: (repo, number, commentDatabaseId, body) =>
    ipcRenderer.invoke("pr:replyThread", { repo, number, commentDatabaseId, body }),
  defaultBranch: (repo) => ipcRenderer.invoke("history:branches", { repo }),
  historyGraph: (repo, branchSpecs) => ipcRenderer.invoke("history:graph", { repo, branchSpecs }),
  createBranch: (repo, branch, sha) => ipcRenderer.invoke("git:createBranch", { repo, branch, sha }),
  forceUpdateBranch: (repo, branch, sha) => ipcRenderer.invoke("git:forceUpdate", { repo, branch, sha }),
  revertPR: (repo, number) => ipcRenderer.invoke("pr:revert", { repo, number }),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  selftestRenderComplete: () => ipcRenderer.send("selftest:render-complete"),
});
