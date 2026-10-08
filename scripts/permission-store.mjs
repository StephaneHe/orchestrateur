// ============================================================================
// scripts/permission-store.mjs — demandes d'autorisation en attente et règles
// « toujours autoriser » (0.45.0)
// ============================================================================
//
// - Demandes : en mémoire (Map id → demande). Le serveur MCP du tour
//   (permission-mcp.mjs) repose sa demande à l'identique après un redémarrage
//   du serveur : une clé (projet, tool_use_id) la retrouve sans doublon.
// - Règles : `permission-rules.json` à la racine (non versionné, comme
//   model-routing.json), écrit en temp + rename. JAMAIS config.json, partagé
//   par plusieurs chefs. Une règle est appliquée par l'orchestrateur lui-même
//   (ruleMatches de public/permission-core.js) : le CLI pose la question, la
//   règle y répond aussitôt, l'utilisateur n'est pas dérangé.
// - Chaque demande et chaque décision sont journalisées dans le log du
//   musicien (system/permission_request, notification/permission_decision) :
//   tous les réducteurs lisent déjà ce log dans l'ordre.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import '../public/permission-core.js';

const PC = globalThis.PermissionCore;
const DECIDED_KEEP_MS = 15 * 60_000;
const MAX_RULES_PER_PROJECT = 200;
const ID_RE = /^p-[a-f0-9]{12}$/;

export function createPermissionStore({ rulesFile, writeEvent, projectInfo, now = () => Date.now(), onNew = () => {}, onDecided = () => {} }) {
  const byId = new Map();
  const byKey = new Map();

  function loadRules() {
    try {
      const j = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
      return j && typeof j === 'object' && j.projects && typeof j.projects === 'object' ? j : { version: 1, projects: {} };
    } catch { return { version: 1, projects: {} }; }
  }
  function saveRules(j) {
    const tmp = `${rulesFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(tmp, rulesFile);
  }
  function listRules(project) {
    const j = loadRules();
    if (project) return (j.projects[project] || []).slice();
    return j.projects;
  }
  function addRule(project, rule, by = 'utilisateur', from = null) {
    if (!PC.validRule(rule)) return { ok: false, status: 400, error: `règle invalide « ${rule} »` };
    const j = loadRules();
    const list = j.projects[project] || (j.projects[project] = []);
    if (list.some(r => r.rule === rule)) return { ok: true, rule, existed: true };
    if (list.length >= MAX_RULES_PER_PROJECT) return { ok: false, status: 409, error: 'trop de règles pour ce projet' };
    list.push({ rule, tool: PC.parseRule(rule).tool, createdAt: new Date(now()).toISOString(), by, ...(from ? { from } : {}) });
    saveRules(j);
    return { ok: true, rule };
  }
  function removeRule(project, rule) {
    const j = loadRules();
    const list = j.projects[project] || [];
    const i = list.findIndex(r => r.rule === rule);
    if (i === -1) return { ok: false, status: 404, error: 'règle introuvable' };
    list.splice(i, 1);
    if (!list.length) delete j.projects[project];
    saveRules(j);
    return { ok: true, rule };
  }
  function matchingRule(project, tool, input, ctx) {
    return listRules(project).find(r => PC.ruleMatches(r.rule, tool, input, ctx)) || null;
  }

  function gc() {
    const t = now();
    for (const [id, r] of byId) {
      if (r.status === 'decided' && t - (r.decidedAt || 0) > DECIDED_KEEP_MS) { byId.delete(id); byKey.delete(r.key); }
      // MCP disparu (tour tué) : la demande ne reste pas affichée indéfiniment.
      if (r.status === 'pending' && t > r.deadline + 60_000) decide(id, { decision: 'expired', by: 'délai' });
    }
  }

  /** Vue publique (masquée) d'une demande. `full` ajoute l'entrée complète. */
  function view(r, full = false) {
    const v = {
      id: r.id, project: r.project, tool: r.tool, toolUseId: r.toolUseId, branch: r.branch || null,
      model: r.model || null, cwd: r.cwd || null, createdAt: r.createdAt, deadline: r.deadline,
      status: r.status, preview: r.preview, risk: r.risk, why: r.why, suggestions: r.suggestions,
      decision: r.decision || null, step: r.step || null,
    };
    if (full) {
      v.blocks = PC.detailBlocks(r.tool, r.input);
      v.lastText = PC.maskSecrets(r.lastText || '');
      v.turnPrompt = r.turnPrompt ? PC.maskSecrets(r.turnPrompt) : null;
    }
    return v;
  }

  function request(body) {
    gc();
    const project = String(body?.project || '');
    const info = projectInfo(project);
    if (!info) return { ok: false, status: 404, error: `projet inconnu « ${project} »` };
    const tool = String(body?.tool || '');
    if (!/^[A-Za-z_][A-Za-z0-9_\-]{0,99}$/.test(tool)) return { ok: false, status: 400, error: 'outil invalide' };
    const input = body?.input && typeof body.input === 'object' ? body.input : {};
    const toolUseId = /^[A-Za-z0-9_\-]{1,100}$/.test(String(body?.toolUseId || '')) ? String(body.toolUseId) : '';
    const ctx = { allowedTools: info.allowedTools, projectPath: info.path, cwd: body?.cwd };

    const rule = matchingRule(project, tool, input, ctx);
    if (rule) {
      writeEvent(project, { type: 'notification', subtype: 'permission_decision', permission: {
        id: null, toolUseId, tool, preview: PC.preview(tool, input), decision: 'rule', rule: rule.rule, by: 'règle', auto: true,
      }, text: `🔐 ${tool} autorisé par la règle permanente ${rule.rule}` });
      return { ok: true, status: 'allow', rule: rule.rule };
    }

    const key = `${project}\u0000${toolUseId || crypto.createHash('sha1').update(tool + JSON.stringify(input)).digest('hex')}`;
    const existing = byKey.get(key) && byId.get(byKey.get(key));
    if (existing) {
      return existing.status === 'decided'
        ? { ok: true, status: 'decided', id: existing.id, decision: existing.decision }
        : { ok: true, status: 'pending', id: existing.id };
    }
    const t = now();
    const createdAt = Number.isFinite(body?.createdAt) && Math.abs(body.createdAt - t) < 24 * 3600_000 ? body.createdAt : t;
    const timeoutMs = Number.isFinite(body?.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : 5 * 60_000;
    const deadline = Number.isFinite(body?.deadline) && body.deadline > createdAt ? body.deadline : createdAt + timeoutMs;
    const r = {
      id: 'p-' + crypto.randomBytes(6).toString('hex'), key, project, tool, input, toolUseId,
      cwd: typeof body?.cwd === 'string' ? body.cwd.slice(0, 500) : '', model: typeof body?.model === 'string' ? body.model.slice(0, 100) : '',
      branch: typeof body?.branch === 'string' ? body.branch.slice(0, 40) : '',
      lastText: typeof body?.lastText === 'string' ? body.lastText.slice(-4000) : '',
      turnPrompt: info.turnPrompt || null, step: info.step || null,
      createdAt, deadline, status: 'pending',
      preview: PC.preview(tool, input), risk: PC.riskOf(tool, input), why: PC.whyAsked(tool, input, ctx),
      suggestions: PC.suggestRules(tool, input, ctx),
    };
    byId.set(r.id, r);
    byKey.set(key, r.id);
    writeEvent(project, { type: 'system', subtype: 'permission_request', permission: {
      id: r.id, toolUseId, tool, preview: r.preview, risk: r.risk, why: r.why, deadline: r.deadline,
      createdAt: r.createdAt, model: r.model || null, ...(r.branch ? { branch: r.branch } : {}),
    }, text: `🔐 ${project} attend une autorisation : ${tool} — ${r.preview}` });
    try { onNew(view(r)); } catch { /* notification best-effort */ }
    return { ok: true, status: 'pending', id: r.id };
  }

  function get(id) {
    gc();
    const r = ID_RE.test(String(id)) ? byId.get(id) : null;
    return r || null;
  }

  function decide(id, { decision, rule, message, by } = {}) {
    const r = byId.get(id);
    if (!r) return { ok: false, status: 404, error: 'demande inconnue (déjà expirée ou serveur redémarré)' };
    if (r.status === 'decided') return { ok: false, status: 409, error: `déjà décidée : ${PC.DECISION_TEXT[r.decision.decision] || r.decision.decision}` };
    if (!['allow_once', 'allow_always', 'deny', 'expired'].includes(decision)) return { ok: false, status: 400, error: 'décision invalide' };
    let ruleAdded = null;
    if (decision === 'allow_always') {
      const chosen = String(rule || '').trim() || r.tool;
      const info = projectInfo(r.project);
      if (!PC.validRule(chosen)) return { ok: false, status: 400, error: `règle invalide « ${chosen} »` };
      // La règle choisie doit couvrir la demande qu'elle approuve.
      if (!PC.ruleMatches(chosen, r.tool, r.input, { projectPath: info?.path, cwd: r.cwd })) {
        return { ok: false, status: 400, error: `la règle « ${chosen} » ne couvre pas cette demande` };
      }
      const a = addRule(r.project, chosen, by || 'utilisateur', r.id);
      if (!a.ok) return a;
      ruleAdded = chosen;
    }
    const msg = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
    r.status = 'decided';
    r.decidedAt = now();
    r.decision = { decision, ...(ruleAdded ? { rule: ruleAdded } : {}), ...(msg ? { message: msg } : {}), by: by || 'utilisateur', at: new Date(r.decidedAt).toISOString() };
    writeEvent(r.project, { type: 'notification', subtype: 'permission_decision', permission: {
      id: r.id, toolUseId: r.toolUseId, tool: r.tool, preview: r.preview, ...r.decision,
    }, text: `🔐 ${r.tool} : ${PC.DECISION_TEXT[decision]}${ruleAdded ? ` (règle ${ruleAdded})` : ''}${msg ? ` — ${msg}` : ''}` });
    try { onDecided(view(r)); } catch { /* best-effort */ }
    return { ok: true, request: view(r) };
  }

  function pending() {
    gc();
    return [...byId.values()].filter(r => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt).map(r => view(r));
  }

  return { request, get, view, decide, pending, listRules, addRule, removeRule, matchingRule };
}

/**
 * Routes HTTP (token-gated par le serveur comme toutes les autres). Montées
 * par server.js ET par la suite de tests, pour tester le vrai code.
 * - request / état / expire : appelés par permission-mcp.mjs (le tour) ;
 * - liste, détails, décision, règles : le dashboard et l'app. Toute DÉCISION
 *   et toute écriture de règle passent par `sameOriginOnly` (comme les clés API).
 */
export function mountPermissionRoutes(app, express, store, { sameOriginOnly, projectInfo, log = () => {} }) {
  app.post('/api/permission/request', express.json({ limit: '4mb' }), (req, res) => {
    const r = store.request(req.body || {});
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.json(r);
  });
  app.get('/api/permission/:id', (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: 'demande inconnue' });
    res.json({ ok: true, status: r.status, decision: r.decision || null });
  });
  app.get('/api/permission/:id/details', (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: 'demande inconnue (expirée ou serveur redémarré)' });
    res.json({ ok: true, request: store.view(r, true) });
  });
  app.get('/api/permissions', (req, res) => {
    res.json({ ok: true, pending: store.pending(), now: Date.now() });
  });
  app.post('/api/permission/:id/decide', sameOriginOnly, express.json({ limit: '8kb' }), (req, res) => {
    const b = req.body || {};
    const by = typeof b.by === 'string' && /^[A-Za-z0-9_.\- ]{1,32}$/.test(b.by) ? b.by : 'utilisateur';
    const r = store.decide(req.params.id, { decision: b.decision === 'expired' ? 'invalide' : b.decision, rule: b.rule, message: b.message, by });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.json(r);
  });
  // Échéance atteinte côté tour : c'est un refus, donc sans risque.
  app.post('/api/permission/:id/expire', (req, res) => {
    const r = store.get(req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: 'demande inconnue' });
    if (r.status === 'decided') return res.json({ ok: true, already: true });
    if (Date.now() < r.deadline - 2000) return res.status(409).json({ ok: false, error: 'échéance non atteinte' });
    const d = store.decide(req.params.id, { decision: 'expired', by: 'délai' });
    res.json(d.ok ? { ok: true } : { ok: false, error: d.error });
  });
  app.get('/api/permission-rules', (req, res) => {
    res.json({ ok: true, rules: store.listRules() });
  });
  // « Toujours autoriser à l'avenir » depuis une ancienne carte de refus.
  app.post('/api/permission-rules', sameOriginOnly, express.json({ limit: '4kb' }), (req, res) => {
    const project = String(req.body?.project || '');
    if (!projectInfo(project)) return res.status(404).json({ ok: false, error: `projet inconnu « ${project} »` });
    const r = store.addRule(project, String(req.body?.rule || '').trim(), 'utilisateur', req.body?.from ? String(req.body.from).slice(0, 100) : null);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    log(`[autorisation] règle ajoutée pour ${project} : ${r.rule}`);
    res.json(r);
  });
  app.delete('/api/permission-rules', sameOriginOnly, express.json({ limit: '4kb' }), (req, res) => {
    const project = String(req.body?.project || '');
    const r = store.removeRule(project, String(req.body?.rule || ''));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    log(`[autorisation] règle révoquée pour ${project} : ${r.rule}`);
    res.json(r);
  });
}
