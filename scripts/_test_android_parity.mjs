#!/usr/bin/env node
// User requirement (2026-10-20): « Fais une nouvelle application android
// Orchestrateur, qui prend en compte toutes les fonctionalites » — the Android
// app (android/, 1.0.0) must keep parity with the web dashboard.
//
// Static check of docs/ANDROID-PARITY.md against the code, no Gradle needed:
//  1. every feature row has a status (oui | partiel | non applicable) and a
//     reason when it is not « oui »;
//  2. every « Où » reference (path#Symbol) exists in the app sources;
//  3. every « Test » reference (jvm:Class#method) exists in the JVM tests;
//  4. every dashboard script of public/ is covered by at least one row;
//  5. every /api route of the server is called by the app, or listed in the
//     « Routes sans écran » table with a reason;
//  6. every section of ui/more/Sections.kt is named in the document;
//  7. the app is a major version (>= 1.0.0) with an integer versionCode.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ORCH_PARITY_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'ANDROID-PARITY.md');
const MAIN = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'orchestrateur');
const TEST = path.join(ROOT, 'android', 'app', 'src', 'test', 'java', 'com', 'orchestrateur');

let ok = 0, ko = 0;
const t = (name, cond, extra = '') => { if (cond) ok++; else { ko++; console.log(`  KO  ${name}${extra ? ` — ${extra}` : ''}`); } };

const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const kt = walk(MAIN).filter(f => f.endsWith('.kt'));
const ktText = new Map(kt.map(f => [f, fs.readFileSync(f, 'utf8')]));
const allKt = [...ktText.values()].join('\n');
const tests = walk(TEST).filter(f => f.endsWith('.kt'));

if (!fs.existsSync(DOC)) { console.log('  KO  docs/ANDROID-PARITY.md absent'); process.exit(1); }
const doc = fs.readFileSync(DOC, 'utf8');

// ---- tables -----------------------------------------------------------------
function table(afterHeading) {
  const i = doc.indexOf(afterHeading);
  if (i < 0) return [];
  const lines = doc.slice(i).split('\n').slice(1);
  const rows = [];
  let started = false;
  for (const l of lines) {
    if (/^\s*\|/.test(l)) { started = true; rows.push(l); continue; }
    if (started) break;
    if (/^#{1,3} /.test(l)) break;
  }
  const cells = rows.map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  return cells.slice(2); // header + separator
}
const features = table('## Fonctionnalités');
const routesNoScreen = table('## Routes sans écran');
t('table des fonctionnalités présente et fournie', features.length >= 40, `${features.length} lignes`);

const STATUS = new Set(['oui', 'partiel', 'non applicable']);
const refs = (cell) => (cell.match(/`([^`]+)`/g) || []).map(s => s.slice(1, -1));
const sources = new Set();
for (const [num, feat, src, status, where, test, note = ''] of features) {
  const label = `n° ${num} « ${feat} »`;
  t(`${label} : statut connu`, STATUS.has(status), status);
  if (status !== 'oui') t(`${label} : raison donnée pour « ${status} »`, note.replace(/[—-]/g, '').trim().length >= 10);
  refs(src).forEach(s => sources.add(s));
  if (status === 'non applicable') continue;
  const w = refs(where);
  t(`${label} : au moins un écran référencé`, w.length > 0);
  for (const r of w) {
    const [file, sym] = r.split('#');
    const f = path.join(MAIN, ...file.split('/'));
    const exists = fs.existsSync(f);
    t(`${label} : fichier ${file}`, exists);
    if (exists && sym) {
      const re = new RegExp(`(fun|class|object|enum class|val|var)\\s+(<[^>]+>\\s*)?([\\w.]+\\.)?${sym}\\b|^\\s*${sym}\\(`, 'm');
      t(`${label} : symbole ${sym} dans ${file}`, re.test(fs.readFileSync(f, 'utf8')));
    }
  }
  for (const r of refs(test).filter(x => x.startsWith('jvm:'))) {
    const [cls, method] = r.slice(4).split('#');
    const f = tests.find(x => path.basename(x) === `${cls}.kt`);
    t(`${label} : test ${cls}`, !!f);
    if (f && method) t(`${label} : test ${cls}#${method}`, new RegExp(`fun\\s+\`?${method}\\b`).test(fs.readFileSync(f, 'utf8')));
  }
}

// ---- 4. every dashboard script is covered -----------------------------------
// Libraries without a feature of their own (fonts, vendor) are not scripts of public/.
const scripts = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js'));
for (const s of scripts) t(`script public/${s} couvert par au moins une ligne`, sources.has(s) || sources.has(`public/${s}`));

// ---- 5. every /api route used by the app or listed with a reason -------------
const serverFiles = [path.join(ROOT, 'server.js'), ...walk(path.join(ROOT, 'scripts')).filter(f => /\.mjs$/.test(f) && !/_test_|_regression/.test(path.basename(f)))];
const routes = new Set();
for (const f of serverFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*['"`](\/api\/[^'"`]+)['"`]/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
}
const listed = new Map(routesNoScreen.map(([r, why = '']) => [r.replace(/`/g, ''), why]));
const SKIP = /^(GET|POST) \/api\/llm-gateway\//; // internal gateway of codex runs (scripts/responses-gateway.mjs)
for (const r of routes) {
  if (SKIP.test(r)) continue;
  const p = r.split(' ')[1];
  const pieces = p.split(/\/:[\w]+/).filter(Boolean).map(x => x.replace(/\/$/, ''));
  const used = [...ktText.values()].some(src => pieces.every(x => src.includes(x)));
  if (used) { ok++; continue; }
  const why = listed.get(r);
  t(`route ${r} : appelée par l'app ou listée dans « Routes sans écran » avec sa raison`, why !== undefined && why.trim().length >= 10);
}
for (const r of listed.keys()) t(`route listée ${r} : existe encore côté serveur`, routes.has(r));

// ---- 6. every app section is in the document --------------------------------
const sections = fs.readFileSync(path.join(MAIN, 'ui', 'more', 'Sections.kt'), 'utf8');
for (const m of sections.matchAll(/^\s+([A-Z_]+)\("([\w-]+)",/gm)) t(`section ${m[1]} (« ${m[2]} ») nommée dans le document`, doc.includes(`\`${m[2]}\``));

// ---- 7. major version --------------------------------------------------------
const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle.kts'), 'utf8');
const vn = gradle.match(/versionName\s*=\s*"(\d+)\.(\d+)\.(\d+)"/);
const vc = gradle.match(/versionCode\s*=\s*(\d+)/);
t('versionName semver >= 1.0.0', vn && Number(vn[1]) >= 1, vn?.[0]);
t('versionCode entier', !!vc);
t('applicationId inchangé (com.orchestrateur)', /applicationId\s*=\s*"com\.orchestrateur"/.test(gradle));
t('document à jour de la version de l’app', vn && doc.includes(`${vn[1]}.${vn[2]}.${vn[3]}`), 'la version de l’app doit figurer dans docs/ANDROID-PARITY.md');

console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
