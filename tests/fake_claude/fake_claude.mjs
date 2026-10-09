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
  // Langue (0.51.0) : trace du prompt reçu, réponse imposée, et rôle de « reformulateur ».
  if (process.env.FAKE_CLAUDE_DUMP_PROMPT) fs.appendFileSync(process.env.FAKE_CLAUDE_DUMP_PROMPT, JSON.stringify({ model: askedModel, prompt: userText }) + '\n');
  const isReformulation = /^\[REFORMULATION\]/.test(userText);
  const fixedReply = isReformulation
    ? (process.env.FAKE_CLAUDE_TRANSLATION || 'Réponse reformulée en français : la suite de tests passe, le travail est terminé et rien ne reste à faire pour cette demande.')
    : (process.env.FAKE_CLAUDE_REPLY || null);

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

  if (!isReformulation && process.env.FAKE_CLAUDE_PIPELINE === '1' && /^PIPELINE_STEP=/m.test(userText)) pipelineStep(userText);

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
        { type: 'text', text: fixedReply || `fake reply to: ${userText.slice(0, 60)}${synthesisNote}${permNote}` },
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
    result: fixedReply || ((synthesisNote ? `fake result${synthesisNote}` : 'fake result') + permNote),
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

// Moteur de pipelines (0.48.0), inactif par défaut :
//   FAKE_CLAUDE_PIPELINE=1      joue l'étape nommée par « PIPELINE_STEP= » sur un
//                               petit projet Node (test/pipe.test.mjs, src/pipe.mjs) :
//                               écrit l'artefact « ARTEFACT= », le test, le code,
//                               puis version + CHANGELOG + exigence + commit (Livrer)
//   FAKE_PIPE_BAD=<étape>[:n]   triche à cette étape (les n premières fois, défaut :
//                               toujours) : Rouge touche le code, Vert le test,
//                               Comprendre cite un chemin inexistant, Rechercher
//                               modifie le projet, Livrer ne commite pas
//   FAKE_PIPE_REVIEW=problemes[:n]  la revue relève un problème (n fois)
//   FAKE_PIPE_ITEMS=<n>         Liste de tests : n items (défaut 2) ; « ITEM=k » → test/pipe-k, src/pipe-k
//   FAKE_PIPE_BIG=1             4b léger crée 4 fichiers de code (montée en complet)
//   FAKE_PIPE_REFACTOR=1        4c modifie vraiment le code (sinon RIEN_A_REFACTORER)
//   FAKE_PIPE_COVERED=<k>[,…]   l'item k est déjà couvert : test qui passe + DEJA_COUVERT
//   FAKE_PIPE_NOCLAIM=1         … mais sans écrire DEJA_COUVERT
//   FAKE_CLAUDE_DUMP_PROMPT=<f>  ajoute chaque prompt reçu à ce fichier (JSON par ligne)
//   FAKE_CLAUDE_REPLY=<texte>    réponse finale imposée (ex. un paragraphe en anglais)
//   FAKE_CLAUDE_TRANSLATION=<t>  réponse d'une demande « [REFORMULATION] » (défaut : un texte français)
//   FAKE_PIPE_REVIEW=doc|hors|mixte[:n]  revue : constat de doc (items / hors_tdd / les deux sortes)
/** Numéro de l'item de la liste de tests (« ITEM=<n>: … »), ou 0 en léger. */
function item(text) { return Number((/^ITEM=(\d+):/m.exec(text) || [])[1] || 0); }

function pipelineStep(text) {
  const step = (/^PIPELINE_STEP=(\S+)/m.exec(text) || [])[1];
  const artefact = (/^ARTEFACT=(.+)$/m.exec(text) || [])[1]?.trim();
  const cwd = process.cwd();
  const once = (spec, key) => {
    const [name, n] = String(spec || '').split(':');
    if (name !== key) return false;
    if (!n) return true;
    const f = path.join(path.dirname(artefact || cwd), `.fake-${key}.count`);
    let c = 0; try { c = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(c + 1));
    return c < Number(n);
  };
  const bad = once(process.env.FAKE_PIPE_BAD, step);
  const w = (rel, s) => { const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, s); };
  const g = (...a) => spawnSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@localhost', ...a], { cwd, encoding: 'utf8' });
  switch (step) {
    case 'comprendre': w(artefact, `# Compréhension\n\nLa question porte sur le projet. Fichiers utiles : \`package.json\`${bad ? ', `inexistant/fichier.js`' : ''}.\n`); break;
    case 'rechercher': w(artefact, '# Recherche\n\n- package.json : script de test « node --test ».\n'); if (bad) w('pollution.txt', 'modifié par la recherche\n'); break;
    // FAKE_PIPE_LANG=en : la réponse est écrite en anglais (portier de langue du moteur).
    case 'repondre': w(artefact, process.env.FAKE_PIPE_LANG === 'en'
      ? '# Answer\n\nSimulated answer: the project is tested with `npm test`, and there is nothing to change for this request at the moment.\n'
      : '# Réponse\n\nRéponse simulée : le projet se teste avec `npm test`. Recommandation : rien à changer.\n'); break;
    case 'concevoir':
      w(artefact, bad ? 'Un plan sans sections.\n' : '# Plan\n\n## Approche\nUn module par comportement.\n\n## Étapes\n1. un test par item\n');
      break;
    case 'liste-tests': {
      const n = Number(process.env.FAKE_PIPE_ITEMS || 2);
      const head = /dépassé le périmètre/.test(text) ? '- [x] double(x) = 2x (déjà couvert par le premier test)\n' : '';
      w(artefact, `# Liste de tests\n\n${head}${Array.from({ length: n }, (_, i) => `- [ ] multiplier par ${i + 2}`).join('\n')}\n`);
      break;
    }
    case 'rouge': {
      const k = item(text);
      // Item déjà couvert par le code existant (Q10) : test fidèle qui passe d'emblée.
      if (k && String(process.env.FAKE_PIPE_COVERED || '').split(',').includes(String(k))) {
        w(`test/pipe-${k}.test.mjs`, `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { id } from '../src/pipe.mjs';\ntest('pipe item ${k} déjà couvert', () => {\n  assert.equal(id(${k}), ${k});\n});\n`);
        if (bad) w('src/pipe.mjs', 'export const id = (x) => x; // retouché\n');
        w(artefact, process.env.FAKE_PIPE_NOCLAIM === '1' ? `# Rouge\n\nLe test « pipe item ${k} » passe déjà.\n` : `DEJA_COUVERT\n\n# Rouge\n\nid() de src/pipe.mjs assure déjà l'item ${k} : le test passe d'emblée.\n`);
        break;
      }
      if (k) {
        w(`test/pipe-${k}.test.mjs`, `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('pipe item ${k}', async () => {\n  const m = await import('../src/pipe-${k}.mjs');\n  assert.equal(m.f(2), ${2 * k});\n});\n`);
        if (bad) w(`src/pipe-${k}.mjs`, `export const f = (x) => x * ${k};\n`);
        w(artefact, `# Rouge\n\nTest « pipe item ${k} » : échoue, src/pipe-${k}.mjs n’existe pas.\n`);
        break;
      }
      w('test/pipe.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('pipe double', async () => {\n  const m = await import('../src/pipe.mjs');\n  assert.equal(m.double(2), 4);\n});\n");
      if (bad) w('src/pipe.mjs', 'export const id = (x) => x;\nexport const double = (x) => x * 2;\n');
      w(artefact, '# Rouge\n\nTest « pipe double » dans test/pipe.test.mjs : échoue, double() n’existe pas encore.\n');
      break;
    }
    case 'vert': {
      const k = item(text);
      if (k) {
        w(`src/pipe-${k}.mjs`, `export const f = (x) => x * ${k};\n`);
        if (bad) fs.appendFileSync(path.join(cwd, `test/pipe-${k}.test.mjs`), '// affaibli\n');
        w(artefact, `# Vert\n\nsrc/pipe-${k}.mjs : f(x) = ${k}x.\n`);
        break;
      }
      // Fichier EXISTANT complété (le léger ne crée pas de fichier de code) ;
      // correction demandée par la revue : renommer le paramètre.
      w('src/pipe.mjs', 'export const id = (x) => x;\n' + (/CORRIGER les problèmes/.test(text) ? 'export const double = (valeur) => valeur * 2;\n' : 'export const double = (x) => x * 2;\n'));
      if (process.env.FAKE_PIPE_BIG === '1') for (let i = 1; i <= 4; i++) w(`src/extra-${i}.mjs`, `export const e${i} = ${i};\n`);
      if (bad) fs.appendFileSync(path.join(cwd, 'test/pipe.test.mjs'), '// affaibli\n');
      w(artefact, '# Vert\n\nsrc/pipe.mjs : double(x) = 2x.\n');
      break;
    }
    case 'refactor': {
      const k = item(text);
      if (bad) { fs.appendFileSync(path.join(cwd, `test/pipe-${k}.test.mjs`), '// retouché\n'); w(artefact, '# Refactor\n\ntests retouchés\n'); break; }
      if (process.env.FAKE_PIPE_REFACTOR === '1') {
        w(`src/pipe-${k}.mjs`, `/** Multiplie par ${k}. */\nexport const f = (valeur) => valeur * ${k};\n`);
        w(artefact, '# Refactor\n\nparamètre renommé, commentaire.\n');
      } else w(artefact, 'RIEN_A_REFACTORER\n');
      break;
    }
    case 'revue': {
      const spec = process.env.FAKE_PIPE_REVIEW;
      // « doc » : constat non testable, à l'ancienne (dans items) ; « hors » :
      // le même, rangé par la revue dans hors_tdd ; « mixte » : un de chaque.
      if (once(spec, 'doc')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: ['docs/USER_REQUIREMENTS.md : la demande est absente du registre'] })); break; }
      if (once(spec, 'hors')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: [], hors_tdd: ['README : documenter la nouvelle fonction'] })); break; }
      if (once(spec, 'mixte')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: ['nommer le paramètre de double', 'CHANGELOG : décrire la fonction'] })); break; }
      const prob = once(spec, 'problemes');
      w(artefact, JSON.stringify(prob ? { verdict: 'problèmes', items: ['nommer le paramètre de double'] } : { verdict: 'ok', items: [] }));
      break;
    }
    case 'livrer': {
      const pkgF = path.join(cwd, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgF, 'utf8'));
      const v = String(pkg.version || '1.0.0').split('.').map(Number); v[2]++;
      pkg.version = v.join('.');
      fs.writeFileSync(pkgF, JSON.stringify(pkg, null, 2) + '\n');
      const cl = path.join(cwd, 'CHANGELOG.md');
      const old = fs.existsSync(cl) ? fs.readFileSync(cl, 'utf8') : '# Changelog\n';
      fs.writeFileSync(cl, old.replace(/^(# Changelog\s*\n)/, `$1\n## [${pkg.version}] - 2026-10-09\n### Added\n- double()\n`));
      fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
      fs.appendFileSync(path.join(cwd, 'docs', 'USER_REQUIREMENTS.md'), `| 2026-10-09 | « double » | test/pipe.test.mjs | ${pkg.version} |\n`);
      w(artefact, `# Livraison\n\nVersion ${pkg.version}.\n`);
      if (!bad) { g('add', '-A'); g('commit', '-q', '-m', `feat: double (v${pkg.version})`); }
      break;
    }
  }
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
