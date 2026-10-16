#!/usr/bin/env node
// ============================================================================
// scripts/pipeline-onboard.mjs — put fleet projects in service (pipelines
// phase 7, 0.56.0)
// ============================================================================
//
//   node scripts/pipeline-onboard.mjs --plan <plan.json> [--dry-run] [--apply]
//
// plan.json: { "<project>": { "testCommand": "…", "verified": true|false,
//              "why": "reason when not eligible" }, … }
// (test commands are established beforehand by really running them.)
//
// For each project of config.json (the chef and its slots excepted):
//   1. eligibility: git work tree at the project root, a verified green test
//      command, no uncommitted change outside local-only files;
//   2. local CLI files never block a pipeline and are never committed:
//      untracked `.claude/` → `.git/info/exclude`; tracked
//      `.claude/settings*.json` → `git update-index --skip-worktree` (both
//      purely local to this machine, nothing is pushed or rewritten);
//   3. `.orchestrateur/pipeline.json` (test command, test globs, version
//      files, changelog, requirements register) is committed alone, in a
//      dedicated documented commit — except for a branch that diverged from
//      its upstream: there the file stays local (`.git/info/exclude`) so the
//      history is not touched at all.
// --apply also writes model-routing.json → enforcement (projects, generalSince).
// Every action is recorded in logs/pipeline-onboarding.json and the table of
// logs/pipeline-onboarding.md. Both are MERGED: only the projects named in the
// plan are re-evaluated, every other line is kept as it was (0.110.0).
// Rollback: `node scripts/pipeline-enforce.mjs off <project>` or `off --all`.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnforcement, writeEnforcement, isEnforced, readVersion, isLocalOnly, ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() }; };

const GLOBS = {
  node: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
  // `test*.py` is unittest's default discovery pattern.
  python: ['tests/**', 'test/**', '**/test_*.py', '**/test*.py', '**/*_test.py'],
  gradle: ['**/src/test/**', '**/src/androidTest/**'],
  dotnet: ['**/tests/**', '**/*.Tests/**'],
};
export function stackOf(cmd) {
  if (/gradlew/i.test(cmd)) return 'gradle';
  if (/dotnet/i.test(cmd)) return 'dotnet';
  // pytest, unittest, nose/tox/nox, or any interpreter call (`python.exe -m …`, `py -m …`).
  if (/pytest|unittest|\bnose2?\b|\btox\b|\bnox\b|\bpython[0-9.]*(\.exe)?\b|(^|[\s\\/"'])py(\.exe)?\s+-/i.test(cmd)) return 'python';
  return 'node';
}

/**
 * Merges this run's results into the previous report: only the projects named
 * in the plan are re-evaluated; every other project keeps its previous line
 * (never downgraded to « exclu » because a plan was partial).
 */
export function mergeReport(prev, planned, { projects = [], enforced = [], at = new Date().toISOString() } = {}) {
  const before = new Map((prev?.results || []).map(r => [r.name, r]));
  const fresh = new Map(planned.map(r => [r.name, { ...r, at }]));
  const names = [...new Set([...projects, ...before.keys(), ...fresh.keys()])];
  const results = names.map(n => fresh.get(n) || before.get(n)
    || (enforced.includes(n) ? { name: n, status: 'service', why: 'déjà en service (absent de ce plan)' } : { name: n, status: 'exclu', why: 'pas encore évalué (absent des plans d’intégration)' }));
  return { at, results };
}

const mdCell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
function mdRow(r) {
  if (r.status === 'service') return `| ${r.name} | en service${r.local ? ' (`pipeline.json` local)' : ''} | \`${mdCell(r.config?.testCommand || r.testCommand || '')}\` |`;
  return `| ${r.name} | exclu | ${mdCell(r.why)} |`;
}
const MD_HEAD = '# Mise en service générale — tableau nominatif (local, non versionné)\n\n| Projet | État | Commande de test (vérifiée verte) / raison |\n|---|---|---|\n';

/**
 * Upserts the rows of the projects evaluated by this run in the hand-kept
 * table of logs/pipeline-onboarding.md; every other row is left untouched. A
 * project listed in a grouped first cell (« a, b, c ») leaves that group.
 */
export function updateOnboardingMd(text, planned) {
  const lines = (text && text.trim() ? text : MD_HEAD).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const firstCell = (l) => (/^\|/.test(l) ? l.split('|')[1].trim() : null);
  for (const r of planned) {
    const row = mdRow(r);
    let i = lines.findIndex(l => firstCell(l) === r.name);
    if (i >= 0) { lines[i] = row; continue; }
    const g = lines.findIndex(l => (firstCell(l) || '').split(/\s*,\s*/).length > 1 && firstCell(l).split(/\s*,\s*/).includes(r.name));
    if (g >= 0) {
      const rest = firstCell(lines[g]).split(/\s*,\s*/).filter(n => n !== r.name);
      lines[g] = lines[g].replace(/^\|[^|]*\|/, `| ${rest.join(', ')} |`);
    }
    const sep = lines.findIndex(l => /^\|\s*-/.test(l));
    const rows = lines.map((l, k) => k).filter(k => k > sep && sep >= 0 && /^\|/.test(lines[k]));
    const lastService = rows.filter(k => /^\|[^|]*\|\s*en service/.test(lines[k])).pop();
    const at = r.status === 'service' && lastService != null ? lastService + 1 : (rows.length ? rows[rows.length - 1] + 1 : lines.length);
    lines.splice(at, 0, row);
  }
  return lines.join('\n') + '\n';
}

/** pipeline.json content for a project, from what really exists in it. */
export function pipelineConfigFor(dir, testCommand) {
  const versionFiles = ['package.json', 'app/build.gradle.kts', 'app/build.gradle', 'pyproject.toml']
    .filter(f => { try { return readVersion(f, fs.readFileSync(path.join(dir, f), 'utf8')) != null; } catch { return false; } })
    .slice(0, 1);
  return {
    testCommand,
    testGlobs: GLOBS[stackOf(testCommand)],
    versionFiles,
    ...(fs.existsSync(path.join(dir, 'CHANGELOG.md')) ? { changelog: 'CHANGELOG.md' } : {}),
    ...(fs.existsSync(path.join(dir, 'docs', 'USER_REQUIREMENTS.md')) ? { requirements: 'docs/USER_REQUIREMENTS.md' } : {}),
  };
}

// Same fallback identity as item-delivery.mjs: a machine without a git identity
// must not leave a project out of service.
const identityArgs = (dir) => git(dir, 'config', 'user.email').out ? [] : ['-c', 'user.name=orchestrateur', '-c', 'user.email=orchestrateur@localhost'];

function addExclude(dir, line) {
  const gd = git(dir, 'rev-parse', '--git-dir').out;
  const f = path.join(path.isAbsolute(gd) ? gd : path.join(dir, gd), 'info', 'exclude');
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.split(/\r?\n/).includes(line)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  return true;
}

/** Onboards one project. Returns { name, status: 'service'|'exclu', why?, actions[], config? }. */
export function onboardProject(project, entry, { dryRun = false } = {}) {
  const dir = project.path;
  const out = { name: project.name, actions: [] };
  const exclude = (why) => ({ ...out, status: 'exclu', why });
  if (!fs.existsSync(dir)) return exclude('dossier absent');
  if (git(dir, 'rev-parse', '--is-inside-work-tree').out !== 'true') return exclude('pas de dépôt git (les critères de sortie s’appuient sur git)');
  if (path.resolve(git(dir, 'rev-parse', '--show-toplevel').out) !== path.resolve(dir)) return exclude('le dossier du projet n’est pas la racine de son dépôt git');
  if (!entry?.testCommand || !entry.verified) return exclude(entry?.why || 'aucune commande de test vérifiée (le Développement exige une suite de tests verte)');
  const up = git(dir, 'rev-parse', '--abbrev-ref', '@{u}');
  let diverged = false;
  if (up.ok) {
    const [ahead, behind] = git(dir, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').out.split(/\s+/).map(Number);
    diverged = ahead > 0 && behind > 0;
    out.upstream = { name: up.out, ahead, behind };
  } else out.upstream = null;
  // 1. Local CLI files: never block, never committed.
  const untrackedClaude = git(dir, 'ls-files', '-o', '--exclude-standard', '--directory', '.claude').out.split('\n').filter(Boolean);
  if (untrackedClaude.length) { if (!dryRun && addExclude(dir, '.claude/')) out.actions.push('.claude/ ajouté à .git/info/exclude (local)'); else if (dryRun) out.actions.push('(simulation) .claude/ → .git/info/exclude'); }
  for (const f of git(dir, 'ls-files', '.claude').out.split('\n').filter(f => /^\.claude\/settings(\.local)?\.json$/.test(f))) {
    if (!dryRun) git(dir, 'update-index', '--skip-worktree', f);
    out.actions.push(`${dryRun ? '(simulation) ' : ''}${f} : skip-worktree (réglages locaux du CLI, jamais commités)`);
  }
  // 2. A clean tree is required (never commit someone else's work in progress).
  const dirty = git(dir, 'status', '--porcelain').out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
  if (dirty.length && !dryRun) return exclude(`arbre non propre : ${dirty.slice(0, 5).map(l => l.slice(3)).join(', ')}`);
  // 3. pipeline.json.
  const pj = path.join(dir, '.orchestrateur', 'pipeline.json');
  if (fs.existsSync(pj)) {
    out.config = JSON.parse(fs.readFileSync(pj, 'utf8'));
    out.actions.push('pipeline.json déjà présent : conservé');
  } else {
    out.config = pipelineConfigFor(dir, entry.testCommand);
    if (!dryRun) {
      const pjDir = path.dirname(pj);
      const createdDir = !fs.existsSync(pjDir);
      fs.mkdirSync(pjDir, { recursive: true });
      fs.writeFileSync(pj, JSON.stringify(out.config, null, 2) + '\n');
      if (diverged) {
        addExclude(dir, '.orchestrateur/pipeline.json');
        out.actions.push(`pipeline.json écrit en LOCAL (.git/info/exclude) : la branche a divergé de ${up.out} (+${out.upstream.ahead}/-${out.upstream.behind}), son historique n’est pas touché`);
      } else {
        // -f: many projects ignore the whole `.orchestrateur/` folder (run
        // artefacts). Only this one file is forced; nothing else of the folder.
        const add = git(dir, 'add', '-f', '--', '.orchestrateur/pipeline.json');
        const c = add.ok && git(dir, ...identityArgs(dir), 'commit', '-q', '-m', 'chore(orchestrator): add .orchestrateur/pipeline.json',
          '-m', 'Exit criteria of the orchestrator pipelines (test command, test globs, version files, changelog). Generated when the project was put in service (orchestrateur 0.56.0); edit freely.',
          '--', '.orchestrateur/pipeline.json');
        if (!add.ok || !c.ok) {
          // Never leave a half-applied state: unstage and remove what this run wrote.
          git(dir, 'rm', '-q', '--cached', '--ignore-unmatch', '--', '.orchestrateur/pipeline.json');
          let cleaned = true;
          try { fs.rmSync(pj, { force: true }); if (createdDir && !fs.readdirSync(pjDir).length) fs.rmdirSync(pjDir); } catch { cleaned = false; }
          const why = (add.ok ? c.err : add.err).slice(0, 200);
          out.actions.push(cleaned ? 'pipeline.json retiré après l’échec du commit (aucun état à moitié appliqué)' : `⚠ pipeline.json n’a pas pu être retiré : ${pj}`);
          return exclude(`${add.ok ? 'commit' : 'git add'} de pipeline.json impossible : ${why} — ${cleaned ? 'fichier écrit retiré, projet inchangé' : `⚠ fichier écrit resté sur le disque (${pj}), à retirer à la main`}`);
        }
        out.actions.push(`commit ${git(dir, 'rev-parse', '--short', 'HEAD').out} : .orchestrateur/pipeline.json (seul fichier du commit, aucun push)`);
      }
    } else out.actions.push(`(simulation) pipeline.json ${diverged ? 'local' : 'commité'}`);
  }
  if (!dryRun) {
    const still = git(dir, 'status', '--porcelain').out.split('\n').filter(l => l && !isLocalOnly(l.slice(3)));
    if (still.length) return exclude(`arbre non propre après l’intégration : ${still.slice(0, 5).join(', ')}`);
  }
  return { ...out, status: 'service', local: diverged };
}

// ---------------------------------------------------------------------------
// New musicians are in service from creation (0.109.0). User rule of
// 2026-10-16: « Tout nouveau musicien est sensé en être ». Until then only the
// one-shot phase 7 batch above put projects in service, so every project
// created afterwards by new-project.mjs silently stayed out.

// Markers of a non-Node stack: no Node suite is ever generated over them.
const OTHER_STACKS = ['gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml'];
const NPM_PLACEHOLDER_TEST = /no test specified/i;
const NEW_PROJECT_GITIGNORE = 'TODO_LIST.md\nnode_modules/\nlogs/\n';
const SMOKE_TEST = `// Generated by the orchestrator (scripts/new-project.mjs): a project needs a
// green test suite to run in the orchestrator pipelines. Extend or replace it
// with real tests as the project grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('package.json version matches the latest CHANGELOG release', () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const top = /^## \\[(\\d+\\.\\d+\\.\\d+[^\\]]*)\\]/m.exec(changelog);
  assert.ok(top, 'CHANGELOG.md has a released version');
  assert.equal(version, top[1]);
});
`;

/** Test command the project already declares (pipeline.json, then a real npm "test" script), or null. */
export function declaredTestCommand(dir) {
  try { const c = JSON.parse(fs.readFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), 'utf8')).testCommand; if (c) return c; } catch { /* absent */ }
  try { const t = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test; if (t && !NPM_PLACEHOLDER_TEST.test(t)) return 'npm test'; } catch { /* absent */ }
  return null;
}

function turnRunning(root, name) {
  try { process.kill(Number(fs.readFileSync(path.join(root, 'logs', `${name}.pid`), 'utf8')), 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Puts a project created (or completed) by new-project.mjs in service.
 *   fresh      — the folder was created (or empty) in this run: only our
 *                scaffolding is in it, so a git repo may be initialised and
 *                everything committed;
 *   scaffolded — files new-project.mjs created in this run (relative paths):
 *                in an existing repo, only those are committed, never anyone
 *                else's work.
 * Returns { status: 'service'|'already'|'chef'|'exclu', why?, actions[], testCommand? }.
 * 'exclu' always carries the reason and what to do: never silently out of service.
 */
export function serviceNewProject(root, { name, dir, fresh = false, scaffolded = [] }) {
  const actions = [];
  const exclude = (why) => ({ status: 'exclu', why, actions });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { /* checked by the caller */ }
  const conductor = cfg.conductor || 'chef';
  if (name === conductor || new RegExp(`^${conductor}-\\d+$`).test(name)) return { status: 'chef', why: 'le chef : pipeline Routage (pipeline-enforce on --chef)', actions };
  const enf = readEnforcement(root);
  if (isEnforced(enf, name)) return { status: 'already', actions };
  if (turnRunning(root, name)) return exclude(`un tour de ${name} est en cours : rien n'est touché, relancer new-project.mjs ${name} après ce tour`);

  // 1. git at the project root.
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || path.resolve(top.out) !== path.resolve(dir)) {
    if (!fresh) return exclude(`pas de dépôt git à la racine de ${dir} (dossier existant : rien n'est initialisé ni commité à la place de son propriétaire) — faire « git init » et un premier commit, puis relancer new-project.mjs ${name}`);
    const init = git(dir, 'init', '-q');
    if (!init.ok) return exclude(`git init impossible : ${init.err.slice(0, 200) || 'git introuvable ?'}`);
    actions.push('git init');
    if (!fs.existsSync(path.join(dir, '.gitignore'))) { fs.writeFileSync(path.join(dir, '.gitignore'), NEW_PROJECT_GITIGNORE); scaffolded = [...scaffolded, '.gitignore']; actions.push('.gitignore (TODO_LIST.md, node_modules/, logs/)'); }
  }

  // 2. A test command: declared, or a minimal Node suite generated.
  let testCommand = declaredTestCommand(dir);
  if (!testCommand) {
    const stack = OTHER_STACKS.find(f => fs.existsSync(path.join(dir, f))) || (fs.existsSync(path.join(dir, 'package.json')) ? 'package.json sans script "test"' : null);
    if (stack) return exclude(`aucune commande de test déclarée (${stack}) — déclarer « testCommand » dans .orchestrateur/pipeline.json (ou un script "test" dans package.json), vérifier qu'elle passe, puis relancer new-project.mjs ${name}`);
    let version = '1.0.0';
    try { version = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'))?.[1] || version; } catch { /* no changelog */ }
    const pkg = { name: name.toLowerCase(), version, private: true, type: 'module', scripts: { test: 'node --test' } };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const smoke = path.join('tests', 'smoke.test.mjs');
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    if (!fs.existsSync(path.join(dir, smoke))) fs.writeFileSync(path.join(dir, smoke), SMOKE_TEST);
    scaffolded = [...scaffolded, 'package.json', smoke];
    testCommand = 'npm test';
    actions.push(`suite minimale générée : package.json (version ${version}, "test": "node --test") + tests/smoke.test.mjs`);
  }

  // 3. Commit what this run created, and only that (the fresh folder holds nothing else).
  const hasHead = git(dir, 'rev-parse', '--verify', '-q', 'HEAD').ok;
  const paths = fresh && !hasHead ? null : [...new Set(scaffolded)].map(p => p.split(path.sep).join('/')).filter(p => !isLocalOnly(p) && fs.existsSync(path.join(dir, p)));
  if (!paths || paths.length) {
    const add = paths ? git(dir, 'add', '--', ...paths) : git(dir, 'add', '-A', '--', '.', ':(exclude).claude');
    const c = add.ok && git(dir, ...identityArgs(dir), 'commit', '-q', '-m', `chore: scaffold ${name} (orchestrateur new-project.mjs)`,
      '-m', 'Fleet project template, version/changelog rules and a test suite, so that the project runs in the orchestrator pipelines from creation.',
      ...(paths ? ['--', ...paths] : []));
    if (!add.ok || !c.ok) return exclude(`commit du squelette impossible : ${(add.err || c.err || '').slice(0, 200)}`);
    actions.push(`commit ${git(dir, 'rev-parse', '--short', 'HEAD').out} : squelette (${paths ? paths.join(', ') : 'dépôt neuf'}, aucun push)`);
  }

  // 4. The suite must really pass (the Development pipeline starts on a green base).
  const t = spawnSync(testCommand, { cwd: dir, shell: true, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
  if (t.status !== 0) {
    const tail = `${t.stdout || ''}${t.stderr || ''}`.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 400);
    return exclude(`suite de tests rouge (« ${testCommand} », code ${t.status ?? t.error?.code}) : ${tail} — la rendre verte, puis relancer new-project.mjs ${name}`);
  }
  actions.push(`suite verte : ${testCommand}`);

  // 5. pipeline.json + local CLI files, then enforcement.
  const r = onboardProject({ name, path: dir }, { testCommand, verified: true });
  actions.push(...r.actions);
  if (r.status !== 'service') return exclude(r.why);
  const cur = readEnforcement(root);
  writeEnforcement(root, { projects: [...new Set([...cur.projects, name])], pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, by: `new-project ${name}` });
  actions.push('model-routing.json → enforcement.projects');
  return { status: 'service', actions, testCommand, local: r.local };
}

// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const planFile = flag('--plan');
  if (!planFile) { console.error('usage: node scripts/pipeline-onboard.mjs --plan <plan.json> [--dry-run] [--apply]'); process.exit(64); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const dryRun = args.includes('--dry-run');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const conductor = cfg.conductor || 'chef';
  const results = [];
  const isChef = (n) => n === conductor || new RegExp(`^${conductor}-\\d+$`).test(n);
  for (const n of Object.keys(plan)) if (!cfg.projects.some(p => p.name === n)) console.log(`${n.padEnd(18)} IGNORÉ     absent de config.json`);
  // Only the projects named in the plan are evaluated: a partial plan never
  // rewrites (nor downgrades) the line of any other project.
  for (const p of cfg.projects) {
    if (isChef(p.name)) { results.push({ name: p.name, status: 'chef', why: 'le chef : pipeline Routage (pipeline-enforce on --chef)' }); continue; }
    if (!Object.hasOwn(plan, p.name)) continue;
    // A project whose turn is running is never touched (its working tree is in use).
    let busy = false;
    try { const pid = Number(fs.readFileSync(path.join(ROOT, 'logs', `${p.name}.pid`), 'utf8')); process.kill(pid, 0); busy = true; } catch (e) { busy = e?.code === 'EPERM'; }
    const r = busy && plan[p.name]?.verified ? { name: p.name, status: 'exclu', why: 'tour en cours : intégration reportée (relancer le script plus tard)', actions: [] } : onboardProject(p, plan[p.name], { dryRun });
    results.push(r);
    console.log(`${r.name.padEnd(18)} ${r.status === 'service' ? 'EN SERVICE' : 'EXCLU     '} ${r.why || r.config?.testCommand || ''}`);
  }
  const untouched = cfg.projects.filter(p => !isChef(p.name) && !Object.hasOwn(plan, p.name)).length;
  if (untouched) console.log(`(${untouched} autre(s) projet(s) hors de ce plan : relevé inchangé)`);
  if (!dryRun) {
    const jf = path.join(ROOT, 'logs', 'pipeline-onboarding.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { /* first run, or unreadable: start a new report */ }
    const report = mergeReport(prev, results, { projects: cfg.projects.map(p => p.name), enforced: readEnforcement(ROOT).projects });
    fs.writeFileSync(jf, JSON.stringify(report, null, 2));
    const mf = path.join(ROOT, 'logs', 'pipeline-onboarding.md');
    let md = '';
    try { md = fs.readFileSync(mf, 'utf8'); } catch { /* created below */ }
    fs.writeFileSync(mf, updateOnboardingMd(md, results.filter(r => r.status !== 'chef')));
    if (args.includes('--apply')) {
      const cur = readEnforcement(ROOT);
      const projects = [...new Set([...cur.projects, ...results.filter(r => r.status === 'service').map(r => r.name)])];
      const e = writeEnforcement(ROOT, { projects, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, generalSince: cur.generalSince || new Date().toISOString(), by: 'pipeline-onboard --apply (phase 7)' });
      console.log(`en service : ${e.projects.length} projet(s)`);
    }
  }
}
