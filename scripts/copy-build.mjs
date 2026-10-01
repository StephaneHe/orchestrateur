#!/usr/bin/env node
/**
 * copy-build.mjs — chef post-build hook
 *
 * Copies the latest debug APK from a project's build output into
 * I:\orchestrateur\builds\<project>\ so the Orchestre Android app
 * can download it via SFTP.
 *
 * Usage:
 *   node copy-build.mjs <projectName>
 *
 * APK search paths (tried in order):
 *   I:\Dev\<project>\android\app\build\outputs\apk\debug\*.apk   (projects with android/ subdir, e.g. BookHaven)
 *   I:\Dev\<project>\android\app\build\outputs\apk\release\*.apk
 *   I:\Dev\<project>\app\build\outputs\apk\debug\*.apk            (standard Android projects)
 *   I:\Dev\<project>\app\build\outputs\apk\release\*.apk
 *   I:\orchestrateur\android\app\build\outputs\apk\debug\*.apk   (special: orchestrateur app)
 *   I:\orchestrateur\android\app\build\outputs\apk\release\*.apk
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILDS_ROOT = path.join(__dirname, '..', 'builds');

const project = process.argv[2];
if (!project) {
  console.error('Usage: node copy-build.mjs <projectName>');
  process.exit(1);
}

// Search paths for APK
const searchPaths = project === 'orchestrateur'
  ? [
    path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug'),
    path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'release'),
  ]
  : [
    path.join('I:\\Dev', project, 'android', 'app', 'build', 'outputs', 'apk', 'debug'),
    path.join('I:\\Dev', project, 'android', 'app', 'build', 'outputs', 'apk', 'release'),
    path.join('I:\\Dev', project, 'app', 'build', 'outputs', 'apk', 'debug'),
    path.join('I:\\Dev', project, 'app', 'build', 'outputs', 'apk', 'release'),
  ];

function findLatestApk(dir) {
  if (!fs.existsSync(dir)) return null;
  const apks = fs.readdirSync(dir)
    .filter(f => f.endsWith('.apk'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return apks.length ? path.join(dir, apks[0].name) : null;
}

let apkSrc = null;
for (const dir of searchPaths) {
  apkSrc = findLatestApk(dir);
  if (apkSrc) break;
}

if (!apkSrc) {
  console.error(`[copy-build] No APK found for project "${project}" in:\n` +
    searchPaths.map(p => `  ${p}`).join('\n'));
  process.exit(1);
}

const destDir = path.join(BUILDS_ROOT, project);
fs.mkdirSync(destDir, { recursive: true });

// Destination: timestamped copy + latest.apk symlink/copy
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destVersioned = path.join(destDir, `${stamp}.apk`);
const destLatest = path.join(destDir, 'latest.apk');

fs.copyFileSync(apkSrc, destVersioned);
fs.copyFileSync(apkSrc, destLatest);

const sizeMB = (fs.statSync(apkSrc).size / (1024 * 1024)).toFixed(1);
console.log(`[copy-build] ${project}: ${path.basename(apkSrc)} (${sizeMB} MB)`);
console.log(`  → ${destVersioned}`);
console.log(`  → ${destLatest} (latest)`);
