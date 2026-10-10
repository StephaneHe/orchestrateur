#!/usr/bin/env node
// ============================================================================
// scripts/_test_launch_refused.mjs — a step refused by dispatch.mjs names its
// real cause (0.61.1)
// ============================================================================
//
// User report (2026-10-10), verbatim: « Tu dis que le model n'a rien produit,
// mais tu n'expliques pas pourquoi il faut etre plus clair sur les causes ».
// The pause said "claude-sonnet-5-5 n'a rien produit 14 fois de suite" and
// recommended "tester le model", while dispatch.mjs had refused the launch
// ("--pipeline-step invalide : …:113-vert", code 64) before any model call.
//
// Protected: such a refusal is named as such ("refusé par dispatch.mjs avant
// d'appeler le model : <raison>"), pauses at once (no back-off), never says
// "le model n'a rien produit", never recommends testing or changing the model.
//
//   node scripts/_test_launch_refused.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatchRefusal, isLaunchFailure } from './model-backoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
let pass = 0, fail = 0;
const ok = (c, l, d) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 900)}` : ''}`); };
const section = (n) => console.log(`\n── ${n}`);

// ---------------------------------------------------------------------------
section('1. La règle, sur le vrai cas 113-vert');
{
  const real = '[dispatch] --pipeline-step invalide : p-20261009T193934-083679:113-vert\n';
  ok(dispatchRefusal({ code: 64, log: { events: 0 }, stderr: real }) === '--pipeline-step invalide : p-20261009T193934-083679:113-vert',
    'code 64, log d’étape vide, « [dispatch] … » sur stderr : refus de lancement, avec sa raison');
  ok(isLaunchFailure({ code: 64, log: { events: 0 } }), '(le piège d’avant : la même sortie passait pour une erreur de lancement du model)');
  ok(dispatchRefusal({ code: 1, log: { events: 3, served: 'claude-opus-5-5' }, stderr: '[dispatch] fallback refusé : …' }) === null,
    'dispatch.mjs a écrit dans le log (le model a été lancé) : pas un refus de lancement');
  ok(dispatchRefusal({ code: 1, log: { events: 0 }, stderr: 'API Error: 529 overloaded' }) === null, 'stderr sans « [dispatch] » (le CLI du model) : pas un refus de dispatch.mjs');
  ok(dispatchRefusal({ code: 0, log: { events: 0 }, stderr: real }) === null, 'code 0 : rien à signaler');
}

// ---------------------------------------------------------------------------
section('2. Vrai dispatch : refus avant tout appel au model → cause nommée, pause immédiate, rien reproché au model');
{
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-refused-'));
  const P = path.join(T, 'proj');
  for (const d of [path.join(T, 'logs'), P, path.join(T, 'chef')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    conductor: 'chef', defaults: { model: 'claude-haiku-5-5', allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
    projects: [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'P', path: P }],
  }));
  fs.writeFileSync(path.join(T, 'model-routing.json'), JSON.stringify({
    version: 2, assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' }, ...Object.fromEntries(['rouge', 'vert', 'revue', 'livrer'].map(s => [`dev.${s}`, { provider: 'anthropic', model: 'claude-sonnet-5-5' }])) },
    history: [], enforcement: { projects: ['P'], pipelines: ['discussion', 'dev'] },
  }));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: P, encoding: 'utf8' });
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  for (const d of ['test', 'src', '.orchestrateur']) fs.mkdirSync(path.join(P, d));
  fs.writeFileSync(path.join(P, 'test', 'base.test.mjs'), "import { test } from 'node:test';\ntest('base', () => {});\n");
  fs.writeFileSync(path.join(P, 'src', 'pipe.mjs'), 'export const id = (x) => x;\n');
  fs.writeFileSync(path.join(P, '.orchestrateur', 'pipeline.json'), JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'] }));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const LAUNCHLOG = path.join(T, 'launches.ndjson');
  const FAILF = path.join(T, 'zero'); fs.writeFileSync(FAILF, '0');
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: T, CLAUDE_BIN: FAKE, FAKE_CLAUDE_PIPELINE: '1', FAKE_CLAUDE_LATENCY_MS: '5', FAKE_CLAUDE_TOOL_USES: '0',
    ORCH_PERM_DISABLE: '1', ORCH_PORT: String(srv.address().port), ORCH_NO_PENDING_RELEASE: '1', ORCH_BACKOFF_STEP_MS: '100',
    ORCH_FAKE_STEP_REFUSAL: '1', FAKE_CLAUDE_LAUNCH_FAIL_FILE: FAILF, FAKE_CLAUDE_LAUNCH_LOG: LAUNCHLOG };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID', 'FAKE_PIPE_BAD', 'FAKE_PIPE_REVIEW']) delete env[k];
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'P', 'Ajoute la fonction double', '--mode', 'leger'], { env, windowsHide: true });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => c.kill(), 120_000);
    c.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
  });
  const evs = fs.readFileSync(path.join(T, 'logs', 'P.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = evs.filter(e => e.subtype === 'pipeline_step_done');
  const lim = evs.find(e => e.type === 'notification' && e.subtype === 'pipeline_limit');
  const res = evs.filter(e => e.type === 'result').pop()?.result || '';
  const question = (/^NEEDS_USER_INPUT:.*$/m.exec(res) || [''])[0];
  ok(r.code === 2 && done.length === 1 && done[0].status === 'launch_refused', `une seule tentative, classée « lancement refusé » (code ${r.code}, ${done.map(d => d.status)})`, r.out.slice(-800));
  ok(/refusé par dispatch\.mjs avant d'appeler le model \(code 64\) : --pipeline-step refusé \(simulation de test\)/.test(done[0]?.why || ''), `motif de l’étape : « ${String(done[0]?.why).slice(0, 140)}… »`);
  ok(lim?.limit === 'launch_refused' && !evs.some(e => e.subtype === 'pipeline_backoff'), 'pause immédiate « launch_refused », aucune attente progressive (le refus est déterministe)');
  ok(/refusé par dispatch\.mjs avant d’appeler le model/.test(res) && /simulation de test/.test(res) && /rien à lui reprocher/.test(res) && /C’est l’orchestrateur qu’il faut corriger/.test(res),
    'message de pause : la cause est nommée en clair, avec la raison, et le model est mis hors de cause');
  ok(!/n.a rien produit/i.test(res) && !/tester le model/i.test(res) && !/changer le model/i.test(res) && !/« simplifier »/.test(res),
    'message de pause : ni « le model n’a rien produit », ni « tester le model », ni « changer le model »');
  ok(/« continuer » \(après correction de l’orchestrateur\) ou « abandonner »/.test(question) && !/tester|changer le model/i.test(question), `ligne de question : ${question.slice(0, 150)}…`);
  ok(!fs.existsSync(LAUNCHLOG) || !fs.readFileSync(LAUNCHLOG, 'utf8').trim(), 'le model n’a jamais été lancé (aucun appel du faux claude pour l’étape)');
  srv.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} réussis, ${fail} échoués`);
process.exitCode = fail ? 1 : 0;
