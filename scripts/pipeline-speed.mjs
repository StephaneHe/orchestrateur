// ============================================================================
// scripts/pipeline-speed.mjs — « vitesse » levers of the full Development (0.143.0)
// ============================================================================
//
// User's « ok » (2026-10-23) to the chef's proposal, measured on six real
// Development runs of one project (304 model calls, 319 min, 27 refusals):
// 4b 119 min / 94 calls, 4a 106 min / 73 calls, Review 41 min / 61 calls,
// Understand + Design replayed by every new run, almost every run stopped on
// « découper » (15 tests or 90 min). Each lever has its own switch
// (pipeline-tuning.mjs), frozen per run; off = the behaviour before 0.143.0.
//
//   limits        — run limits set hot (tests per run, working time), 25 / 150 min
//   redGreen      — small item: test + code in ONE call; the PROGRAM proves the
//                   red (suite run with the code put back as before: it must
//                   fail on the new test, output kept), then the green
//   groupReview   — one Review for 2–3 consecutive items (provisional commit
//                   per item; a defect sends back only its item)
//   reuseContext  — a run citing the previous run of the same request reuses
//                   its comprehension.md / plan.md unless the code diverged
//   targetedTests — each step runs the item's tests and the tests that import
//                   or name the changed files (requirement tests included); the
//                   full suite runs only at Livrer
//   extraTests    — « N declared, N+1 written » accepted (and said) when the
//                   extra test is in the same file as the item's tests
//
// Everything here is plain code: git plumbing, file reading, a deterministic
// import graph. No model, no keyword routing.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { countTestCases } from './item-tests.mjs';
import { attachedCase } from './item-review.mjs';

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() };
}
const posix = (f) => String(f).replace(/\\/g, '/');
const LOCAL_ONLY = (f) => /^\.orchestrateur\/runs\/|^\.claude\//.test(posix(f));

/** The values a run uses, said in its tuning event (only those of the levers on). */
export function valuesText(t, v) {
  const parts = [];
  if (t?.limits) parts.push(`limites ${v.items} tests et ${v.runMin} min par exécution`);
  if (t?.groupReview) parts.push(`relecture groupée par ${v.reviewBatch} items`);
  if (t?.redGreen) parts.push(`test + code en un appel jusqu’à ${v.redGreenMaxTests} test(s) annoncé(s)`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// extraTests — « N tests annoncés, N+1 écrits »
// ---------------------------------------------------------------------------
/**
 * A refused item-tests verdict (checkItemTests) that the lever accepts: one
 * test more than declared, every added test in ONE file. → {file, declared,
 * written} or null (the refusal stands).
 */
export function toleratedExtra(v) {
  if (!v || v.ok || !v.checked || !Number.isInteger(v.declared)) return null;
  const files = Object.keys(v.added?.perFile || {});
  if (v.written !== v.declared + 1 || files.length !== 1) return null;
  return { file: files[0], declared: v.declared, written: v.written };
}
export function toleratedText(t, n) {
  return `item ${n} : ${t.written} tests écrits pour ${t.declared} annoncé(s) — accepté (levier extraTests) : le test en plus est dans le même fichier (${t.file})`;
}

// ---------------------------------------------------------------------------
// redGreen — file swaps for the red proof
// ---------------------------------------------------------------------------
/**
 * Puts `files` back as they are in snapshot `snap` (Map file → blob hash, the
 * engine's snapshot(): every blob was written with `hash-object -w`); a file
 * absent from `snap` is removed. Returns the files it could not restore.
 */
export function restoreFromSnapshot(cwd, files, snap) {
  const failed = [];
  for (const f of files) {
    const abs = path.join(cwd, f);
    if (!snap.has(f)) { try { fs.rmSync(abs, { force: true }); } catch { failed.push(f); } continue; }
    const r = spawnSync('git', ['-C', cwd, 'cat-file', 'blob', snap.get(f)], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) { failed.push(f); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, r.stdout);
  }
  return failed;
}

/** Does the failing output cite one of the test files (its name or one of its test titles)? */
export function failureCites(cwd, testFiles, out) {
  const text = String(out || '');
  for (const f of testFiles) {
    const name = path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
    if (name && text.includes(name)) return true;
    let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {}
    for (const m of s.matchAll(/\b(?:test|it|describe)\s*\(\s*(['"`])(.{3,120}?)\1/g)) if (text.includes(m[2])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// targetedTests — which tests a change touches
// ---------------------------------------------------------------------------
/** Steps of the TDD loop that run targeted tests; Livrer and the start precondition run the full suite. */
export const TARGET_STEPS = new Set(['rouge', 'vert', 'refactor', 'rouge-vert']);
const CODE_EXT = /\.(m?js|cjs|mts|cts|ts|tsx|jsx)$/i;
const IMPORT_RE = /(?:\bimport\s+(?:[^'"`]*?\sfrom\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*|\bexport\s+[^'"`]*?\sfrom\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
/** Files a project never needs to test (registry, docs, versions): they never force the full suite. */
function isNeutral(f, cfg) {
  const p = posix(f);
  if (/\.md$/i.test(p) || p.startsWith('docs/')) return true;
  if ((cfg.versionFiles || []).includes(p)) return true;
  return [cfg.changelog || 'CHANGELOG.md', cfg.requirements].filter(Boolean).includes(p);
}
function resolveImport(cwd, fromFile, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(posix(fromFile)), spec));
  if (base.startsWith('..')) return null;
  for (const c of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.ts`, `${base}/index.mjs`, `${base}/index.js`]) {
    try { if (fs.statSync(path.join(cwd, c)).isFile()) return c; } catch {}
  }
  return null;
}
/** Files reached by the real relative imports of `file`, transitively (bounded). */
export function importClosure(cwd, file, cache = new Map(), limit = 400) {
  const seen = new Set();
  const stack = [posix(file)];
  while (stack.length && seen.size < limit) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!CODE_EXT.test(f)) continue;
    let deps = cache.get(f);
    if (!deps) {
      let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch {}
      deps = [...s.matchAll(IMPORT_RE)].map(m => resolveImport(cwd, f, m[2])).filter(Boolean);
      cache.set(f, deps);
    }
    for (const d of deps) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

/** Files changed since `from` (committed or not), untracked included, run artefacts excluded. */
export function changedSince(cwd, from) {
  const tracked = git(cwd, ['diff', '--name-only', from]).out.split('\n');
  const untracked = git(cwd, ['ls-files', '-o', '--exclude-standard']).out.split('\n');
  return [...new Set([...tracked, ...untracked].map(posix).filter(f => f && !LOCAL_ONLY(f)))].sort();
}

/** The project's runnable test files: under its test globs AND declaring at least one test case. */
export function runnableTests(cwd, isTest) {
  const files = git(cwd, ['ls-files', '-c', '-o', '--exclude-standard']).out.split('\n').map(posix).filter(f => f && !LOCAL_ONLY(f) && isTest(f));
  return [...new Set(files)].filter((f) => {
    let s = ''; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return false; }
    return countTestCases(s, f) > 0;
  }).sort();
}

/** Test files cited by the requirements registry (« tests d'exigence »). */
export function requirementTests(cwd, cfg, tests) {
  if (!cfg.requirements) return new Set();
  let s = ''; try { s = fs.readFileSync(path.join(cwd, cfg.requirements), 'utf8'); } catch { return new Set(); }
  return new Set(tests.filter(t => s.includes(t) || s.includes(path.basename(t))));
}

/**
 * The command that runs only `files`: `targetedTestCommand` of
 * .orchestrateur/pipeline.json (« {files} » replaced), else, for a Node
 * project whose test script is `node … --test`, that script with the files.
 * → {command} | {why} (no targeting: the full suite runs, said).
 */
export function targetedCommand(cwd, cfg, files) {
  if (files.some(f => /["'`&|<>^%$;\r\n]/.test(f))) return { why: 'un nom de fichier de test contient un caractère spécial' };
  const list = files.map(f => (/\s/.test(f) ? `"${f}"` : f)).join(' ');
  let command = null;
  if (typeof cfg.targetedTestCommand === 'string' && cfg.targetedTestCommand.includes('{files}')) command = cfg.targetedTestCommand.replace('{files}', list);
  else {
    let script = null;
    const tc = String(cfg.testCommand || '').trim();
    if (/^npm(\.cmd)?\s+(run\s+)?test$/.test(tc)) {
      try { script = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts?.test || null; } catch {}
    } else if (/^node\s/.test(tc)) script = tc;
    if (script && /^node\s/.test(script.trim()) && /(^|\s)--test(\s|$)/.test(script) && !/[&|;<>]/.test(script)) command = `${script.trim()} ${list}`;
    // Deduced like « node --test » (2026-10-29): pytest takes the files, Gradle takes classes.
    else if (/^python3?(\.exe)?\s+-m\s+pytest(\s|$)/.test(tc) && !/[&|;<>]/.test(tc)) command = `python -m pytest -q ${list}`;
    else if (/(^|[\\/\s])gradlew(\.bat)?\s+\S*[tT]est\S*\s*$/.test(tc) && !/[&|;<>]/.test(tc)) {
      const classes = [...new Set(files.map(f => path.posix.basename(posix(f)).replace(/\.[^.]+$/, '')).filter(Boolean))];
      command = `${tc} ${classes.map(c => `--tests "*.${c}"`).join(' ')}`;
    }
  }
  if (!command) return { why: 'commande de tests ciblés inconnue : déclarer « targetedTestCommand » (avec {files}) dans .orchestrateur/pipeline.json' };
  // cmd.exe stops at 8191 characters.
  if (command.length > 7500) return { why: `trop de fichiers de test sélectionnés (${files.length}) pour une seule commande` };
  return { command };
}

/**
 * Tests to run for a change since `from`: the changed test files, then every
 * test whose import closure reaches a changed file or whose text names it.
 * A changed code file reached by no test, or no known command ⇒ the full suite.
 * → {targeted:true, command, files, reasons, requirement, total} | {targeted:false, why}
 */
export function selectTargetedTests({ cwd, cfg, from, isTest, lean = false }) {
  return selectForChanged({ cwd, cfg, changed: changedSince(cwd, from), isTest, lean });
}
/** Same selection for a given list of changed files (the bench reads them from real commits, read-only). */
export function selectForChanged({ cwd, cfg, changed, isTest, tests = null, lean = false }) {
  // Files of a declared area are tested by that area's own command, never by the main suite.
  if (Array.isArray(cfg.areas) && cfg.areas.length) changed = changed.filter(f => !cfg.areas.some(a => inArea(a, f)));
  tests = tests || runnableTests(cwd, isTest);
  if (!tests.length) return { targeted: false, why: 'aucun fichier de test reconnu' };
  const sources = changed.filter(f => !isTest(f) && !isNeutral(f, cfg));
  const reasons = new Map();
  const add = (t, why) => { if (!reasons.has(t)) reasons.set(t, why); };
  for (const f of changed) if (tests.includes(f)) add(f, 'test de l’item (modifié)');
  const cache = new Map();
  const texts = new Map(tests.map(t => { let s = ''; try { s = fs.readFileSync(path.join(cwd, t), 'utf8'); } catch {} return [t, s]; }));
  const uncovered = [];
  for (const src of sources) {
    let hit = false;
    for (const t of tests) {
      const closure = importClosure(cwd, t, cache);
      if (closure.has(src)) { add(t, `importe ${src}`); hit = true; continue; }
      const s = texts.get(t);
      if (s.includes(src) || s.includes(path.posix.basename(src))) { add(t, `nomme ${src}`); hit = true; }
    }
    // lean: a class name is not an import path (.kt…): tests naming the class count.
    if (!hit && lean) {
      const stem = path.posix.basename(src).replace(/\.[^.]+$/, '');
      const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = stem.length >= 3 ? new RegExp('\\b' + esc + '\\b') : null;
      if (re) for (const t of tests) if (re.test(texts.get(t))) { add(t, `nomme la classe ${stem}`); hit = true; }
    }
    if (!hit && fs.existsSync(path.join(cwd, src))) uncovered.push(src);
  }
  // lean (lever targetedTests): a changed file no test reaches no longer forces the
  // full suite at each step — the full run happens once, after the fact (idle regression).
  if (uncovered.length && !lean) return { targeted: false, why: `fichier modifié couvert par aucun test : ${uncovered.slice(0, 4).join(', ')}` };
  const files = [...reasons.keys()].sort();
  if (!files.length && lean) return { targeted: true, empty: true, command: null, files, reasons: {}, requirement: [], total: tests.length, uncovered };
  if (!files.length) return { targeted: false, why: 'aucun test touché par les fichiers modifiés' };
  const cmd = targetedCommand(cwd, cfg, files);
  if (!cmd.command) return { targeted: false, why: cmd.why };
  const req = requirementTests(cwd, cfg, files);
  return { targeted: true, command: cmd.command, files, reasons: Object.fromEntries(reasons), requirement: [...req], total: tests.length, ...(uncovered.length ? { uncovered } : {}) };
}

// ---------------------------------------------------------------------------
// areas — optional zones of .orchestrateur/pipeline.json (2026-10-29)
// ---------------------------------------------------------------------------
// Local glob (no import from the engine, which imports this module).
function areaGlob(g) {
  const s = posix(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\/\*\*$/, '/\u0001').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${s}$`);
}
const inArea = (a, f) => (a.paths || []).some(g => areaGlob(g).test(posix(f)));
/**
 * Which test commands a change needs when the project declares `areas`:
 * only the areas touched by the diff run their own command; a file outside
 * every area keeps the main suite. Without `areas`: the main suite, as before.
 * → {commands: [{area|null, command}], versionFiles}
 */
export function selectAreaTests({ cwd, cfg, changed, lean = false }) {
  const areas = Array.isArray(cfg.areas) ? cfg.areas : [];
  const files = changed.map(posix).filter(f => f && !LOCAL_ONLY(f));
  const touched = new Map();
  let mainTouched = !areas.length;
  for (const f of files) {
    const a = areas.find(x => inArea(x, f));
    if (a) touched.set(a.name, a);
    // docs, changelog, registry and main version files never make the main suite run on their own
    else if (!isNeutral(f, cfg)) mainTouched = true;
  }
  if (!touched.size) mainTouched = true;
  const commands = [];
  const versionFiles = [];
  const addVersions = (v) => { for (const x of v || []) if (!versionFiles.includes(x)) versionFiles.push(x); };
  if (mainTouched) { commands.push({ area: null, command: cfg.testCommand }); addVersions(cfg.versionFiles); }
  for (const a of touched.values()) {
    const own = files.filter(f => inArea(a, f));
    const isT = (f) => inArea(a, f) && (a.testGlobs || []).some(g => areaGlob(g).test(posix(f)));
    // targeting only under the lever (lean): otherwise the area's whole testCommand runs
    const sel = !lean ? { targeted: false } : selectForChanged({ cwd, changed: own, isTest: isT, lean,
      cfg: { testCommand: a.testCommand, targetedTestCommand: a.targetedTestCommand, testGlobs: a.testGlobs, versionFiles: a.versionFiles, changelog: cfg.changelog } });
    // targeted when known; an area whose selection is empty runs nothing (lean)
    const command = sel.targeted ? sel.command : a.testCommand;
    commands.push({ area: a.name, command, ...(sel.targeted ? { files: sel.files } : {}) });
    addVersions(a.versionFiles);
  }
  return { commands, versionFiles };
}

/** cfg with the areas' test globs merged into testGlobs (so their tests count as tests); the main ones stay in mainTestGlobs. */
export function withAreaTestGlobs(cfg) {
  if (!cfg || !Array.isArray(cfg.areas) || !cfg.areas.length || cfg.mainTestGlobs) return cfg;
  const extra = cfg.areas.flatMap(a => a?.testGlobs || []);
  return { ...cfg, mainTestGlobs: cfg.testGlobs || [], testGlobs: [...new Set([...(cfg.testGlobs || []), ...extra])] };
}

// ---------------------------------------------------------------------------
// reuseContext — Understand + Design of the previous run of the same request
// ---------------------------------------------------------------------------
const RUN_CITED_RE = /\bp-\d{8}T\d{6}-[0-9a-f]{6}\b/g;
/** Run ids cited by a request (identifiers, never words), most recent first. */
export function citedRuns(text) {
  return [...new Set(String(text || '').match(RUN_CITED_RE) || [])].sort().reverse();
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/**
 * Has the code diverged since the previous run ended? Its last commit must be
 * an ancestor of the current base, and the commits since may only touch
 * documentation, version files, CHANGELOG or the requirements registry.
 */
export function divergence(cwd, cfg, prevEnd, base) {
  if (!prevEnd) return 'fin de l’exécution précédente inconnue';
  if (prevEnd === base) return null;
  if (!git(cwd, ['merge-base', '--is-ancestor', prevEnd, base]).ok) return `le dernier commit de l’exécution précédente (${prevEnd.slice(0, 7)}) n’est plus dans l’historique`;
  const files = git(cwd, ['diff', '--name-only', prevEnd, base]).out.split('\n').map(posix).filter(Boolean);
  const code = files.filter(f => !isNeutral(f, cfg) && !LOCAL_ONLY(f));
  return code.length ? `code modifié depuis : ${code.slice(0, 5).join(', ')}${code.length > 5 ? ` (+${code.length - 5})` : ''}` : null;
}

/**
 * The previous run whose understanding and plan this one may reuse: cited by
 * the request, same project, full Development, both artefacts accepted, and
 * the code not diverged since. → {run, dir, end, why} | {none, why, tried}
 */
export function findReusableRun({ logsDir, request, project, run, dirs, cfg, cwd, base }) {
  const tried = [];
  for (const id of citedRuns(request)) {
    if (id === run) continue;
    const st = readJson(path.join(logsDir, 'runs', id, 'run.json'));
    const no = (why) => tried.push({ run: id, why });
    if (!st || st.project !== project) { no('exécution introuvable pour ce projet'); continue; }
    if (st.pipeline !== 'dev' || st.mode !== 'complet') { no('pas un Développement complet'); continue; }
    if (!['comprendre', 'concevoir'].every(s => (st.steps || []).some(x => x.id === s && ['ok', 'skipped'].includes(x.status)))) { no('compréhension ou plan non validés'); continue; }
    const dir = dirs.map(d => path.join(d, '.orchestrateur', 'runs', id)).find(d => ['comprehension.md', 'plan.md'].every(f => fs.existsSync(path.join(d, f))));
    if (!dir) { no('artefacts comprehension.md / plan.md introuvables'); continue; }
    const end = (st.releases || []).at(-1)?.commit || st.lastDelivered || st.base || null;
    const div = divergence(cwd, cfg, end, base);
    if (div) { no(`le code a divergé (${div})`); continue; }
    return { run: id, dir, end, request: String(st.request || '').slice(0, 300) };
  }
  return { none: true, why: tried.length ? tried.map(t => `${t.run} : ${t.why}`).join(' ; ') : 'aucune exécution citée par la demande', tried };
}

// ---------------------------------------------------------------------------
// groupReview — batch of items reviewed together
// ---------------------------------------------------------------------------
/**
 * Items of a batch review and their findings: every entry must name its item
 * (`{"item": n, "text": "…"}`) when the batch holds several items.
 * → {ok, byItem: {n: {items:[], fixes:[]}}} | {ok:false, why}
 */
export function attributeFindings(raw, groups) {
  let j;
  try { j = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, why: 'revue.json n’est pas un JSON valide' }; }
  const byItem = Object.fromEntries(groups.map(g => [g, { items: [], fixes: [] }]));
  const bad = [];
  const take = (list, kind) => {
    for (const x of Array.isArray(list) ? list : []) {
      const n = x && typeof x === 'object' ? Number(x.item) : NaN;
      const g = groups.length === 1 ? groups[0] : groups.includes(n) ? n : null;
      let s = String(typeof x === 'string' ? x : x?.text || '').replace(/\s+/g, ' ').trim();
      if (x && typeof x === 'object' && Number.isInteger(x.tests) && !/\(\s*tests?\s*:/i.test(s)) s = `(tests: ${x.tests}) ${s}`;
      if (!s) continue;
      if (g == null) { bad.push(s.slice(0, 80)); continue; }
      byItem[g][kind].push(s.slice(0, 400));
    }
  };
  take(j?.items, 'items');
  take(j?.hors_tdd, 'fixes');
  if (bad.length) return { ok: false, why: `revue.json : relecture groupée des items ${groups.join(', ')} — chaque entrée doit nommer son item, {"item": <n>, "text": "…"} ; sans item valide : ${bad.slice(0, 3).join(' ; ')}` };
  return { ok: true, byItem };
}

/**
 * Cases a grouped Review attaches to item `g`: inserted right after the last
 * case already started (checked), never before it — the items of a batch are
 * all started, and their numbers must not shift (insertAttachedCases puts them
 * right after the group, which would renumber the batch's later items).
 */
export function insertAfterStarted(md, g, defects) {
  const lines = String(md || '').replace(/\s*$/, '').split(/\r?\n/);
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*[-*]\s+\[(x|X)\]\s+.+$/.test(lines[i])) last = i;
  const at = last >= 0 ? last + 1 : lines.length;
  return [...lines.slice(0, at), ...defects.map(d => attachedCase(g, d)), ...lines.slice(at)].join('\n') + '\n';
}

/**
 * Longest prefix of the batch's commits (in commit order) whose items are all
 * reviewed without defect: what can be delivered now.
 * seq = [{commit, group}], reviewed = Set of groups. → {commit, groups} | null
 */
export function deliverablePrefix(seq, reviewed) {
  let n = 0;
  for (const s of seq) { if (!reviewed.has(s.group)) break; n++; }
  // A commit shared by several items (put back together) is delivered whole or not at all.
  while (n > 0 && n < seq.length && seq[n].commit === seq[n - 1].commit) n--;
  if (!n) return null;
  const last = seq[n - 1].commit;
  const groups = [...new Set(seq.slice(0, n).map(s => s.group))];
  // A group whose later commit is not in the prefix is not delivered yet.
  const after = new Set(seq.slice(n).map(s => s.group));
  return { commit: last, groups: groups.filter(g => !after.has(g)) };
}
