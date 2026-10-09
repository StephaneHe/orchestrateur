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
// Every action is recorded in logs/pipeline-onboarding.json.
// Rollback: `node scripts/pipeline-enforce.mjs off <project>` or `off --all`.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnforcement, writeEnforcement, readVersion, isLocalOnly, ENGINE_PIPELINES } from './pipeline-engine.mjs';

const ROOT = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').trim() }; };

const GLOBS = {
  node: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
  python: ['tests/**', 'test/**', '**/test_*.py', '**/*_test.py'],
  gradle: ['**/src/test/**', '**/src/androidTest/**'],
  dotnet: ['**/tests/**', '**/*.Tests/**'],
};
export function stackOf(cmd) {
  if (/gradlew/.test(cmd)) return 'gradle';
  if (/pytest/.test(cmd)) return 'python';
  if (/dotnet/.test(cmd)) return 'dotnet';
  return 'node';
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
      fs.mkdirSync(path.dirname(pj), { recursive: true });
      fs.writeFileSync(pj, JSON.stringify(out.config, null, 2) + '\n');
      if (diverged) {
        addExclude(dir, '.orchestrateur/pipeline.json');
        out.actions.push(`pipeline.json écrit en LOCAL (.git/info/exclude) : la branche a divergé de ${up.out} (+${out.upstream.ahead}/-${out.upstream.behind}), son historique n’est pas touché`);
      } else {
        git(dir, 'add', '--', '.orchestrateur/pipeline.json');
        const c = git(dir, 'commit', '-q', '-m', 'chore(orchestrator): add .orchestrateur/pipeline.json',
          '-m', 'Exit criteria of the orchestrator pipelines (test command, test globs, version files, changelog). Generated when the project was put in service (orchestrateur 0.56.0); edit freely.',
          '--', '.orchestrateur/pipeline.json');
        if (!c.ok) return exclude(`commit de pipeline.json impossible : ${c.err.slice(0, 200)}`);
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
  for (const p of cfg.projects) {
    if (p.name === conductor || new RegExp(`^${conductor}-\\d+$`).test(p.name)) { results.push({ name: p.name, status: 'chef', why: 'le chef : pipeline Routage (pipeline-enforce on --chef)' }); continue; }
    // A project whose turn is running is never touched (its working tree is in use).
    let busy = false;
    try { const pid = Number(fs.readFileSync(path.join(ROOT, 'logs', `${p.name}.pid`), 'utf8')); process.kill(pid, 0); busy = true; } catch (e) { busy = e?.code === 'EPERM'; }
    const r = busy && plan[p.name]?.verified ? { name: p.name, status: 'exclu', why: 'tour en cours : intégration reportée (relancer le script plus tard)', actions: [] } : onboardProject(p, plan[p.name], { dryRun });
    results.push(r);
    console.log(`${r.name.padEnd(18)} ${r.status === 'service' ? 'EN SERVICE' : 'EXCLU     '} ${r.why || r.config?.testCommand || ''}`);
  }
  if (!dryRun) {
    fs.writeFileSync(path.join(ROOT, 'logs', 'pipeline-onboarding.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    if (args.includes('--apply')) {
      const cur = readEnforcement(ROOT);
      const projects = [...new Set([...cur.projects, ...results.filter(r => r.status === 'service').map(r => r.name)])];
      const e = writeEnforcement(ROOT, { projects, pipelines: cur.pipelines.length ? cur.pipelines : ENGINE_PIPELINES, generalSince: new Date().toISOString(), by: 'pipeline-onboard --apply (phase 7)' });
      console.log(`en service : ${e.projects.length} projet(s)`);
    }
  }
}
