#!/usr/bin/env node
// ============================================================================
// tests/fake_claude/fake_claude.mjs — deterministic claude CLI stub.
// ============================================================================
//
// Mimics the subset of `claude --print --output-format=stream-json` that the
// orchestrator's dispatch path consumes. NO real API call. Intended for
// Phase 4 stress tests and any future deterministic test harness.
//
// Reads (when --input-format=stream-json) one user-turn NDJSON line on stdin,
// or takes the prompt as positional argv. Emits stream-json events on stdout
// in the order the real CLI does : system/init → assistant → optional
// tool_use+tool_result → result. Exits 0 unless FAKE_CLAUDE_FAIL_RATE fires.
//
// Env-driven knobs :
//   FAKE_CLAUDE_LATENCY_MS     per-event delay (default 50)
//   FAKE_CLAUDE_TURN_BUDGET_MS  total per turn upper bound (default 200)
//   FAKE_CLAUDE_FAIL_RATE      0..1 chance to emit error instead of result
//   FAKE_CLAUDE_TOOL_USES      number of synthetic tool_use rounds (default 1)
// ============================================================================

// Réglages du mode double model (0.44.0), tous optionnels et inactifs par défaut :
//   FAKE_CLAUDE_ECHO_MODEL=1   annonce le model demandé (--model) au lieu de « fake-claude »
//   FAKE_CLAUDE_WRITE=<rel>    écrit ce fichier dans le dossier courant ; « {model} »
//                              y est remplacé (ex. notes/{model}.txt)
//   FAKE_CLAUDE_FAIL_MODEL=<m> ce model échoue (aucun result, sortie 2)
//   FAKE_CLAUDE_MERGE=1        relecture : fusionne les branches citées dans le
//                              prompt (lignes BRANCHE_PRINCIPALE= / BRANCHE_SECONDE=)

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}
function hasFlag(name) { return argv.includes(name); }

const resumeId = flag('--resume');
const useStreamJsonInput = flag('--input-format') === 'stream-json';
let positionalPrompt = null;
const printIdx = argv.indexOf('--print');
// In dispatch.mjs's text-only mode, the prompt is the last positional arg
// after `--print` and not preceded by another flag. Be tolerant.
if (printIdx >= 0) {
  for (let i = printIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { i++; continue; }
    positionalPrompt = a;
  }
}

const LATENCY  = Number(process.env.FAKE_CLAUDE_LATENCY_MS) || 50;
const BUDGET   = Number(process.env.FAKE_CLAUDE_TURN_BUDGET_MS) || 200;
const FAIL     = Math.max(0, Math.min(1, Number(process.env.FAKE_CLAUDE_FAIL_RATE) || 0));
const TOOL_USES = Number(process.env.FAKE_CLAUDE_TOOL_USES) || 1;

const sessionId = resumeId || crypto.randomUUID();
const startTs = Date.now();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

async function readUserTurn() {
  if (!useStreamJsonInput) {
    return positionalPrompt || '(empty)';
  }
  // Read all of stdin and take the first user message line.
  return await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c.toString('utf8'); });
    process.stdin.on('end', () => {
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'user' && ev.message?.content) {
            // Pull out the first text block.
            const texts = ev.message.content.filter(b => b.type === 'text').map(b => b.text);
            return resolve(texts.join('\n') || '(empty)');
          }
        } catch {}
      }
      resolve('(empty)');
    });
    // If stdin is closed already (no input), end fires immediately.
  });
}

async function run() {
  const userText = await readUserTurn();
  const askedModel = flag('--model');
  const servedModel = process.env.FAKE_CLAUDE_ECHO_MODEL === '1' && askedModel ? askedModel : 'fake-claude';

  // 1. system/init
  emit({
    type: 'system', subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    model: servedModel,
  });
  await sleep(LATENCY);

  if (process.env.FAKE_CLAUDE_FAIL_MODEL && askedModel === process.env.FAKE_CLAUDE_FAIL_MODEL) {
    emit({ type: 'system', subtype: 'error', session_id: sessionId, error: `FAKE_CLAUDE_FAIL_MODEL ${askedModel}` });
    process.exit(2);
  }
  let synthesisNote = '';
  const isSynthesis = /\[RELECTURE DOUBLE/.test(userText);
  if (isSynthesis && process.env.FAKE_CLAUDE_MERGE === '1') {
    const kept = [];
    for (const [, label, br] of userText.matchAll(/BRANCHE_(PRINCIPALE|SECONDE)=(\S+)/g)) {
      const r = spawnSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@localhost', 'merge', '--no-edit', br], { cwd: process.cwd(), encoding: 'utf8' });
      kept.push(`${label.toLowerCase()} (${br}) : ${r.status === 0 ? 'fusionnée' : 'non fusionnée'}`);
    }
    synthesisNote = `\n\n## Synthèse double\n${kept.map(k => `- ${k}`).join('\n')}`;
  } else if (!isSynthesis && process.env.FAKE_CLAUDE_WRITE) {
    const rel = process.env.FAKE_CLAUDE_WRITE.replace('{model}', askedModel || 'fake');
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), rel), `écrit par ${askedModel || 'fake'}\n`);
  }

  // 2. Optional tool_use rounds
  for (let i = 0; i < TOOL_USES; i++) {
    const toolUseId = newId('toolu');
    emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: 'fake.txt' } },
        ],
      },
    });
    await sleep(LATENCY);
    emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: `fake content for "${userText.slice(0, 40)}"` },
        ],
      },
    });
    await sleep(LATENCY);
  }

  // 3. Final assistant text
  emit({
    type: 'assistant',
    message: {
      ...(process.env.FAKE_CLAUDE_ECHO_MODEL === '1' ? { model: servedModel } : {}),
      content: [
        { type: 'text', text: `fake reply to: ${userText.slice(0, 60)}${synthesisNote}` },
      ],
    },
  });
  await sleep(LATENCY);

  // 4. Result OR synthetic error
  const elapsed = Date.now() - startTs;
  if (Math.random() < FAIL) {
    emit({
      type: 'system', subtype: 'error',
      session_id: sessionId,
      error: 'FAKE_CLAUDE_FAIL_RATE fired',
    });
    process.exit(2);
  }

  emit({
    type: 'result',
    session_id: sessionId,
    result: synthesisNote ? `fake result${synthesisNote}` : 'fake result',
    total_cost_usd: 0,
    duration_ms: elapsed,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 20 },
  });

  // Flush + exit cleanly.
  await new Promise(r => process.stdout.write('', r));
  process.exit(0);
}

run().catch(e => {
  process.stderr.write(`[fake_claude] fatal: ${e.message}\n`);
  process.exit(3);
});
