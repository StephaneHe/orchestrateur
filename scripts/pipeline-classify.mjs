// ============================================================================
// scripts/pipeline-classify.mjs — entry classification by the model of the
// `routage.classifier` slot (pipelines, phase 5, 0.52.0)
// ============================================================================
//
// Plan §1.3: an entry without an explicit choice (selector, `/prefix`,
// `--pipeline`) is classified by the model the user assigned to the
// `routage.classifier` slot in the Models page. The output is a validated JSON
// object; an invalid answer gets one retry. If the slot is empty, not a Claude
// model (no tool-less one-shot harness for other providers yet), or the model
// fails twice, the rule classifier of phase 1 decides — and the record says so.
// Every model decision is compared with the rules in
// logs/pipeline-classify.ndjson (plan: "compared with the observation log").
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { oneShotClaude } from './language.mjs';
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

function record(logsDir, rec) {
  if (!logsDir) return;
  try { fs.appendFileSync(path.join(logsDir, CLASSIFY_FILE), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch { /* never blocks */ }
}

/**
 * Classifies one entry. Explicit choices (prefix) never reach the model.
 * Returns the rules' shape plus { classifier, rules?, agree?, raison?, note? }.
 */
export async function classifyEntry({ root, logsDir, text, project = null, entry = null, oneShot = oneShotClaude, timeoutMs = 60_000, env = process.env } = {}) {
  const rules = classifyRules({ text });
  const base = { ...rules, classifier: RULES_CLASSIFIER };
  if (rules.explicit) return base;
  const c = classifierCase(root);
  if (!c) return { ...base, note: `case ${CLASSIFIER_SLOT} non affectée : classement par règles` };
  if (c.provider !== 'claude') {
    const note = `case ${CLASSIFIER_SLOT} = ${c.model} (${c.provider}) : seul un model Claude peut classer pour l'instant — classement par règles`;
    record(logsDir, { project, entry, model: c.model, ok: false, why: 'provider', rules: { pipeline: rules.pipeline, mode: rules.mode } });
    return { ...base, note };
  }
  let parsed = null, why = '';
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const r = await oneShot(classificationPrompt(text), { model: c.model, timeoutMs, env });
    if (!r.ok) { why = r.why || 'échec'; continue; }
    parsed = parseClassification(r.text);
    if (!parsed) why = `réponse non conforme (« ${String(r.text).slice(0, 80)} »)`;
  }
  const rulesView = { pipeline: rules.pipeline, mode: rules.mode, confidence: rules.confidence };
  if (!parsed) {
    record(logsDir, { project, entry, model: c.model, ok: false, why, rules: rulesView });
    return { ...base, note: `classement par ${c.model} impossible (${why}) : classement par règles` };
  }
  const agree = parsed.pipeline === rules.pipeline && (parsed.pipeline !== 'dev' || parsed.mode === rules.mode);
  record(logsDir, { project, entry, model: c.model, ok: true, model_result: parsed, rules: rulesView, agree });
  return {
    pipeline: parsed.pipeline, mode: parsed.mode, explicit: false, confidence: 'model',
    reasons: [`${c.model} : ${parsed.raison || 'sans raison'}`], unclassifiable: false,
    classifier: `model:${c.model}`, raison: parsed.raison, rules: rulesView, agree,
  };
}
