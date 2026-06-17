"use strict";

/**
 * Descubrimiento de repos LOCALES (OPE-19): Pulpo es un cliente remoto puro, así que esta
 * es la única pieza que toca git en disco. Dado un directorio raíz donde conviven todos los
 * clones de GitLab (config.local.rootDir), lista los repos, sus ramas y worktrees, y los
 * casa con los proyectos de GitLab por la URL del remote `origin`.
 *
 * Standalone a propósito (no requiere electron ni config) para poder auto-verificarlo con
 *   node src/local.js <dir>
 * y para mantener el límite con el resto del backend bien marcado.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const pexec = promisify(execFile);
const BRANCH_RE = /^[\w./-]{1,200}$/;

async function git(cwd, args) {
  const { stdout } = await pexec("git", args, { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

// URL del remote origin → "grupo/proyecto" (sin host ni .git). Soporta ssh (git@host:g/p),
// scp-like, ssh:// y https://. null si no encaja (p.ej. un remote local).
function remotePath(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, "");
  const ssh = /^[a-z]+:\/\/[^/]+\/(.+)$/i.exec(s); // ssh://host/group/proj , https://host/group/proj
  if (ssh) return ssh[1].replace(/^[^@]*@/, "");
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(s); // git@host:group/proj
  if (scp) return scp[1];
  return null;
}

// Repos git directos bajo rootDir (un nivel). Para cada uno: nombre de carpeta, ruta absoluta,
// remote origin y su path de GitLab normalizado. ponytail: un solo nivel; si alguien anida repos
// en subcarpetas, que lo diga y hacemos walk con tope de profundidad.
async function scanRepos(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const out = [];
  for (const e of entries) {
    const dir = path.join(rootDir, e.name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    let remote = null;
    try {
      remote = (await git(dir, ["remote", "get-url", "origin"])).trim();
    } catch {
      /* sin origin: lo listamos igual, gitlabPath quedará null */
    }
    out.push({ name: e.name, dir, remote, gitlabPath: remotePath(remote) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseBranches(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, date] = l.split("\t");
      return { name, date: date || null };
    });
}

// `git worktree list --porcelain` → [{ dir, branch, head }]. Cada bloque va separado por línea en blanco.
function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      cur = { dir: line.slice("worktree ".length), branch: null, head: null };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    }
  }
  return out;
}

// Estado git de un repo (o worktree) concreto: rama actual, ramas locales (por fecha desc),
// worktrees y si el árbol tiene cambios sin commitear.
async function repoInfo(dir) {
  const [current, branches, worktrees, dirty] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => null),
    git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:iso8601)", "refs/heads"])
      .then(parseBranches)
      .catch(() => []),
    git(dir, ["worktree", "list", "--porcelain"]).then(parseWorktrees).catch(() => []),
    git(dir, ["status", "--porcelain"]).then((s) => s.trim().length > 0).catch(() => false),
  ]);
  return { current, branches, worktrees, dirty };
}

// Empuja una rama local al remote origin (reutiliza las credenciales git del usuario: ssh/https).
// `-u` deja el upstream listo. Devuelve la salida de git por si interesa mostrarla.
async function pushBranch(dir, branch) {
  if (!BRANCH_RE.test(branch || "")) throw new Error(`Nombre de rama no válido: ${branch}`);
  const { stdout, stderr } = await pexec("git", ["push", "-u", "origin", branch], { cwd: dir, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return { ok: true, output: (stderr || stdout || "").trim() };
}

// Diff de los commits que `branch` tiene y `target` no (target...branch), para alimentar a la IA.
// Si target no existe en local, intenta origin/<target>; si tampoco, devuelve "" (la IA recibe poco).
async function branchDiff(dir, target, branch) {
  for (const base of [target, `origin/${target}`]) {
    try {
      const out = await git(dir, ["diff", `${base}...${branch}`]);
      if (out.trim()) return out;
    } catch {
      /* base inexistente: probamos el siguiente */
    }
  }
  return "";
}

module.exports = { scanRepos, repoInfo, remotePath, parseWorktrees, parseBranches, pushBranch, branchDiff };

// Auto-verificación: `node src/local.js [dir]` (dir por defecto = el padre de este repo).
if (require.main === module) {
  (async () => {
    // remotePath: casos que romperían el casado con GitLab si la regex falla.
    const assert = require("assert");
    assert.strictEqual(remotePath("git@gitlab.openhealth.es:OpenSaludGroup/opensalud.git"), "OpenSaludGroup/opensalud");
    assert.strictEqual(remotePath("https://gitlab.openhealth.es/OpenSaludGroup/sub/proj.git"), "OpenSaludGroup/sub/proj");
    assert.strictEqual(remotePath("ssh://git@host/grp/p"), "grp/p");
    assert.strictEqual(remotePath(""), null);
    assert.deepStrictEqual(
      parseWorktrees("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n"),
      [
        { dir: "/a", branch: "main", head: "abc" },
        { dir: "/b", branch: null, head: "def" },
      ],
    );
    console.log("self-check OK");

    const dir = process.argv[2] || path.dirname(path.dirname(__dirname));
    console.log("scan:", dir);
    const repos = await scanRepos(dir);
    for (const r of repos.slice(0, 5)) {
      const info = await repoInfo(r.dir);
      console.log(` - ${r.name}  gitlab=${r.gitlabPath}  rama=${info.current}  ramas=${info.branches.length}  wt=${info.worktrees.length}  sucio=${info.dirty}`);
    }
    console.log(`(${repos.length} repos)`);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
