// Requirement (2026-10-31): « versionSlot reconnaît versionName = "x.y.z" dans un
// build.gradle.kts et la livraison incrémente versionCode = N de 1 en même temps ».
// Prod defect of 2026-10-30 (BookHaven, zone « android », versionFiles =
// android/app/build.gradle.kts): the program delivery left the gradle file
// untouched and the run had to be handed to the model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releasePlan, deliverRelease } from './code-delivery.mjs';
import { readVersion } from './pipeline-engine.mjs';

let fail = 0;
const ok = (c, l, d) => { if (!c) fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${!c && d ? `\n      ${String(d).slice(0, 600)}` : ''}`); };

// Real excerpt of BookHaven android/app/build.gradle.kts (versionCode before versionName).
const REAL = [
  'android {',
  '    namespace = "com.example.bookhaven"',
  '    defaultConfig {',
  '        applicationId = "com.example.bookhaven"',
  '        minSdk = 26',
  '        versionCode = 144',
  '        versionName = "2.0.11"',
  '    }',
  '    compileOptions {',
  '        sourceCompatibility = JavaVersion.VERSION_17',
  '    }',
  '}',
  '',
].join('\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradlever-'));
try {
  fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
  const gradle = path.join(dir, 'android', 'app', 'build.gradle.kts');
  fs.writeFileSync(gradle, REAL);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
  const cfg = { versionFiles: ['android/app/build.gradle.kts'], changelog: 'CHANGELOG.md' };

  const plan = releasePlan(dir, cfg);
  ok(plan.ok === true, 'releasePlan recognises versionName in build.gradle.kts', plan.why);

  const r = deliverRelease(dir, cfg, { bump: 'patch', changelog: '### Fixed\n- x\n', requirement: '' }, { date: '2026-10-31' });
  const after = fs.readFileSync(gradle, 'utf8');
  ok(/versionName = "2\.0\.12"/.test(after), 'versionName goes 2.0.11 → 2.0.12', after);
  ok(/versionCode = 145\b/.test(after), 'versionCode goes 144 → 145 in the same delivery', after);
  ok(readVersion('android/app/build.gradle.kts', after) === '2.0.12', 'the engine reads the bumped version', JSON.stringify(r));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
