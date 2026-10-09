// ============================================================================
// scripts/pipeline-classify.mjs — entry classification by the model of the
// `routage.classifier` slot (pipelines, phase 5, 0.52.0)
// ============================================================================
//
// Plan §1.3: an entry without an explicit choice (selector, `/prefix`,
// `--pipeline`) is classified by the model the user assigned to the
// `routage.classifier` slot in the Models page (any provider since 0.53.0:
// Claude and codex via their CLI, OpenRouter and NVIDIA via their API). The
// output is a validated JSON object; an invalid answer gets one retry. If the
// slot is empty, the provider key is missing, or the model fails twice, the
// rule classifier of phase 1 decides — and the record says so.
// Every model decision is compared with the rules in
// logs/pipeline-classify.ndjson (plan: "compared with the observation log").
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { oneShotClaude, chatCompletion } from './language.mjs';
import { classify as classifyRules, CLASSIFIER as RULES_CLASSIFIER, normalizeText } from './pipeline-observe.mjs';
import { PIPELINES } from './model-pipelines.mjs';

export const CLASSIFIER_SLOT = 'routage.classifier';
export const CLASSIFY_FILE = 'pipeline-classify.ndjson';
const PROVIDER_OF = { anthropic: 'claude', openai: 'codex', nvidia: 'nvidia', openrouter: 'openrouter' };
// Routage is the chef's own pipeline: a musician entry is never classified into it.
const CHOICES = PIPELINES.filter(p => p.id !== 'routage');

/** The assigned classifier model, or null when the slot is empty. */
export function classifierCase(root) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(root, 'model-routing.json'), 'utf8')).assignments?.[CLASSIFIER_SLOT] || null; } catch { /* no file */ }
  if (!a?.model || !PROVIDER_OF[a.provider]) return null;
  return { model: a.model, provider: PROVIDER_OF[a.provider] };
}

export function classificationPrompt(text) {
  const list = CHOICES.map(p => `- ${p.id}: ${p.label} — ${p.when || p.purpose || ''}`).join('\n');
  return '[CLASSIFY] You route requests sent to a software project agent. Pick the ONE pipeline that fits the request below.\n' +
    `Pipelines:\n${list}\n\n` +
    'Rules: a question, a remark or a reflection that does not ask for a change → discussion. If nothing fits clearly → discussion. ' +
    'For dev: mode "complet" for a new feature or behaviour, "leger" for a small fix or a mechanical edit; if unsure between the two → "leger". ' +
    'Other pipelines: mode "complet" unless the request is clearly small.\n' +
    'Answer with ONE JSON object and nothing else: {"pipeline":"<id>","mode":"leger"|"complet","raison":"<one short sentence in French>"}\n\n' +
    `Request:\n<<<\n${normalizeText(text).slice(0, 6000)}\n>>>`;
}

/** Validated {pipeline, mode, raison} from the model's answer, or null. */
export function parseClassification(answer) {
  const m = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const pipeline = typeof j.pipeline === 'string' ? j.pipeline.trim().toLowerCase() : '';
  if (!CHOICES.some(p => p.id === pipeline)) return null;
  const mode = j.mode === 'complet' ? 'complet' : j.mode === 'leger' || j.mode === 'léger' ? 'leger' : null;
  if (!mode) return null;
  const raison = typeof j.raison === 'string' ? j.raison.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { pipeline, mode, raison };
}

/** Provider key from the environment, then the orchestrator's own .env (never logged). */
export function keyFromDotEnv(root, name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  try {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

/** codex binary: CODEX_BIN, then the npm package entry point, then codex on PATH. */
export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const dirs = [...(env.PATH || '').split(path.delimiter), env.APPDATA ? path.join(env.APPDATA, 'npm') : null].filter(Boolean);
  for (const d of dirs) {
    const js = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return js;
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

/** One tool-less codex exchange (subscription billing, read-only sandbox, temp cwd). */
export function oneShotCodex(prompt, { model, timeoutMs = 90_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const bin = resolveCodexBin(env);
    const out = path.join(os.tmpdir(), `orch-classify-${process.pid}-${Date.now()}.txt`);
    const args = ['exec', ...(model ? ['--model', model] : []), '-s', 'read-only', '--skip-git-repo-check', '--json', '--cd', os.tmpdir(), '--output-last-message', out, '-'];
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
    const isJs = /\.(mjs|js|cjs)$/i.test(bin);
    let c;
    try { c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: os.tmpdir(), env: childEnv, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }); }
    catch (e) { resolve({ ok: false, why: `lancement de codex impossible : ${e.message}` }); return; }
    let err = '';
    const t = setTimeout(() => { try { c.kill(); } catch {} resolve({ ok: false, why: 'délai dépassé' }); }, timeoutMs);
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => { clearTimeout(t); resolve({ ok: false, why: e.message }); });
    c.on('close', (code) => {
      clearTimeout(t);
      let text = '';
      try { text = fs.readFileSync(out, 'utf8').trim(); fs.rmSync(out, { force: true }); } catch {}
      resolve(code === 0 && text ? { ok: true, text } : { ok: false, why: (err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 300) });
    });
    c.stdin.end(prompt);
  });
}

/** The one-shot caller for a provider (non-Claude: 0.53.0). */
export function callerFor(provider, { root, keys = (n) => keyFromDotEnv(root, n), env = process.env, fetchImpl } = {}) {
  if (provider === 'claude') return (prompt, o) => oneShotClaude(prompt, o);
  if (provider === 'codex') return (prompt, o) => oneShotCodex(prompt, o);
  if (provider === 'openrouter' || provider === 'nvidia') {
    const name = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
    const base = provider === 'openrouter' ? (env.ORCH_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') : (env.ORCH_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1');
    return async (prompt, o) => {
      const key = keys(name);
      if (!key) return { ok: false, why: `clé ${provider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} absente` };
      return chatCompletion({ url: `${base}/chat/completions`, key, model: o.model, prompt, fetchImpl, timeoutMs: o.timeoutMs });
    };
  }
  return null;
}

function record(logsDir, rec) {
  if (!logsDir) return;
  try { fs.appendFileSync(path.join(logsDir, CLASSIFY_FILE), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch { /* never blocks */ }
}

/**
 * Classifies one entry. Explicit choices (prefix) never reach the model.
 * Returns the rules' shape plus { classifier, rules?, agree?, raison?, note? }.
 */
export async function classifyEntry({ root, logsDir, text, project = null, entry = null, oneShot = null, keys, fetchImpl, timeoutMs = 60_000, env = process.env } = {}) {
  const rules = classifyRules({ text });
  const base = { ...rules, classifier: RULES_CLASSIFIER };
  if (rules.explicit) return base;
  const c = classifierCase(root);
  if (!c) return { ...base, note: `case ${CLASSIFIER_SLOT} non affectée : classement par règles` };
  // Every provider of the Models page can classify (0.53.0): Claude and codex
  // through their CLI (subscription), OpenRouter and NVIDIA through their API.
  oneShot = oneShot || callerFor(c.provider, { root, keys, env, fetchImpl });
  if (!oneShot) return { ...base, note: `fournisseur ${c.provider} non géré : classement par règles` };
  let parsed = null, why = '';
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const r = await oneShot(classificationPrompt(text), { model: c.model, timeoutMs, env });
    if (!r.ok) { why = r.why || 'échec'; continue; }
    parsed = parseClassification(r.text);
    if (!parsed) why = `réponse non conforme (« ${String(r.text).slice(0, 80)} »)`;
  }
  const rulesView = { pipeline: rules.pipeline, mode: rules.mode, confidence: rules.confidence };
  if (!parsed) {
    record(logsDir, { project, entry, provider: c.provider, model: c.model, ok: false, why, rules: rulesView });
    return { ...base, note: `classement par ${c.model} impossible (${why}) : classement par règles` };
  }
  const agree = parsed.pipeline === rules.pipeline && (parsed.pipeline !== 'dev' || parsed.mode === rules.mode);
  record(logsDir, { project, entry, provider: c.provider, model: c.model, ok: true, model_result: parsed, rules: rulesView, agree });
  return {
    pipeline: parsed.pipeline, mode: parsed.mode, explicit: false, confidence: 'model',
    reasons: [`${c.model} : ${parsed.raison || 'sans raison'}`], unclassifiable: false,
    classifier: `model:${c.model}`, raison: parsed.raison, rules: rulesView, agree,
  };
}
