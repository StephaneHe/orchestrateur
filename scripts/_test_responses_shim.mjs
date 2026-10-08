#!/usr/bin/env node
// scripts/_test_responses_shim.mjs — outillage NVIDIA / OpenRouter (phase 2, 0.47.0)
//
// Décision n° 7 de l'utilisateur : « tous les models doivent pouvoir agir de
// manière identique. Nvidia et openrouter aussi doivent pouvoir avoir un
// outillage. » Exigence de la mission : « toute entrée passe par un pipeline »,
// dont cette phase est le prérequis (tous les models peuvent tenir une étape
// d'action).
//
// 1-4 : traduction pure (Responses ↔ chat), flux, erreurs, web_fetch.
// 5   : routes de la passerelle (boucle locale, jeton dérivé, fournisseur).
// 6-7 : bout en bout RÉEL : vrai dispatch.mjs → vrai codex → vraie passerelle →
//       faux NVIDIA local scripté ; et vrai codex → faux OpenRouter (Responses).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { toChatRequest, handleResponses, htmlToText, mountGatewayRoutes, WEB_FETCH_TOOL } from './responses-gateway.mjs';
import { derivedToken, readOrCreateSecret } from './local-secret.mjs';
import { AGENT_HARNESS } from './model-routing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { ko++; console.log(`  ✗ ${name} ${extra}`); } };

/** Faux `res` Node : récupère les événements SSE écrits. */
function fakeRes() {
  const r = { status: null, headers: null, chunks: [], ended: false };
  return Object.assign(r, {
    writeHead(s, h) { r.status = s; r.headers = h; },
    write(c) { r.chunks.push(String(c)); },
    end(c) { if (c) r.chunks.push(String(c)); r.ended = true; },
    events() { return r.chunks.join('').split('\n\n').filter(b => b.startsWith('event:')).map(b => JSON.parse(b.split('\n')[1].slice(6))); },
  });
}
/** Faux fetch : réponses scriptées, requêtes mémorisées. */
function scriptedFetch(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r.status && r.status !== 200) return new Response(JSON.stringify({ error: { message: r.message || 'erreur' } }), { status: r.status });
    if (r.sse) return new Response(r.sse.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    return new Response(JSON.stringify(r.json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}

console.log('\n── 1. Requête Responses (codex) → chat/completions');
{
  const body = {
    model: 'moonshotai/kimi-k3', instructions: 'SYSTÈME', parallel_tool_calls: true,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev 1' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev 2' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Lis note.txt' }] },
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Je lis.' }] },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"cat note.txt"}' },
      { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ligne 1' },
      { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'note.txt' }] },
      { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' },
    ],
    tools: [
      { type: 'function', name: 'exec_command', description: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'function', name: 'request_plugin_install', parameters: {} },
      { type: 'namespace', name: 'multi_agent_v1', tools: [] },
      { type: 'web_search', external_web_access: false },
      { type: 'custom', name: 'apply_patch', description: 'patch' },
    ],
  };
  const { chat, custom } = toChatRequest(body, { webFetch: true });
  const m = chat.messages;
  t('instructions → message system, messages developer fusionnés à la suite', m[0].role === 'system' && /SYSTÈME[\s\S]*dev 1[\s\S]*dev 2/.test(m[0].content) && m[1].role === 'user');
  t('texte assistant + appels consécutifs → UN seul message assistant (essai réel kimi-k3)', m[2].role === 'assistant' && m[2].content === 'Je lis.' && m[2].tool_calls.length === 2 && m[2].tool_calls[0].id === 'c1');
  t('sorties d\'outils → messages « tool » (texte extrait des parties)', m[3].role === 'tool' && m[3].tool_call_id === 'c1' && m[3].content === 'ligne 1' && m[4].content === 'note.txt');
  t('outil custom (forme libre) → fonction à argument « input », et retour', custom.has('apply_patch') && m[5].tool_calls[0].function.arguments === JSON.stringify({ input: '*** Begin Patch' }) && m[6].role === 'tool');
  t('reasoning ignoré', !m.some(x => /reasoning/.test(JSON.stringify(x))));
  const names = chat.tools.map(x => x.function.name);
  t('outils : namespace, web_search natif et outils sans objet retirés ; web_fetch ajouté', names.join(',') === 'exec_command,apply_patch,web_fetch' && chat.tool_choice === 'auto');
  t('sans droit au web : pas de web_fetch', !toChatRequest(body).chat.tools.some(x => x.function.name === 'web_fetch'));
  t('flux demandé avec l\'usage', chat.stream === true && chat.stream_options.include_usage === true && chat.parallel_tool_calls === true);
}

console.log('\n── 2. Flux chat → flux Responses (ce que codex lit)');
{
  const sse = [
    { model: 'moonshotai/kimi-k3', choices: [{ delta: { content: 'Je ' } }] },
    { choices: [{ delta: { content: 'lis.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'exec_', arguments: '{"cmd":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'command', arguments: '"cat note.txt"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ];
  const res = fakeRes();
  const r = await handleResponses({ body: { model: 'moonshotai/kimi-k3', input: [] }, upstream: { url: 'http://x/chat/completions', key: 'k' }, res, fetch: scriptedFetch([{ sse }]) });
  const ev = res.events();
  const types = ev.map(e => e.type);
  t('ordre : created, message (added, deltas, done), appel de fonction, completed', types[0] === 'response.created' && types.at(-1) === 'response.completed' && types.indexOf('response.output_text.delta') > types.indexOf('response.output_item.added'));
  const msg = ev.find(e => e.type === 'response.output_item.done' && e.item.type === 'message');
  t('texte reconstitué', msg.item.content[0].text === 'Je lis.');
  const fc = ev.find(e => e.type === 'response.output_item.done' && e.item.type === 'function_call');
  t('appel d\'outil reconstitué depuis ses fragments (nom et arguments)', fc && fc.item.name === 'exec_command' && fc.item.arguments === '{"cmd":"cat note.txt"}' && fc.item.call_id === 'call_a');
  const done = ev.at(-1).response;
  t('completed : usage et model servi', done.usage.input_tokens === 100 && done.usage.output_tokens === 20 && done.model === 'moonshotai/kimi-k3' && r.served === 'moonshotai/kimi-k3');
  // Sans flux côté fournisseur (NVIDIA) : même résultat pour codex.
  const res2 = fakeRes();
  await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k', stream: false }, res: res2,
    fetch: scriptedFetch([{ json: { model: 'm', choices: [{ message: { content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } }]) });
  const fc2 = res2.events().find(e => e.type === 'response.output_item.done' && e.item.type === 'function_call');
  t('fournisseur sans flux (stream:false) : appel d\'outil rendu à codex en flux Responses', fc2 && fc2.item.call_id === 'c9' && fc2.item.arguments === '{"cmd":"ls"}');
  // Réglages propres au fournisseur (NVIDIA : thinking coupé pour kimi-k3).
  const f3 = scriptedFetch([{ json: { model: 'm', choices: [{ message: { content: 'ok' } }] } }]);
  await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k', stream: false, extraBody: { chat_template_kwargs: { thinking: false } } }, res: fakeRes(), fetch: f3 });
  t('extraBody transmis au fournisseur (NVIDIA : chat_template_kwargs.thinking=false), sans flux', f3.calls[0].body.chat_template_kwargs?.thinking === false && f3.calls[0].body.stream === false);
  t('server.js : NVIDIA appelé thinking coupé, échantillonnage conseillé', /extraBody: \{ chat_template_kwargs: \{ thinking: false \}, temperature: 0\.6, top_p: 0\.95 \}/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));
}

console.log('\n── 3. Erreurs : jamais de repli, l\'erreur remonte telle quelle');
{
  const res = fakeRes();
  const r = await handleResponses({ body: { model: 'nvidia/inexistant', input: [] }, upstream: { url: 'http://x', key: 'k' }, res, fetch: scriptedFetch([{ status: 404, message: 'model not found' }]) });
  t('404 du fournisseur avant le flux → 404 JSON pour codex, message conservé', !r.ok && res.status === 404 && /model not found/.test(res.chunks.join('')));
  const res2 = fakeRes();
  const unreachable = async () => { throw new Error('ECONNREFUSED'); };
  const r2 = await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k' }, res: res2, fetch: unreachable });
  t('fournisseur injoignable → 502', !r2.ok && res2.status === 502);
  // 0.47.2 : la durée accompagne l'erreur (« ✕ échec : NVIDIA 504 après … »).
  const res3 = fakeRes();
  await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k' }, res: res3, fetch: scriptedFetch([{ status: 504, message: 'Gateway Timeout' }]) });
  t('504 du fournisseur → message avec la durée « (après N s) »', res3.status === 504 && /\(après \d+ (s|min)/.test(res3.chunks.join('')), res3.chunks.join('').slice(0, 200));
}

console.log('\n── 4. web_fetch servi par la passerelle');
{
  const fetchUp = scriptedFetch([
    { sse: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'web_fetch', arguments: '{"url":"https://exemple.org/doc"}' } }] } }] }] },
    { sse: [{ choices: [{ delta: { content: 'La page dit bonjour.' } }] }] },
  ]);
  const res = fakeRes();
  await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k' }, res, fetch: fetchUp, webFetch: true, webFetchImpl: async (u) => `contenu de ${u} : bonjour` });
  const second = fetchUp.calls[1]?.body;
  t('le model appelle web_fetch : la passerelle lit la page et relance le model', second && second.messages.at(-1).role === 'tool' && /contenu de https:\/\/exemple\.org\/doc : bonjour/.test(second.messages.at(-1).content));
  t('codex ne voit que le résultat final, pas l\'appel web_fetch', !res.events().some(e => e.item?.name === 'web_fetch') && res.events().some(e => e.item?.content?.[0]?.text === 'La page dit bonjour.'));
  const res2 = fakeRes();
  const f2 = scriptedFetch([{ sse: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w', function: { name: 'web_fetch', arguments: '{"url":"http://127.0.0.1:7777/api/config"}' } }] } }] }] }, { sse: [{ choices: [{ delta: { content: 'ok' } }] }] }]);
  await handleResponses({ body: { model: 'm', input: [] }, upstream: { url: 'http://x', key: 'k' }, res: res2, fetch: f2, webFetch: true });
  t('web_fetch refuse la machine locale et le réseau local (le serveur y écoute)', /adresse locale refusée/.test(f2.calls[1].body.messages.at(-1).content));
  t('HTML nettoyé en texte', htmlToText('<html><script>x()</script><p>Bonjour&nbsp;<b>monde</b></p></html>') === 'Bonjour monde');
  t('outil web_fetch déclaré proprement', WEB_FETCH_TOOL.function.parameters.required[0] === 'url');
}

// ── Environnement isolé pour les sections 5 à 7 ─────────────────────────────
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'harnais-'));
const proj = path.join(sb, 'projects', 'labo');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(sb, 'logs'));
fs.writeFileSync(path.join(proj, 'note.txt'), 'ligne 1\n');
fs.writeFileSync(path.join(sb, '.env'), 'OPENROUTER_API_KEY=fixture-fixture-fixture\n');
fs.writeFileSync(path.join(sb, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { allowedTools: 'Read,Edit,Write,Bash,WebFetch,WebSearch,Grep,Glob', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(sb, 'projects', 'chef') }, { name: 'labo', path: proj }],
}));
fs.mkdirSync(path.join(sb, 'projects', 'chef'));
const codexHome = path.join(sb, 'codex-home');
fs.mkdirSync(codexHome);
// Comme le poste (~/.codex/config.toml) : bac à sable Windows « elevated », sans
// lequel codex demande une approbation pour chaque commande (relecteur automatique).
fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
readOrCreateSecret(sb);

// Faux NVIDIA (chat/completions, sans flux) : scénario d'agent en 3 tours.
const nvRequests = [];
let nvMode = 'agent';
const nv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    nvRequests.push({ body, auth: req.headers.authorization });
    if (nvMode === 'missing' || body.model === 'nvidia/inexistant') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `model ${body.model} not found` } })); return; }
    const toolMsgs = body.messages.filter(m => m.role === 'tool').length;
    const call = (cmd) => ({ model: body.model, choices: [{ message: { content: '', tool_calls: [{ id: `call_${toolMsgs}`, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
    const reply = toolMsgs === 0 ? call('Add-Content -Path note.txt -Value "ligne 2 par le model"; Get-Content note.txt')
      : toolMsgs === 1 ? call('if ($env:ORCH_GATEWAY_TOKEN -or $env:OPENROUTER_API_KEY -or $env:NVIDIA_API_KEY) { "SECRET-VISIBLE" } else { "SECRET-ABSENT" }')
      : { model: body.model, choices: [{ message: { content: 'FAIT : note.txt modifié.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 6 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise(r => nv.listen(0, '127.0.0.1', r));

const app = express();
mountGatewayRoutes(app, express, { root: sb, upstreams: { nvidia: () => ({ url: `http://127.0.0.1:${nv.address().port}/v1/chat/completions`, key: 'cle-nvidia-fixture', stream: false }), vide: () => ({ url: 'http://x', key: '' }) } });
const gw = http.createServer(app);
await new Promise(r => gw.listen(0, '127.0.0.1', r));
const GW = `http://127.0.0.1:${gw.address().port}`;
const TOKEN = derivedToken(sb, 'gateway');

console.log('\n── 5. Routes de la passerelle');
{
  const g = (p, h = {}) => fetch(GW + p, { headers: h });
  t('sans jeton → 401', (await g('/api/llm-gateway/nvidia/v1/models')).status === 401);
  t('mauvais jeton → 401', (await g('/api/llm-gateway/nvidia/v1/models', { authorization: 'Bearer ' + 'f'.repeat(64) })).status === 401);
  t('jeton dérivé du secret local → 200 (liste de models pour codex)', (await g('/api/llm-gateway/nvidia/v1/models', { authorization: `Bearer ${TOKEN}` })).status === 200);
  t('fournisseur inconnu → 404', (await g('/api/llm-gateway/inconnu/v1/models', { authorization: `Bearer ${TOKEN}` })).status === 404);
  const r = await fetch(GW + '/api/llm-gateway/vide/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"model":"m","input":[]}' });
  t('clé du fournisseur absente → 503 explicite', r.status === 503);
  t('le jeton est un dérivé : le secret brut n\'est pas le jeton', TOKEN !== readOrCreateSecret(sb) && /^[a-f0-9]{64}$/.test(TOKEN));
}

const hasCodex = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' }).status === 0;
function dispatch(args, extraEnv = {}) {
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: sb, CODEX_HOME: codexHome, ORCH_PORT: String(gw.address().port), ORCH_PERM_DISABLE: '1', ...extraEnv };
  for (const k of ['DISPATCH_SLOT', 'DISPATCH_TICKET', 'ORCH_OBS_ID', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'CLAUDE_BIN', 'CODEX_BIN']) if (!(k in extraEnv)) delete env[k];
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [DISPATCH, 'labo', ...args], { cwd: sb, env, windowsHide: true });
    let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
    const timer = setTimeout(() => c.kill(), 240_000);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
const logOf = () => fs.readFileSync(path.join(sb, 'logs', 'labo.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
const turn = () => { const l = logOf(); let i = l.length - 1; while (i > 0 && l[i].type !== 'user_prompt') i--; return l.slice(i); };

console.log('\n── 6. Bout en bout NVIDIA : dispatch.mjs → codex → passerelle → faux NVIDIA');
if (!hasCodex) { console.log('  (codex absent de cette machine : section sautée)'); }
else {
  const r = await dispatch(['ajoute une ligne à note.txt', '--provider', 'nvidia', '--model', 'moonshotai/kimi-k3']);
  const ev = turn();
  const init = ev.find(e => e.subtype === 'init');
  t('system/init : provider nvidia, harnais codex, model et source explicites, bac à sable, web_fetch', init?.provider === 'nvidia' && init.harness === 'codex' && init.model === 'moonshotai/kimi-k3' && init.modelSource === 'flag' && init.sandbox === 'workspace-write' && /web_fetch/.test(init.webSearch), JSON.stringify(init));
  t('le model AGIT : commandes exécutées par codex, fichier réellement modifié', /ligne 2 par le model/.test(fs.readFileSync(path.join(proj, 'note.txt'), 'utf8')) && ev.filter(e => e.message?.content?.some(b => b.type === 'tool_use' && b.name === 'Bash')).length >= 2, r.out.slice(-600));
  const outputs = nvRequests.flatMap(q => q.body.messages.filter(m => m.role === 'tool').map(m => m.content)).join('\n');
  t('aucune clé ni jeton visible des commandes du model', /SECRET-ABSENT/.test(outputs) && !/SECRET-VISIBLE\r?\n?$/m.test(outputs.replace(/if \(.*\) \{ "SECRET-VISIBLE" \}/g, '')), outputs.slice(-300));
  t('la clé NVIDIA reste dans la passerelle (le faux fournisseur la reçoit, codex jamais)', nvRequests.every(q => q.auth === 'Bearer cle-nvidia-fixture'));
  const res = ev.find(e => e.type === 'result');
  t('result : succès, provider nvidia, texte final du model', res && !res.is_error && res.provider === 'nvidia' && /FAIT/.test(res.result || ''), JSON.stringify(res).slice(0, 300));
  t('journal au même format qu\'un tour codex (assistant / tool_use Bash / result)', ev.some(e => e.type === 'assistant' && e.provider === 'nvidia') && ev.some(e => e.subtype === 'model_verified' || e.subtype === 'model_unverified'));
  // Model indisponible : aucun repli, pause côté chef.
  nvRequests.length = 0;
  const r2 = await dispatch(['tâche', '--provider', 'nvidia', '--model', 'nvidia/inexistant']);
  const ev2 = turn();
  t('model indisponible → fallback_refused puis error_model_unavailable, aucun autre model appelé', ev2.some(e => e.subtype === 'fallback_refused') && ev2.some(e => e.type === 'result' && e.subtype === 'error_model_unavailable') && nvRequests.every(q => q.body.model === 'nvidia/inexistant'), r2.out.slice(-400));
  const r3 = await dispatch(['tâche', '--provider', 'nvidia']);
  t('sans --model : refus explicite (exit 64), il n\'y a pas de défaut', r3.code === 64 && /précise le model/.test(r3.out));
}

console.log('\n── 7. Bout en bout OpenRouter : dispatch.mjs → codex → (faux) OpenRouter Responses');
if (!hasCodex) { console.log('  (codex absent : section sautée)'); }
else {
  const orReqs = [];
  const or = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      orReqs.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
      const body = JSON.parse(b);
      const outs = (body.input || []).filter(i => i.type === 'function_call_output').length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      send('response.created', { response: { id: 'r1' } });
      const item = outs === 0
        ? { type: 'function_call', id: 'fc1', call_id: 'or1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'if ($env:OPENROUTER_API_KEY) { "CLE-VISIBLE" } else { "CLE-ABSENTE" }' }), status: 'completed' }
        : { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'FAIT OpenRouter', annotations: [] }] };
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } });
      res.end();
    });
  });
  await new Promise(r => or.listen(0, '127.0.0.1', r));
  const r = await dispatch(['vérifie l\'environnement', '--provider', 'openrouter', '--model', 'deepseek/deepseek-v4.1-flash'], { ORCH_OPENROUTER_BASE_URL: `http://127.0.0.1:${or.address().port}/api/v1` });
  const ev = turn();
  const init = ev.find(e => e.subtype === 'init');
  t('system/init : provider openrouter, harnais codex', init?.provider === 'openrouter' && init.harness === 'codex' && init.model === 'deepseek/deepseek-v4.1-flash', JSON.stringify(init));
  const posts = orReqs.filter(q => q.body && q.url.endsWith('/responses'));
  t('codex appelle OpenRouter en Responses avec la clé du .env (en-tête seulement)', posts.length >= 2 && posts.every(q => q.auth === 'Bearer fixture-fixture-fixture'), r.out.slice(-400));
  const outText = JSON.stringify(posts.at(-1)?.body.input || []);
  t('la clé OpenRouter n\'est pas visible des commandes du model', /CLE-ABSENTE/.test(outText.replace(/\{ \\"CLE-VISIBLE\\" \}/g, '')) && !/"output":"[^"]*CLE-VISIBLE/.test(outText));
  t('result : succès, provider openrouter', ev.some(e => e.type === 'result' && !e.is_error && e.provider === 'openrouter' && /FAIT OpenRouter/.test(e.result)));
  const noKey = fs.readFileSync(path.join(sb, '.env'), 'utf8');
  fs.writeFileSync(path.join(sb, '.env'), '');
  const r2 = await dispatch(['x', '--provider', 'openrouter', '--model', 'deepseek/deepseek-v4.1-flash'], { ORCH_OPENROUTER_BASE_URL: `http://127.0.0.1:${or.address().port}/api/v1` });
  fs.writeFileSync(path.join(sb, '.env'), noKey);
  t('clé OpenRouter absente → refus explicite, aucun repli', turn().some(e => e.subtype === 'fallback_refused' && /clé OpenRouter absente/.test(e.reason || '')), r2.out.slice(-300));
  or.close();
}

console.log('\n── 8. Câblage');
{
  const disp = fs.readFileSync(DISPATCH, 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  t('dispatch.mjs : --provider nvidia|openrouter acceptés, NVIDIA via la passerelle du serveur, OpenRouter en direct', /'claude', 'codex', 'nvidia', 'openrouter'/.test(disp) && /api\/llm-gateway\//.test(disp) && /model_providers\.openrouter\.wire_api="responses"/.test(disp));
  t('dispatch.mjs : clé et jeton exclus de l\'environnement des commandes', /shell_environment_policy\.exclude=\["OPENROUTER_API_KEY","ORCH_GATEWAY_TOKEN","NVIDIA_API_KEY"\]/.test(disp));
  t('server.js : passerelle montée, NVIDIA sans flux, exemptée du token gate (contrôle propre plus strict)', /mountGatewayRoutes\(app, express/.test(srv) && /stream: false/.test(srv) && /startsWith\('\/api\/llm-gateway\/'\)/.test(srv));
  t('page Models : NVIDIA et OpenRouter déclarés outillés (étapes d\'action permises)', AGENT_HARNESS.nvidia === true && AGENT_HARNESS.openrouter === true);
  t('.orchestrateur-secret non versionné', /^\.orchestrateur-secret$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
}

nv.close(); gw.close();
console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
