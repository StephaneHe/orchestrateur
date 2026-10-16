#!/usr/bin/env node
// ============================================================================
// scripts/_test_id_links.mjs — clickable identifiers explained by an overlay
// (0.107.0)
// ============================================================================
//
// User request (2026-10-16): « il faut que toutes references a un identifiant
// quelconque soit un lien qui ouvre un overlay qui decrit ou explique ce qu'est
// cet identifiant ».
//   1. public/id-links.js (pure part, under Node): the [[…]] marks and the
//      known formats become links; <a>/<pre>, everyday words, colours, plain
//      numbers stay text; a mark cannot inject an attribute; strip().
//   2. Speech and journal summaries never show the [[ ]] brackets.
//   3. scripts/id-resolve.mjs on a throw-away root: every kind resolved from
//      the real files (TODO, run, queue, Routage task, commit, version,
//      project, file, case), unknown → a plain message, no path escape.
//   4. The REAL dispatch.mjs: the marking instruction reaches claude for a
//      musician and for the chef, never the text shown in the thread.
//   5. report-check: a marked Routage task id gets its title after the mark.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const section = (n) => console.log(`\n── ${n}`);

await import(pathToFileURL(path.join(ROOT, 'public', 'html-render.js')).href);
await import(pathToFileURL(path.join(ROOT, 'public', 'id-links.js')).href);
await import(pathToFileURL(path.join(ROOT, 'public', 'tts.js')).href);
await import(pathToFileURL(path.join(ROOT, 'public', 'turn-core.js')).href);
const L = globalThis.IdLinks;
const H = globalThis.HtmlRender;

// ---------------------------------------------------------------------------
section('1. Liens côté client (linkify)');
L.setVocab({ projects: ['chef', 'alpha', 'BlueFox', 'garde', 'sky-share', 'index'], slots: ['routage.classifier', 'dev.vert', 'images.generer.photo'], conductor: 'chef' });
const links = (html) => [...L.linkify(html).matchAll(/<a class="idref"[^>]*data-idref="([^"]*)"(?: data-idref-kind="([^"]*)")?[^>]*>([^<]*)<\/a>/g)]
  .map(m => ({ value: m[1], kind: m[2] || '', text: m[3] }));
const one = (html) => links(html)[0] || null;

let r = one('<p>Voir [[t-1a2b3c]] « titre ».</p>');
ok(r && r.value === 't-1a2b3c' && r.text === 't-1a2b3c' && !/\[\[/.test(L.linkify('<p>[[t-1a2b3c]]</p>')), 'balise [[t-…]] → lien, crochets retirés');
r = one('<p>[[commit:3e3b51b]]</p>');
ok(r && r.value === '3e3b51b' && r.kind === 'commit' && r.text === '3e3b51b', 'balise avec préfixe [[commit:…]] → lien typé, préfixe non affiché');
r = one('<p>[[fichier:I:\\Dev\\x\\notes.md]]</p>');
ok(r && r.kind === 'fichier' && r.value === 'I:\\Dev\\x\\notes.md', 'balise de chemin Windows (lettre de lecteur gardée)');
r = one('<p>[[quelque-chose-de-libre]]</p>');
ok(r && r.value === 'quelque-chose-de-libre' && r.kind === '', 'balise d’un format inconnu → lien quand même (le serveur dira inconnu)');
const bare = links('<p>t-abc123, p-20261016T101500-a1b2c3, q-1760000000000-ab12, v0.105.0, scripts/dispatch.mjs:12, routage.classifier, 3e3b51b, 7562a914, BlueFox, alpha, garde a fini et sky-share.</p>');
const kinds = Object.fromEntries(bare.map(b => [b.value, b.kind]));
ok(kinds['t-abc123'] === 'todo' && kinds['p-20261016T101500-a1b2c3'] === 'run' && kinds['q-1760000000000-ab12'] === 'queue', `formats détectés : TODO, exécution, file (${JSON.stringify(kinds)})`);
ok(kinds['v0.105.0'] === 'version' && kinds['scripts/dispatch.mjs:12'] === 'fichier' && kinds['routage.classifier'] === 'case', 'formats détectés : version, fichier avec ligne, case de la page Models');
ok(kinds['3e3b51b'] === '' && kinds['7562a914'] === '' && kinds.BlueFox === 'projet' && kinds.garde === 'projet' && kinds.alpha === 'projet' && kinds['sky-share'] === 'projet', 'formats détectés : hex (commit ou tâche en attente), noms de projets');
ok(bare.length === 12, `12 identifiants, rien de plus (${bare.length})`);
const none = links('<p>Node.js, la garde, the garde, l’index, le chef, couleur #ff00aa, 20261016, decade, abcdef, v1.2, dev.md5, e-mail a.b@c.com, http://x.org/a.js, 75627914 (chiffres seuls : à baliser)</p>');
ok(none.length === 0, `aucun faux positif sur des mots, couleurs, nombres, URL (${JSON.stringify(none)})`);
ok(links('<p><a href="https://x.org">t-abc123</a></p><pre><code>git show 3e3b51b</code></pre>').length === 0, 'rien dans un lien ni dans un bloc de code');
ok(one('<p>Commit <code>3e3b51b</code></p>')?.value === '3e3b51b', 'identifiant en code en ligne → lien');
ok(one('<p>[[index]] et [[chef]]</p>')?.value === 'index' && links('<p>[[index]] et [[chef]]</p>').length === 2, 'nom de projet banal : lié seulement s’il est balisé');
const inj = L.linkify(H.sanitize('<p>[[" onmouseover="alert(1)]] et [[x"><img src=x onerror=alert(2)>]]</p>'));
const tags = [...inj.matchAll(/<([a-z]+)([^>]*)>/g)];
const attrs = tags.flatMap(m => [...m[2].matchAll(/\s([a-z-]+)(?==")/g)].map(a => `${m[1]}.${a[1]}`));
ok(tags.every(m => m[1] === 'p' || m[1] === 'a') && attrs.every(a => /^a\.(class|href|role|data-idref|data-idref-kind|title)$/.test(a))
  && tags.every(m => /^(\s+[a-z-]+="[^"]*")*$/.test(m[2])), `une balise n’injecte ni attribut ni élément : ${[...new Set(attrs)].join(' ')}`);
const md = L.linkify('<p>Voir &lt;b&gt; t-abc123 &amp; [[fichier:a&amp;b.md]]</p>');
ok(/data-idref="a&amp;b.md"/.test(md) && /&lt;b&gt;/.test(md), 'entités préservées, valeur décodée puis ré-échappée');
ok(L.strip('Voir [[t-1a2b3c]] et [[commit:3e3b51b]]') === 'Voir t-1a2b3c et 3e3b51b', 'strip() : texte sans balises');
ok(L.linkify('') === '' && L.linkify('<p>rien</p>') === '<p>rien</p>', 'texte sans identifiant inchangé');

// ---------------------------------------------------------------------------
section('2. Lecture audio et résumés sans crochets');
const said = globalThis.Tts.toSpeech('Item [[t-1a2b3c]] livré dans [[version:v0.105.0]] et [[fichier:a/b.js]].');
ok(!/\[\[|\]\]|version:|fichier:/.test(said) && /t-1a2b3c/.test(said), `lecture audio : « ${said} »`);
const sum = globalThis.TurnCore.summarizeResult('Fait : [[t-1a2b3c]] coché, [[commit:3e3b51b]] posé.').join(' ');
ok(/t-1a2b3c/.test(sum) && /3e3b51b/.test(sum) && !/\[\[|commit:/.test(sum), `résumé du journal sans crochets : ${sum}`);

// ---------------------------------------------------------------------------
section('3. Résolution côté serveur (id-resolve.mjs)');
const { resolveId, idVocabulary, guessKinds } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'id-resolve.mjs')).href);
const { PIPELINES } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'model-pipelines.mjs')).href);
const { parseTodo } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'todo-core.mjs')).href);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idref-'));
const LOGS = path.join(T, 'logs');
const SRV = path.join(T, 'server');
fs.mkdirSync(SRV);
const A = path.join(T, 'alpha');
fs.mkdirSync(path.join(LOGS, 'runs', 'p-20261016T101500-a1b2c3'), { recursive: true });
fs.mkdirSync(path.join(LOGS, 'queue'), { recursive: true });
fs.mkdirSync(path.join(A, 'src'), { recursive: true });
fs.writeFileSync(path.join(T, 'secret.txt'), 'hors projet');
fs.writeFileSync(path.join(A, 'TODO_LIST.md'), '# TODO\n\n- [ ] (2026-10-15 09:00) [fonctionnalite] Mode sombre du tableau <!-- id:t-1a2b3c -->\n- [x] (2026-10-14 09:00) Corriger la file → fait (2026-10-15 10:00) par alpha <!-- id:t-4d5e6f -->\n');
fs.writeFileSync(path.join(A, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.0] - 2026-10-15\n\n### Added\n- Mode sombre.\n\n### Fixed\n- File bloquée.\n\n## [1.1.0] - 2026-10-01\n\n### Added\n- Début.\n');
fs.writeFileSync(path.join(A, 'src', 'app.mjs'), 'export const x = 1;\n');
const git = (...a) => spawnSync('git', ['-C', A, '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', ...a], { encoding: 'utf8' });
git('init', '-q'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'Ajoute le mode sombre');
const sha = git('rev-parse', 'HEAD').stdout.trim();
fs.writeFileSync(path.join(LOGS, 'runs', 'p-20261016T101500-a1b2c3', 'run.json'), JSON.stringify({
  run: 'p-20261016T101500-a1b2c3', project: 'alpha', pipeline: 'dev', mode: 'leger', status: 'done', createdAt: '2026-10-16T10:15:00Z', endedAt: '2026-10-16T10:40:00Z',
  request: 'Ajoute le mode sombre', plan: ['comprendre', 'rouge', 'vert', 'revue', 'livrer'], steps: [{ id: 'comprendre', title: '1 Comprendre', status: 'ok' }, { id: 'rouge', title: '4a Rouge', status: 'ok' }],
}));
fs.writeFileSync(path.join(LOGS, 'queue', 'alpha.json'), JSON.stringify([{ id: 'q-1760000000000-ab12', text: 'Relire le README', source: 'chef' }, { id: 'q-1760000000001-cd34', text: 'Deuxième' }]));
fs.writeFileSync(path.join(LOGS, 'routage-pending.json'), JSON.stringify({ tasks: [{ id: '75627914', titre: 'Livrer après la revue', projet: 'alpha', run: 'p-20261016T101500-a1b2c3', n: 2, demande: 'Livre la version quand la revue est finie', createdAt: '2026-10-16T10:20:00Z' }] }));
const projects = [{ name: 'chef', path: path.join(T, 'chef') }, { name: 'alpha', path: A }];
fs.mkdirSync(projects[0].path);
const todoOf = (p) => { try { return parseTodo(fs.readFileSync(path.join(p.path, 'TODO_LIST.md'), 'utf8'), { project: p.name }); } catch { return null; } };
const ctx = (contextProject = null) => ({ root: SRV, logsDir: LOGS, projects, conductor: 'chef', todoOf, pipelines: PIPELINES,
  assignments: { 'routage.classifier': { provider: 'anthropic', model: 'claude-haiku-5-5' } }, serverVersion: '0.107.0', contextProject });
const R = (id, kind = '', p = null) => resolveId(id, kind, ctx(p));

r = await R('t-1a2b3c');
ok(r.known && r.kind === 'todo' && r.title === 'Mode sombre du tableau' && r.project === 'alpha' && r.state === 'à faire' && r.links.some(l => l.open === 'todo' && l.item === 't-1a2b3c'), `item TODO : ${JSON.stringify(r).slice(0, 160)}`);
r = await R('t-4d5e6f');
ok(r.known && r.state === 'fait' && r.fields.some(f => f.k === 'Fait le' && /par alpha/.test(f.v)), 'item TODO fait : date et nom du musicien');
r = await R('p-20261016T101500-a1b2c3');
ok(r.known && r.kind === 'run' && /Développement/.test(r.title) && r.state === 'terminée' && r.fields.some(f => f.k === 'Étapes' && /2 faite\(s\) sur 5/.test(f.v)), `exécution : ${r.title} · ${r.state}`);
r = await R('q-1760000000001-cd34');
ok(r.known && r.kind === 'queue' && r.project === 'alpha' && /position 2 sur 2/.test(r.state), `file d’attente : ${r.state}`);
r = await R('75627914');
ok(r.known && r.kind === 'attente' && r.title === 'Livrer après la revue' && r.project === 'alpha', 'tâche du Routage en attente (8 hex) : son titre officiel');
r = await R(sha.slice(0, 7));
ok(r.known && r.kind === 'commit' && r.title === 'Ajoute le mode sombre' && r.project === 'alpha' && r.fields.some(f => f.k === 'SHA' && f.v === sha), `commit (sha court) : ${r.title}`);
r = await R(sha.slice(0, 8));
ok(r.known && r.kind === 'commit', '8 hex absent des tâches en attente → cherché comme commit');
r = await R('v1.2.0', '', 'alpha');
ok(r.known && r.kind === 'version' && r.date === '2026-10-15' && /Mode sombre/.test(r.summary) && /Added \(1\), Fixed \(1\)/.test(r.fields.find(f => f.k === 'Sections')?.v || ''), `version : ${r.title} (${r.date})`);
r = await R('alpha');
ok(r.known && r.kind === 'projet' && r.fields.some(f => f.k === 'Dépôt git' && f.v === 'oui') && r.links.some(l => l.musician === 'alpha'), 'projet : rôle, dossier, git, lien vers son volet');
r = await R('chef', 'projet');
ok(r.known && /routeur/.test(r.fields.find(f => f.k === 'Rôle')?.v || ''), 'le chef : son rôle est expliqué');
r = await R('src/app.mjs:1', '', 'alpha');
ok(r.known && r.kind === 'fichier' && r.title === 'src/app.mjs' && r.fields.some(f => f.k === 'Ligne' && f.v === '1') && !('content' in r), 'fichier : projet, ligne, taille, jamais le contenu');
r = await R(path.join(A, 'CHANGELOG.md'));
ok(r.known && r.project === 'alpha' && r.title === 'CHANGELOG.md', 'chemin absolu dans un projet');
for (const bad of ['../secret.txt', path.join(T, 'secret.txt'), '..\\..\\Windows\\win.ini']) {
  r = await R(bad, 'fichier', 'alpha');
  ok(!r.known, `hors des projets : inconnu (${bad})`);
}
r = await R('routage.classifier');
ok(r.known && r.kind === 'case' && /Routage/.test(r.title) && /claude-haiku-5-5/.test(r.state) && r.links.some(l => l.route === '#/models'), `case de la page Models : ${r.title} · ${r.state}`);
r = await R('dev.inexistante', 'case');
ok(!r.known, 'case inexistante : inconnue');
r = await R('t-ffffff');
ok(!r.known && r.kind === 'todo' && /Item de TODO list/.test(r.message) && /ne le trouve pas/.test(r.message), `inconnu, forme reconnue : ${r.message}`);
r = await R('bidule truc');
ok(!r.known && /aucun identifiant connu/.test(r.message), 'inconnu sans forme : message clair');
r = await R('commit:' + sha.slice(0, 7));
ok(r.known && r.kind === 'commit', 'préfixe de balise accepté par le serveur');
const v = idVocabulary(ctx());
ok(v.projects.includes('alpha') && v.pipelines.includes('routage') && v.slots.includes('routage.classifier') && !v.slots.includes('dev.md5') && v.conductor === 'chef' && v.kinds.todo, 'vocabulaire : projets, pipelines, chef, types');
ok(JSON.stringify(guessKinds('75627914')) === '["attente","commit"]' && guessKinds('v1.0.0')[0] === 'version', 'ordre des types devinés');

// ---------------------------------------------------------------------------
section('4. Consigne de balisage injectée par le vrai dispatch.mjs');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idref-d-'));
fs.mkdirSync(path.join(D, 'logs'));
fs.mkdirSync(path.join(D, 'proj'));
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { model: 'claude-opus-5-5', allowedTools: 'Read', provider: 'claude' },
  projects: [{ name: 'chef', path: path.join(D, 'proj') }, { name: 'M', path: path.join(D, 'proj') }],
}));
const STUB = path.join(D, 'claude-stub.mjs');
fs.writeFileSync(STUB, `
import fs from 'node:fs';
fs.writeFileSync(process.env.STUB_ARGS, JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sid-i', model: 'claude-opus-5-5' });
out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'C’est fait, voir [[t-1a2b3c]] pour le détail du travail.' }] }, session_id: 'sid-i' });
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 5, result: 'C’est fait, voir [[t-1a2b3c]] pour le détail du travail.', session_id: 'sid-i' });
`);
const run = (project, prompt) => {
  const argsFile = path.join(D, `args-${project}.json`);
  const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: D, CLAUDE_BIN: STUB, STUB_ARGS: argsFile };
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) if (/^(DISPATCH_|ORCH_TURN|ORCH_STEP|ORCH_OBS)/.test(k) && k !== 'DISPATCH_ROOT_FOR_TESTS') delete env[k];
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), project, prompt, '--no-queue-if-busy'], { env, encoding: 'utf8', timeout: 60_000 });
  let argv = [];
  try { argv = JSON.parse(fs.readFileSync(argsFile, 'utf8')); } catch { /* no spawn */ }
  let raw = '';
  try { raw = fs.readFileSync(path.join(D, 'logs', `${project}.jsonl`), 'utf8'); } catch { /* no log */ }
  const log = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { res, prompt: argv.find(a => a.startsWith(prompt)) || '', log };
};
for (const [who, text] of [['M', 'Ajoute le mode sombre'], ['chef', 'Point sur la flotte']]) {
  const x = run(who, text);
  if (!x.prompt) console.log(String(x.res.stderr || '').slice(-600));
  ok(x.res.status === 0 && /IDENTIFIANTS :/.test(x.prompt) && /\[\[t-1a2b3c\]\]/.test(x.prompt) && /\[\[commit:3e3b51b\]\]/.test(x.prompt), `${who} : consigne de balisage dans le prompt envoyé au model`);
  ok(/JAMAIS de crochets dans du JSON, du code, une commande/.test(x.prompt), `${who} : jamais de balise dans du JSON, du code ou une commande`);
  ok(x.prompt.indexOf('IDENTIFIANTS :') < x.prompt.indexOf('LANGUE'), `${who} : la consigne de langue reste la dernière`);
  const shown = x.log.find(e => e.type === 'user_prompt');
  ok(shown && shown.text === text, `${who} : le fil n’affiche que la demande`);
}

// ---------------------------------------------------------------------------
section('5. Contrôle du rapport : la note suit la balise');
const { checkReportIds } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'report-check.mjs')).href);
const chk = checkReportIds('La tâche [[75627914]] attend la revue.', { pending: [{ id: '75627914', titre: 'Livrer après la revue', projet: 'alpha', demande: 'x' }], queueIds: new Map(), hasRun: () => true });
ok(/\[\[75627914\]\] « Livrer après la revue »/.test(chk.text), `titre ajouté après la balise : ${chk.text}`);
const chk2 = checkReportIds('Voir [[p-20261016T101500-ffffff]].', { pending: [], queueIds: new Map(), hasRun: () => false });
ok(/\]\] ⚠ \[contrôle : exécution inconnue\]/.test(chk2.text), 'exécution inconnue : note après la balise');

fs.rmSync(T, { recursive: true, force: true });
fs.rmSync(D, { recursive: true, force: true });
console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
