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

// Interactive central terminal double (0.52.0): started by the server through
// ORCH_CENTRAL_CMD with `--orch-fake-interactive`. Prints its argv, then
// "RECU:<line>" on Enter and "EFFACE" on Ctrl+U, so a test can see exactly
// which bytes the router let through.
if (argv.includes('--orch-fake-interactive')) {
  process.stdout.write(`ARGS ${JSON.stringify(argv)}\r\n`);
  let line = '';
  try { process.stdin.setRawMode?.(true); } catch { /* not a tty */ }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    for (const ch of d) {
      if (ch === '\r' || ch === '\n') { process.stdout.write(`\r\nRECU:${line}\r\n`); line = ''; }
      else if (ch === '\x15') { process.stdout.write('\r\nEFFACE\r\n'); line = ''; }
      else if (ch === '\x03') process.exit(0);
      else if (ch >= ' ') line += ch;
    }
  });
  await new Promise(() => {});
}

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
  // Pipelines phase 5 (0.52.0): classifier slot. FAKE_CLAUDE_CLASSIFY = the JSON
  // answer (or any text to simulate an invalid answer); default: a naive guess.
  const isClassify = /^\[CLASSIFY\]/.test(userText);
  if (isClassify && process.env.FAKE_CLAUDE_CLASSIFY_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_CLASSIFY_LOG, JSON.stringify({ model: askedModel }) + '\n');
  const classifyReply = () => {
    if (process.env.FAKE_CLAUDE_CLASSIFY) return process.env.FAKE_CLAUDE_CLASSIFY;
    const req = (/Request:\n<<<\n([\s\S]*)\n>>>/.exec(userText) || [])[1] || '';
    // A variant choice (chooseOption): the first option, unless FAKE_CLAUDE_CHOICE names one.
    if (/^Options:$/m.test(userText) && !/^Pipelines:$/m.test(userText)) {
      // FAKE_CLAUDE_CHOICE=<id>[,<id>…]: the first offered option in that list (several steps, one env).
      const opts = [...userText.matchAll(/^- ([^:\n]+): (.*)$/gm)].map(m => ({ id: m[1], what: m[2] }));
      const offered = opts.map(o => o.id);
      const wanted = String(process.env.FAKE_CLAUDE_CHOICE || '').split(',').map(x => x.trim()).filter(Boolean);
      // Without a scripted choice, the double plays a rough « meaning »: the option
      // whose description shares the most word stems with the request.
      const stems = (s) => new Set(String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4).map(w => w.slice(0, 5)));
      const rq = stems(req);
      const best = opts.map(o => ({ id: o.id, n: [...stems(o.what)].filter(w => rq.has(w)).length })).sort((a, b) => b.n - a.n)[0];
      return JSON.stringify({ choix: offered.find(o => wanted.includes(o)) || (best?.n ? best.id : offered[0]), raison: 'choix du faux claude' });
    }
    // The fake stands for the model: its naive guess (test double only — the
    // orchestrator itself never classifies by words since 0.66.0).
    const imposed = /The user already chose pipeline "([a-z-]+)"/.exec(userText)?.[1];
    const imposedMode = /mode "(leger|complet)": keep it/.exec(userText)?.[1] || /and mode "(leger|complet)"/.exec(userText)?.[1];
    const dev = imposed ? imposed === 'dev' : /\b(ajoute|corrige|implémente|implemente|modifie|fix|add)\b/i.test(req);
    const nature = /\b(corrige|bug|fix|répare|repare)\b/i.test(req) ? 'bugfix' : /\b(renomme|remplace|rename)\b/i.test(req) ? 'mecanique' : 'comportement';
    return JSON.stringify({ pipeline: imposed || (dev ? 'dev' : 'discussion'), mode: imposedMode || 'leger', nature, raison: 'classement du faux claude' });
  };
  const fixedReply = isReformulation
    ? (process.env.FAKE_CLAUDE_TRANSLATION || 'Réponse reformulée en français : la suite de tests passe, le travail est terminé et rien ne reste à faire pour cette demande.')
    : isClassify ? classifyReply()
    : (process.env.FAKE_CLAUDE_REPLY || null);

  // FAKE_CLAUDE_LAUNCH_FAIL_FILE=<f> (0.60.0): while <f> holds n > 0, decrement it
  // and die like a temporarily unavailable model — exit 1, NOTHING on stdout,
  // one line on stderr. Pipeline step prompts only, unless
  // FAKE_CLAUDE_LAUNCH_FAIL_ALL=1 (then the model test fails too).
  if (process.env.FAKE_CLAUDE_LAUNCH_FAIL_FILE && (/^PIPELINE_STEP=/m.test(userText) || process.env.FAKE_CLAUDE_LAUNCH_FAIL_ALL === '1')) {
    const f = process.env.FAKE_CLAUDE_LAUNCH_FAIL_FILE;
    let left = 0; try { left = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
    if (left > 0) {
      fs.writeFileSync(f, String(left - 1));
      if (process.env.FAKE_CLAUDE_LAUNCH_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LAUNCH_LOG, JSON.stringify({ at: Date.now(), model: askedModel, failed: true }) + '\n');
      process.stderr.write(`API Error: 529 overloaded_error — ${askedModel} temporarily unavailable (simulated)\n`);
      process.exit(1);
    }
    if (process.env.FAKE_CLAUDE_LAUNCH_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LAUNCH_LOG, JSON.stringify({ at: Date.now(), model: askedModel, failed: false }) + '\n');
  }

  // 1. system/init
  emit({
    type: 'system', subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    model: servedModel,
  });
  await sleep(LATENCY);
  // 0.67.0: FAKE_CLAUDE_STDERR=<text> — a stderr line WITHOUT its newline, as the
  // real CLI does (« No conversation found… »): it must never glue to a JSON line.
  if (process.env.FAKE_CLAUDE_STDERR) { process.stderr.write(process.env.FAKE_CLAUDE_STDERR); await sleep(LATENCY); }

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
//   FAKE_PIPE_ITEM_EXTRA_TESTS=<e>[:n]  4a d'un item écrit e tests de plus (n fois)
//   FAKE_PIPE_DECL=two          chaque case de tests.md déclare « (tests: 2) »
//   FAKE_CLAUDE_DUMP_PROMPT=<f>  ajoute chaque prompt reçu à ce fichier (JSON par ligne)
//   FAKE_CLAUDE_REPLY=<texte>    réponse finale imposée (ex. un paragraphe en anglais)
//   FAKE_CLAUDE_TRANSLATION=<t>  réponse d'une demande « [REFORMULATION] » (défaut : un texte français)
//   FAKE_PIPE_REVIEW=doc|hors|mixte[:n]  revue : constat de doc (items / hors_tdd / les deux sortes)
//   FAKE_PIPE_REVIEW_ITEM=<k>[:n][,…]  revue de l'item k (« REVUE_ITEM=k ») : un défaut (n fois)
//   FAKE_PIPE_REVIEW_LOG=<f>     chaque revue ajoute {item, diff} à ce fichier (JSON par ligne)
//   FAKE_PIPE_REVIEW_SEVERITY=P2 le défaut de FAKE_PIPE_REVIEW_ITEM porte cette gravité
//   FAKE_PIPE_REVIEW_DOC_ITEM=<k>[:n][,…]  revue de l'item k : un constat de doc (hors_tdd), n fois
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
  // Catalog steps (phase 6) carry MODIFIER=… lines: same id as a dev step does not mean same contract.
  if (/^MODIFIER=/m.test(text)) return catalogStep(text, step, artefact, bad, w, once);
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
      // 0.61.0 « c+d » : each case states "(tests: N)". FAKE_PIPE_DECL=none[:n]
      // omits it on case 1, over[:n] declares one test more than the cap.
      const cap = Number(process.env.ORCH_PIPE_TESTS_PER_ITEM) || 2;
      const noDecl = once(process.env.FAKE_PIPE_DECL, 'none'), over = once(process.env.FAKE_PIPE_DECL, 'over');
      // FAKE_PIPE_DECL=two declares 2 tests on every case (0.62.0).
      const two = process.env.FAKE_PIPE_DECL === 'two';
      const decl = (i) => (i === 0 && noDecl ? '' : `(tests: ${i === 0 && over ? cap + 1 : two ? 2 : 1}) `);
      w(artefact, `# Liste de tests\n\n${head}${Array.from({ length: n }, (_, i) => `- [ ] ${decl(i)}multiplier par ${i + 2}`).join('\n')}\n`);
      break;
    }
    case 'rouge': {
      const k = item(text);
      // Item déjà couvert par le code existant (Q10) : test fidèle qui passe d'emblée.
      // k = 0 in light mode: FAKE_PIPE_COVERED=0 means the request itself is
      // already implemented. FAKE_PIPE_PROOF=none[:n] omits the proof,
      // FAKE_PIPE_NOTEST=1[:n] claims DEJA_COUVERT without (re)writing the test.
      if (String(process.env.FAKE_PIPE_COVERED || '').split(',').includes(String(k))) {
        const noTest = once(process.env.FAKE_PIPE_NOTEST && `notest:${String(process.env.FAKE_PIPE_NOTEST).split(':')[1] || ''}`.replace(/:$/, ''), 'notest');
        const noProof = once(process.env.FAKE_PIPE_PROOF && `noproof:${String(process.env.FAKE_PIPE_PROOF).split(':')[1] || ''}`.replace(/:$/, ''), 'noproof');
        const name = k ? `pipe-${k}` : 'pipe-covered';
        if (!noTest) w(`test/${name}.test.mjs`, `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { id } from '../src/pipe.mjs';\ntest('${name} déjà couvert', () => {\n  assert.equal(id(${k || 7}), ${k || 7});\n});\n`);
        if (bad) w('src/pipe.mjs', 'export const id = (x) => x; // retouché\n');
        const head = (g('rev-parse', '--short', 'HEAD').stdout || '').trim();
        const proof = noProof ? 'Le code existant le fait déjà.' : (k ? `id() de src/pipe.mjs assure déjà l'item ${k}.` : `Preuve : commit ${head}, src/pipe.mjs:1 (id).`);
        w(artefact, process.env.FAKE_PIPE_NOCLAIM === '1' ? `# Rouge\n\nLe test « ${name} » passe déjà.\n` : `DEJA_COUVERT\n\n# Rouge\n\n${proof} Le test passe d'emblée.\n`);
        break;
      }
      if (k) {
        // 0.62.0: FAKE_PIPE_ITEM_EXTRA_TESTS=<e>[:n] writes e more tests for the
        // item than the one expected (the n first times, default: always).
        const [e, en] = String(process.env.FAKE_PIPE_ITEM_EXTRA_TESTS || '').split(':');
        const extra = Number(e) > 0 && once(`extra${en ? `:${en}` : ''}`, 'extra') ? Number(e) : 0;
        const one = (j) => `test('pipe item ${k}${j ? ` extra ${j}` : ''}', async () => {\n  const m = await import('../src/pipe-${k}.mjs');\n  assert.equal(m.f(2), ${2 * k});\n});\n`;
        w(`test/pipe-${k}.test.mjs`, `import { test } from 'node:test';\nimport assert from 'node:assert';\n${Array.from({ length: extra + 1 }, (_, j) => one(j)).join('')}`);
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
      // Per-item Review (0.63.0): FAKE_PIPE_REVIEW_LOG=<f> records each review
      // (item reviewed + the diff it was given); FAKE_PIPE_REVIEW_ITEM=<k>[:n][,…]
      // reports one defect when reviewing item k (the n first times).
      const rItem = (/^REVUE_ITEM=(\d+)$/m.exec(text) || [])[1];
      if (process.env.FAKE_PIPE_REVIEW_LOG) {
        let diff = ''; try { diff = fs.readFileSync(path.join(path.dirname(artefact), 'diff.patch'), 'utf8'); } catch {}
        fs.appendFileSync(process.env.FAKE_PIPE_REVIEW_LOG, JSON.stringify({ item: rItem == null ? null : Number(rItem), diff }) + '\n');
      }
      const perItem = String(process.env.FAKE_PIPE_REVIEW_ITEM || '').split(',').filter(Boolean).map(s => s.split(':'));
      const hit = rItem != null && perItem.find(([k]) => k === rItem);
      if (hit && once(`item${rItem}${hit[1] ? `:${hit[1]}` : ''}`, `item${rItem}`)) {
        // 0.65.0: FAKE_PIPE_REVIEW_SEVERITY=P2 tags the defect with its severity.
        const sev = process.env.FAKE_PIPE_REVIEW_SEVERITY ? `[${process.env.FAKE_PIPE_REVIEW_SEVERITY}] ` : '';
        w(artefact, JSON.stringify({ verdict: 'problèmes', items: [`(tests: 1) ${sev}défaut relevé sur l’item ${rItem}`] }));
        break;
      }
      // 0.65.0: FAKE_PIPE_REVIEW_DOC_ITEM=<k>[:n][,…] — a non-testable (doc) finding on item k.
      const docHit = rItem != null && String(process.env.FAKE_PIPE_REVIEW_DOC_ITEM || '').split(',').filter(Boolean).map(s => s.split(':')).find(([k]) => k === rItem);
      if (docHit && once(`doc${rItem}${docHit[1] ? `:${docHit[1]}` : ''}`, `doc${rItem}`)) {
        w(artefact, JSON.stringify({ verdict: 'problèmes', items: [], hors_tdd: [`README : documenter le comportement de l’item ${rItem}`] }));
        break;
      }
      const spec = process.env.FAKE_PIPE_REVIEW;
      // « doc » : constat non testable, à l'ancienne (dans items) ; « hors » :
      // le même, rangé par la revue dans hors_tdd ; « mixte » : un de chaque.
      // 0.66.0: the model itself files a registry finding under hors_tdd (no keyword re-sorting by the engine).
      if (once(spec, 'doc')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: [], hors_tdd: ['docs/USER_REQUIREMENTS.md : la demande est absente du registre'] })); break; }
      if (once(spec, 'hors')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: [], hors_tdd: ['README : documenter la nouvelle fonction'] })); break; }
      if (once(spec, 'mixte')) { w(artefact, JSON.stringify({ verdict: 'problèmes', items: ['(tests: 1) nommer le paramètre de double'], hors_tdd: ['CHANGELOG : décrire la fonction'] })); break; }
      const prob = once(spec, 'problemes');
      // 0.61.0: a behaviour item declares its tests; FAKE_PIPE_REVIEW_DECL=none[:n] / over[:n].
      const rcap = Number(process.env.ORCH_PIPE_TESTS_PER_ITEM) || 2;
      const rdecl = once(process.env.FAKE_PIPE_REVIEW_DECL, 'none') ? '' : once(process.env.FAKE_PIPE_REVIEW_DECL, 'over') ? `(tests: ${rcap + 1}) ` : '(tests: 1) ';
      w(artefact, JSON.stringify(prob ? { verdict: 'problèmes', items: [`${rdecl}nommer le paramètre de double`] } : { verdict: 'ok', items: [] }));
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
    default: catalogStep(text, step, artefact, bad, w, once);
  }
}

// Pipelines phase 6 (0.53.0): any catalog step, driven by the ATTENDU_* lines
// of the step prompt. FAKE_PIPE_NOTHING=<step,…> writes the "nothing to do"
// marker; FAKE_PIPE_REMAINING=<n> makes the re-check report one remaining flaw
// n times; FAKE_PIPE_BAD=<step> breaks that step's contract.
function catalogStep(text, step, artefact, bad, w, once) {
  const line = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(text) || [])[1]?.trim() || '';
  const modify = line('MODIFIER');
  const sections = line('ATTENDU_SECTIONS').split('|').map(s => s.trim()).filter(Boolean);
  const nSources = Number(line('ATTENDU_SOURCES') || 0);
  const jsonKeys = line('ATTENDU_JSON').split(',').filter(Boolean);
  const nothing = line('MARQUEUR_RIEN');
  const files = line('FICHIERS_REQUIS').split(',').map(s => s.trim()).filter(Boolean);
  const wantNothing = String(process.env.FAKE_PIPE_NOTHING || '').split(',').includes(step);
  if (process.env.FAKE_PIPE_SEEN_LOG) fs.appendFileSync(process.env.FAKE_PIPE_SEEN_LOG, JSON.stringify({ step, files: fs.readdirSync(path.dirname(artefact)) }) + '\n');
  const urls = Array.from({ length: nSources }, (_, i) => `- Source ${i + 1} : https://example.org/source-${i + 1}`).join('\n');
  if (jsonKeys.length) {
    const j = {};
    const enums = Object.fromEntries(line('ATTENDU_ENUM').split(';').filter(Boolean).map(p => { const [k, v] = p.split(':'); return [k, v.split('|')]; }));
    for (const k of jsonKeys) j[k] = enums[k] ? enums[k][0] : k === 'final' ? 'Texte final relu : tout est clair.' : k === 'raison' ? 'raison simulée' : [];
    // FAKE_PIPE_JSON='{"<step>": {…}}' : réponse imposée pour une étape (Routage).
    try { Object.assign(j, JSON.parse(process.env.FAKE_PIPE_JSON || '{}')[step] || {}); } catch { /* ignoré */ }
    if (jsonKeys.includes('remaining') && Number(process.env.FAKE_PIPE_REMAINING || 0) > 0) {
      const f = path.join(path.dirname(artefact), '.fake-remaining.count');
      let c = 0; try { c = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
      fs.writeFileSync(f, String(c + 1));
      if (c < Number(process.env.FAKE_PIPE_REMAINING)) j.remaining = [{ severity: 'haute', file: 'src/pipe.mjs', issue: 'entrée non validée' }];
    }
    if (jsonKeys.includes('findings')) j.findings = [{ severity: 'moyenne', file: 'src/pipe.mjs', issue: 'entrée non validée' }];
    w(artefact, bad ? 'pas du JSON' : JSON.stringify(j));
    return;
  }
  const body = [`# ${step}`, '', ...sections.flatMap(s => [`## ${s}`, `Contenu simulé pour « ${s} » (voir \`package.json\`).`, '']), urls, ''].join('\n') || `# ${step}\n\nContenu simulé, assez long pour le critère.\n`;
  // Media steps (0.55.0): really write a small valid file of the expected kind
  // and list it under « ## Fichiers ». FAKE_PIPE_BAD lists a missing file.
  const media = line('MEDIA');
  if (media) {
    const noMedia = line('MARQUEUR_SANS_MEDIA');
    if (noMedia && wantNothing) { w(artefact, `${noMedia}\n\n${body}`); return; }
    const ext = { image: 'png', audio: 'wav', video: 'mp4', text: 'txt' }[media];
    const rel = `media/${step}.${ext}`;
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const wav = () => { const n = 800, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), 44 + i * 2); return b; };
    const data = media === 'image' ? Buffer.from(PNG_1x1, 'base64') : media === 'audio' ? wav()
      : media === 'video' ? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
      : Buffer.from(process.env.FAKE_PIPE_TRANSCRIPT || `Transcription simulée de l'étape ${step}.\n`);
    if (!bad) { fs.mkdirSync(path.join(process.cwd(), 'media'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), rel), data); }
    w(artefact, `${body}\n## Fichiers\n- \`${rel}\`\n`);
    return;
  }
  if (modify === 'non') {
    w(artefact, `${body}\nRapport simulé (lecture seule, \`package.json\`).\n`);
    if (bad) w('pollution.txt', `modifié par l'étape ${step}\n`);
    return;
  }
  if (nothing && wantNothing) { w(artefact, `${nothing}\n\n${body}`); return; }
  for (const f of files) {
    if (f === '.orchestrateur/pipeline.json') w(f, JSON.stringify({ testCommand: 'node --test', testGlobs: ['test/**'], versionFiles: ['package.json'], changelog: 'CHANGELOG.md', requirements: 'docs/USER_REQUIREMENTS.md' }));
    else if (f === 'CHANGELOG.md') w(f, '# Changelog\n\n## [1.0.0] - 2026-10-09\n- squelette\n');
    else w(f, `# ${f}\n\nCréé par l'étape ${step}.\n`);
  }
  if (modify.startsWith('docs')) w(bad ? `src/${step}.mjs` : `docs/${step}.md`, `# ${step}\n\nTexte simulé.\n`);
  else if (bad) w(`test/zz-${step}.test.mjs`, "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('cassé', () => assert.equal(1, 2));\n");
  else {
    // A step played again (loop) must change something new each time.
    const f = path.join(path.dirname(artefact), `.fake-${step}.passes`);
    let n = 0; try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
    fs.writeFileSync(f, String(n + 1));
    w(`src/pipe-${step}.mjs`, `export const ${step.replace(/[^a-z]/g, '')} = ${n + 1};\n`);
  }
  w(artefact, `${body}\nModification simulée pour l'étape ${step}.\n`);
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
