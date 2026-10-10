#!/usr/bin/env node
// ============================================================================
// scripts/_test_turn_logs.mjs — every turn writes its request, every line of a
// turn is attributed to it (0.66.0)
// ============================================================================
//
// User request (2026-10-10), verbatim: « Je vois dans le journal d'activite
// qu'une des dernieres de l'orchestrateur affiche : Demande non visible dans
// le log (tour lancé sans demande écrite) / Je veux qu'il y ai toutes les
// logs ».
//
// Causes found in the fleet logs: two turns of the same musician running at
// once (their lines interleaved in one log), the tail of a turn written after
// its result (failover leg, dispatch's own error result, background task
// notification), a pipeline run launched by the chef (sourced request, no
// init), and the CLI's stderr written raw into the JSONL.
//
// Protected:
//   - the activity journal never shows a system-launched turn without its
//     request, even interleaved or continued after its result;
//   - every launch path (direct, new session, codex, pipeline run, « continuer »,
//     pause answer, queue drain, chef relay / wake prefixes) writes the request
//     and stamps every line of the turn with the same `orch_turn`;
//   - the CLI's stderr becomes JSON events (visible, never breaks a line);
//   - two turns of the same musician never run at once (turn lock).
//
//   node scripts/_test_turn_logs.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(ROOT, 'public', 'turn-core.js')).href);
const TC = globalThis.TurnCore;
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const FAKE_CODEX = path.join(ROOT, 'tests', 'fake_codex', 'fake_codex.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);
const journal = (evs) => { const j = TC.createJournal({ max: 1000 }); for (const e of evs) j.push(e); return j.list().reverse(); };
const ts = (s) => `2026-10-10T10:00:${String(s).padStart(2, '0')}.000Z`;
const asst = (id, text, s) => ({ type: 'assistant', orch_turn: id, timestamp: ts(s), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const res = (id, text, s, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, orch_turn: id, num_turns: 2, duration_ms: 1000, result: text, timestamp: ts(s), ...extra });

// ---------------------------------------------------------------------------
section('1. Journal : chaque tour garde sa demande, même entremêlé ou prolongé après son result');
{
  // Two turns of the same musician at once, lines interleaved.
  const t = journal([
    { type: 'user_prompt', text: 'Demande A', orch_turn: 'A', timestamp: ts(1) },
    { type: 'user_prompt', text: 'Demande B', source: 'chef', orch_turn: 'B', timestamp: ts(2) },
    { type: 'system', subtype: 'init', orch_turn: 'A' }, { type: 'system', subtype: 'init', orch_turn: 'B' },
    asst('A', 'travail A', 3), asst('B', 'travail B', 4), res('A', 'A terminé', 5),
    asst('B', 'B continue après le result de A', 6), res('B', 'B terminé', 7),
  ]);
  ok(t.length === 2 && t.every(x => x.prompt) && t.map(x => x.prompt).join('|') === 'Demande A|Demande B', `deux tours entremêlés : chacun sa demande (${t.map(x => x.prompt || '∅').join(' | ')})`);
  ok(/B continue/.test(t[1].summary.join(' ')) && t[1].outcome === 'ok' && !/B continue/.test(t[0].summary.join(' ')), 'la fin du tour B (après le result de A) lui revient, pas à A ni à un tour sans demande');
}
{
  // Tail written after the CLI result: dispatch's own error result, background task continuation.
  const t = journal([
    { type: 'user_prompt', text: 'Demande C', orch_turn: 'C', timestamp: ts(1) },
    { type: 'system', subtype: 'init', orch_turn: 'C' }, asst('C', 'fait', 2), res('C', 'fait', 3),
    { type: 'system', subtype: 'task_notification', orch_turn: 'C' }, { type: 'system', subtype: 'init', orch_turn: 'C' },
    asst('C', 'la tâche de fond a fini', 4), res('C', 'fini pour de bon', 5),
    { type: 'system', subtype: 'fallback_refused', orch_turn: 'C', timestamp: ts(6) },
    res('C', 'model indisponible', 7, { subtype: 'error_model_unavailable', is_error: true }),
  ]);
  ok(t.length === 1 && t[0].prompt === 'Demande C' && t[0].outcome === 'error', `suite après le result (tâche de fond, erreur de dispatch.mjs) : un seul tour, avec sa demande (${t.length} tour(s), ${t[0]?.outcome})`);
}
{
  // Pipeline run launched by the chef: sourced request, no init, synthetic text then result.
  for (const id of ['P', undefined]) {
    const t = journal([
      { type: 'user_prompt', text: 'Ajoute la fonction double', source: 'chef', ...(id ? { orch_turn: id } : {}), pipeline: { run: 'p-1', pipeline: 'dev', steps: [] }, timestamp: ts(1) },
      { type: 'system', subtype: 'pipeline_start', ...(id ? { orch_turn: id } : {}), pipeline: { run: 'p-1' }, timestamp: ts(2) },
      { type: 'assistant', ...(id ? { orch_turn: id } : {}), message: { model: '<synthetic>', content: [{ type: 'text', text: 'livré' }] }, timestamp: ts(3) },
      { type: 'result', subtype: 'success', ...(id ? { orch_turn: id } : {}), result: 'livré', num_turns: 1, duration_ms: 1, timestamp: ts(4) },
    ]);
    ok(t.length === 1 && t[0].prompt === 'Ajoute la fonction double', `exécution de pipeline lancée par le chef${id ? '' : ' (ancien log, sans orch_turn)'} : la demande est affichée (« ${t[0]?.prompt || '∅'} »)`);
  }
}
{
  // Old logs (no orch_turn): failover leg, dispatch error after the result, orphan assistant.
  const t = journal([
    { type: 'user_prompt', text: 'Demande D', timestamp: ts(1) }, { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, { type: 'result', subtype: 'success', result: 'limite', num_turns: 1 },
    { type: 'system', subtype: 'failover', timestamp: ts(2) }, { type: 'system', subtype: 'init', provider: 'codex' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'suite codex' }] } }, { type: 'result', subtype: 'success', result: 'fini par codex', num_turns: 1 },
    { type: 'system', subtype: 'task_notification' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'orphelin' }] } },
    { type: 'result', subtype: 'error_model_unavailable', is_error: true, result: 'trop tard' },
  ]);
  ok(t.length === 1 && t[0].prompt === 'Demande D', `ancien log : bascule de fournisseur, suite et erreur tardive rattachées au même tour (${t.length} tour(s))`);
  ok(journal([{ type: 'system', subtype: 'stderr', text: 'Failed to resume session', orch_turn: 'E' }]).length === 0, 'une ligne de stderr (événement JSON) n’ouvre pas de tour');
}

// ---------------------------------------------------------------------------
// Throwaway root: P (ordinary turns), Q (pipelines in service).
// ---------------------------------------------------------------------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turnlogs-'));
const P = path.join(T, 'p'), Q = path.join(T, 'q');
for (const d of [path.join(T, 'logs'), P, Q, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }, { name: 'Q', path: Q }],
}));
fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
  version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['rouge', 'vert', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
  history: [], enforcement: { projects: ['Q'], pipelines: ['discussion', 'dev'] },
}));
const gq = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: Q, encoding: 'utf8' });
fs.writeFileSync(path.join(Q, 'package.json'), JSON.stringify({ name: 'q', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
for (const d of ['test', 'src', 'docs', '.orchestrateur']) fs.mkdirSync(path.join(Q, d));
fs.writeFileSync(path.join(Q, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
fs.writeFileSync(path.join(Q, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
fs.writeFileSync(path.join(Q, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-01\n- début\n');
fs.writeFileSync(path.join(Q, 'docs', 'USER_REQUIREMENTS.md'), '| date | demande | test | version |\n|---|---|---|---|\n');
fs.writeFileSync(path.join(Q, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
gq('init', '-q'); gq('add', '-A'); gq('commit', '-q', '-m', 'init');
const CODEX = path.join(T, 'codex-ok.mjs');
fs.writeFileSync(CODEX, `process.stdin.resume(); process.stdin.on('data', () => {});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stderr.write('codex: progression simulée');
out({ type: 'thread.started', thread_id: 't-logs' }); out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Réponse simulée de codex.' } });
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
setTimeout(() => process.exit(0), 50);
`);
const baseEnv = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, CODEX_BIN: CODEX, FAKE_CLAUDE_ECHO_MODEL: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '1',
  ORCH_PERM_DISABLE: '1', ORCH_PORT: '9', ORCH_PIPE_PROGRESS_MS: '200', ORCH_NO_PENDING_RELEASE: '1', ORCH_TURN_LOCK_POLL_MS: '100' };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'ORCH_TURN_ID',
  'DISPATCH_SLOT', 'ORCH_TEST_LABEL', 'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW', 'FAKE_CLAUDE_STDERR', 'CODEX_HOME']) delete baseEnv[k];
const run = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], { env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  const t = setTimeout(() => c.kill(), 180_000);
  c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
});
const lines = (name) => { try { return fs.readFileSync(path.join(T, 'logs', `${name}.jsonl`), 'utf8').split('\n').filter(l => l.trim()); } catch { return []; } };
/** Runs a dispatch and checks: request written, every JSON line of the turn tagged with ITS id, journal shows the request. */
async function path_(label, name, args, env, want) {
  const n0 = lines(name).length;
  const r = await run([name, ...args], env);
  const raw = lines(name).slice(n0);
  const bad = raw.filter(l => { try { JSON.parse(l); return false; } catch { return true; } });
  const evs = raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const up = evs.find(e => e.type === 'user_prompt');
  const id = up?.orch_turn;
  const untagged = evs.filter(e => e.orch_turn !== id);
  const last = journal(lines(name).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)).pop();
  ok(r.code !== null && id && /^t-/.test(id) && !untagged.length && !bad.length && last?.prompt && last.prompt.includes(want),
    `${label} : demande écrite, ${evs.length} lignes toutes marquées du même tour, journal « ${String(last?.prompt).slice(0, 50)} »`,
    `code ${r.code} id ${id} non marquées ${untagged.map(e => `${e.type}/${e.subtype || ''}:${e.orch_turn}`).slice(0, 5)} illisibles ${bad.slice(0, 2)} — ${r.out.slice(-400)}`);
  return { r, evs, id };
}

// ---------------------------------------------------------------------------
section('2. Chaque chemin de lancement écrit la demande, et chaque ligne du tour porte son identifiant');
await path_('dispatch direct', 'P', ['Demande directe au musicien'], {}, 'Demande directe');
await path_('--new-session', 'P', ['Repars de zéro', '--new-session'], {}, 'Repars de zéro');
await path_('drain de la file (--no-queue-if-busy)', 'P', ['Demande sortie de la file', '--no-queue-if-busy', '--source', 'chef', '--callback', 'chef'], {}, 'Demande sortie de la file');
await path_('relais du chef [CHEF_ANSWER]', 'P', ['[CHEF_ANSWER] Oui, utilise la seconde option'], {}, 'seconde option');
await path_('réveil [CALLBACK_WAKE]', 'P', ['[CALLBACK_WAKE] synthèse demandée'], {}, 'synthèse demandée');
await path_('provider codex', 'P', ['Demande pour codex', '--provider', 'codex', '--model', 'gpt-5.5'], {}, 'Demande pour codex');
const st = await path_('stderr du CLI', 'P', ['Demande avec stderr'], { FAKE_CLAUDE_STDERR: 'No conversation found with session ID: 0000' }, 'Demande avec stderr');
ok(st.evs.some(e => e.type === 'system' && e.subtype === 'stderr' && /No conversation found/.test(e.text)), 'stderr du CLI : un événement JSON system/stderr, lisible (plus de ligne brute dans le JSONL)');
const cx = lines('P').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
ok(cx.some(e => e.subtype === 'stderr' && e.origin === 'codex' && /progression simulée/.test(e.text)), 'stderr de codex : journalisé lui aussi (il ne l’était pas du tout)');
const pr = await path_('exécution de pipeline (projet en service)', 'Q', ['Ajoute une fonction double', '--pipeline', 'dev', '--mode', 'leger'], { FAKE_CLAUDE_PIPELINE: '1', FAKE_PIPE_BAD: 'vert' }, 'fonction double');
ok(pr.evs.some(e => e.subtype === 'pipeline_step_done') && pr.evs.some(e => e.type === 'notification' && e.subtype === 'pipeline_limit'), `exécution réelle (étapes, puis pause) : ${pr.evs.length} lignes, toutes du même tour`, pr.evs.map(e => `${e.type}/${e.subtype || ""} ${String(e.text || e.result || "").slice(0, 160)}`).join(" || "));
await path_('« continuer » (reprise d’exécution)', 'Q', ['continuer'], { FAKE_CLAUDE_PIPELINE: '1', FAKE_PIPE_BAD: 'vert' }, 'continuer');
await path_('réponse à une pause (« abandonner »)', 'Q', ['abandonner'], { FAKE_CLAUDE_PIPELINE: '1' }, 'abandonner');
ok(lines('Q').concat(lines('P')).every(l => { try { JSON.parse(l); return true; } catch { return false; } }), 'aucune ligne illisible dans les logs des musiciens');

// ---------------------------------------------------------------------------
section('3. Un musicien, un tour : un second lancement attend la fin du premier (plus de lignes entremêlées)');
{
  const n0 = lines('P').length;
  const a = run(['P', 'Premier tour, lent'], { FAKE_CLAUDE_LATENCY_MS: '300', FAKE_CLAUDE_TOOL_USES: '3' });
  await new Promise(r => setTimeout(r, 1200));
  const b = run(['P', 'Second tour, lancé pendant le premier', '--no-queue-if-busy'], {});
  const [ra, rb] = await Promise.all([a, b]);
  const evs = lines('P').slice(n0).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ids = evs.map(e => e.orch_turn);
  const firstId = ids[0], switchAt = ids.findIndex(x => x !== firstId);
  const contiguous = switchAt > 0 && ids.slice(switchAt).every(x => x === ids[switchAt]);
  ok(ra.code === 0 && rb.code === 0 && contiguous && /attente de sa fin/.test(rb.out), `les deux tours se suivent sans s’entremêler (le second a attendu : ${/attente de sa fin/.test(rb.out)})`, `${ra.code}/${rb.code} ${ids.join(',').slice(0, 300)}`);
  const t = journal(lines('P').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)).slice(-2);
  ok(t.length === 2 && /Premier tour/.test(t[0].prompt) && /Second tour/.test(t[1].prompt), 'journal : deux tours, chacun avec sa demande');
  ok(!fs.existsSync(path.join(T, 'logs', 'P.turnlock')), 'le verrou est libéré à la fin du tour');
  fs.writeFileSync(path.join(T, 'logs', 'P.turnlock'), JSON.stringify({ pid: 999999, turn: 't-mort', at: new Date().toISOString() }));
  const rc = await run(['P', 'Après un tour tué sans libérer le verrou'], {});
  ok(rc.code === 0 && !/attente de sa fin/.test(rc.out), 'verrou d’un processus mort : repris aussitôt, pas d’attente');
}

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
