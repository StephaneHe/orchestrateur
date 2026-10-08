// ============================================================================
// scripts/responses-gateway.mjs — passerelle Responses → chat/completions
// (phase 2 des pipelines, 0.47.0)
// ============================================================================
//
// Décision n° 7 : « tous les models doivent pouvoir agir de manière identique ».
// codex est le harnais unique de tout ce qui n'est pas Claude, mais il ne parle
// que l'API Responses (`wire_api = "chat"` refusé depuis codex 0.154.0), et
// NVIDIA ne connaît que `chat/completions`. Cette passerelle, montée DANS le
// serveur (même processus, même port, boucle locale seulement), traduit :
//
//   requête codex (Responses) → requête chat/completions vers le fournisseur
//   flux SSE chat            → flux SSE Responses attendu par codex
//
// Format vérifié le 2026-10-08 sur codex-cli 0.154.0 (requête capturée) :
// codex envoie `instructions`, `input[]` (message / function_call /
// function_call_output / reasoning), `tools[]` (function, namespace,
// web_search) et attend `response.created`, `response.output_item.added|done`,
// `response.output_text.delta`, puis `response.completed`.
//
// - Outils « namespace » (sous-agents, applis ChatGPT) et `web_search` natif :
//   inconnus d'un fournisseur chat, retirés. Restent les outils de fonction
//   utiles au travail dans le projet (exec_command, write_stdin, view_image…).
// - `web_fetch` : outil servi par la passerelle elle-même quand le projet a
//   droit au web (le model l'appelle, la passerelle lit la page et relance).
// - La clé du fournisseur ne quitte jamais le serveur.
// ============================================================================

import crypto from 'node:crypto';
import { derivedToken } from './local-secret.mjs';

/** Outils de fonction que codex déclare mais qui n'ont pas de sens ici. */
const DROP_FUNCTIONS = new Set([
  'request_plugin_install', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'get_goal', 'create_goal', 'update_goal', 'request_user_input',
]);

export const WEB_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Lit une page web (HTTP GET) et renvoie son texte (HTML nettoyé, 20 000 caractères au plus).',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL http(s) complète' } }, required: ['url'] },
  },
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(p => (typeof p === 'string' ? p : p?.text ?? (p?.type === 'input_image' ? '[image]' : ''))).filter(Boolean).join('\n');
}

/**
 * Requête Responses (codex) → requête chat/completions.
 * Renvoie { chat, custom } : `custom` = noms des outils « custom » (forme
 * libre) convertis en fonctions à un seul argument `input`.
 */
export function toChatRequest(body, { webFetch = false } = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  // Appels de fonction consécutifs → UN message assistant, qui porte aussi le
  // texte dit juste avant. Deux messages assistant de suite (texte, puis
  // appels) dérèglent le modèle de conversation de certains models (essai réel
  // kimi-k3 sur NVIDIA, 2026-10-08 : réponse finale incohérente).
  let pendingCalls = null;
  const flush = () => {
    if (!pendingCalls) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && !last.tool_calls) last.tool_calls = pendingCalls;
    else messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = null;
  };
  for (const it of body.input || []) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call' || it.type === 'custom_tool_call') {
      (pendingCalls = pendingCalls || []).push({
        id: it.call_id, type: 'function',
        function: { name: it.name, arguments: it.type === 'custom_tool_call' ? JSON.stringify({ input: it.input ?? '' }) : (it.arguments || '{}') },
      });
      continue;
    }
    flush();
    if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: textOf(it.output) || '(sortie vide)' });
    } else if (it.type === 'message' || (!it.type && it.role)) {
      const role = it.role === 'developer' || it.role === 'system' ? 'system' : it.role === 'assistant' ? 'assistant' : 'user';
      const text = textOf(it.content);
      if (!text) continue;
      // Messages consécutifs du même rôle (fréquent pour system/user chez codex) : fusionnés.
      const last = messages[messages.length - 1];
      if (last && last.role === role && !last.tool_calls && typeof last.content === 'string') last.content += '\n\n' + text;
      else messages.push({ role, content: text });
    }
    // reasoning, local_shell_call, web_search_call… : rien à transmettre.
  }
  flush();
  const custom = new Set();
  const tools = [];
  for (const t of body.tools || []) {
    if (t?.type === 'function' && t.name && !DROP_FUNCTIONS.has(t.name)) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } });
    } else if (t?.type === 'custom' && t.name) {
      custom.add(t.name);
      tools.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } });
    }
  }
  if (webFetch) tools.push(WEB_FETCH_TOOL);
  const chat = { model: body.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) { chat.tools = tools; chat.tool_choice = 'auto'; }
  if (typeof body.parallel_tool_calls === 'boolean' && tools.length) chat.parallel_tool_calls = body.parallel_tool_calls;
  if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
  return { chat, custom };
}

/** Lit un flux SSE chat/completions : appelle onChunk(obj) pour chaque `data:`. */
export async function readChatStream(stream, onChunk) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const part of stream) {
    buf += typeof part === 'string' ? part : dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { onChunk(JSON.parse(data)); } catch { /* ligne partielle ou bruit */ }
    }
  }
}

/** Accumule un tour chat (texte, appels d'outils, usage, model servi). */
export function createAccumulator(onTextDelta = () => {}) {
  const acc = { text: '', calls: [], usage: null, model: null, finish: null };
  return {
    acc,
    push(chunk) {
      if (chunk.model) acc.model = chunk.model;
      if (chunk.usage) acc.usage = chunk.usage;
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      for (const ch of chunk.choices || []) {
        const d = ch.delta || ch.message || {};
        if (typeof d.content === 'string' && d.content) { acc.text += d.content; onTextDelta(d.content); }
        for (const tc of d.tool_calls || []) {
          const idx = Number.isInteger(tc.index) ? tc.index : acc.calls.length;
          const c = acc.calls[idx] || (acc.calls[idx] = { id: '', name: '', arguments: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
        }
        if (ch.finish_reason) acc.finish = ch.finish_reason;
      }
    },
  };
}

/** Texte lisible d'une page HTML (sans dépendance). */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function defaultWebFetch(url, fetchImpl) {
  let u;
  try { u = new URL(url); } catch { return 'URL invalide'; }
  if (!/^https?:$/.test(u.protocol)) return 'seules les URL http(s) sont acceptées';
  // Jamais vers la machine elle-même ni le réseau local (le serveur y écoute).
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\]|::1)/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return 'adresse locale refusée';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetchImpl(u, { signal: ctl.signal, headers: { 'user-agent': 'orchestrateur-gateway/1.0' }, redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    const raw = await r.text();
    const text = /html/i.test(type) ? htmlToText(raw) : raw;
    return `HTTP ${r.status} ${type}\n\n${text.slice(0, 20_000)}`;
  } catch (e) {
    return `lecture impossible : ${e.message}`;
  } finally { clearTimeout(t); }
}

/**
 * Traite POST /responses : écrit le flux Responses sur `res` (Node http).
 * @param upstream { url: '.../chat/completions', key, headers? }
 */
export async function handleResponses({ body, upstream, res, fetch: fetchImpl = globalThis.fetch, webFetch = false, webFetchImpl, maxWebRounds = 5, log = () => {} }) {
  const { chat, custom } = toChatRequest(body, { webFetch });
  const respId = 'resp_' + crypto.randomBytes(8).toString('hex');
  let started = false, seq = 0;
  const send = (type, data) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`); };
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    send('response.created', { response: { id: respId, object: 'response', status: 'in_progress', model: body.model } });
  };
  const output = [];
  let usageTotal = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let served = null;
  const messages = chat.messages;
  for (let round = 0; round <= maxWebRounds; round++) {
    // `stream: false` côté fournisseur (NVIDIA) : en flux, kimi-k3 laissait
    // fuir ses jetons de modèle (« <|open|> », « <|close|> ») au lieu d'appels
    // d'outils propres ; sans flux, la même requête rend des tool_calls nets
    // (essais réels du 2026-10-08). Le flux vers codex est alors reconstitué.
    const upstreamStream = upstream.stream !== false;
    // `extraBody` : réglages propres au fournisseur (NVIDIA : thinking coupé, voir server.js).
    const payload = { ...chat, messages, ...(upstream.extraBody || {}), ...(upstreamStream ? {} : { stream: false, stream_options: undefined }) };
    let r;
    try {
      r = await fetchImpl(upstream.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: upstreamStream ? 'text/event-stream' : 'application/json', authorization: `Bearer ${upstream.key}`, ...(upstream.headers || {}) },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return fail(502, `fournisseur injoignable : ${e.message}`);
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      let msg = txt;
      try { const j = JSON.parse(txt); msg = j.error?.message || j.detail || j.message || txt; } catch { /* texte brut */ }
      return fail(r.status, `fournisseur : HTTP ${r.status} ${String(msg).slice(0, 400)}`);
    }
    start();
    // Message texte de ce tour : ouvert au premier delta.
    const msgId = 'msg_' + crypto.randomBytes(6).toString('hex');
    let msgOpen = false;
    const idx = output.length;
    const A = createAccumulator((delta) => {
      if (!msgOpen) {
        msgOpen = true;
        send('response.output_item.added', { output_index: idx, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } });
      }
      send('response.output_text.delta', { output_index: idx, item_id: msgId, content_index: 0, delta });
    });
    try {
      if (upstreamStream) await readChatStream(r.body, (c) => A.push(c));
      else {
        const j = await r.json();
        // Réponse entière : mêmes champs qu'un fragment (message au lieu de delta).
        A.push({ ...j, choices: (j.choices || []).map(ch => ({ ...ch, message: { ...ch.message, tool_calls: (ch.message?.tool_calls || []).map((t, i) => ({ ...t, index: i })) } })) });
      }
    } catch (e) { return fail(502, `réponse du fournisseur illisible ou interrompue : ${e.message}`); }
    const a = A.acc;
    if (a.model) served = a.model;
    if (a.usage) {
      usageTotal.input_tokens += a.usage.prompt_tokens || 0;
      usageTotal.output_tokens += a.usage.completion_tokens || 0;
      usageTotal.total_tokens = usageTotal.input_tokens + usageTotal.output_tokens;
    }
    if (msgOpen) {
      const item = { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: a.text, annotations: [] }] };
      output.push(item);
      send('response.output_item.done', { output_index: idx, item });
    }
    const calls = a.calls.filter(c => c && c.name);
    const web = calls.filter(c => c.name === 'web_fetch');
    const others = calls.filter(c => c.name !== 'web_fetch');
    for (const c of others) {
      const callId = c.id || 'call_' + crypto.randomBytes(6).toString('hex');
      let item;
      if (custom.has(c.name)) {
        let input = '';
        try { input = JSON.parse(c.arguments || '{}').input ?? ''; } catch { input = c.arguments; }
        item = { type: 'custom_tool_call', id: 'ctc_' + crypto.randomBytes(6).toString('hex'), call_id: callId, name: c.name, input, status: 'completed' };
      } else {
        item = { type: 'function_call', id: 'fc_' + crypto.randomBytes(6).toString('hex'), call_id: callId, name: c.name, arguments: c.arguments || '{}', status: 'completed' };
      }
      output.push(item);
      send('response.output_item.added', { output_index: output.length - 1, item: { ...item, status: 'in_progress' } });
      send('response.output_item.done', { output_index: output.length - 1, item });
    }
    // web_fetch servi ici seulement s'il est seul : mélangé à des appels que
    // codex doit exécuter, il serait perdu de l'historique renvoyé par codex.
    if (!webFetch || !web.length || others.length) {
      if (web.length && others.length) log(`[passerelle] web_fetch ignoré (mêlé à ${others.length} autre(s) appel(s))`);
      break;
    }
    messages.push({ role: 'assistant', content: a.text || null, tool_calls: web.map(c => ({ id: c.id, type: 'function', function: { name: 'web_fetch', arguments: c.arguments } })) });
    for (const c of web) {
      let url = '';
      try { url = JSON.parse(c.arguments || '{}').url; } catch { /* arguments illisibles */ }
      const content = await (webFetchImpl ? webFetchImpl(url) : defaultWebFetch(url, fetchImpl));
      log(`[passerelle] web_fetch ${url}`);
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  send('response.completed', { response: { id: respId, object: 'response', status: 'completed', model: served || body.model, output, usage: usageTotal } });
  res.end();
  return { ok: true, served, usage: usageTotal };

  function fail(status, message) {
    log(`[passerelle] ${message}`);
    if (!started) {
      res.writeHead(status >= 400 ? status : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'upstream_error', code: status } }));
    } else {
      send('response.failed', { response: { id: respId, status: 'failed', error: { code: 'upstream_error', message } } });
      res.end();
    }
    return { ok: false, status, message };
  }
}

/** GET /models : codex le demande au démarrage ; une liste vide lui suffit. */
export function modelsResponse() {
  return { object: 'list', data: [], models: [] };
}

/**
 * Routes de la passerelle, montées par server.js ET par la suite de tests.
 * - boucle locale seulement ;
 * - jeton = dérivé du secret local (`derivedToken(root, 'gateway')`), que
 *   dispatch.mjs passe à codex par `env_key` (jamais visible des commandes) ;
 * - `<fournisseur>-web` : même chose, avec l'outil web_fetch servi ici.
 * @param upstreams { nom: () => ({ url, key }) }
 */
export function mountGatewayRoutes(app, express, { root, upstreams, log = () => {}, fetch: fetchImpl, webFetchImpl }) {
  function guard(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) { res.status(403).json({ error: { message: 'passerelle : boucle locale seulement' } }); return null; }
    const want = `Bearer ${derivedToken(root, 'gateway')}`;
    const got = String(req.get('authorization') || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) { res.status(401).json({ error: { message: 'passerelle : jeton invalide' } }); return null; }
    const name = String(req.params.provider || '');
    const base = name.replace(/-web$/, '');
    if (!upstreams[base]) { res.status(404).json({ error: { message: `passerelle : fournisseur inconnu « ${name} »` } }); return null; }
    return { base, web: name.endsWith('-web') };
  }
  app.get('/api/llm-gateway/:provider/v1/models', (req, res) => {
    if (!guard(req, res)) return;
    res.json(modelsResponse());
  });
  app.post('/api/llm-gateway/:provider/v1/responses', express.json({ limit: '32mb' }), async (req, res) => {
    const g = guard(req, res);
    if (!g) return;
    const up = upstreams[g.base]();
    if (!up.key) return res.status(503).json({ error: { message: `passerelle : clé ${g.base.toUpperCase()} absente (page Models → Clés API)` } });
    const t0 = Date.now();
    const r = await handleResponses({ body: req.body || {}, upstream: up, res, webFetch: g.web, log, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(webFetchImpl ? { webFetchImpl } : {}) });
    log(`[passerelle] ${g.base} ${req.body?.model} → ${r.ok ? `servi ${r.served || '?'}, ${r.usage?.input_tokens || 0}+${r.usage?.output_tokens || 0} tokens` : `échec ${r.status} ${r.message}`} (${Date.now() - t0} ms)`);
  });
}
