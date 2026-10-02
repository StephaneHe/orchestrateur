#!/usr/bin/env node
// Recette workspace-trust.mjs / new-project.mjs / trust-projects.mjs (0.30.0).
// Tout se passe dans un dossier temporaire : faux ~/.claude.json, faux
// config.json, faux projets. Le vrai ~/.claude.json n'est jamais lu ni écrit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trustKey, trustStatus, trustWorkspace, forgetWorkspace, ensureProjectPermissions, STANDARD_TOOLS } from './workspace-trust.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ok  ${label}`); } else { fail++; console.log(`  KO  ${label}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-trust-'));
const cj = path.join(tmp, '.claude.json');
const projA = path.join(tmp, 'Dev', 'Alpha');
const projB = path.join(tmp, 'Dev', 'Beta');
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(path.join(projB, '.claude'), { recursive: true });
fs.writeFileSync(path.join(projB, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: ['PowerShell', 'Bash(git *)'], deny: ['Bash(rm *)'] }, env: { X: '1' } }, null, 2));

const keyA = trustKey(projA), keyB = trustKey(projB);
const backslashB = keyB.replace(/\//g, '\\');
const initial = {
  numStartups: 3, userID: 'u', oauthAccount: { a: 1 },
  projects: {
    [keyB]: { allowedTools: [], hasTrustDialogAccepted: false, lastCost: 1.5 },
    [backslashB]: { allowedTools: [], hasTrustDialogAccepted: false },
    'Z:/Other': { hasTrustDialogAccepted: false, keep: true },
  },
};
fs.writeFileSync(cj, JSON.stringify(initial, null, 2));

console.log('trustKey');
ok(trustKey('i:\\Dev\\X\\') === 'I:/Dev/X', 'lettre de lecteur en majuscule, slashs avant, sans slash final');

console.log('trustWorkspace');
const rA = trustWorkspace(projA, { file: cj });
ok(rA.changed && rA.touched.join() === keyA, 'entrée absente créée');
let j = JSON.parse(fs.readFileSync(cj, 'utf8'));
ok(j.projects[keyA].hasTrustDialogAccepted === true && Array.isArray(j.projects[keyA].allowedTools), 'nouvelle entrée de la forme du CLI');
const rB = trustWorkspace(projB, { file: cj });
j = JSON.parse(fs.readFileSync(cj, 'utf8'));
ok(rB.touched.length === 2 && j.projects[keyB].hasTrustDialogAccepted && j.projects[backslashB].hasTrustDialogAccepted, 'les deux formes de chemin');
ok(j.projects[keyB].lastCost === 1.5, 'autres champs de l’entrée conservés');
ok(j.projects['Z:/Other'].hasTrustDialogAccepted === false && j.projects['Z:/Other'].keep, 'autres projets intacts');
ok(j.numStartups === 3 && j.oauthAccount.a === 1, 'champs de premier niveau intacts');
ok(!fs.readFileSync(cj, 'utf8').endsWith('\n') && fs.readFileSync(cj, 'utf8').startsWith('{\n  "'), 'format du CLI (2 espaces, sans saut final)');
ok(fs.existsSync(cj + '.orchestrateur-bak') && JSON.parse(fs.readFileSync(cj + '.orchestrateur-bak', 'utf8')).projects[keyB].hasTrustDialogAccepted === false, 'sauvegarde avant écriture');
ok(trustWorkspace(projA, { file: cj }).changed === false, 'idempotent');
ok(trustStatus(projB, cj).trusted === true, 'trustStatus');
ok(fs.readdirSync(tmp).every(f => !f.endsWith('.tmp')), 'aucun fichier temporaire laissé');
const before = JSON.parse(fs.readFileSync(cj, 'utf8'));
const fB = forgetWorkspace(projB, { file: cj });
j = JSON.parse(fs.readFileSync(cj, 'utf8'));
ok(fB.touched.length === 2 && !j.projects[keyB] && !j.projects[backslashB], 'forgetWorkspace : les deux formes retirées');
ok(j.projects[keyA] && Object.keys(j.projects).length === Object.keys(before.projects).length - 2, 'forgetWorkspace : rien d’autre retiré');
trustWorkspace(projB, { file: cj });

console.log('ensureProjectPermissions');
const pA = ensureProjectPermissions(projA);
const sA = JSON.parse(fs.readFileSync(path.join(projA, '.claude', 'settings.json'), 'utf8'));
ok(STANDARD_TOOLS.split(',').every(t => sA.permissions.allow.includes(t)) && sA.permissions.allow.includes('PowerShell'), 'outils standard + PowerShell');
ok(ensureProjectPermissions(projA).added.length === 0 && pA.added.length === 9, 'idempotent');
ensureProjectPermissions(projB);
const sB = JSON.parse(fs.readFileSync(path.join(projB, '.claude', 'settings.json'), 'utf8'));
ok(sB.permissions.allow[0] === 'PowerShell' && sB.permissions.allow[1] === 'Bash(git *)' && sB.permissions.deny[0] === 'Bash(rm *)' && sB.env.X === '1', 'additif : rien retiré ni réordonné');
ok(sB.permissions.allow.filter(t => t === 'PowerShell').length === 1, 'pas de doublon');
fs.writeFileSync(path.join(projB, '.claude', 'settings.json'), '{ cassé');
let threw = false; try { ensureProjectPermissions(projB); } catch { threw = true; }
ok(threw && fs.readFileSync(path.join(projB, '.claude', 'settings.json'), 'utf8') === '{ cassé', 'settings illisible : refus, fichier non écrasé');

console.log('new-project.mjs + trust-projects.mjs (racine de test)');
const root = path.join(tmp, 'root');
fs.mkdirSync(root);
fs.cpSync(path.join(REPO, 'templates'), path.join(root, 'templates'), { recursive: true });
const projC = path.join(tmp, 'Dev', 'Gamma');
const projD = path.join(tmp, 'Dev', 'Delta');
fs.mkdirSync(projD, { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  conductor: 'chef', defaults: { allowedTools: STANDARD_TOOLS },
  projects: [{ name: 'Delta', path: projD }, { name: 'Ghost', path: path.join(tmp, 'nope') }],
}, null, 2));
const env = { ...process.env, DISPATCH_ROOT_FOR_TESTS: root, ORCH_CLAUDE_JSON: cj };
const np = spawnSync(process.execPath, [path.join(__dirname, 'new-project.mjs'), 'Gamma', '--path', projC], { env, encoding: 'utf8' });
ok(np.status === 0, `new-project exit 0 (${np.status})`);
ok(trustStatus(projC, cj).trusted, 'nouveau projet : workspace de confiance');
ok(JSON.parse(fs.readFileSync(path.join(projC, '.claude', 'settings.json'), 'utf8')).permissions.allow.includes('PowerShell'), 'nouveau projet : settings.json');
const envNoCj = { ...process.env, DISPATCH_ROOT_FOR_TESTS: root }; delete envNoCj.ORCH_CLAUDE_JSON;
const np2 = spawnSync(process.execPath, [path.join(__dirname, 'new-project.mjs'), 'Epsilon', '--path', path.join(tmp, 'Dev', 'Epsilon')], { env: envNoCj, encoding: 'utf8' });
ok(np2.status === 0 && /trust skipped/.test(np2.stdout), 'racine de test sans ORCH_CLAUDE_JSON : vrai ~/.claude.json jamais touché');

const dry = spawnSync(process.execPath, [path.join(__dirname, 'trust-projects.mjs'), 'Delta', '--dry-run', '--json'], { env, encoding: 'utf8' });
const dr = JSON.parse(dry.stdout).rows[0];
ok(dry.status === 0 && dr.trustedBefore === false && dr.trustedAfter === false && !trustStatus(projD, cj).trusted, '--dry-run n’écrit rien');
const run = spawnSync(process.execPath, [path.join(__dirname, 'trust-projects.mjs'), '--json'], { env, encoding: 'utf8' });
const rows = JSON.parse(run.stdout).rows;
ok(run.status === 0 && rows.find(r => r.name === 'Delta').trustedAfter && rows.find(r => r.name === 'Delta').missingAfter.length === 0, 'rétroactif : Delta de confiance et complet');
ok(rows.find(r => r.name === 'Ghost').skipped === 'path missing', 'chemin absent : ignoré');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} KO`);
process.exit(fail ? 1 : 0);
