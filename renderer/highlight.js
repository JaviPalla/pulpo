"use strict";

/*
 * Resaltador de sintaxis dependency-free (como graph.js).
 * Trabaja por LÍNEA (cada celda del diff es una línea suelta): no arrastra estado
 * multilínea entre filas porque en un diff las líneas add/del van intercaladas y
 * cualquier estado heredado sería incorrecto. El coste asumido es que strings o
 * comentarios de bloque a varias líneas se colorean de forma aproximada — lo mismo
 * que hace cualquier visor de diffs.
 *
 * Seguridad: TODO fragmento emitido pasa por esc(); el texto crudo nunca llega a
 * innerHTML. La salida son <span class="hl-*">…</span> + huecos escapados.
 */
(function () {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Palabras clave de uso común en C-family + lenguajes de script. Es un visor de
  // diffs: una unión amplia da buen aspecto y un falso positivo ocasional es cosmético.
  const KEYWORDS = new Set([
    // control de flujo
    "if", "else", "for", "while", "do", "switch", "case", "default", "break",
    "continue", "return", "goto", "throw", "try", "catch", "finally", "yield",
    "await", "async", "match", "when", "unless", "until", "loop", "then", "elif",
    // declaración
    "var", "let", "const", "function", "fn", "func", "def", "class", "struct",
    "enum", "interface", "type", "trait", "impl", "module", "namespace", "package",
    "import", "export", "from", "as", "use", "using", "require", "include",
    "extends", "implements", "public", "private", "protected", "static", "final",
    "abstract", "override", "virtual", "new", "delete", "typedef", "template",
    "typename", "operator", "extern", "inline", "constexpr", "mut", "ref", "out",
    "in", "is", "of", "with", "where", "lambda", "macro", "pub", "dyn", "move",
    // valores / tipos primitivos frecuentes
    "true", "false", "null", "nil", "none", "None", "True", "False", "undefined",
    "this", "self", "super", "void", "int", "long", "short", "float", "double",
    "char", "bool", "boolean", "string", "str", "byte", "unsigned", "signed",
    "and", "or", "not", "end", "begin", "echo", "print", "global", "nonlocal",
    "raise", "pass", "lambda", "go", "defer", "chan", "select", "map", "set",
  ]);

  const EXT_FAMILY = {
    js: "c", jsx: "c", ts: "c", tsx: "c", mjs: "c", cjs: "c", mts: "c", cts: "c",
    java: "c", c: "c", h: "c", hpp: "c", cpp: "c", cc: "c", cxx: "c", cs: "c",
    go: "c", rs: "c", swift: "c", kt: "c", kts: "c", scala: "c", php: "c",
    dart: "c", m: "c", mm: "c", json: "c", jsonc: "c",
    py: "hash", rb: "hash", sh: "hash", bash: "hash", zsh: "hash", fish: "hash",
    yml: "hash", yaml: "hash", toml: "hash", pl: "hash", pm: "hash", r: "hash",
    tf: "hash", conf: "hash", ini: "hash", dockerfile: "hash", makefile: "hash",
    sql: "sql",
  };

  function familyFromFilename(name) {
    const base = String(name || "").toLowerCase().split("/").pop() || "";
    if (base === "dockerfile" || base === "makefile") return "hash";
    const ext = base.includes(".") ? base.split(".").pop() : "";
    return EXT_FAMILY[ext] || "c";
  }

  // Reglas por familia: cómo empieza un comentario de línea. El comentario de bloque
  // /* … */ solo se reconoce para la familia C y únicamente si cierra en la misma línea.
  function lineCommentRe(family) {
    if (family === "hash") return /^#.*/;
    if (family === "sql") return /^--.*/;
    return /^\/\/.*/; // c
  }

  const RE_BLOCK = /^\/\*[\s\S]*?\*\//; // bloque cerrado en la misma línea (familia c)
  const RE_STR_D = /^"(?:\\.|[^"\\])*"/;
  const RE_STR_S = /^'(?:\\.|[^'\\])*'/;
  const RE_STR_B = /^`(?:\\.|[^`\\])*`/;
  const RE_NUM = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
  const RE_IDENT = /^[A-Za-z_$][\w$]*/;
  const RE_OP = /^[+\-*/%=<>!&|^~?]+/;
  const RE_PUNCT = /^[{}()[\].,;:@#]/;
  const RE_WS = /^\s+/;

  function classifyIdent(word, rest, family) {
    if (KEYWORDS.has(word)) return "hl-kw";
    // Tipo/clase: empieza por mayúscula (convención casi universal).
    if (/^[A-Z]/.test(word) && word.length > 1) return "hl-type";
    // Llamada a función: identificador seguido (saltando espacios) de "(".
    if (/^\s*\(/.test(rest)) return "hl-fn";
    return null; // texto por defecto (color de primer plano del tema)
  }

  /**
   * Resalta UNA línea de código. Devuelve HTML seguro (todo escapado).
   * @param {string} text  línea de código sin el signo +/- del diff.
   * @param {string} family  "c" | "hash" | "sql".
   */
  function highlightLine(text, family) {
    const commentRe = lineCommentRe(family);
    let out = "";
    let i = 0;
    const span = (cls, raw) => `<span class="${cls}">${esc(raw)}</span>`;

    while (i < text.length) {
      const s = text.slice(i);
      let m;

      if ((m = RE_WS.exec(s))) { out += esc(m[0]); i += m[0].length; continue; }
      if ((m = commentRe.exec(s))) { out += span("hl-com", m[0]); i += m[0].length; continue; }
      if (family === "c" && (m = RE_BLOCK.exec(s))) { out += span("hl-com", m[0]); i += m[0].length; continue; }
      if ((m = RE_STR_D.exec(s)) || (m = RE_STR_S.exec(s)) || (family === "c" && (m = RE_STR_B.exec(s)))) {
        out += span("hl-str", m[0]); i += m[0].length; continue;
      }
      if ((m = RE_NUM.exec(s))) { out += span("hl-num", m[0]); i += m[0].length; continue; }
      if ((m = RE_IDENT.exec(s))) {
        const cls = classifyIdent(m[0], s.slice(m[0].length), family);
        out += cls ? span(cls, m[0]) : esc(m[0]);
        i += m[0].length;
        continue;
      }
      if ((m = RE_OP.exec(s))) { out += span("hl-op", m[0]); i += m[0].length; continue; }
      if ((m = RE_PUNCT.exec(s))) { out += span("hl-punct", m[0]); i += m[0].length; continue; }

      // Carácter suelto sin clasificar: escapar y avanzar.
      out += esc(s[0]);
      i += 1;
    }
    return out;
  }

  window.pulpoHL = { highlightLine, familyFromFilename };
})();
