#!/usr/bin/env node
// scripts/_test_permission_prompt.mjs — demandes d'autorisation interactives (0.45.0)
//
// Exigence utilisateur (2026-10-08) : « Je n'ai pas vu de moyen d'autoriser (1
// fois, pour toujours). … En clickant dessus je dois voir un overlay avec tous
// les details. Il faut donc attendre ma reponse pendant au moins 5 minutes avant
// de passer. »
//
// Bout en bout : VRAI dispatch.mjs → faux claude (FAKE_CLAUDE_PERM) qui lance le
// VRAI permission-mcp.mjs → VRAIES routes (mountPermissionRoutes, montées sur un
// serveur express de test) → décision → le tour continue.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import '../public/permission-core.js';
import '../public/turn-core.js';
import { createPermissionStore, mountPermissionRoutes } from './permission-store.mjs';
import { deriveState, scanProject } from './fleet-status-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const FAKE = path.join(ROOT, 'tests', 'fake_claude', 'fake_claude.mjs');
const PC = globalThis.PermissionCore;
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\n── 1. Règles partagées (public/permission-core.js)');
{
  const masked = PC.maskSecrets('export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx1234 && curl -H "Authorization: Bearer nvapi-ZZZZZZZZZZZZZZZZZZZZ9876"');
  t('secrets masqués (clé Anthropic, Bearer NVIDIA), 4 derniers caractères au plus', !/sk-ant-api03-abcdef/.test(masked) && !/nvapi-ZZZZ/.test(masked) && /••••/.test(masked), masked);
  t('jeton hexadécimal de 64 caractères masqué', !/[a-f0-9]{64}/.test(PC.maskSecrets('a'.repeat(0) + 'f'.repeat(64))));
  t('risque : rm -rf = destructif, élevé', PC.riskOf('Bash', { command: 'rm -rf build' }).tags.includes('destructif') && PC.riskOf('Bash', { command: 'rm -rf build' }).level === 'élevé');
  t('risque : curl = réseau ; Write = écriture ; Read = lecture seule ; .env = secrets',
    PC.riskOf('Bash', { command: 'curl https://x.y' }).tags.includes('réseau') && PC.riskOf('Write', { file_path: 'a.js', content: '' }).tags.includes('écriture') &&
    PC.riskOf('Read', { file_path: 'a.js' }).level === 'faible' && PC.riskOf('Read', { file_path: 'I:/p/.env' }).tags.includes('secrets'));
  t('pourquoi : outil non accordé = règle manquante', PC.whyAsked('Monitor', {}, { allowedTools: ['Read', 'Bash'] }).kind === 'tool');
  const w = PC.whyAsked('Bash', { command: 'git status && rm -rf x' }, { allowedTools: ['Bash'] });
  t('pourquoi : Bash accordé mais commande composite (analyse du CLI)', w.kind === 'command' && /enchaînement/.test(w.text), w.text);
  const s = PC.suggestRules('Bash', { command: 'git status --short' });
  t('portées proposées : motif « Bash(git status:*) », commande exacte, outil entier', s[0].rule === 'Bash(git status:*)' && s.some(x => x.scope === 'exact') && s.some(x => x.rule === 'Bash'));
  t('une règle de préfixe ne couvre JAMAIS une commande composite', PC.ruleMatches('Bash(git status:*)', 'Bash', { command: 'git status -s' }) && !PC.ruleMatches('Bash(git status:*)', 'Bash', { command: 'git status && rm -rf /' }));
  t('Edit(src/**) couvre Write src/a.js du projet, pas ../autre', PC.ruleMatches('Edit(src/**)', 'Write', { file_path: 'I:/Dev/p/src/a.js' }, { projectPath: 'I:/Dev/p' }) &&
    !PC.ruleMatches('Edit(src/**)', 'Write', { file_path: 'I:/Dev/autre/src/a.js' }, { projectPath: 'I:/Dev/p' }));
  t('WebFetch(domain:example.com) couvre les sous-domaines seulement', PC.ruleMatches('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://docs.example.com/a' }) && !PC.ruleMatches('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://evil-example.com' }));
  const blocks = PC.detailBlocks('Edit', { file_path: 'a.js', old_string: 'x = 1', new_string: 'x = 2' });
  t('overlay : un Edit est rendu en diff (- / +)', blocks.some(b => b.kind === 'diff' && /^-x = 1/m.test(b.text) && /^\+x = 2/m.test(b.text)));
}

// ── Serveur de test : les VRAIES routes, un vrai store ───────────────────────
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
const proj = path.join(sb, 'projects', 'labo');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(sb, 'logs'));
fs.writeFileSync(path.join(sb, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(sb, 'projects', 'chef') }, { name: 'labo', path: proj }],
}));
fs.mkdirSync(path.join(sb, 'projects', 'chef'));
const logOf = (p) => { try { return fs.readFileSync(path.join(sb, 'logs', `${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
const store = createPermissionStore({
  rulesFile: path.join(sb, 'permission-rules.json'),
  projectInfo: (n) => n === 'labo' ? { path: proj, allowedTools: ['Read', 'Edit', 'Write', 'Bash'], turnPrompt: 'mission de test', step: 'développement · léger' } : null,
  writeEvent: (p, ev) => fs.appendFileSync(path.join(sb, 'logs', `${p}.jsonl`), JSON.stringify({ ...ev, timestamp: new Date().toISOString() }) + '\n'),
});
function sameOriginOnly(req, res, next) {
  const origin = req.get('origin');
  if (origin) { let same = false; try { same = new URL(origin).host === req.get('host'); } catch { /* */ } if (!same) return res.status(403).json({ ok: false, error: 'origine refusée' }); }
  next();
}
const app = express();
mountPermissionRoutes(app, express, store, { sameOriginOnly, projectInfo: (n) => n === 'labo' ? {} : null });
const srv = http.createServer(app);
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const api = async (method, p, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

function dispatch(prompt, env = {}) {
  const e = { ...process.env, DISPATCH_ROOT_FOR_TESTS: sb, CLAUDE_BIN: FAKE, FAKE_CLAUDE_LATENCY_MS: '10', ORCH_PORT: String(PORT), ORCH_PERM_POLL_MS: '150', ...env };
  for (const k of ['DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_OBS_ID', 'ANTHROPIC_API_KEY', 'ORCH_PERM_TIMEOUT_MS', 'ORCH_PERM_DISABLE']) if (!(k in env)) delete e[k];
  const child = spawn(process.execPath, [DISPATCH, 'labo', prompt], { cwd: sb, windowsHide: true, env: e });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const done = new Promise(r => child.on('exit', (code) => r({ code, out })));
  return { child, done };
}
async function waitPending(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await api('GET', '/api/permissions');
    if (r.body?.pending?.length) return r.body.pending[0];
    await sleep(100);
  }
  return null;
}
const lastResult = () => [...logOf('labo')].reverse().find(e => e.type === 'result');

console.log('\n── 2. Une demande non autorisée met le tour EN ATTENTE, avec sa carte');
const LONG = 'node -e "' + 'x'.repeat(3000) + '" && echo FIN-DE-COMMANDE';
const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRET42';
{
  const d = dispatch('opération composite', { FAKE_CLAUDE_PERM: `Bash|${JSON.stringify({ command: `${LONG} --key ${SECRET}`, description: 'test' })}` });
  const p = await waitPending();
  t('carte en attente (GET /api/permissions) : projet, outil, aperçu, échéance ≈ 5 min par défaut', p && p.project === 'labo' && p.tool === 'Bash' && p.deadline - p.createdAt >= 5 * 60_000 - 1000, JSON.stringify(p)?.slice(0, 200));
  await sleep(300);
  t('le tour est toujours en cours (pas de result) pendant l\'attente', d.child.exitCode === null && !lastResult());
  const ev = logOf('labo');
  t('le log du musicien porte system/permission_request (risque, raison, échéance)', ev.some(e => e.subtype === 'permission_request' && e.permission?.id === p.id && e.permission.risk && e.permission.why));
  const snap = scanProject('labo', path.join(sb, 'logs'));
  t('supervision : état distinct « attend autorisation » (live + awaitingPermission), jamais stalled', snap.state === 'live' && snap.awaitingPermission?.tool === 'Bash' && !snap.stalled, JSON.stringify({ s: snap.state, a: snap.awaitingPermission, st: snap.stalled }));
  const k = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kill-stalled.mjs'), 'labo'], { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: sb }, encoding: 'utf8' });
  t('kill-stalled refuse de tuer un musicien qui attend une autorisation (exit 3, processus vivant)', k.status === 3 && /ATTEND UNE AUTORISATION/.test(k.stderr) && d.child.exitCode === null, `${k.status} ${k.stderr}`);
  const det = await api('GET', `/api/permission/${p.id}/details`);
  const cmdBlock = det.body?.request?.blocks?.find(b => b.label === 'Commande');
  t('overlay : entrée COMPLÈTE (commande de plus de 3000 caractères intacte jusqu\'à la fin)', cmdBlock && cmdBlock.text.includes('x'.repeat(3000)) && cmdBlock.text.includes('FIN-DE-COMMANDE'));
  t('overlay : aucun secret en clair', det.body && !JSON.stringify(det.body).includes(SECRET));
  t('overlay : projet, model, tour, étape, répertoire, dernier message, raison, risque, horodatage', (() => { const r = det.body.request; return r.project === 'labo' && r.model && r.turnPrompt === 'mission de test' && r.step && r.cwd && /utiliser Bash/.test(r.lastText) && r.why?.kind === 'command' && r.risk?.level && r.createdAt && r.deadline; })(), JSON.stringify(det.body?.request || {}).slice(0, 300));
  const foreign = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'allow_once' }, { Origin: 'http://evil.example' });
  t('décision refusée depuis une autre origine (403, comme les clés API)', foreign.status === 403);
  const dec = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'allow_once' });
  t('« Autoriser une fois » accepté', dec.status === 200 && dec.body.request.decision.decision === 'allow_once');
  const res = await d.done;
  t('… et le tour CONTINUE : l\'outil s\'exécute, result normal', res.code === 0 && /PERM_RESULT: allow/.test(lastResult()?.result || ''), `${res.code} ${res.out.slice(-300)}`);
  t('décision journalisée (notification/permission_decision)', logOf('labo').some(e => e.subtype === 'permission_decision' && e.permission?.id === p.id && e.permission.decision === 'allow_once'));
  t('plus aucune attente après la décision', !scanProject('labo', path.join(sb, 'logs')).awaitingPermission);
}

console.log('\n── 3. « Refuser » transmet le motif au model');
{
  const d = dispatch('écriture refusée', { FAKE_CLAUDE_PERM: `Write|${JSON.stringify({ file_path: path.join(proj, 'a.txt'), content: 'bonjour' })}` });
  const p = await waitPending();
  const r = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'deny', message: 'utilise plutôt Edit sur b.txt' });
  const res = await d.done;
  const txt = lastResult()?.result || '';
  t('refus avec motif : le model reçoit « Refusé par l\'utilisateur » ET le motif', r.status === 200 && res.code === 0 && /PERM_RESULT: deny: Refusé par l'utilisateur\. Motif de l'utilisateur : utilise plutôt Edit sur b\.txt/.test(txt), txt.slice(-300));
}

console.log('\n── 4. « Toujours » crée une règle ; la fois suivante, l\'outil passe SANS demande');
{
  const perm = `Bash|${JSON.stringify({ command: 'git status --short' })}`;
  const d = dispatch('git status', { FAKE_CLAUDE_PERM: perm });
  const p = await waitPending();
  const bad = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'allow_always', rule: 'Bash(npm test:*)' });
  t('une règle qui ne couvre pas la demande est refusée (400)', bad.status === 400);
  const r = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'allow_always', rule: p.suggestions[0].rule });
  await d.done;
  t('« Toujours autoriser » avec la portée « Bash(git status:*) »', r.status === 200 && p.suggestions[0].rule === 'Bash(git status:*)' && /PERM_RESULT: allow/.test(lastResult()?.result || ''));
  const rules = await api('GET', '/api/permission-rules');
  t('la règle est listée (persistée dans permission-rules.json, jamais config.json)', rules.body.rules.labo?.some(x => x.rule === 'Bash(git status:*)') && fs.existsSync(path.join(sb, 'permission-rules.json')) && !fs.readFileSync(path.join(sb, 'config.json'), 'utf8').includes('git status'));
  const before = logOf('labo').filter(e => e.subtype === 'permission_request').length;
  const d2 = dispatch('git status encore', { FAKE_CLAUDE_PERM: perm });
  const res2 = await d2.done;
  const after = logOf('labo').filter(e => e.subtype === 'permission_request').length;
  t('2ᵉ fois : l\'outil passe sans demande (aucune nouvelle carte), décision « règle » journalisée', res2.code === 0 && after === before && /PERM_RESULT: allow/.test(lastResult()?.result || '') &&
    logOf('labo').some(e => e.subtype === 'permission_decision' && e.permission?.decision === 'rule' && e.permission.rule === 'Bash(git status:*)'));
  const composite = store.matchingRule('labo', 'Bash', { command: 'git status && rm -rf /' }, { projectPath: proj });
  t('… mais la règle ne laisse pas passer « git status && rm -rf / »', composite === null);
  const rev = await api('DELETE', '/api/permission-rules', { project: 'labo', rule: 'Bash(git status:*)' });
  t('règle révocable (DELETE), puis absente de la liste', rev.status === 200 && !(await api('GET', '/api/permission-rules')).body.rules.labo);
  const viaDenial = await api('POST', '/api/permission-rules', { project: 'labo', rule: 'WebFetch(domain:example.com)', from: 'toolu_ancien' });
  t('« Toujours autoriser à l\'avenir » depuis une ancienne carte de refus : règle créée', viaDenial.status === 200 && store.matchingRule('labo', 'WebFetch', { url: 'https://example.com/x' }, {}));
}

console.log('\n── 5. Sans réponse : refus « expiré sans réponse » (délai court pour le test)');
{
  const d = dispatch('attente expirée', { FAKE_CLAUDE_PERM: `Bash|${JSON.stringify({ command: 'mkdir dossier && cd dossier' })}`, ORCH_PERM_TIMEOUT_MS: '2500' });
  const p = await waitPending();
  t('échéance = délai configuré', p && Math.abs((p.deadline - p.createdAt) - 2500) < 50);
  const res = await d.done;
  const txt = lastResult()?.result || '';
  t('à l\'échéance : refus transmis au model avec « EXPIRÉE SANS RÉPONSE » et la consigne de contourner ou demander', res.code === 0 && /PERM_RESULT: deny: Demande d'autorisation EXPIRÉE SANS RÉPONSE/.test(txt) && /NEEDS_USER_INPUT/.test(txt), txt.slice(-300));
  t('décision « expired » visible dans le log du musicien', logOf('labo').some(e => e.subtype === 'permission_decision' && e.permission?.id === p.id && e.permission.decision === 'expired'));
  const late = await api('POST', `/api/permission/${p.id}/decide`, { decision: 'allow_once' });
  t('une décision après l\'expiration est refusée (409)', late.status === 409);
  const j = globalThis.TurnCore.createJournal();
  for (const e of logOf('labo')) j.push(e);
  const turnsJ = j.list();
  const all = turnsJ.flatMap(x => x.permissions || []);
  t('journal du musicien : chaque demande avec son issue (une fois, refusé, toujours, règle, expiré sans réponse)',
    ['allow_once', 'deny', 'allow_always', 'rule', 'expired'].every(d => all.some(x => x.decision === d)) && turnsJ[0].permissions?.[0]?.decision === 'expired', JSON.stringify(all.map(x => x.decision)));
}

console.log('\n── 6. Supervision : silence long mais attente d\'autorisation ≠ stall');
{
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const lines = [
    { type: 'user_prompt', text: 'x', timestamp: old },
    { type: 'system', subtype: 'init', timestamp: old },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }, timestamp: old },
  ];
  const withPerm = [...lines, { type: 'system', subtype: 'permission_request', permission: { id: 'p-aaaaaaaaaaaa', tool: 'Bash', toolUseId: 'toolu_1', deadline: Date.now() + 60_000 }, timestamp: old }];
  const dir = path.join(sb, 'logs-sup');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), withPerm.map(l => JSON.stringify(l)).join('\n') + '\n');
  t('sans demande : 10 min de silence = stalled', scanProject('a', dir).stalled === true);
  t('avec une demande en attente : pas stalled, awaitingPermission', scanProject('b', dir).stalled === false && scanProject('b', dir).awaitingPermission?.id === 'p-aaaaaaaaaaaa');
  const decided = [...withPerm, { type: 'notification', subtype: 'permission_decision', permission: { id: 'p-aaaaaaaaaaaa', decision: 'deny' } }];
  t('après la décision : plus d\'attente', !deriveState(decided.map(l => JSON.stringify(l))).awaitingPermission);
  const fsSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'fleet-status.mjs'), 'utf8');
  t('l\'état reste LIVE (les scripts restart-when-idle du chef lisent « occupé »), la note dit « ATTEND AUTORISATION »',
    scanProject('b', dir).state === 'live' && /r\.stalled \? 'STALLED' : r\.state\.toUpperCase\(\)/.test(fsSrc) && /ATTEND AUTORISATION/.test(fsSrc));
}

console.log('\n── 7. Serveur pas encore redémarré : refus immédiat, comme avant');
{
  const old = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<pre>Cannot POST</pre>'); });
  await new Promise(r => old.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const d = dispatch('ancien serveur', { FAKE_CLAUDE_PERM: `Bash|${JSON.stringify({ command: 'mkdir z && cd z' })}`, ORCH_PORT: String(old.address().port) });
  const res = await d.done;
  old.close();
  t('route absente : refus immédiat avec la raison (pas d\'attente de 5 min)', res.code === 0 && Date.now() - started < 20000 && /prochain redémarrage/.test(lastResult()?.result || ''), (lastResult()?.result || '').slice(-200));
}

console.log('\n── 8. Câblage');
{
  const disp = fs.readFileSync(DISPATCH, 'utf8');
  const srvJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('dispatch.mjs : --permission-prompt-tool mcp__orch__approve, MCP local, outil masqué au model', /'--permission-prompt-tool', 'mcp__orch__approve'/.test(disp) && /permission-mcp\.mjs/.test(disp) && /'--disallowed-tools', 'mcp__orch__approve'/.test(disp));
  t('dispatch.mjs : tous les tours claude (musiciens ET chef) — pas de condition sur le chef', /if \(PERMISSION_PROMPTS\) \{/.test(disp) && !/PERMISSION_PROMPTS\s*=[^;]*CONDUCTOR/.test(disp));
  t('dispatch.mjs : délai configurable (permissionTimeoutMin, défaut 5)', /permissionTimeoutMin/.test(disp) && /: 5\)\);/.test(disp));
  t('server.js : routes montées, décisions protégées par sameOriginOnly, chef prévenu', /mountPermissionRoutes\(app, express, permissions, \{ sameOriginOnly/.test(srvJs) && /\[AUTORISATION EN ATTENTE\]/.test(srvJs));
  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  t('dashboard : bandeau #perm-band, permission-core.js et permissions.js chargés', /id="perm-band"/.test(idx) && /permission-core\.js/.test(idx) && /permissions\.js/.test(idx));
  t('permission-rules.json non versionné', /^permission-rules\.json$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
}

srv.close();
console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
