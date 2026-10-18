#!/usr/bin/env node
// ============================================================================
// scripts/_test_mail_draft_page.mjs — mail draft readable as a web page
// ============================================================================
//
// User requirement (2026-10-17): "Je veux le mail que tu viens de rédiger,
// disponible sur une page web". The draft is registered in downloads.json
// (docs[], id `mail-retour-reunion`) and served by the REAL route
// `/downloads/:project/doc/:id` of server.js, extracted and mounted on a
// private express app on 127.0.0.1 (no production server is contacted).
//
// Proves: the route answers 200 with the draft's text, the draft gaps
// ([À COMPLÉTER …] / [À VÉRIFIER …]) are shown verbatim and highlighted, the
// source is read on every request (an edit shows without restart), the raw
// route returns the exact bytes, and the source file is never modified.
// The mail's text is never copied into this repo: it is read at run time.
//
//   node scripts/_test_mail_draft_page.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDownloadsRegistry } from './downloads-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PROJECT = 'Ayor';
const DOC_ID = 'mail-retour-reunion';

function extractBlock(startToken, label) {
  const start = SRC.indexOf(startToken);
  if (start < 0) throw new Error(`${label} not found in server.js`);
  // Body brace = first "{" after ") {" / "=> {", not a destructured parameter.
  let depth = 0, i = SRC.slice(start).search(/\)\s*(=>\s*)?\{/) + start;
  i = SRC.indexOf('{', i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}
const fn = (name) => extractBlock(`function ${name}(`, `function ${name}`);
const route = (p) => extractBlock(`app.get('${p}', `, `route ${p}`) + ');';

// eslint-disable-next-line no-new-func
const mountDocRoutes = new Function('app', 'downloadsRegistry', 'fs', 'path', 'BUILDS_DIR', [
  fn('escHtml'), fn('readDocMarkdown'), fn('renderMarkdown'), fn('docPageHtml'),
  route('/downloads/:project/doc/:id'), route('/downloads/:project/doc/:id/raw'),
].join('\n'));

async function serve(registry, buildsDir) {
  const app = express();
  mountDocRoutes(app, registry, fs, path, buildsDir);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const plain = (html) => html.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');
const sourceLineText = (l) => l.replace(/^\s*>\s?/, '').replace(/^\s*#+\s+/, '').replace(/^\s*[-*+]\s+/, '')
  .replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const scenario = (n) => console.log(`\n── ${n}`);

// ---------- 1. the real registry entry --------------------------------------
scenario('downloads.json du dépôt : le brouillon est enregistré');
const realReg = createDownloadsRegistry({ file: path.join(ROOT, 'downloads.json'), buildsDir: path.join(ROOT, 'builds'), log: () => {} });
const doc = realReg.findDoc(PROJECT, DOC_ID);
ok(!!doc, `docs[] contient ${PROJECT}/${DOC_ID}`);
const source = doc && doc.fallbacks.find(f => fs.existsSync(f));
ok(!!source, 'le fichier source du brouillon existe');
ok(!fs.existsSync(path.join(ROOT, 'builds', PROJECT, doc ? doc.file : '-')), 'aucune copie figée sous builds/ : la source est lue directement');

// ---------- 2. the real route serves the mail -------------------------------
if (doc && source) {
  scenario('la page répond et contient le texte du mail');
  const before = sha(source);
  const md = fs.readFileSync(source, 'utf8');
  const { srv, url } = await serve(realReg, path.join(ROOT, 'builds'));
  try {
    const res = await fetch(`${url}/downloads/${PROJECT}/doc/${DOC_ID}`);
    const html = await res.text();
    ok(res.status === 200 && /text\/html/.test(res.headers.get('content-type') || ''), 'GET /downloads/Ayor/doc/mail-retour-reunion → 200 HTML');
    const text = plain(html);
    const lines = md.split(/\r?\n/).map(sourceLineText).filter(l => l && !/^-{3,}$/.test(l));
    const missing = lines.filter(l => !text.includes(l));
    ok(lines.length > 20 && missing.length === 0, `chaque ligne du brouillon est dans la page (${lines.length} lignes${missing.length ? `, manquantes : ${missing.slice(0, 3).join(' | ')}` : ''})`);
    ok(/<strong>Objet :<\/strong>/.test(html), 'mise en forme Markdown rendue (gras de l’objet)');

    const joined = md.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
    const gaps = [...joined.matchAll(/\[À (?:COMPLÉTER|VÉRIFIER) :[^\]]*\]/g)].map(m => m[0]);
    ok(gaps.length >= 3, `les trous du brouillon sont relevés dans la source (${gaps.length})`);
    const marks = [...html.matchAll(/<mark class="draft-gap">([^<]*)<\/mark>/g)].map(m => m[1].replace(/\s+/g, ' '));
    ok(gaps.every(g => marks.includes(g)), 'chaque trou est affiché tel quel ET mis en évidence');

    const raw = await fetch(`${url}/downloads/${PROJECT}/doc/${DOC_ID}/raw`);
    ok(raw.status === 200 && (await raw.text()) === md, 'le .md brut est servi à l’identique');
  } finally { srv.closeAllConnections(); srv.close(); }
  ok(sha(source) === before, 'le fichier source n’est pas modifié');
}

// ---------- 3. read on every request (temp registry) -------------------------
scenario('la page suit les corrections du brouillon, sans redémarrage');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-page-'));
const draft = path.join(TMP, 'draft.md');
fs.writeFileSync(draft, 'Bonjour,\n\nDate : [À COMPLÉTER : date].\n\nVu dans `[À COMPLÉTER]` du code.\n');
fs.writeFileSync(path.join(TMP, 'downloads.json'), JSON.stringify({ apps: [], docs: [{ project: 'Demo', id: 'mail', title: 'Mail', file: 'mail.md', fallbacks: [draft] }] }));
const tmpReg = createDownloadsRegistry({ file: path.join(TMP, 'downloads.json'), buildsDir: path.join(TMP, 'builds'), log: () => {} });
const t = await serve(tmpReg, path.join(TMP, 'builds'));
try {
  let html = await (await fetch(`${t.url}/downloads/Demo/doc/mail`)).text();
  ok(html.includes('<mark class="draft-gap">[À COMPLÉTER : date]</mark>'), 'trou mis en évidence');
  ok(html.includes('<code>[À COMPLÉTER]</code>'), 'un repère dans du code reste du code');
  fs.writeFileSync(draft, 'Bonjour,\n\nDate : jeudi 22 octobre.\n');
  html = await (await fetch(`${t.url}/downloads/Demo/doc/mail`)).text();
  ok(html.includes('jeudi 22 octobre') && !html.includes('<mark class="draft-gap">'), 'la correction du fichier apparaît à la requête suivante');
  fs.rmSync(draft);
  ok((await fetch(`${t.url}/downloads/Demo/doc/mail`)).status === 404, 'source absente → 404 propre, jamais 500');
} finally { t.srv.closeAllConnections(); t.srv.close(); fs.rmSync(TMP, { recursive: true, force: true }); }

console.log(`\n${pass} OK, ${fail} KO`);
process.exitCode = fail ? 1 : 0;
