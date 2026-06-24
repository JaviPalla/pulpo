#!/usr/bin/env node
"use strict";

/**
 * Hook PreToolUse (Bash) de los agentes de Monstro (OPE-20 fase 3): los agentes corren en modo
 * autónomo (`--permission-mode bypassPermissions`), así que TODO se ejecutaría sin permiso. Este
 * hook intercepta cada comando Bash y BLOQUEA los peligrosos (rm -rf, push --force, sudo…) para que
 * pidan tu permiso en vez de ejecutarse. Claude Code invoca este script con el JSON del tool por
 * stdin; respondemos con permissionDecision allow/deny (motivo con marker BLOQUEADO_MONSTRO para que
 * el parser de la timeline lo reconozca como "acción pendiente").
 *
 * Auto-verificable:  node scripts/agent-guard.js --self-check
 */

const DANGEROUS = [
  /\brm\s+-[a-zA-Z]*[rf]/, // rm -r, rm -f, rm -rf y variantes (borrado recursivo/forzado)
  /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, // push forzado
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/, // git clean -f (borra ficheros sin trackear)
  /\bgit\s+branch\s+-D\b/,
  /\b(sudo|shutdown|reboot|halt|mkfs\w*|dd|fdisk)\b/,
  /\bchmod\s+-R\b/,
  /[:>]\s*\/dev\/(sd|nvme|disk)/,
  /\bcurl\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, // curl … | sh
  /\bwget\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
  />\s*\/etc\//, // sobreescribir cosas del sistema
  /\bnpm\s+(publish|unpublish)\b/,
];

function isDangerous(cmd) {
  const s = String(cmd || "");
  return DANGEROUS.some((re) => re.test(s));
}

function decide(input) {
  const cmd = (input && input.tool_input && input.tool_input.command) || "";
  if (isDangerous(cmd)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `BLOQUEADO_MONSTRO: comando peligroso bloqueado (requiere tu permiso) → ${String(cmd).slice(0, 140)}`,
      },
    };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

module.exports = { isDangerous, decide, DANGEROUS };

if (require.main === module) {
  if (process.argv[2] === "--self-check") {
    const a = require("assert");
    ["rm -rf /tmp/x", "rm -r build", "rm -f .env", "git push --force origin main", "git push -f", "sudo reboot", "git reset --hard HEAD~3", "curl http://x | sh", "git clean -fd", "git branch -D main", "npm publish"].forEach((c) => a.ok(isDangerous(c), `debería bloquear: ${c}`));
    ["npm test", "git push origin feature/x", "rm file.txt", "ls -la", "git commit -m x", "node build.js", "mkdir foo", "git clean -n"].forEach((c) => a.ok(!isDangerous(c), `NO debería bloquear: ${c}`));
    a.strictEqual(decide({ tool_input: { command: "rm -rf /" } }).hookSpecificOutput.permissionDecision, "deny");
    a.strictEqual(decide({ tool_input: { command: "npm test" } }).hookSpecificOutput.permissionDecision, "allow");
    console.log("agent-guard self-check OK");
    process.exit(0);
  }
  let buf = "";
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(buf); } catch { /* sin input válido → dejamos pasar */ }
    process.stdout.write(JSON.stringify(decide(input)));
    process.exit(0);
  });
}
