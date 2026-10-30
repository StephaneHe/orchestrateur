#!/usr/bin/env node
// User request (2026-10-29): « Il faut que l'orchestrateur puisse afficher des
// images ou des videos. Web et mobile ». Android side (task 2 of 2): the thread
// is native Compose (no WebView), so the app must itself preview a cited image
// or video through the same GET /api/media route and the same token as the web.
// Static check, no Gradle: the pure logic lives in android/.../data/MediaLinks.kt;
// its behaviour is covered by the JVM test MediaLinksTest (testDebugUnitTest).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}`); };
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

const kt = read('android/app/src/main/java/com/orchestrateur/data/MediaLinks.kt');
const srv = read(['server', 'js'].join('.'));

ok(kt.includes('object MediaLinks'), 'app has a MediaLinks object');
ok(kt.includes('/api/media?path='), 'app builds the same /api/media?path= route as the web');
ok(kt.includes('&token=') && /fun\s+token\(\)/.test(read('android/app/src/main/java/com/orchestrateur/data/Api.kt')), 'app passes the store token in the query (&token=) from Api.token()');
ok(fs.existsSync(path.join(ROOT, 'android/app/src/test/java/com/orchestrateur/data/MediaLinksTest.kt')), 'JVM test MediaLinksTest exists');

// Same extensions as the server route: every one must be recognised.
const serverExt = [...(srv.match(/const MEDIA_TYPES = \{([^}]*)\}/s)?.[1] || '').matchAll(/'\.(\w+)'/g)].map(m => m[1]).sort();
ok(serverExt.length > 0 && serverExt.every(e => kt.includes(`"${e}"`)), `app recognises every server media extension (${serverExt.join(',')})`);
ok(/fun\s+kindOf/.test(kt) && /fun\s+url/.test(kt), 'MediaLinks exposes kindOf() and url()');

// Review finding: reports cite media in bullets / numbered lists (« - capture : `x.png` »),
// the web thread previews them there too, so the Bullet and Ordered branches must preview.
const md = read('android/app/src/main/java/com/orchestrateur/ui/fleet/Markdown.kt');
const branch = (head, next) => {
  const a = md.indexOf(head);
  const b = md.indexOf(next, a + head.length);
  return a < 0 || b < 0 ? '' : md.slice(a, b);
};
ok(/MediaLinks\.cited\(b\.text\)/.test(branch('is MdBlock.Bullet', 'is MdBlock.Ordered')), 'bullet items preview a cited image/video');
ok(/MediaLinks\.cited\(b\.text\)/.test(branch('is MdBlock.Ordered', 'is MdBlock.Quote')), 'numbered items preview a cited image/video');

// Review finding: a missing or refused video must keep the plain link (like an image
// whose onError shows nothing), so the video link is only shown once the file is
// confirmed available through a HEAD probe off the main thread.
ok(/fun\s+available\(/.test(kt) && /"HEAD"/.test(kt), 'MediaLinks.available() probes the media URL with HEAD');
const prev = md.slice(md.indexOf('private fun MediaPreview'));
ok(/MediaLinks\.available\(/.test(prev) && /Dispatchers\.IO/.test(prev), 'video preview checks availability off the main thread before showing the player link');

// Item 4: only a cited path whose extension is a known image/video is kept as media
// (with its kind); another type or no extension stays a plain link without preview.
const flat = kt.replace(/\s+/g, ' ');
ok(/in IMAGES -> MediaKind\.IMAGE/.test(flat) && /in VIDEOS -> MediaKind\.VIDEO/.test(flat) && /else -> null/.test(flat), 'kindOf() maps a known extension to IMAGE / VIDEO and anything else to null');
ok(/substringAfterLast\('\.', ""\)/.test(kt) && /\.filter \{ kindOf\(it\) != null \}/.test(flat), 'a path without extension is not media, and cited() keeps only paths with a media kind');

console.log(`\n${pass} ok, ${fail} ko`);
process.exit(fail ? 1 : 0);
