#!/usr/bin/env node
// ============================================================================
// scripts/permission-mcp.mjs — demandes d'autorisation interactives (0.45.0)
// ============================================================================
//
// Serveur MCP stdio minimal, lancé par le CLI claude de chaque tour (musiciens
// et chef) via `--permission-prompt-tool mcp__orch__approve`. Quand un outil
// n'est pas déjà autorisé, le CLI appelle l'outil `approve` au lieu de refuser :
//
//   arguments : { tool_name, input, tool_use_id }        (vérifié, CLI 2.1.283)
//   réponse   : texte JSON {behavior:'allow', updatedInput}
//               ou {behavior:'deny', message}
//
// Ici on transmet la demande à l'orchestrateur (POST /api/permission/request),
// puis on attend la décision de l'utilisateur (GET /api/permission/:id toutes
// les 1,5 s) jusqu'au délai (ORCH_PERM_TIMEOUT_MS, 5 min par défaut). Sans
// réponse : refus « expiré sans réponse », transmis au model pour qu'il
// contourne ou pose la question. Le tour reste en pause pendant l'attente.
//
// Si le serveur redémarre pendant l'attente (404), la demande est reposée à
// l'identique : même tool_use_id, même échéance.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.ORCH_ROOT || path.join(__dirname, '..'));
const BASE = new URL(process.env.ORCH_PERM_URL || 'http://127.0.0.1:7777');
const PROJECT = process.env.ORCH_PERM_PROJECT || '';
const TIMEOUT_MS = Math.max(1000, Number(process.env.ORCH_PERM_TIMEOUT_MS) || 5 * 60_000);
const POLL_MS = Math.max(100, Number(process.env.ORCH_PERM_POLL_MS) || 1500);
const LOG = process.env.ORCH_PERM_LOG || '';

let token = '';
try { token = fs.readFileSync(path.join(ROOT, '.token'), 'utf8').trim(); } catch { /* gate désactivé ou instance de test */ }

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function api(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: BASE.hostname, port: BASE.port || 80, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}), ...(token ? { 'X-Orchestrator-Token': token } : {}) },
      timeout: 10_000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* corps vide */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}

/** Dernier texte du model avant la demande (fin du log du tour). */
function lastAssistantText() {
  if (!LOG) return '';
  try {
    const st = fs.statSync(LOG);
    const want = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(want);
    try { fs.readSync(fd, buf, 0, want, st.size - want); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
      if (ev?.type === 'user_prompt') break;
      if (ev?.type !== 'assistant') continue;
      const t = (ev.message?.content || []).filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n');
      if (t.trim()) return t.slice(-4000);
    }
  } catch { /* log absent */ }
  return '';
}

const allow = (input) => ({ behavior: 'allow', updatedInput: input });
const deny = (message) => ({ behavior: 'deny', message });

function denyText(decision) {
  if (decision.decision === 'expired') {
    const min = Math.round(TIMEOUT_MS / 60000);
    return `Demande d'autorisation EXPIRÉE SANS RÉPONSE (aucune réponse de l'utilisateur en ${min >= 1 ? min + ' min' : Math.round(TIMEOUT_MS / 1000) + ' s'}). ` +
      `Ne relance pas la même opération : contourne-la (commande simple, outil déjà autorisé) ou, si elle est indispensable, ` +
      `termine ton tour en posant la question avec NEEDS_USER_INPUT.`;
  }
  const why = decision.message ? ` Motif de l'utilisateur : ${decision.message}` : '';
  return `Refusé par l'utilisateur.${why} Ne retente pas la même opération ; tiens compte du motif ou fais autrement.`;
}

async function approve(args, progressToken) {
  const tool = String(args.tool_name || '');
  const input = args.input && typeof args.input === 'object' ? args.input : {};
  const createdAt = Date.now();
  const deadline = createdAt + TIMEOUT_MS;
  const body = {
    project: PROJECT, tool, input, toolUseId: String(args.tool_use_id || ''),
    cwd: process.env.ORCH_PERM_CWD || process.cwd(), model: process.env.ORCH_PERM_MODEL || '',
    branch: process.env.ORCH_PERM_BRANCH || '', lastText: lastAssistantText(),
    createdAt, deadline, timeoutMs: TIMEOUT_MS,
  };
  let id = null;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    if (progressToken != null && Date.now() - lastProgress > 20_000) {
      lastProgress = Date.now();
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: Date.now() - createdAt, total: TIMEOUT_MS } });
    }
    if (!id) {
      const r = await api('POST', '/api/permission/request', body);
      if (r.status === 200 && r.body?.status === 'allow') return allow(input);
      if (r.status === 200 && r.body?.status === 'decided') return r.body.decision?.decision === 'deny' || r.body.decision?.decision === 'expired' ? deny(denyText(r.body.decision)) : allow(input);
      if (r.status === 200 && r.body?.id) id = r.body.id;
      // Serveur d'avant 0.45.0 (route absente, pas de corps JSON) : même refus
      // immédiat qu'avant, avec la raison.
      else if ((r.status === 404 || r.status === 200) && !r.body) return deny(`Permission refusée : ${tool} n'est pas autorisé pour ce projet (les demandes interactives arrivent au prochain redémarrage de l'orchestrateur).`);
      else if (r.status === 400 || r.status === 404) return deny(`Demande d'autorisation impossible (${r.body?.error || r.status}) : opération non exécutée.`);
      else { await sleep(2000); continue; }
    }
    await sleep(POLL_MS);
    const s = await api('GET', `/api/permission/${encodeURIComponent(id)}`);
    if (s.status === 404) { id = null; continue; }          // serveur redémarré : on repose la même demande
    if (s.status !== 200 || !s.body) continue;               // injoignable un instant : on attend
    if (s.body.status === 'decided') {
      const d = s.body.decision || {};
      if (d.decision === 'deny' || d.decision === 'expired') return deny(denyText(d));
      return allow(input);
    }
  }
  if (id) await api('POST', `/api/permission/${encodeURIComponent(id)}/expire`, {});
  return deny(denyText({ decision: 'expired' }));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'orch', version: '1.0.0' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
      name: 'approve',
      description: "Demande d'autorisation à l'utilisateur de l'orchestrateur (attend sa décision).",
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    }] } });
  } else if (m.method === 'tools/call') {
    let res;
    try { res = await approve(m.params?.arguments || {}, m.params?._meta?.progressToken); }
    catch (e) { res = deny(`Demande d'autorisation en échec (${e.message}) : opération non exécutée.`); }
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(res) }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
