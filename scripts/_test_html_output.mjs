#!/usr/bin/env node
// HTML output of the models, rendered safely (0.105.0).
// User request (2026-10-16): « il faut qu'elles soient au format html (et que
// le client web soit capables de les afficher correctemetn) ».
//
// Checks the real client code: public/html-render.js (detection, allowlist
// sanitizer, plain text), the real mdToHtml of public/app.js (HTML → sanitized,
// legacy Markdown → unchanged path), tts.js (tags never read aloud) and the
// journal summaries of turn-core.js (client and server paths).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };

// A fresh context per load: the server imports turn-core.js without html-render.js.
function load(files) {
  const ctx = vm.createContext({ console });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}
const ctx = load(['public/html-render.js', 'public/turn-core.js', 'public/tts.js']);
const H = ctx.HtmlRender;

// The real mdToHtml (and esc) of app.js, without the rest of the client.
function extract(src, start) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`${start} introuvable dans app.js`);
  const end = src.indexOf('\n}\n', i);
  return src.slice(i, end + 2);
}
const app = read('public/app.js');
const escLine = app.split('\n').find((l) => l.startsWith('const esc = '));
vm.runInContext(`${escLine}\n${extract(app, 'function mdToHtml(')}\nglobalThis.mdToHtml = mdToHtml;`, ctx);
const md = ctx.mdToHtml;

// Every element the sanitizer emits, with its attributes, for structural checks.
const tags = (html) => [...html.matchAll(/<([a-z0-9]+)([^>]*)>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] }));
function noDanger(html, label) {
  const t = tags(html);
  const bad = t.filter((x) => ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'img', 'form', 'input', 'link', 'meta', 'base', 'template', 'frame', 'video', 'audio', 'source'].includes(x.tag));
  // Attribute names only: an escaped value may legitimately mention « onerror= ».
  const names = (x) => x.attrs.replace(/"[^"]*"/g, '""');
  const onAttr = t.filter((x) => /\son[a-z]+\s*=/i.test(names(x)));
  const styleAttr = t.filter((x) => /\sstyle\s*=/i.test(names(x)));
  const badHref = t.filter((x) => /\s(?:href|src|action|formaction|xlink:href)\s*=\s*"(?!https?:\/\/|mailto:|\/(?!\/)|#)/i.test(x.attrs));
  ok(!bad.length && !onAttr.length && !styleAttr.length && !badHref.length,
    `${label} : aucune balise, aucun attribut on*/style, aucun lien dangereux${bad.length || onAttr.length || styleAttr.length || badHref.length ? ` — ${html}` : ''}`);
}

console.log('1. Détection HTML / Markdown');
ok(H.isHtml('<p>Bonjour</p>'), 'un paragraphe HTML');
ok(H.isHtml('<h2>Bilan</h2>\n<ul><li>un</li><li>deux</li></ul>'), 'titre + liste');
ok(H.isHtml('Voici le point :\n<p>un</p>\n<p>deux</p>'), 'texte puis deux blocs');
ok(H.isHtml('<!doctype html><html><body><p>x</p></body></html>'), 'document complet');
ok(!H.isHtml('## Bilan\n\n- **un**\n- deux'), 'Markdown');
ok(!H.isHtml('Le test `<div>` a échoué, voir ```html\n<p>x</p>\n<p>y</p>\n```'), 'Markdown qui cite du HTML en code');
ok(!H.isHtml('si a < b et c > d alors rien'), 'texte avec < et >');
ok(!H.isHtml('NEEDS_USER_INPUT: on publie ?'), 'texte simple');
ok(!H.isHtml('') && !H.isHtml(null), 'vide');

console.log('2. Rendu correct d\'un fragment HTML');
const answer = '<h2>Résumé</h2>\n<p>J\'ai <strong>corrigé</strong> le bug &amp; ajouté <code>x &lt; y</code>.</p>\n'
  + '<ul><li>un</li><li>deux <em>ok</em></li></ul>\n<ol start="3"><li>trois</li></ol>\n'
  + '<table><thead><tr><th scope="col">Suite</th><th>État</th></tr></thead><tbody><tr><td colspan="2">verte</td></tr></tbody></table>\n'
  + '<pre><code class="language-js">if (a &lt; b) {\n  run();\n}</code></pre>\n'
  + '<blockquote>cité</blockquote><details open><summary>Détails</summary><p>caché</p></details>\n'
  + '<p>Voir <a href="https://example.org/doc" title="doc">la doc</a> et <a href="#s2">plus bas</a>.</p>\n'
  + 'NEEDS_USER_INPUT: on publie ?';
const out = H.sanitize(answer);
ok(out.includes('<h2>Résumé</h2>'), 'titre gardé');
ok(out.includes('<strong>corrigé</strong>') && out.includes('&amp; ajouté') && out.includes('<code>x &lt; y</code>'), 'emphase, entités et code en ligne gardés');
ok(out.includes('<ul><li>un</li><li>deux <em>ok</em></li></ul>') && out.includes('<ol start="3">'), 'listes gardées');
ok(out.includes('<th scope="col">Suite</th>') && out.includes('<td colspan="2">verte</td>'), 'tableau gardé');
ok(out.includes('<pre><code class="language-js">if (a &lt; b) {\n  run();\n}</code></pre>'), 'bloc de code gardé avec ses retours à la ligne');
ok(out.includes('<blockquote>cité</blockquote>') && out.includes('<details open><summary>Détails</summary>'), 'citation, détails gardés');
ok(out.includes('<a href="https://example.org/doc" target="_blank" rel="noopener noreferrer" title="doc">la doc</a>'), 'lien https : nouvel onglet, noopener');
ok(out.includes('<a href="#s2" target="_blank" rel="noopener noreferrer">plus bas</a>'), 'ancre gardée');
ok(/NEEDS_USER_INPUT: on publie \?$/.test(out), 'ligne de question finale gardée');
ok(H.sanitize('<p>a<br>b<br/>c</p>') === '<p>a<br>b<br>c</p>', 'retours à la ligne <br>');
ok(H.sanitize('<P CLASS="x">Maj</P>') === '<p>Maj</p>', 'balises en majuscules, class retirée');

console.log('3. Injection refusée');
const attacks = {
  'script': '<p>a</p><script>window.__xss=1</script><p>b</p>',
  'script non fermé': '<p>a</p><script>window.__xss=1',
  'img onerror': '<p>x</p><img src=x onerror="window.__xss=1">',
  'attribut on* sur balise permise': '<p onclick="window.__xss=1" onmouseover=alert(1)>clic</p>',
  'javascript: dans un lien': '<a href="javascript:window.__xss=1">l</a>',
  'javascript: en majuscules et espaces': '<a href="  JaVaScRiPt:alert(1)">l</a>',
  'javascript: avec entités': '<a href="jav&#x61;script&colon;alert(1)">l</a><a href="&#106;avascript:alert(1)">m</a>',
  'javascript: coupé par tabulation': '<a href="java\tscript:alert(1)">l</a><a href="java&#9;script:alert(1)">m</a>',
  'data: et vbscript:': '<a href="data:text/html,<script>alert(1)</script>">d</a><a href="vbscript:msgbox(1)">v</a>',
  'lien protocole relatif': '<a href="//evil.example/x">p</a>',
  'style': '<style>body{display:none}</style><p style="position:fixed;top:0">x</p>',
  'iframe': '<iframe src="https://evil.example"></iframe><p>ok</p>',
  'svg onload': '<svg onload="window.__xss=1"><circle r=1></circle></svg><p>ok</p>',
  'math et template': '<math><mi xlink:href="javascript:alert(1)">x</mi></math><template><img src=x onerror=alert(1)></template>',
  'object et embed': '<object data="x.swf"></object><embed src="x.swf">',
  'formulaire': '<form action="https://evil.example"><input name=a><button formaction="javascript:alert(1)">go</button></form>',
  'meta et base': '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">',
  'commentaire conditionnel': '<!--[if IE]><script>alert(1)</script><![endif]--><p>ok</p>',
  'attribut non fermé': '<p title="x" onclick=alert(1)//>y</p>',
  'balise dans un attribut': '<p title="<img src=x onerror=alert(1)>">t</p>',
};
for (const [label, a] of Object.entries(attacks)) noDanger(H.sanitize(a), label);
ok(!H.sanitize(attacks['script']).includes('__xss') && !H.sanitize(attacks['script non fermé']).includes('__xss'), 'le contenu du script disparaît (rien n\'est affiché)');
ok(H.sanitize(attacks['iframe']) === '<p>ok</p>', 'iframe retirée, le reste gardé');
ok(H.sanitize('<p title="<img src=x onerror=alert(1)>">t</p>') === '<p title="&lt;img src=x onerror=alert(1)&gt;">t</p>', 'attribut permis échappé');
ok(H.safeHref('javascript:alert(1)') === null && H.safeHref('https://a.b') === 'https://a.b' && H.safeHref('/api/x') === '/api/x', 'safeHref');

console.log('4. Le fragment ne sort jamais de sa bulle');
const breakout = H.sanitize('<p>a</div></div></section><div>b');
ok(breakout === '<p>a<div>b</div></p>', `fermetures parasites ignorées, ouvertures refermées : ${breakout}`);
ok(H.sanitize('<ul><li>un<li>deux</ul>') === '<ul><li>un<li>deux</li></li></ul>', 'imbrication refermée');
ok(H.sanitize('a < b et <notatag> c') === 'a &lt; b et  c', 'balise inconnue retirée, « < » échappé');

console.log('5. mdToHtml (app.js) : HTML assaini, anciennes sorties inchangées');
ok(md('<p>Bonjour <strong>toi</strong></p>') === '<p>Bonjour <strong>toi</strong></p>', 'HTML rendu');
noDanger(md('<p>a</p><script>window.__xss=1</script><img src=x onerror=alert(1)>'), 'mdToHtml + injection');
const legacy = md('## Bilan\n\n- **un**\n- `deux`\n\n[doc](https://example.org) et [x](javascript:alert(1))');
ok(legacy.includes('<h2>Bilan</h2>') && legacy.includes('<li><strong>un</strong></li>') && legacy.includes('<code>deux</code>'), 'Markdown ancien toujours rendu');
ok(legacy.includes('href="https://example.org"') && !legacy.includes('javascript:'), 'lien Markdown dangereux toujours neutralisé');
ok(md('a < b, <b>gras</b> isolé') === '<p>a &lt; b, &lt;b&gt;gras&lt;/b&gt; isolé</p>', 'texte simple : rien n\'est interprété');
ok(md('<p>du HTML tapé</p><p>par l\'utilisateur</p>', { html: false }).includes('&lt;p&gt;'), 'demande de l\'utilisateur : jamais interprétée comme HTML');
const cl = md('## [1.2.0] - 2026-10-16\n\n### Added\n\n- (server) rendu HTML');
ok(cl.includes('<h3>Added</h3>') && cl.includes('<li>(server) rendu HTML</li>'), 'CHANGELOG (panneau Release) inchangé');

console.log('6. Texte brut : lecture audio et résumés du journal');
const plain = H.toPlain(answer);
ok(!/<[a-z\/]/i.test(plain), `aucune balise : ${JSON.stringify(plain.slice(0, 120))}`);
ok(plain.includes('## Résumé') && plain.includes('- un') && plain.includes('| Suite | État |') && plain.includes('```'), 'titres, puces, tableau, bloc de code gardés en Markdown');
ok(!H.toPlain('<p>a</p><script>secret()</script><style>x{}</style>').includes('secret'), 'script jamais lu');
const spoken = ctx.Tts.toSpeech('<h2>Bilan</h2><p>J\'ai <strong>corrigé</strong> le bug.</p><pre><code>const s = 1;</code></pre>');
ok(spoken === 'Bilan. J\'ai corrigé le bug. (bloc de code).', `lecture audio sans balise : « ${spoken} »`);
const sum = ctx.TurnCore.summarizeResult('<h2>Bilan</h2>\n<p>Suite <strong>verte</strong> &amp; livrée.</p>\n<ul><li>commit 5bf1dde</li></ul>');
ok(sum[0] === 'Bilan' && sum[1] === 'Suite verte & livrée.' && sum[2] === 'commit 5bf1dde', `résumé du journal (client) : ${JSON.stringify(sum)}`);
const srv = load(['public/turn-core.js']);
const sum2 = srv.TurnCore.summarizeResult('<h2>Bilan</h2>\n<p>Suite <strong>verte</strong> &amp; livrée.</p><script>x()</script>\n<ul><li>commit 5bf1dde</li></ul>');
ok(sum2[0] === 'Bilan' && sum2[1] === 'Suite verte & livrée.' && sum2[2] === 'commit 5bf1dde', `résumé du journal (serveur, sans html-render.js) : ${JSON.stringify(sum2)}`);
ok(srv.TurnCore.summarizeResult('**Bilan** : a < b')[0] === 'Bilan : a < b', 'résumé Markdown inchangé');

console.log('7. Chargé par la page');
const index = read('public/index.html');
const at = (f) => index.indexOf(`src="./${f}`);
ok(at('html-render.js') > 0 && at('html-render.js') < at('tts.js') && at('html-render.js') < at('turn-core.js') && at('html-render.js') < at('app.js'), 'html-render.js chargé avant turn-core.js, tts.js et app.js');

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
