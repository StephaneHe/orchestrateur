#!/usr/bin/env node
// ============================================================================
// scripts/_test_downloads_register.mjs — an Android app gets its /downloads card
// ============================================================================
//
// User requirement (2026-10-31, PitchRoll: APK published, /downloads/PitchRoll/apk
// 404 because downloads.json had no entry): « Quand new-project.mjs crée un
// projet Android, il doit ajouter lui-même son entrée dans downloads.json, pour
// que cela ne se reproduise pas. »
//
// Real cause replayed: the project is created empty (no app module), the
// module comes later, then copy-build.mjs publishes the APK. The entry must
// exist after that publication, and new-project.mjs adds it at once when the
// module already exists. Everything runs in temporary roots
// (DISPATCH_ROOT_FOR_TESTS, ORCH_DEV_ROOT_FOR_TESTS): the real downloads.json,
// builds/ and config.json are only read.
//
//   node scripts/_test_downloads_register.mjs
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerDownloadApp, androidAppGradle } from './downloads-register.mjs';
import { createDownloadsRegistry, validateRegistry } from './downloads-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) console.log(`  ok  ${msg}`); else { fails++; console.log(`  KO  ${msg}`); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-register-'));
const ROOT = path.join(TMP, 'orch');
const DEV = path.join(TMP, 'dev');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(DEV, { recursive: true });
const realDownloads = fs.readFileSync(path.join(REPO, 'downloads.json'), 'utf8');
const DL = path.join(ROOT, 'downloads.json');
const resetDownloads = () => fs.writeFileSync(DL, realDownloads.replace(/\n\s*\{ "name": "PitchRoll"[^\n]*\n/, '\n').replace(/\},(\n\s*\])/, '}$1'));
const apps = () => JSON.parse(fs.readFileSync(DL, 'utf8')).apps;

const APP_PLUGIN = 'plugins {\n    alias(libs.plugins.android.application)\n}\n';
function androidModule(dir, gradle) {
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'build.gradle.kts'), APP_PLUGIN + gradle);
}

try {
  console.log('1. the repository registry has PitchRoll, valid, version readable');
  {
    const raw = JSON.parse(realDownloads);
    const e = raw.apps.find(a => a.name === 'PitchRoll');
    ok(!!e, 'downloads.json has a PitchRoll entry');
    ok(!validateRegistry(raw).errors, 'downloads.json passes the registry validation');
    ok(e && /PitchRoll[\\/](app[\\/]build\.gradle\.kts|package\.json)$/.test(e.version.file), `version source in PitchRoll (${e && e.version.file})`);
    if (e && fs.existsSync(e.version.file)) {
      const card = createDownloadsRegistry({ file: path.join(REPO, 'downloads.json'), buildsDir: path.join(TMP, 'none') }).entries().find(x => x.name === 'PitchRoll');
      ok(card && /^\d+\.\d+\.\d+/.test(card.version), `real PitchRoll version read: ${card && card.version}`);
    }
  }

  console.log('2. fresh project (no app module yet): nothing written');
  resetDownloads();
  {
    const P = path.join(DEV, 'Fresh');
    fs.mkdirSync(P);
    fs.writeFileSync(path.join(P, 'README.md'), '# Fresh\n');
    const before = fs.readFileSync(DL, 'utf8');
    ok(registerDownloadApp(ROOT, { name: 'Fresh', dir: P }).status === 'not-android', 'status not-android');
    ok(fs.readFileSync(DL, 'utf8') === before, 'downloads.json unchanged');
  }

  console.log('3. PitchRoll replay: module added later, APK published by copy-build.mjs ⇒ entry added');
  resetDownloads();
  {
    const P = path.join(DEV, 'PitchRoll');
    fs.mkdirSync(P);
    fs.writeFileSync(path.join(P, 'package.json'), '{\n  "name": "pitchroll",\n  "version": "1.1.0"\n}\n');
    androidModule(P, 'val appVersionName: String = run { rootProject.file("package.json").readText() }\nandroid { defaultConfig { versionCode = 1\n versionName = appVersionName } }\n');
    const apkDir = path.join(P, 'app', 'build', 'outputs', 'apk', 'debug');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), 'fake apk');
    const before = apps();
    const r = spawnSync(process.execPath, [path.join(__dirname, 'copy-build.mjs'), 'PitchRoll'],
      { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: ROOT, ORCH_DEV_ROOT_FOR_TESTS: DEV }, encoding: 'utf8', windowsHide: true });
    ok(r.status === 0, `copy-build exit 0 (${r.status}) ${r.stderr.slice(-300)}`);
    ok(fs.existsSync(path.join(ROOT, 'builds', 'PitchRoll', 'latest.apk')), 'builds/PitchRoll/latest.apk written in the test root');
    const after = apps();
    const e = after.find(a => a.name === 'PitchRoll');
    ok(!!e, 'downloads.json now has PitchRoll');
    ok(after.length === before.length + 1 && JSON.stringify(after.slice(0, -1)) === JSON.stringify(before), 'other entries untouched, order kept');
    ok(e && e.version.file === path.join(P, 'package.json'), 'versionName read from package.json ⇒ source = package.json');
    const reg = createDownloadsRegistry({ file: DL, buildsDir: path.join(ROOT, 'builds') });
    const card = reg.entries().find(x => x.name === 'PitchRoll');
    ok(card && card.version === '1.1.0' && card.apkAvailable, `card served: version ${card && card.version}, APK available`);
    const again = fs.readFileSync(DL, 'utf8');
    spawnSync(process.execPath, [path.join(__dirname, 'copy-build.mjs'), 'PitchRoll'],
      { env: { ...process.env, DISPATCH_ROOT_FOR_TESTS: ROOT, ORCH_DEV_ROOT_FOR_TESTS: DEV }, encoding: 'utf8', windowsHide: true });
    ok(fs.readFileSync(DL, 'utf8') === again, 'second publication: downloads.json unchanged (idempotent)');
  }

  console.log('4. literal versionName ⇒ source = the app module gradle file');
  resetDownloads();
  {
    const P = path.join(DEV, 'Literal');
    androidModule(P, 'android { defaultConfig { versionCode = 3\n versionName = "2.0.1" } }\n');
    const r = registerDownloadApp(ROOT, { name: 'Literal', dir: P });
    ok(r.status === 'added' && r.entry.version.file === androidAppGradle(P) && !r.entry.version.regex, 'gradle source, no regex');
    const card = createDownloadsRegistry({ file: DL, buildsDir: path.join(ROOT, 'builds') }).entries().find(x => x.name === 'Literal');
    ok(card && card.version === '2.0.1', `version read: ${card && card.version}`);
  }

  console.log('5. new-project.mjs on an existing Android project adds the entry');
  resetDownloads();
  {
    fs.cpSync(path.join(REPO, 'templates'), path.join(ROOT, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ conductor: 'chef', defaults: {}, projects: [] }, null, 2));
    const P = path.join(DEV, 'Existing');
    androidModule(P, 'android { defaultConfig { versionName = "0.3.0" } }\n');
    const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: ROOT };
    delete env.ORCH_CLAUDE_JSON;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'new-project.mjs'), 'Existing', '--path', P], { env, encoding: 'utf8', windowsHide: true });
    ok(/downloads\.json entry "Existing" — created/.test(r.stdout), 'new-project reports the downloads.json entry');
    ok(apps().some(a => a.name === 'Existing' && a.version.file === path.join(P, 'app', 'build.gradle.kts')), 'entry written with the module gradle file');
    ok(!validateRegistry(JSON.parse(fs.readFileSync(DL, 'utf8'))).errors, 'downloads.json still valid');
  }

  console.log('6. broken downloads.json is left alone');
  {
    fs.writeFileSync(DL, '{ broken');
    const P = path.join(DEV, 'Literal');
    ok(registerDownloadApp(ROOT, { name: 'Other', dir: P }).status === 'invalid', 'status invalid');
    ok(fs.readFileSync(DL, 'utf8') === '{ broken', 'file not rewritten');
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${n - fails}/${n} ok`);
process.exit(fails ? 1 : 0);
