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

// Demandes d'autorisation (0.45.0), inactif par défaut :
//   FAKE_CLAUDE_PERM='<Outil>|<entrée JSON>'  le tour appelle cet outil « non
//     autorisé ». Avec --permission-prompt-tool + --mcp-config, on lance VRAIMENT
//     le serveur MCP de --mcp-config et on attend sa réponse (comme le CLI) ;
//     sinon refus immédiat, comme avant. Le texte final porte
//     « PERM_RESULT: allow » ou « PERM_RESULT: deny: <message> ».

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

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

  // 2b. Demande d'autorisation (FAKE_CLAUDE_PERM)
  let permNote = '';
  const permDenials = [];
  if (process.env.FAKE_CLAUDE_PERM) {
    const [permTool, ...rest] = process.env.FAKE_CLAUDE_PERM.split('|');
    let permInput = {};
    try { permInput = JSON.parse(rest.join('|') || '{}'); } catch { /* entrée vide */ }
    const toolUseId = newId('toolu');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: `Je vais utiliser ${permTool}.` }] } });
    await sleep(LATENCY);
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: permTool, input: permInput }] } });
    let decision;
    const promptTool = flag('--permission-prompt-tool');
    const mcpConfig = flag('--mcp-config');
    if (promptTool && mcpConfig) decision = await askMcp(mcpConfig, promptTool, { tool_name: permTool, input: permInput, tool_use_id: toolUseId });
    else decision = { behavior: 'deny', message: `Claude requested permissions to use ${permTool}, but you haven't granted it yet.` };
    if (decision.behavior === 'allow') {
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `fake ${permTool} exécuté` }] } });
      permNote = '\nPERM_RESULT: allow';
    } else {
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: decision.message, is_error: true }] } });
      permDenials.push({ tool_name: permTool, tool_use_id: toolUseId, tool_input: permInput });
      permNote = `\nPERM_RESULT: deny: ${decision.message}`;
    }
    await sleep(LATENCY);
  }

  // 3. Final assistant text
  emit({
    type: 'assistant',
    message: {
      ...(process.env.FAKE_CLAUDE_ECHO_MODEL === '1' ? { model: servedModel } : {}),
      content: [
        { type: 'text', text: `fake reply to: ${userText.slice(0, 60)}${synthesisNote}${permNote}` },
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
    result: (synthesisNote ? `fake result${synthesisNote}` : 'fake result') + permNote,
    ...(process.env.FAKE_CLAUDE_PERM ? { permission_denials: permDenials } : {}),
    total_cost_usd: 0,
    duration_ms: elapsed,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 20 },
  });

  // Flush + exit cleanly.
  await new Promise(r => process.stdout.write('', r));
  process.exit(0);
}

/** Comme le CLI : lance le serveur MCP de --mcp-config, poignée de main, puis
 *  tools/call de l'outil de --permission-prompt-tool ; renvoie sa décision. */
async function askMcp(configJson, promptTool, args) {
  let cfg;
  try { cfg = JSON.parse(configJson); } catch { return { behavior: 'deny', message: 'mcp-config illisible' }; }
  const [, server, toolName] = /^mcp__([^_]+)__(.+)$/.exec(promptTool) || [];
  const srv = cfg.mcpServers?.[server];
  if (!srv) return { behavior: 'deny', message: `serveur MCP ${server} absent` };
  const child = spawn(srv.command, srv.args || [], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env, windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  let seq = 0;
  const call = (method, params) => new Promise((resolve) => { const id = seq++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await call('tools/list', {});
  const res = await call('tools/call', { name: toolName, arguments: args, _meta: { progressToken: 1 } });
  child.kill();
  try { return JSON.parse(res.result.content[0].text); } catch { return { behavior: 'deny', message: 'réponse MCP illisible' }; }
}

run().catch(e => {
  process.stderr.write(`[fake_claude] fatal: ${e.message}\n`);
  process.exit(3);
});
