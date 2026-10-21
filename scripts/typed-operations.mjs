// ============================================================================
// scripts/typed-operations.mjs — the registry of typed operations
// ============================================================================
//
// Pipelines redesign, phase 1 (docs/PIPELINES-SYNTHESE.md §3.3, user decisions
// of 2026-10-20 « tout comme recommandé », decisions 4 and 5). ONE registry,
// written once: the `operations` pipeline uses it now, and the typed actions of
// the chef (Routage v3, phase 2, ROUTAGE-SYNTHESE §3.2) add their entries here
// instead of keeping a second list.
//
// An operation is { id, label, irreversible, params, prepare, verify }:
//   prepare(ctx, params) → { ok, why?, argv?, already?, expect?, detail? }
//     reads only (preconditions); builds the argv ARRAY (never a shell string).
//     `already: true` = the effect is already there (idempotent: nothing run).
//   verify(ctx, params, expect) → { ok, observed, why? }
//     the POSTCONDITION, re-read after the command. A return code alone is
//     never « done » (§3.3: `git ls-remote`, installed versionCode, URL…).
// ctx: { cwd, root, project, cfg (.orchestrateur/pipeline.json), config
//        (config.json), env, exec, bins, backupDir, startedAt }
//
// Rules kept by the code, whatever a model wrote:
//   - argv only, `shell: false`; parameters validated against closed patterns;
//   - `prod_jump` only ever builds the PLAN (`--apply` never appears: a jump of
//     the production is applied by the user's decision only, never by a
//     musician — decision 5);
//   - `service_restart` and `run_script` run only what the project declared in
//     its versioned .orchestrateur/pipeline.json (`operations.services`,
//     `operations.scripts`), and a script must declare a check.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

export const MAX_OPERATIONS = 6;
const REF_RE = /^(?!-)[\w./-]{1,120}$/;
const TAG_RE = /^(?!-)[\w.+/-]{1,80}$/;
const REMOTE_RE = /^(?!-)[\w.-]{1,60}$/;
const NAME_RE = /^[\w.-]{1,60}$/;

/** spawnSync with an argv array, never a shell. → { code, out } */
export function defaultExec(argv, { cwd, env, timeoutMs = 10 * 60_000, input } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, ...(input != null ? { input } : {}) });
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { code: r.status ?? (r.error ? 127 : 1), out: out.trim() };
}

const run = (ctx, argv, o = {}) => (ctx.exec || defaultExec)(argv, { cwd: o.cwd || ctx.cwd, env: ctx.env || process.env, ...o });
const bin = (ctx, name) => ctx.bins?.[name] || (name === 'node' ? process.execPath : name);
const git = (ctx, args, o = {}) => run(ctx, [bin(ctx, 'git'), ...args], o);
const first = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || '';
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

function currentBranch(ctx) {
  const r = git(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 ? first(r.out) : null;
}
function revParse(ctx, ref, cwd) {
  const r = git(ctx, ['rev-parse', '--verify', '--quiet', ref], cwd ? { cwd } : {});
  return r.code === 0 ? first(r.out) : null;
}
function remoteSha(ctx, remote, ref) {
  const r = git(ctx, ['ls-remote', remote, ref], { timeoutMs: 120_000 });
  if (r.code !== 0) return { ok: false, why: `git ls-remote ${remote} ${ref} : ${first(r.out) || `code ${r.code}`}` };
  const line = r.out.split('\n').find(l => l.trim().endsWith(`\t${ref}`) || l.trim().endsWith(` ${ref}`));
  return { ok: true, sha: line ? line.trim().split(/\s+/)[0] : null };
}

/** Gradle facts of an Android project: applicationId and versionCode, or nulls. */
export function gradleFacts(cwd, cfg = {}) {
  const cands = [...(cfg.versionFiles || []).filter(f => /build\.gradle(\.kts)?$/.test(f)), 'app/build.gradle.kts', 'app/build.gradle', 'android/app/build.gradle.kts', 'android/app/build.gradle'];
  for (const f of cands) {
    let s; try { s = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
    const id = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(s)?.[1] || null;
    const code = /versionCode\s*=?\s*(\d+)/.exec(s)?.[1] || null;
    if (id || code) return { file: f, applicationId: id, versionCode: code ? Number(code) : null };
  }
  return { file: null, applicationId: null, versionCode: null };
}

function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { resolve({ ok: false, why: 'URL invalide' }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 200_000) body += d; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: 'délai dépassé' }); });
    req.on('error', (e) => resolve({ ok: false, why: e.message }));
  });
}
/** Polls `url` until it answers (status < 500, and `contains` when given), up to timeoutSec. */
export async function waitForUrl(url, { timeoutSec = 60, contains = null, probe = httpProbe } = {}) {
  const until = Date.now() + Math.max(1, timeoutSec) * 1000;
  let last = null;
  for (;;) {
    last = await probe(url, 5000);
    if (last.ok && last.status < 500 && (!contains || String(last.body || '').includes(contains))) return { ok: true, observed: `${url} répond (HTTP ${last.status})${contains ? `, contient « ${contains} »` : ''}` };
    if (Date.now() > until) return { ok: false, observed: last.ok ? `${url} : HTTP ${last.status}${contains ? `, sans « ${contains} »` : ''}` : `${url} : ${last.why}`, why: `${url} ne répond pas comme attendu après ${timeoutSec} s` };
    await new Promise(r => setTimeout(r, 1000));
  }
}

function insideProject(cwd, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const n = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(n) || n.split('/').includes('..') || n.startsWith('-')) return null;
  return n;
}

/** A declared command of .orchestrateur/pipeline.json → argv array, or a reason. */
function declaredArgv(def) {
  if (!def || !Array.isArray(def.argv) || !def.argv.length || !def.argv.every(a => typeof a === 'string' && a.length && a.length < 400)) return { why: 'commande déclarée invalide (« argv » : liste de chaînes)' };
  return { argv: def.argv };
}

export const OPERATIONS = {
  git_push: {
    label: 'pousser une branche vers le dépôt distant (git push, jamais forcé)', irreversible: true,
    params: { remote: 'dépôt distant (défaut origin)', branch: 'branche locale (défaut : la branche courante)' },
    prepare(ctx, p) {
      const remote = p.remote || 'origin';
      if (!REMOTE_RE.test(remote)) return { ok: false, why: `dépôt distant invalide « ${remote} »` };
      const remotes = git(ctx, ['remote']).out.split('\n').map(s => s.trim()).filter(Boolean);
      if (!remotes.includes(remote)) return { ok: false, why: `dépôt distant « ${remote} » inconnu (connus : ${remotes.join(', ') || 'aucun'})` };
      const branch = p.branch || currentBranch(ctx);
      if (!branch || !REF_RE.test(branch)) return { ok: false, why: branch ? `branche invalide « ${branch} »` : 'HEAD détachée : aucune branche à pousser' };
      const local = revParse(ctx, `refs/heads/${branch}`);
      if (!local) return { ok: false, why: `branche locale « ${branch} » introuvable` };
      const rs = remoteSha(ctx, remote, `refs/heads/${branch}`);
      if (!rs.ok) return { ok: false, why: rs.why };
      const expect = { remote, branch, sha: local };
      if (rs.sha === local) return { ok: true, already: true, expect, detail: `${remote}/${branch} est déjà à ${local.slice(0, 7)}` };
      if (rs.sha) {
        if (git(ctx, ['cat-file', '-e', `${rs.sha}^{commit}`]).code !== 0) git(ctx, ['fetch', '--quiet', remote, `refs/heads/${branch}`], { timeoutMs: 300_000 });
        if (git(ctx, ['merge-base', '--is-ancestor', rs.sha, local]).code !== 0) return { ok: false, why: `${remote}/${branch} (${rs.sha.slice(0, 7)}) n’est pas un ancêtre de ${branch} (${local.slice(0, 7)}) : le push ne serait pas une avance rapide, et il n’est jamais forcé` };
      }
      const n = rs.sha ? first(git(ctx, ['rev-list', '--count', `${rs.sha}..${local}`]).out) : null;
      return { ok: true, argv: [bin(ctx, 'git'), 'push', remote, `refs/heads/${branch}:refs/heads/${branch}`], expect, detail: `${n ? `${n} commit(s)` : 'nouvelle branche'} vers ${remote}/${branch}` };
    },
    verify(ctx, p, e) {
      const rs = remoteSha(ctx, e.remote, `refs/heads/${e.branch}`);
      if (!rs.ok) return { ok: false, observed: rs.why, why: rs.why };
      return rs.sha === e.sha ? { ok: true, observed: `git ls-remote : ${e.remote}/${e.branch} = ${e.sha.slice(0, 7)}` }
        : { ok: false, observed: `git ls-remote : ${e.remote}/${e.branch} = ${rs.sha ? rs.sha.slice(0, 7) : 'absente'}, attendu ${e.sha.slice(0, 7)}`, why: 'le dépôt distant n’a pas la branche attendue' };
    },
  },
  git_tag: {
    label: 'poser un tag annoté local (git tag -a)', irreversible: false,
    params: { tag: 'nom du tag (obligatoire)', ref: 'commit visé (défaut HEAD)', message: 'message du tag' },
    prepare(ctx, p) {
      if (!p.tag || !TAG_RE.test(p.tag)) return { ok: false, why: `tag invalide « ${p.tag ?? ''} »` };
      const ref = p.ref || 'HEAD';
      if (!REF_RE.test(ref)) return { ok: false, why: `référence invalide « ${ref} »` };
      const commit = revParse(ctx, `${ref}^{commit}`);
      if (!commit) return { ok: false, why: `référence « ${ref} » introuvable` };
      const existing = revParse(ctx, `refs/tags/${p.tag}^{commit}`);
      const expect = { tag: p.tag, commit };
      if (existing === commit) return { ok: true, already: true, expect, detail: `le tag ${p.tag} existe déjà sur ${commit.slice(0, 7)}` };
      if (existing) return { ok: false, why: `le tag ${p.tag} existe déjà, sur un autre commit (${existing.slice(0, 7)}) : jamais déplacé` };
      const msg = String(p.message || `Tag ${p.tag}`).replace(/\s+/g, ' ').slice(0, 300);
      return { ok: true, argv: [bin(ctx, 'git'), 'tag', '-a', p.tag, '-m', msg, commit], expect, detail: `${p.tag} sur ${commit.slice(0, 7)}` };
    },
    verify(ctx, p, e) {
      const at = revParse(ctx, `refs/tags/${e.tag}^{commit}`);
      return at === e.commit ? { ok: true, observed: `git rev-parse ${e.tag} = ${at.slice(0, 7)}` } : { ok: false, observed: `git rev-parse ${e.tag} = ${at ? at.slice(0, 7) : 'absent'}`, why: 'le tag n’est pas sur le commit attendu' };
    },
  },
  git_push_tag: {
    label: 'pousser un tag vers le dépôt distant', irreversible: true,
    params: { tag: 'nom du tag (obligatoire)', remote: 'dépôt distant (défaut origin)' },
    prepare(ctx, p) {
      const remote = p.remote || 'origin';
      if (!p.tag || !TAG_RE.test(p.tag)) return { ok: false, why: `tag invalide « ${p.tag ?? ''} »` };
      if (!REMOTE_RE.test(remote)) return { ok: false, why: `dépôt distant invalide « ${remote} »` };
      const obj = revParse(ctx, `refs/tags/${p.tag}`);
      if (!obj) return { ok: false, why: `tag local ${p.tag} introuvable` };
      const rs = remoteSha(ctx, remote, `refs/tags/${p.tag}`);
      if (!rs.ok) return { ok: false, why: rs.why };
      const expect = { remote, tag: p.tag, sha: obj };
      if (rs.sha === obj) return { ok: true, already: true, expect, detail: `${p.tag} est déjà sur ${remote}` };
      if (rs.sha) return { ok: false, why: `${remote} a déjà un tag ${p.tag} différent (${rs.sha.slice(0, 7)}) : jamais remplacé` };
      return { ok: true, argv: [bin(ctx, 'git'), 'push', remote, `refs/tags/${p.tag}:refs/tags/${p.tag}`], expect, detail: `${p.tag} vers ${remote}` };
    },
    verify(ctx, p, e) {
      const rs = remoteSha(ctx, e.remote, `refs/tags/${e.tag}`);
      if (!rs.ok) return { ok: false, observed: rs.why, why: rs.why };
      return rs.sha === e.sha ? { ok: true, observed: `git ls-remote : ${e.remote} a le tag ${e.tag}` } : { ok: false, observed: `git ls-remote : tag ${e.tag} ${rs.sha ? 'différent' : 'absent'} sur ${e.remote}`, why: 'le tag n’est pas sur le dépôt distant' };
    },
  },
  git_restore: {
    label: 'remettre des fichiers suivis dans l’état du dernier commit (copie de sauvegarde gardée)', irreversible: true,
    params: { paths: 'liste de chemins suivis du projet (obligatoire)' },
    prepare(ctx, p) {
      const list = Array.isArray(p.paths) ? p.paths.map(x => insideProject(ctx.cwd, x)) : [];
      if (!list.length || list.length > 50 || list.some(x => !x)) return { ok: false, why: '« paths » : 1 à 50 chemins relatifs au projet' };
      for (const f of list) if (git(ctx, ['ls-files', '--error-unmatch', '--', f]).code !== 0) return { ok: false, why: `${f} n’est pas suivi par git` };
      const dirty = git(ctx, ['status', '--porcelain', '--', ...list]).out.trim();
      const expect = { paths: list };
      if (!dirty) return { ok: true, already: true, expect, detail: 'déjà identiques au dernier commit' };
      return { ok: true, argv: [bin(ctx, 'git'), 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...list], expect, backup: list, detail: `${list.length} fichier(s)` };
    },
    verify(ctx, p, e) {
      const dirty = git(ctx, ['status', '--porcelain', '--', ...e.paths]).out.trim();
      return !dirty ? { ok: true, observed: `git status : ${e.paths.length} fichier(s) identiques au dernier commit` } : { ok: false, observed: `git status : ${dirty.split('\n').slice(0, 5).join(' ; ')}`, why: 'des fichiers diffèrent encore du dernier commit' };
    },
  },
  prod_jump: {
    label: 'préparer le bond de la prod (prod-jump.mjs, PLAN seulement : jamais --apply)', irreversible: false,
    params: { tag: 'version testée vX.Y.Z (obligatoire)' },
    prepare(ctx, p) {
      if (!p.tag || !/^v\d+\.\d+\.\d+$/.test(p.tag)) return { ok: false, why: `tag de version invalide « ${p.tag ?? ''} » (vX.Y.Z)` };
      const me = (ctx.config?.projects || []).find(x => x.name === ctx.project);
      const prod = me?.devOf ? (ctx.config.projects || []).find(x => x.name === me.devOf) : null;
      if (!prod?.path) return { ok: false, why: `${ctx.project} n’est l’instance de développement d’aucun projet (« devOf » absent de config.json)` };
      const script = path.join(ctx.cwd, 'scripts', 'prod-jump.mjs');
      if (!fs.existsSync(script)) return { ok: false, why: 'scripts/prod-jump.mjs absent du projet' };
      if (!revParse(ctx, `refs/tags/${p.tag}`)) return { ok: false, why: `tag ${p.tag} introuvable dans ${ctx.project}` };
      const prodHead = revParse(ctx, 'HEAD', prod.path);
      // The plan only: --apply is never part of this argv.
      return { ok: true, argv: [bin(ctx, 'node'), script, '--tag', p.tag, '--prod', prod.path], expect: { prod: prod.path, prodHead, tag: p.tag }, detail: `plan du bond ${p.tag} → ${prod.name}` };
    },
    verify(ctx, p, e, res) {
      const now = revParse(ctx, 'HEAD', e.prod);
      if (now !== e.prodHead) return { ok: false, observed: `prod passée de ${String(e.prodHead).slice(0, 7)} à ${String(now).slice(0, 7)}`, why: 'la prod a changé : un plan ne doit rien y écrire' };
      if (res?.code !== 0) return { ok: false, observed: `prod-jump refuse (code ${res?.code}) : ${first(res?.out)}`, why: 'prod-jump refuse le bond (voir sa sortie)' };
      return { ok: true, observed: `plan accepté par prod-jump, prod inchangée (${String(now).slice(0, 7)}) — l’application (--apply) reste à la décision de l’utilisateur` };
    },
  },
  copy_build: {
    label: 'publier le dernier APK du projet sur /downloads (copy-build.mjs)', irreversible: false,
    params: {},
    prepare(ctx) {
      const script = path.join(ctx.root, 'scripts', 'copy-build.mjs');
      if (!fs.existsSync(script)) return { ok: false, why: 'scripts/copy-build.mjs absent de l’orchestrateur' };
      const dir = path.join(ctx.root, 'builds', ctx.project);
      const stamped = (() => { try { return fs.readdirSync(dir).filter(f => /^\d{4}-.*\.apk$/.test(f)); } catch { return []; } })();
      return { ok: true, argv: [bin(ctx, 'node'), script, ctx.project], expect: { dir, stamped }, detail: `APK de ${ctx.project} vers builds/${ctx.project}/latest.apk` };
    },
    verify(ctx, p, e) {
      const latest = path.join(e.dir, 'latest.apk');
      let st = null; try { st = fs.statSync(latest); } catch {}
      if (!st || !st.size) return { ok: false, observed: `${latest} absent ou vide`, why: 'aucun APK publié' };
      const now = (() => { try { return fs.readdirSync(e.dir).filter(f => /^\d{4}-.*\.apk$/.test(f)); } catch { return []; } })();
      const added = now.filter(f => !e.stamped.includes(f));
      if (!added.length) return { ok: false, observed: 'aucune nouvelle copie horodatée dans builds/', why: 'copy-build n’a rien publié' };
      const same = added.some(f => sha256(path.join(e.dir, f)) === sha256(latest));
      return same ? { ok: true, observed: `latest.apk (${(st.size / 1048576).toFixed(1)} Mo) = ${added[0]}` } : { ok: false, observed: 'latest.apk diffère de la copie publiée', why: 'latest.apk n’est pas l’APK publié' };
    },
  },
  adb_install: {
    label: 'installer un APK sur l’appareil connecté (adb install -r)', irreversible: true,
    params: { apk: 'chemin de l’APK (défaut : builds/<projet>/latest.apk)', package: 'applicationId (défaut : lu dans le gradle)', versionCode: 'versionCode attendu (défaut : lu dans le gradle)' },
    prepare(ctx, p) {
      const apk = p.apk ? (path.isAbsolute(p.apk) ? p.apk : path.join(ctx.cwd, p.apk)) : path.join(ctx.root, 'builds', ctx.project, 'latest.apk');
      if (!/\.apk$/i.test(apk) || !fs.existsSync(apk)) return { ok: false, why: `APK introuvable : ${apk}` };
      const g = gradleFacts(ctx.cwd, ctx.cfg);
      const pkg = p.package || g.applicationId;
      const code = Number(p.versionCode || g.versionCode);
      if (!pkg || !/^[\w.]+$/.test(pkg) || !Number.isInteger(code)) return { ok: false, why: 'postcondition non vérifiable : applicationId ou versionCode inconnus (ni en paramètre, ni dans le gradle)' };
      const st = run(ctx, [bin(ctx, 'adb'), 'get-state'], { timeoutMs: 20_000 });
      if (st.code !== 0 || first(st.out) !== 'device') return { ok: false, why: `aucun appareil prêt (adb get-state : ${first(st.out) || `code ${st.code}`})` };
      return { ok: true, argv: [bin(ctx, 'adb'), 'install', '-r', apk], expect: { pkg, code }, detail: `${path.basename(apk)} → ${pkg} (versionCode ${code})` };
    },
    verify(ctx, p, e) {
      const r = run(ctx, [bin(ctx, 'adb'), 'shell', 'dumpsys', 'package', e.pkg], { timeoutMs: 30_000 });
      const got = /versionCode=(\d+)/.exec(r.out)?.[1];
      return Number(got) === e.code ? { ok: true, observed: `appareil : ${e.pkg} versionCode=${got}` } : { ok: false, observed: `appareil : ${e.pkg} versionCode=${got ?? 'absent'}`, why: `versionCode installé ${got ?? 'absent'}, attendu ${e.code}` };
    },
  },
  service_restart: {
    label: 'redémarrer un service déclaré dans .orchestrateur/pipeline.json', irreversible: true,
    params: { service: 'nom déclaré dans operations.services (obligatoire)' },
    prepare(ctx, p) {
      if (!p.service || !NAME_RE.test(p.service)) return { ok: false, why: `service invalide « ${p.service ?? ''} »` };
      const def = ctx.cfg?.operations?.services?.[p.service];
      if (!def) return { ok: false, why: `service « ${p.service} » non déclaré dans .orchestrateur/pipeline.json (operations.services)` };
      const a = declaredArgv(def);
      if (!a.argv) return { ok: false, why: `service « ${p.service} » : ${a.why}` };
      if (!def.check?.url || !/^https?:\/\//.test(def.check.url)) return { ok: false, why: `service « ${p.service} » : « check.url » obligatoire (un code retour seul ne prouve rien)` };
      return { ok: true, argv: a.argv, expect: { url: def.check.url, contains: def.check.contains || null, timeoutSec: Number(def.check.timeoutSec) || 60 }, detail: p.service };
    },
    async verify(ctx, p, e) { return waitForUrl(e.url, { timeoutSec: e.timeoutSec, contains: e.contains, probe: ctx.probe }); },
  },
  run_script: {
    label: 'lancer un script déclaré dans .orchestrateur/pipeline.json', irreversible: null,
    params: { script: 'nom déclaré dans operations.scripts (obligatoire)' },
    irreversibleFor(ctx, p) { return ctx.cfg?.operations?.scripts?.[p.script]?.irreversible !== false; },
    prepare(ctx, p) {
      if (!p.script || !NAME_RE.test(p.script)) return { ok: false, why: `script invalide « ${p.script ?? ''} »` };
      const def = ctx.cfg?.operations?.scripts?.[p.script];
      if (!def) return { ok: false, why: `script « ${p.script} » non déclaré dans .orchestrateur/pipeline.json (operations.scripts)` };
      const a = declaredArgv(def);
      if (!a.argv) return { ok: false, why: `script « ${p.script} » : ${a.why}` };
      const c = def.check || {};
      if (!c.url && !(Array.isArray(c.fileExists) && c.fileExists.length) && !c.outputContains) return { ok: false, why: `script « ${p.script} » : un contrôle est obligatoire (check.fileExists, check.url ou check.outputContains)` };
      return { ok: true, argv: a.argv, expect: { check: c }, timeoutMs: (Number(def.timeoutSec) || 600) * 1000, detail: p.script };
    },
    async verify(ctx, p, e, res) {
      const c = e.check;
      if (res?.code !== 0) return { ok: false, observed: `code ${res?.code}`, why: `le script sort en code ${res?.code}` };
      const obs = [];
      for (const f of c.fileExists || []) {
        const rel = insideProject(ctx.cwd, f);
        if (!rel || !fs.existsSync(path.join(ctx.cwd, rel))) return { ok: false, observed: `${f} absent`, why: `fichier attendu absent : ${f}` };
        obs.push(`${rel} présent`);
      }
      if (c.outputContains) {
        if (!String(res?.out || '').includes(c.outputContains)) return { ok: false, observed: `sortie sans « ${c.outputContains} »`, why: 'la sortie ne contient pas le texte attendu' };
        obs.push(`sortie contient « ${c.outputContains} »`);
      }
      if (c.url) { const w = await waitForUrl(c.url, { timeoutSec: Number(c.timeoutSec) || 60, contains: c.contains || null, probe: ctx.probe }); if (!w.ok) return w; obs.push(w.observed); }
      return { ok: true, observed: obs.join(' ; ') };
    },
  },
};
export const OPERATION_IDS = Object.keys(OPERATIONS);

export function isIrreversible(ctx, op) {
  const def = OPERATIONS[op.id];
  return def?.irreversibleFor ? def.irreversibleFor(ctx, op.params || {}) : !!def?.irreversible;
}

/** The registry as a closed list for a prompt (one line per operation). */
export function operationsCatalogText() {
  return OPERATION_IDS.map(id => {
    const d = OPERATIONS[id];
    const ps = Object.entries(d.params).map(([k, v]) => `${k} : ${v}`).join(' ; ');
    return `- ${id} — ${d.label}${d.irreversible ? ' [IRRÉVERSIBLE : autorisation explicite de l’utilisateur]' : ''}${ps ? ` (paramètres : ${ps})` : ''}`;
  }).join('\n');
}

/**
 * operations.json → { ok, ops: [{id, params, autorisation}] } | { ok:false, why }.
 * Closed list, at most MAX_OPERATIONS, known parameter names only.
 */
export function parseOperations(json) {
  const list = Array.isArray(json?.operations) ? json.operations : null;
  if (!list || !list.length) return { ok: false, why: '« operations » : liste vide ou absente' };
  if (list.length > MAX_OPERATIONS) return { ok: false, why: `${list.length} opérations (au plus ${MAX_OPERATIONS} : découper la demande)` };
  const ops = [];
  for (const [i, o] of list.entries()) {
    const n = `opération ${i + 1}`;
    const def = OPERATIONS[o?.id];
    if (!def) return { ok: false, why: `${n} : « ${o?.id ?? o} » n’est pas une opération connue (liste : ${OPERATION_IDS.join(', ')})` };
    const params = o.params && typeof o.params === 'object' ? o.params : {};
    const bad = Object.keys(params).filter(k => !(k in def.params));
    if (bad.length) return { ok: false, why: `${n} (${o.id}) : paramètre(s) inconnu(s) ${bad.join(', ')}` };
    ops.push({ id: o.id, params, ...(typeof o.autorisation === 'string' && o.autorisation.trim() ? { autorisation: o.autorisation.trim().slice(0, 400) } : {}) });
  }
  return { ok: true, ops, ...(typeof json.autorisation === 'string' && json.autorisation.trim() ? { autorisation: json.autorisation.trim().slice(0, 400) } : {}) };
}

/**
 * Runs ONE operation: preconditions (prepare), the argv, then the
 * postcondition re-read. A failed postcondition is a failure, whatever the
 * return code. → { id, ok, already?, argv?, code?, out?, ms, observed, why?, detail? }
 */
export async function runOperation(ctx, op) {
  const def = OPERATIONS[op.id];
  const t0 = Date.now();
  const base = { id: op.id, params: op.params || {} };
  if (!def) return { ...base, ok: false, ms: 0, why: `opération inconnue « ${op.id} »`, observed: '—' };
  let prep;
  try { prep = def.prepare(ctx, op.params || {}); } catch (e) { prep = { ok: false, why: `erreur de préparation : ${e.message}` }; }
  if (!prep.ok) return { ...base, ok: false, stage: 'precondition', ms: Date.now() - t0, why: prep.why, observed: prep.why };
  if (prep.already) {
    const v = await def.verify(ctx, op.params || {}, prep.expect, { code: 0, out: '' });
    return { ...base, ok: v.ok, already: true, ms: Date.now() - t0, detail: prep.detail, observed: v.observed, ...(v.ok ? {} : { why: v.why, stage: 'postcondition' }) };
  }
  if (prep.backup?.length && ctx.backupDir) {
    for (const f of prep.backup) {
      const from = path.join(ctx.cwd, f);
      if (!fs.existsSync(from)) continue;
      const to = path.join(ctx.backupDir, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  const res = run(ctx, prep.argv, { timeoutMs: prep.timeoutMs || 10 * 60_000 });
  let v;
  try { v = await def.verify(ctx, op.params || {}, prep.expect, res); } catch (e) { v = { ok: false, observed: e.message, why: `postcondition illisible : ${e.message}` }; }
  // A non-zero return code with a true postcondition is still reported (rare: already done remotely).
  return { ...base, ok: v.ok, argv: prep.argv, code: res.code, out: String(res.out || '').slice(-4000), ms: Date.now() - t0, detail: prep.detail, observed: v.observed,
    ...(v.ok ? {} : { why: v.why || `postcondition fausse (code ${res.code})`, stage: 'postcondition' }) };
}

/** The preconditions of every operation, without running anything. → [{id, ok, why?, irreversible, detail}] */
export function precheckOperations(ctx, ops) {
  return ops.map((op) => {
    const def = OPERATIONS[op.id];
    let prep; try { prep = def.prepare(ctx, op.params || {}); } catch (e) { prep = { ok: false, why: e.message }; }
    return { id: op.id, ok: !!prep.ok, ...(prep.ok ? {} : { why: prep.why }), already: !!prep.already, irreversible: isIrreversible(ctx, op), detail: prep.detail || '' };
  });
}
