// ============================================================================
// scripts/item-tests.mjs — tests actually written for a test-list item (0.62.0)
// ============================================================================
//
// User decision « c+d » (2026-10-10), part d: « à l'étape Liste de tests, le
// model écrit pour chaque item le nombre de tests prévus, et le code vérifie
// ensuite que ce nombre est respecté ». 0.61.0 added the declaration
// "(tests: N)"; this module counts what was really written for the item.
//
// Counting method (documented, deterministic, language-aware):
//   - a "test" is one test-case declaration in a project test file:
//       JS/TS   test(…) / it(…) (also .only / .skip / .each(…)(…)) with a name
//       Python  def test_xxx( / async def test_xxx(
//       Kotlin / Java  @Test
//       Go      func TestXxx(
//   - counted per test file at the start of the item, then again; the item's
//     tests = the sum of the per-file increases (a parametrised test counts 1,
//     a removed test never offsets an added one elsewhere);
//   - an item without declaration (written before 0.61.0) cannot be checked:
//     it is reported, never refused.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const JS_RE = /(?:^|[^\w.$])(?:test|it)(?:\.(?:only|skip|concurrent|todo|each\s*\([^)]*\)))*\s*\(\s*(['"`])/g;
const PY_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+test_\w*\s*\(/gm;
const JVM_RE = /@Test\b/g;
const GO_RE = /^func[ \t]+Test[A-Z_0-9]\w*\s*\(/gm;

/** Number of test cases declared in `text` (file name selects the language). */
export function countTestCases(text, file = '') {
  const s = String(text || '');
  const ext = path.extname(String(file)).toLowerCase();
  const n = (re) => (s.match(re) || []).length;
  if (ext === '.py') return n(PY_RE);
  if (ext === '.kt' || ext === '.kts' || ext === '.java') return n(JVM_RE);
  if (ext === '.go') return n(GO_RE);
  if (/^\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/.test(ext)) return n(JS_RE);
  // Unknown extension: whichever syntax the file actually uses.
  return Math.max(n(JS_RE), n(PY_RE), n(JVM_RE), n(GO_RE));
}

/** { file: count } for the given test files (relative to cwd). */
export function countTests(cwd, files) {
  const out = {};
  for (const f of files || []) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
    out[f] = countTestCases(txt, f);
  }
  return out;
}

/** Tests added between two counts: sum of the per-file increases. */
export function addedTests(base, now) {
  const perFile = {};
  let total = 0;
  for (const [f, n] of Object.entries(now || {})) {
    const d = n - (Number(base?.[f]) || 0);
    if (d > 0) { perFile[f] = d; total += d; }
  }
  return { total, perFile };
}

/**
 * Verdict for an item: ok when the tests written do not exceed the tests
 * declared (0 is fine: an already-covered item may add none). A refusal asks
 * to split the item — never a silent acceptance.
 */
export function itemTestsVerdict({ declared, added, itemN = null, where = '' }) {
  const n = Number(added?.total ?? added) || 0;
  const files = added?.perFile ? Object.entries(added.perFile).map(([f, k]) => `${f} (+${k})`).join(', ') : '';
  if (!Number.isInteger(declared)) return { ok: true, checked: false, written: n, note: `item${itemN ? ` n° ${itemN}` : ''} sans déclaration « (tests: N) » (liste antérieure à 0.61.0) : nombre de tests non vérifié` };
  if (n <= declared) return { ok: true, checked: true, written: n, declared };
  return {
    ok: false, checked: true, written: n, declared,
    // Key words first: pause messages keep only the first 300 characters.
    why: `${where ? `${where} : ` : ''}l’item${itemN ? ` n° ${itemN}` : ''} annonçait ${declared} test(s), mais ${n} ont été écrits : `
      + `garde au plus ${declared} test(s) pour cet item ; s’il en faut vraiment davantage, l’item est trop large et doit être redécoupé en items plus petits`
      + `${files ? ` (${files})` : ''}.`,
  };
}
