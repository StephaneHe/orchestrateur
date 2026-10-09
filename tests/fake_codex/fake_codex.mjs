#!/usr/bin/env node
// Minimal `codex exec` double for the one-shot classifier (0.53.0): reads the
// prompt on stdin, writes FAKE_CODEX_ANSWER (or a fixed classification) to the
// --output-last-message file, logs the requested model to FAKE_CODEX_LOG.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ model: flag('--model'), sandbox: flag('-s'), classify: input.startsWith('[CLASSIFY]') }) + '\n');
  const out = flag('--output-last-message');
  if (out) fs.writeFileSync(out, process.env.FAKE_CODEX_ANSWER || '{"pipeline":"recherche","mode":"complet","raison":"classement du faux codex"}');
  process.exit(0);
});
