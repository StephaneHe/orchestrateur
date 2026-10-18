// ============================================================================
// scripts/lane-rules.mjs — when two tasks of the SAME musician cannot run in
// parallel (0.101.0)
// ============================================================================
//
// User request (2026-10-15), verbatim: « Il faut que ce soit assez fin (d'ou la
// question sur git) pour que les taches d'un meme musicien puissent s'activer
// en parallele. Sauf pour certains cas particuliers sont detectes, ils doivent
// alors etre justifies et documentes. »
//
// Principle: parallel by default (within maxParallel), serial only when a rule
// fires. Every rule has an id, a scope, and a justification documented in
// docs/PLAN-parallel-tasks-same-musician.md §3 (the suite _test_lane_rules.mjs
// fails when the registry and the document disagree). Detection is by code on
// facts (git, files, config) or by a field the Routage model declares
// (`ressources`) — never by keywords in the request (0.66.0 rule).
//
// Scopes:
//   project  the project never runs tasks in parallel (legacy turn lock, lane 0)
//   lane0    this task runs in lane 0 (the musician's own checkout); other
//            tasks may still run in lanes ≥ 1
//   lane     this task must run in one given lane (task affinity)
//   task     this task runs ALONE: it waits until every lane is idle and
//            blocks new lanes while it runs
//   resource tasks sharing the resource run one after the other
//   none     informational (exempt or verified-by-test), never fires
//
// Status: `active` (detected by this code) or `planned` (documented, detector
// not written yet — the document says which development item brings it).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DOC = 'docs/PLAN-parallel-tasks-same-musician.md';

/** Closed list of resources the Routage model may declare for a task. */
export const DECLARED_RESOURCES = ['migration', 'serveur', 'appareil', 'base', 'poste'];

export const RULES = [
  { id: 'no-git', scope: 'project', status: 'active',
    text: "le projet n'est pas un dépôt git (ou n'a aucun commit) : aucune copie isolée possible" },
  { id: 'git-unsupported', scope: 'project', status: 'active',
    text: 'dépôt non pris en charge par les copies isolées (sous-modules, LFS sans filtre, extraction partielle, HEAD détachée ou git trop ancien)' },
  { id: 'same-task', scope: 'lane', status: 'active',
    text: 'suite de la même tâche : elle reprend le couloir, la session et la copie de cette tâche' },
  { id: 'lane0-direct', scope: 'lane0', status: 'active',
    text: "dialogue direct de l'utilisateur : il travaille dans sa propre copie du projet" },
  // P9 (0.114.0): a NEW pipeline run goes to a lane (worktree); only a run that
  // started in the main checkout resumes there, where its files are.
  { id: 'pipeline-engine', scope: 'lane0', status: 'active',
    text: "reprise d'une exécution de pipeline commencée dans la copie principale : elle reprend là où sont ses fichiers" },
  // P9 is piloted by the dev instance first (user request 2026-10-18,
  // « orchestrateur-dev : il faut activer P9 »): every other project keeps its
  // pipeline runs in lane 0 until it opts in (`pipelineLanes: true`).
  { id: 'pipeline-pilot', scope: 'lane0', status: 'active',
    text: "exécution de pipeline d'un projet qui ne fait pas encore tourner ses pipelines dans les couloirs : orchestrateur-dev les pilote d'abord (décision utilisateur du 2026-10-18)" },
  { id: 'dual-mode', scope: 'lane0', status: 'active',
    text: 'mode double model demandé hors pipeline (--second-model) : ses deux branches partent de la copie principale' },
  { id: 'main-dirty', scope: 'lane0', status: 'active',
    text: "la copie principale a des modifications non commitées : la tâche doit les voir, elle tourne donc dans cette copie" },
  { id: 'machine-state', scope: 'task', status: 'active',
    text: 'la tâche touche au poste (tâches planifiées, services, registre, installations globales) : effets globaux, impossibles à fusionner' },
  { id: 'migration', scope: 'task', status: 'active',
    text: "migration de schéma : l'ordre des migrations est global" },
  { id: 'port', scope: 'resource', status: 'active',
    text: "la tâche lance un serveur sur un port fixe : deux serveurs ne peuvent pas écouter le même port" },
  { id: 'orchestrator-self', scope: 'resource', status: 'active',
    text: "instance de l'orchestrateur : son bac à sable écoute un port fixe (.orchestrateur-instance.json)" },
  { id: 'adb-device', scope: 'resource', status: 'active',
    text: 'installation ou exécution sur un appareil Android : un appareil, une application au premier plan' },
  { id: 'database', scope: 'resource', status: 'active',
    text: "base de données partagée : écritures et jeux d'essai concurrents s'écraseraient" },
  { id: 'gradle-heavy', scope: 'none', status: 'planned',
    text: 'builds Gradle : pas exclusifs, mais comptés double dans la limite du poste (item P4, limite du poste)' },
  { id: 'deps-shared', scope: 'task', status: 'planned',
    text: "la tâche change les dépendances alors que node_modules est partagé par lien (item P10)" },
  { id: 'outside-repo', scope: 'task', status: 'planned',
    text: "écriture hors du dossier du couloir : elle échapperait à l'isolation et à l'intégration (item P10)" },
  { id: 'chef', scope: 'none', status: 'active',
    text: 'le chef est exempté : il a déjà son propre pool de tours' },
  { id: 'codex-sandbox', scope: 'none', status: 'active',
    text: 'codex travaille dans le dossier du couloir (vérifié par test) ; listé pour qu’une régression se voie ici' },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));

/** Plain one-line justification shown to the user. */
export function ruleText(id, evidence) {
  const r = RULE_BY_ID[id];
  if (!r) return String(evidence || id);
  return `${r.text}${evidence ? ` — ${evidence}` : ''}`;
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Git facts of a checkout, read-only (GIT_OPTIONAL_LOCKS=0: the index is never rewritten). */
export function gitFacts(dir) {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return { repo: false, why: 'pas un dépôt git' };
  const top = git(dir, ['rev-parse', '--show-toplevel']).out;
  const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return { repo: false, why: 'dépôt sans aucun commit' };
  const facts = { repo: true, top, head: head.out, unsupported: [] };
  const branch = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  facts.branch = branch.ok ? branch.out : null;
  if (!facts.branch) facts.unsupported.push('HEAD détachée : pas de branche d’intégration');
  if (fs.existsSync(path.join(top, '.gitmodules'))) facts.unsupported.push('sous-modules (.gitmodules)');
  try {
    if (/filter=lfs/.test(fs.readFileSync(path.join(top, '.gitattributes'), 'utf8')) && !git(dir, ['lfs', 'version']).ok) facts.unsupported.push('LFS sans le filtre git-lfs installé');
  } catch { /* no .gitattributes */ }
  if (git(dir, ['config', '--bool', 'core.sparseCheckout']).out === 'true') facts.unsupported.push('extraction partielle (core.sparseCheckout)');
  const v = /(\d+)\.(\d+)/.exec(git(dir, ['--version']).out);
  if (v && (Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 20))) facts.unsupported.push(`git ${v[0]} < 2.20`);
  const st = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  facts.dirty = st.ok ? st.out.split('\n').filter(Boolean).map(l => l.slice(3)) : [];
  return facts;
}

/** Fixed ports this project is known to listen to: config `port`, the instance file, `lanes.ports` in pipeline.json. */
export function knownPorts(project) {
  const ports = new Set();
  if (Number(project.port) > 0) ports.add(Number(project.port));
  for (const p of readLanesCfg(project.path).ports || []) if (Number(p) > 0) ports.add(Number(p));
  return [...ports];
}
export function instancePort(project) {
  try { const j = JSON.parse(fs.readFileSync(path.join(project.path, '.orchestrateur-instance.json'), 'utf8')); return Number(j.port) > 0 ? Number(j.port) : null; }
  catch { return null; }
}
/** `lanes` block of the project's versioned .orchestrateur/pipeline.json (may be absent). */
export function readLanesCfg(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, '.orchestrateur', 'pipeline.json'), 'utf8')); return j && typeof j.lanes === 'object' && j.lanes ? j.lanes : {}; }
  catch { return {}; }
}

/** Parses `--ressources a,b` (closed list). Unknown names are reported, never guessed. */
export function parseResources(arg) {
  if (!arg) return { list: [], unknown: [] };
  const items = String(arg).split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return { list: [...new Set(items.filter(i => DECLARED_RESOURCES.includes(i)))], unknown: items.filter(i => !DECLARED_RESOURCES.includes(i)) };
}

/**
 * Decides how a turn may use the musician's lanes. Pure apart from reading the
 * git facts of the main checkout and the project files.
 *
 * input: { project, conductor, direct, laneArg, laneWhy?, sameTask, sameTaskLanes,
 *          pipeline, pipelineLanes?, pipelineLanesWhy?, pipelineResumeLane0?, dual, resources: [...declared], facts? }
 * output: { mode: 'project'|'lane0'|'lane'|'alone'|'parallel'|'pipeline', lane?, lane0?, rule?,
 *           evidence?, resources: [{key, rule, evidence}], fired: [{rule, evidence}] }
 *
 * `resources` and `alone` add to the lane decision: a pinned task may still
 * hold a resource, a task running alone always runs in lane 0.
 */
export function decide(input) {
  const { project } = input;
  const fired = [];
  const fire = (rule, evidence) => { fired.push({ rule, evidence }); return { rule, evidence }; };
  if (project.name === input.conductor) { const f = fire('chef', 'chef'); return { mode: 'project', ...f, resources: [], fired }; }

  const facts = input.facts || gitFacts(project.path);
  if (!facts.repo) { const f = fire('no-git', facts.why); return { mode: 'project', ...f, resources: [], fired }; }
  if (facts.unsupported.length) { const f = fire('git-unsupported', facts.unsupported.join(', ')); return { mode: 'project', ...f, resources: [], fired }; }

  // Resources, whatever lane the task ends up in.
  const resources = [];
  const declared = new Set(input.resources || []);
  if (declared.has('serveur')) {
    const ports = knownPorts(project);
    const inst = instancePort(project);
    if (inst) resources.push({ key: `port-${inst}`, rule: 'orchestrator-self', evidence: `port ${inst} (.orchestrateur-instance.json)` });
    for (const p of ports.filter(p => p !== inst)) resources.push({ key: `port-${p}`, rule: 'port', evidence: `port ${p}` });
    if (!inst && !ports.length) resources.push({ key: 'port', rule: 'port', evidence: 'serveur déclaré par le Routage, port non déclaré' });
  }
  if (declared.has('appareil')) resources.push({ key: 'adb', rule: 'adb-device', evidence: 'appareil Android déclaré par le Routage' });
  if (declared.has('base') || declared.has('migration')) resources.push({ key: 'db', rule: 'database', evidence: declared.has('migration') ? 'migration déclarée par le Routage' : 'base déclarée par le Routage' });
  for (const r of resources) fired.push({ rule: r.rule, evidence: r.evidence });

  // A task that runs alone.
  if (declared.has('poste')) { const f = fire('machine-state', 'déclaré par le Routage (« poste »)'); return { mode: 'alone', ...f, resources, fired }; }
  if (declared.has('migration')) { const f = fire('migration', 'déclarée par le Routage (« migration »)'); return { mode: 'alone', ...f, resources, fired }; }

  // Lane choice.
  if (input.laneArg != null) { const f = fire('same-task', input.laneWhy || `couloir ${input.laneArg} demandé (--lane)`); return { mode: 'lane', lane: Number(input.laneArg), ...f, resources, fired }; }
  if (input.pipelineResumeLane0) { const f = fire('pipeline-engine', input.pipelineResumeLane0 === true ? 'exécution en pause dans la copie principale' : `exécution ${input.pipelineResumeLane0} en pause dans la copie principale`); return { mode: 'lane0', ...f, resources, fired }; }
  if (input.sameTask) {
    const lanes = input.sameTaskLanes || [];
    if (lanes.length === 1) { const f = fire('same-task', `réponse à la tâche du couloir ${lanes[0]}`); return { mode: 'lane', lane: lanes[0], ...f, resources, fired }; }
    if (lanes.length > 1) return { mode: 'ambiguous', lanes, resources, fired };
    const f = fire('same-task', 'suite de la tâche de la copie principale'); return { mode: 'lane0', ...f, resources, fired };
  }
  if (input.direct) { const f = fire('lane0-direct', "message direct de l'utilisateur"); return { mode: 'lane0', ...f, resources, fired }; }
  // A new pipeline run (P9): a free worktree lane first, so that a run that
  // pauses leaves the main checkout clean; lane 0 only when it is clean (a
  // pipeline that needs a clean tree would refuse it, and the user's
  // uncommitted work is never mixed into a delivery).
  if (input.pipeline && input.pipelineLanes === false) { const f = fire('pipeline-pilot', input.pipelineLanesWhy || 'pipelines hors couloirs pour ce projet'); return { mode: 'lane0', ...f, resources, fired }; }
  if (input.pipeline) return { mode: 'pipeline', lane0: !(input.mainDirtyMatters !== false && facts.dirty.length), resources, fired };
  if (input.dual) { const f = fire('dual-mode', '--second-model'); return { mode: 'lane0', ...f, resources, fired }; }
  if (input.mainDirtyMatters !== false && facts.dirty.length) {
    const f = fire('main-dirty', `${facts.dirty.length} fichier(s) modifié(s) : ${facts.dirty.slice(0, 5).join(', ')}${facts.dirty.length > 5 ? '…' : ''}`);
    return { mode: 'lane0', ...f, resources, fired };
  }
  return { mode: 'parallel', resources, fired };
}

/** Rule ids listed in the §3 table of the design document. */
export function documentedRuleIds(docText) {
  const sec = /##\s*3\.[\s\S]*?(?=\n##\s*4\.)/.exec(docText);
  const ids = [];
  for (const m of (sec ? sec[0] : '').matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)) ids.push(m[1]);
  return ids;
}
