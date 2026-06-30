"use strict";

// Compara dos versiones "x.y.z" numéricamente (NO lexical: 0.10.0 > 0.9.0).
// Partes no numéricas/ausentes cuentan como 0. Devuelve true si `a` es más nueva que `b`.
function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

module.exports = { isNewer };

// ponytail: self-check de la única lógica con miga (comparación numérica de versiones).
if (require.main === module) {
  const assert = require("assert");
  assert.strictEqual(isNewer("0.2.0", "0.1.0"), true);
  assert.strictEqual(isNewer("0.10.0", "0.9.0"), true, "numérico, no lexical");
  assert.strictEqual(isNewer("0.1.0", "0.1.0"), false);
  assert.strictEqual(isNewer("1.0", "0.9.9"), true);
  assert.strictEqual(isNewer("0.1.0", "0.2.0"), false);
  console.log("version.js OK");
}
