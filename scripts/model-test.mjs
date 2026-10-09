#!/usr/bin/env node
// ============================================================================
// scripts/model-test.mjs — "test the model", with a log to understand (0.60.0)
// ============================================================================
//
// User request (2026-10-09): when a model fails to start, offer "lancer un test
// sur le model (deja pret, avec logs pour comprendre)". It reuses the calls the
// orchestrator already trusts — no new client:
//   - Claude: oneShotClaude() (language.mjs), the "Tester la langue" trial of
//     the Models page, with the exact isolation flags of a pipeline step;
//   - OpenRouter / NVIDIA: chatCompletion() (language.mjs), key from the
//     orchestrator's .env (never written anywhere);
//   - codex: not callable outside a turn here — said so, with what to do.
// Every trial writes logs/model-tests/<time>-<model>.log: command, exit code,
// duration, model actually served, verdict, then the full stderr and stdout.
//
//   node scripts/model-test.mjs --provider claude --model claude-opus-5-5 [--label "<why>"]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShotClaude, chatCompletion } from './language.mjs';
import { keyFromDotEnv } from './pipeline-classify.mjs';

export const MODEL_TEST_PROMPT = 'Réponds uniquement par le mot PONG.';
export const MODEL_TEST_DIR = 'model-tests';
const LOG_NAME_RE = /^\d{8}T\d{6}Z-[a-z0-9._-]{1,80}\.log$/;

export function isModelTestLog(name) { return LOG_NAME_RE.test(String(name || '')); }

/**
 * One short trial of `model`. Returns {ok, why, served, ms, logFile, logName}.
 * Never throws; never forwards provider keys to a CLI.
 */
export async function runModelTest({ root, provider, model, label = '', env = process.env, timeoutMs = 60_000 }) {
  const logsDir = path.join(root, 'logs', MODEL_TEST_DIR);
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const logName = `${stamp}-${String(model || 'model').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80)}.log`;
  const logFile = path.join(logsDir, logName);
  const p = String(provider || '').toLowerCase();
  const t0 = Date.now();
  let r, command;
  if (!model) r = { ok: false, why: 'aucun model à tester (case vide : défaut du projet)' };
  else if (p === 'claude' || p === 'anthropic') {
    r = await oneShotClaude(MODEL_TEST_PROMPT, { model, timeoutMs, env });
    command = r.raw ? `${r.raw.bin} ${r.raw.args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` : 'claude';
  } else if (p === 'openrouter' || p === 'nvidia') {
    const name = p === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
    const key = env[name] || keyFromDotEnv(root, name);
    const url = p === 'openrouter'
      ? `${env.ORCH_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`
      : `${env.ORCH_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`;
    command = `POST ${url} (model ${model})`;
    r = key ? await chatCompletion({ url, key, model, prompt: MODEL_TEST_PROMPT, timeoutMs }) : { ok: false, why: `clé ${name} absente` };
    if (r.ok) r.served = model;
  } else {
    r = { ok: false, why: `test direct non pris en charge pour ${provider || '?'} : lancer un tour d'essai (dispatch.mjs <projet> "…" --provider ${provider} --model ${model} --test "essai du model")` };
  }
  const ms = r.raw?.ms ?? (Date.now() - t0);
  const verdict = r.ok ? `OK — le model répond (${JSON.stringify(String(r.text || '').slice(0, 60))})` : `ÉCHEC — ${r.why}`;
  const lines = [
    `# Test du model ${model || '(aucun)'} — ${new Date().toISOString()}`,
    `fournisseur : ${provider || '?'}`,
    label ? `contexte : ${label}` : null,
    command ? `commande : ${command}` : null,
    `code de sortie : ${r.raw ? r.raw.code : '—'}`,
    `durée : ${ms} ms`,
    `model servi : ${r.served || '—'}`,
    `verdict : ${verdict}`,
    '',
    '--- stderr ---',
    r.raw ? (r.raw.stderr || '(vide)') : '(sans objet)',
    '',
    '--- stdout ---',
    r.raw ? (String(r.raw.stdout || '').slice(-64 * 1024) || '(vide)') : (r.text ? String(r.text) : '(sans objet)'),
  ].filter(l => l !== null);
  try { fs.writeFileSync(logFile, lines.join('\n') + '\n'); } catch { /* the verdict is still returned */ }
  return { ok: !!r.ok, why: r.ok ? null : r.why, served: r.served || null, ms, logFile, logName, verdict };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  const root = process.env.DISPATCH_ROOT_FOR_TESTS ? path.resolve(process.env.DISPATCH_ROOT_FOR_TESTS) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const model = val('--model'), provider = val('--provider') || 'claude';
  if (!model) { console.error('usage : model-test.mjs --provider claude|openrouter|nvidia --model <id> [--label "<contexte>"]'); process.exit(64); }
  const r = await runModelTest({ root, provider, model, label: val('--label') || '' });
  console.log(`${r.verdict}\njournal : ${r.logFile}`);
  process.exit(r.ok ? 0 : 1);
}
