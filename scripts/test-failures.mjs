// ============================================================================
// scripts/test-failures.mjs — which tests failed, read from a test command's
// output (0.145.0)
// ============================================================================
//
// User agreement (2026-10-24): « oui », to the chef's proposal after the first
// night of after-the-fact full runs: a project's alert said « KO :
// testCommand » while one test out of 559 failed. The alert and the incident
// request now name the failed tests, and tell « the command could not run »
// (environment, missing file) apart from « N tests failed ».
//
// Pure: parseTestOutput(text, {code}) reads the output of node --test (spec and
// TAP), pytest, unittest, gradle/JUnit and dotnet test; anything else keeps its
// last useful lines. Reading a machine's output is not lexical routing: no
// request of the user is classified here.
// ============================================================================

const MAX_TESTS = 20;
const MAX_TAIL = 12;
const clip = (s, n = 200) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Signs that the command did not get to run its tests (or a test died on its
// environment): the line itself is kept as the reason.
const ENV_SIGNS = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /\bENOENT\b/,
  /no such file or directory/i,
  /cannot find module/i,
  /ERR_MODULE_NOT_FOUND/,
  /ModuleNotFoundError|ImportError: /,
  /Could not (?:find|resolve)\b/,
  /Missing script:/i,
  /error (?:CS|MSB|NU)\d{3,4}\b/,
  /Cannot find (?:file|path)/i,
  /The system cannot find the (?:file|path) specified/i,
  /Le fichier spécifié est introuvable|Le chemin d’accès spécifié est introuvable|n'est pas reconnu en tant que commande/i,
];
const NOISE = /^\s*(?:at |npm (?:ERR!|error) (?:A complete log|code|path|command|errno)|\s*$|>\s+\S+@\S+ test|\[idle-regression\]|\$ )/;

/** Paths named by ENOENT-like messages (to say which file was missing). */
export function missingPaths(text) {
  const out = new Set();
  const res = [
    /ENOENT[^'"\n]*['"]([^'"\n]+)['"]/g,
    /no such file or directory[,:]?\s*(?:open\s+|stat\s+)?['"]?([^'"\n]+?)['"]?\s*$/gim,
    /Cannot find module ['"]([^'"\n]+)['"]/g,
    /Could not find ([^\s.][^\s]*\.(?:aar|jar|so|dll|json|txt|onnx|bin))/g,
    /No module named ['"]([^'"\n]+)['"]/g,
  ];
  for (const re of res) for (const m of String(text || '').matchAll(re)) { const p = m[1].trim().replace(/[.,;]+$/, ''); if (p) out.add(p); }
  return [...out].slice(0, 10);
}

const push = (list, seen, t) => { const k = `${t.name}\u0000${t.file || ''}`; if (seen.has(k) || list.length >= MAX_TESTS * 5) return; seen.add(k); list.push(t); };

function parseNode(lines) {
  const failed = [], seen = new Set();
  let total = null, fail = null, pass = null, found = false;
  // spec reporter: the « failing tests: » section lists the leaves only.
  const sec = lines.findIndex(l => /^\s*✖ failing tests:/.test(l));
  if (sec >= 0) {
    found = true;
    let file = null;
    for (let i = sec + 1; i < lines.length; i++) {
      const at = /^\s*test at (.+?):(\d+):\d+\s*$/.exec(lines[i]);
      if (at) { file = `${at[1]}:${at[2]}`; continue; }
      const m = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(lines[i]);
      if (m) {
        const err = (lines[i + 1] || '').trim();
        push(failed, seen, { name: m[1], file, error: err ? clip(err, 160) : null });
        file = null;
      }
    }
  }
  // TAP reporter: « not ok » whose YAML block is not « subtestsFailed ».
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(lines[i]);
    if (!m) continue;
    found = true;
    if (sec >= 0) continue;
    let parent = false, file = null, error = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      const l = lines[j];
      if (/^\s*\.\.\.\s*$/.test(l)) break;
      if (/failureType: 'subtestsFailed'/.test(l)) parent = true;
      const loc = /location: '(.+?):(\d+):\d+'/.exec(l); if (loc) file = `${loc[1].replace(/\\\\/g, '\\')}:${loc[2]}`;
      const er = /^\s*error: '(.*)'\s*$/.exec(l); if (er) error = clip(er[1], 160);
    }
    if (!parent) push(failed, seen, { name: m[2], file, error });
  }
  for (const l of lines) {
    let m;
    if ((m = /^(?:ℹ|#) tests (\d+)\s*$/.exec(l))) { total = +m[1]; found = true; }
    if ((m = /^(?:ℹ|#) fail (\d+)\s*$/.exec(l))) fail = +m[1];
    if ((m = /^(?:ℹ|#) pass (\d+)\s*$/.exec(l))) pass = +m[1];
  }
  return found ? { runner: 'node --test', failed, counts: { total, failed: fail, passed: pass } } : null;
}

function parsePytest(lines) {
  const failed = [], seen = new Set();
  let found = false, collection = false;
  const counts = { total: null, failed: null, passed: null, errors: null };
  for (const l of lines) {
    let m;
    if ((m = /^(FAILED|ERROR) ([^\s(]\S*?)(?:::(\S+))?(?: - (.*))?$/.exec(l))) {
      found = true;
      if (m[1] === 'ERROR' && !m[3]) { collection = true; push(failed, seen, { name: m[2], file: m[2], error: m[4] ? clip(m[4], 160) : 'erreur à la collecte', collection: true }); continue; }
      push(failed, seen, { name: m[3] ? `${m[2]}::${m[3]}` : m[2], file: m[2], error: m[4] ? clip(m[4], 160) : null });
    }
    if (/^=+ .*\b(?:passed|failed|error|errors|no tests ran)\b.* in [\d.]+s/.test(l)) {
      found = true;
      const n = (k) => { const x = new RegExp(`(\\d+) ${k}\\b`).exec(l); return x ? +x[1] : 0; };
      counts.failed = n('failed'); counts.passed = n('passed'); counts.errors = n('errors?');
      counts.total = counts.failed + counts.passed + n('skipped');
    }
    if (/error during collection|errors during collection/.test(l)) collection = true;
  }
  return found ? { runner: 'pytest', failed, counts, collection } : null;
}

function parseUnittest(lines) {
  const failed = [], seen = new Set();
  let total = null, found = false;
  for (let i = 0; i < lines.length; i++) {
    let m;
    if ((m = /^(FAIL|ERROR): (\S+) \(([^)]+)\)/.exec(lines[i]))) { found = true; push(failed, seen, { name: `${m[3]}`.endsWith(m[2]) ? m[3] : `${m[3]}.${m[2]}`, file: null, error: null }); }
    if ((m = /^Ran (\d+) tests? in /.exec(lines[i]))) { total = +m[1]; found = true; }
  }
  return found ? { runner: 'unittest', failed, counts: { total, failed: failed.length, passed: total != null ? total - failed.length : null } } : null;
}

function parseGradle(lines) {
  const failed = [], seen = new Set();
  let found = false, total = null, fail = null, wrong = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*(\S+) > (.+?) FAILED\s*$/.exec(l))) {
      found = true;
      const err = (lines[i + 1] || '').trim();
      push(failed, seen, { name: `${m[1]} > ${m[2]}`, file: null, error: err && !/FAILED$/.test(err) ? clip(err, 160) : null });
    }
    if ((m = /^(\d+) tests? completed, (\d+) failed/.exec(l))) { total = +m[1]; fail = +m[2]; found = true; }
    if (/^\* What went wrong:/.test(l)) {
      found = true;
      wrong = lines.slice(i + 1, i + 6).map(s => s.trim()).filter(s => s && !/^\* Try:/.test(s)).slice(0, 3).join(' ');
    }
  }
  if (!found && !lines.some(l => /gradle/i.test(l))) return null;
  const testsFailed = failed.length || /There were failing tests/.test(wrong || '');
  return { runner: 'gradle', failed, counts: { total, failed: fail, passed: total != null && fail != null ? total - fail : null },
    buildError: !testsFailed && wrong ? clip(wrong, 300) : null };
}

function parseDotnet(lines) {
  const failed = [], seen = new Set();
  let found = false;
  const counts = { total: null, failed: null, passed: null };
  let buildError = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s+Failed (\S+) \[[^\]]+\]\s*$/.exec(l))) {
      found = true;
      const k = lines.slice(i + 1, i + 4).findIndex(s => /Error Message:/.test(s));
      push(failed, seen, { name: m[1], file: null, error: k >= 0 ? clip(lines[i + 2 + k], 160) : null });
    }
    if ((m = /Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+), Total:\s*(\d+)/.exec(l))) {
      found = true; counts.failed = +m[1]; counts.passed = +m[2]; counts.total = +m[4];
    }
    if (!buildError && /: error (?:CS|MSB|NU)\d+/.test(l)) { buildError = clip(l, 300); found = true; }
    if (/Build FAILED\./.test(l)) found = true;
  }
  if (!found) return null;
  return { runner: 'dotnet test', failed, counts, buildError: failed.length ? null : buildError };
}

/** Last useful lines of an output (stack frames, npm boilerplate and blanks dropped). */
export function usefulTail(text, n = MAX_TAIL) {
  return stripAnsi(text).split(/\r?\n/).filter(l => !NOISE.test(l)).map(l => clip(l, 240)).slice(-n);
}

/**
 * → { kind: 'passed'|'tests'|'not-run'|'unknown', runner, failed[{name, file, error}],
 *     counts {total, failed, passed}, reason, missing[], tail[] }
 *   tests   — N tests failed (named);
 *   not-run — the command could not run its tests (environment, missing file,
 *             build or collection error): `reason` says why;
 *   unknown — non-zero exit, no test identified: `tail` holds the last lines.
 */
export function parseTestOutput(text, { code = null } = {}) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const tail = usefulTail(clean);
  const missing = missingPaths(clean);
  const envLine = lines.find(l => ENV_SIGNS.some(re => re.test(l)));
  const parsers = [parseNode, parsePytest, parseUnittest, parseDotnet, parseGradle];
  let r = null;
  for (const p of parsers) { const x = p(lines); if (x && (x.failed.length || x.counts?.total != null || x.buildError || x.collection)) { r = x; break; } }
  const base = { runner: r?.runner || null, failed: [], counts: r?.counts || null, reason: null, missing, tail };
  if (code === 0) return { ...base, kind: 'passed' };
  if (r?.collection) return { ...base, kind: 'not-run', failed: r.failed.slice(0, MAX_TESTS), reason: clip(envLine || r.failed[0]?.error || 'erreur à la collecte des tests', 300) };
  if (r?.failed.length) {
    return { ...base, kind: 'tests', failed: r.failed.slice(0, MAX_TESTS), truncated: Math.max(0, r.failed.length - MAX_TESTS),
      counts: { ...r.counts, failed: r.counts?.failed ?? r.failed.length } };
  }
  if (r?.buildError) return { ...base, kind: 'not-run', reason: r.buildError };
  if (code === 127 || envLine) return { ...base, kind: 'not-run', reason: clip(envLine || `commande introuvable (code ${code})`, 300) };
  if (r?.counts?.total === 0) return { ...base, kind: 'not-run', reason: 'aucun test exécuté' };
  return { ...base, kind: 'unknown' };
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** One French line for an alert: what failed, never just « KO : testCommand ». */
export function describeFailures(f) {
  if (!f) return null;
  if (f.kind === 'passed') return 'tests verts';
  const miss = f.missing?.length ? ` — fichier(s) manquant(s) : ${f.missing.slice(0, 3).join(', ')}` : '';
  if (f.kind === 'not-run') return `la commande de test n’a pas pu tourner : ${f.reason || 'raison inconnue'}${miss}`;
  if (f.kind === 'tests') {
    const n = f.counts?.failed ?? f.failed.length;
    const names = f.failed.slice(0, 3).map(t => `« ${t.name} »`).join(', ');
    return `${plural(n, 'test en échec', 'tests en échec')}${f.counts?.total != null ? ` sur ${f.counts.total}` : ''}${f.runner ? ` (${f.runner})` : ''} : ${names}${f.failed.length > 3 ? ', …' : ''}${miss}`;
  }
  return `échec sans test identifié${f.tail?.length ? ` — dernières lignes : ${f.tail.slice(-3).join(' | ')}` : ''}${miss}`;
}

/** Detailed lines (each failed test with its place and first error line, or the tail). */
export function failureLines(f, { max = 10, indent = '' } = {}) {
  if (!f || f.kind === 'passed') return [];
  const L = [];
  if (f.kind === 'tests') {
    for (const t of f.failed.slice(0, max)) L.push(`${indent}- ${t.name}${t.file ? ` (${t.file})` : ''}${t.error ? ` — ${t.error}` : ''}`);
    const more = (f.failed.length - Math.min(max, f.failed.length)) + (f.truncated || 0);
    if (more > 0) L.push(`${indent}- … et ${more} autre(s)`);
  } else for (const l of (f.tail || []).slice(-max)) L.push(`${indent}| ${l}`);
  return L;
}

/** KO identifiers for the bisect (stillRed compares them between runs). */
export function koIds(f, code) {
  if (code === 0) return [];
  if (f?.kind === 'tests') return f.failed.map(t => `test:${t.name}`);
  if (f?.kind === 'not-run') return ['testCommand:non-lancée'];
  return ['testCommand'];
}

/** A compact copy for state files and alerts. */
export function compactFailures(f) {
  if (!f) return null;
  return { kind: f.kind, runner: f.runner, counts: f.counts, reason: f.reason, missing: (f.missing || []).slice(0, 5),
    failed: (f.failed || []).slice(0, 10), truncated: Math.max(0, (f.failed || []).length - 10) + (f.truncated || 0), tail: (f.tail || []).slice(-8) };
}
