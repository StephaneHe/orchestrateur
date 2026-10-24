// ============================================================================
// scripts/design.mjs — the « Design » pipeline (0.146.0)
// ============================================================================
//
// User agreement (2026-10-24): « ok » to the chef's proposal of a dedicated
// pipeline, after « l'ui de psyProfile est vraiment moche. quel model la fait »
// and « faut-il un pipeline dédié ? ». The Development checks that the code
// works (DOM, texts, contrasts) but nobody ever LOOKS at the rendered screen:
// interfaces judged « vides », « pas pro », « moches » several times.
//
//   Capturer (program) → Critiquer (vision model) → [Corriger → Capturer →
//   Critiquer] × at most 3 to 5 rounds → Second avis (another family) →
//   Vérifier (program: the project's tests) → Livrer.
//
// The captures are REAL screens rendered by a headless browser (mobile 390×844
// and desktop 1280×800), joined to the model's message as images (native
// image blocks for Claude, --image for codex): the critique is about what the
// user sees, never about the code. The code checks every critique (each screen
// judged, P1/P2/P3, the stop criterion consistent with the problems) and every
// correction (no new external resource without saying so, tests unchanged and
// green). Captures live outside the repository (the run's artefact folder, git
// excluded, then logs/runs/<run>/captures/).
//
// Pure helpers and the capture itself here; the engine glue lives in
// pipeline-engine.mjs (CODE_STEPS design-capturer / design-verifier,
// designCheck, the image attachments). Switch `design` of pipeline-tuning.mjs,
// off by default.
// ============================================================================

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { imageSize } from './media-check.mjs';

export const DESIGN_PIPELINE = 'design';
export const VIEWPORTS = Object.freeze({
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
  bureau: { width: 1280, height: 800, isMobile: false, hasTouch: false },
});
export const ROUNDS = Object.freeze({ min: 3, max: 5, default: 4 });
export const GRAVITIES = Object.freeze(['P1', 'P2', 'P3']);
const IMPORTANT = new Set(['P1', 'P2']);
// Images joined to one model turn: above 20 images the API caps each one at
// 2000 px; the others are listed, to be opened with Read (checked in the log).
export const MAX_ATTACH = 20;
export const MAX_EDGE = 2000;
export const MAX_SHOTS = 80;
export const CAPTURE_DIR = 'captures';
export const CHARTE_CANDIDATES = ['docs/CHARTE-GRAPHIQUE.md', 'docs/charte-graphique.md', 'docs/CHARTE.md', 'CHARTE-GRAPHIQUE.md', 'docs/DESIGN.md', 'DESIGN.md', 'docs/design-system.md', 'docs/STYLEGUIDE.md', 'STYLEGUIDE.md'];
const STATIC_DIRS = ['', 'public', 'www', 'web', 'site', 'static', 'dist', 'docs', 'src', 'app'];
const ACTIONS = new Set(['click', 'fill', 'press', 'wait', 'waitFor', 'hash', 'eval']);
const SCHEMES = new Set(['light', 'dark']);

const posix = (p) => String(p).replace(/\\/g, '/');
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ecran';

/** Number of correction rounds allowed (design.maxRounds, clamped to 3..5). */
export function maxRounds(cfg) {
  const n = Number(cfg?.design?.maxRounds);
  return Number.isInteger(n) ? Math.min(ROUNDS.max, Math.max(ROUNDS.min, n)) : ROUNDS.default;
}

/** The project's graphic charter, if any: design.charte, else a known name. */
export function findCharte(cwd, cfg) {
  const declared = cfg?.design?.charte;
  if (typeof declared === 'string' && declared.trim()) {
    const rel = posix(declared.trim());
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(path.join(cwd, rel))) return rel;
  }
  return CHARTE_CANDIDATES.find(f => fs.existsSync(path.join(cwd, f))) || null;
}

/**
 * What to capture, from .orchestrateur/pipeline.json → design:
 *   capture   a command of the project that writes PNG files into {out}
 *             (its own states, fake engines, failures…) — the most faithful;
 *   start     {command, url ('http://127.0.0.1:{port}/'), readyTimeoutSec, env}
 *             + screens [{id, path|url, actions?}] captured by the orchestrator;
 *   screens   alone, with `file` (a static HTML page of the project);
 *   nothing   the default: the static index.html of the project (root, public/,
 *             www/, dist/, docs/, src/…) and its sibling pages.
 * → { ok, mode, … } | { ok: false, why }
 */
export function designConfig(cwd, cfg = {}) {
  const d = cfg.design && typeof cfg.design === 'object' ? cfg.design : {};
  const viewports = (Array.isArray(d.viewports) && d.viewports.length ? d.viewports : Object.keys(VIEWPORTS)).filter(v => VIEWPORTS[v]);
  const schemes = (Array.isArray(d.schemes) && d.schemes.length ? d.schemes : ['light']).filter(s => SCHEMES.has(s));
  const base = { viewports: viewports.length ? viewports : Object.keys(VIEWPORTS), schemes: schemes.length ? schemes : ['light'], settleMs: clampInt(d.settleMs, 0, 10_000, 500), timeoutMs: clampInt(d.timeoutSec, 10, 1800, 300) * 1000, maxRounds: maxRounds(cfg), charte: findCharte(cwd, cfg) };
  if (typeof d.capture === 'string' && d.capture.trim()) {
    if (!d.capture.includes('{out}')) return { ok: false, why: 'design.capture doit contenir « {out} » (le dossier où écrire les captures PNG)' };
    return { ok: true, mode: 'command', command: d.capture.trim(), ...base };
  }
  const screens = Array.isArray(d.screens) ? d.screens : null;
  if (screens) {
    const bad = checkScreens(screens, { served: !!d.start });
    if (bad) return { ok: false, why: `design.screens : ${bad}` };
  }
  if (d.start) {
    const s = typeof d.start === 'string' ? { command: d.start } : d.start;
    if (!s || typeof s.command !== 'string' || !s.command.trim()) return { ok: false, why: 'design.start.command manquant (la commande qui lance l’application)' };
    if (!screens?.length) return { ok: false, why: 'design.start sans design.screens : liste les pages et états à capturer ([{"id": "accueil", "path": "/"}])' };
    return { ok: true, mode: 'serve', start: { command: s.command.trim(), url: String(s.url || 'http://127.0.0.1:{port}/'), readyMs: clampInt(s.readyTimeoutSec, 1, 600, 30) * 1000, env: s.env && typeof s.env === 'object' ? s.env : {} }, screens, ...base };
  }
  if (screens?.length) return { ok: true, mode: 'static', screens, ...base };
  const found = defaultStaticScreens(cwd);
  if (found.length) return { ok: true, mode: 'static', screens: found, defaulted: true, ...base };
  return { ok: false, why: 'aucun écran à capturer : déclare dans .orchestrateur/pipeline.json → « design » soit « capture » (une commande du projet qui écrit ses captures PNG dans {out}), soit « start » (commande de lancement, URL avec {port}) et « screens » ([{"id": "accueil", "path": "/", "actions": [{"click": "#menu"}]}]) ; sans déclaration, seule une page index.html statique du projet est capturée' };
}
function clampInt(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; }

function checkScreens(screens, { served }) {
  if (!screens.length) return 'liste vide';
  const ids = new Set();
  for (const [i, s] of screens.entries()) {
    if (!s || typeof s !== 'object') return `entrée ${i + 1} invalide`;
    if (typeof s.id !== 'string' || !/^[\w.-]{1,60}$/.test(s.id)) return `entrée ${i + 1} : « id » attendu (lettres, chiffres, _ . -)`;
    if (ids.has(s.id)) return `id « ${s.id} » en double`;
    ids.add(s.id);
    if (!served && typeof s.file !== 'string') return `« ${s.id} » : « file » (page HTML du projet) attendu sans design.start`;
    if (typeof s.file === 'string' && (path.isAbsolute(s.file) || posix(s.file).split('/').includes('..'))) return `« ${s.id} » : « file » doit être un chemin relatif du projet`;
    for (const a of s.actions || []) {
      const k = a && typeof a === 'object' ? Object.keys(a) : [];
      if (k.length !== 1 || !ACTIONS.has(k[0])) return `« ${s.id} » : action inconnue ${JSON.stringify(a)} (permises : ${[...ACTIONS].join(', ')})`;
    }
  }
  return null;
}

/** Without a declaration: the static index.html of the project and its sibling pages (8 at most). */
export function defaultStaticScreens(cwd) {
  for (const d of STATIC_DIRS) {
    const dir = path.join(cwd, d);
    if (!fs.existsSync(path.join(dir, 'index.html'))) continue;
    let pages = [];
    try { pages = fs.readdirSync(dir).filter(f => /\.html?$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b))); } catch { /* unreadable */ }
    return pages.slice(0, 8).map(f => ({ id: f === 'index.html' ? 'accueil' : slug(f.replace(/\.html?$/i, '')), file: posix(path.join(d, f)) }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** PNG files written under dir → shots, sorted, with their size and viewport. */
export function collectShots(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.png$/i.test(e.name)) {
        let size = null;
        try { size = imageSize(fs.readFileSync(abs)); } catch { /* unreadable */ }
        if (!size?.w || !size?.h) continue;
        const id = posix(path.relative(dir, abs)).replace(/\.png$/i, '');
        out.push({ id, file: abs, width: size.w, height: size.h, viewport: viewportOf(id) });
      }
    }
  };
  walk(dir);
  return out;
}
function viewportOf(id) {
  const s = String(id).toLowerCase();
  if (/(^|[\/_-])(mobile|phone|telephone|tel)([\/_.-]|$)/.test(s)) return 'mobile';
  if (/(^|[\/_-])(bureau|desktop|ordinateur)([\/_.-]|$)/.test(s)) return 'bureau';
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}
async function waitForUrl(url, ms, child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode != null) return { ok: false, why: `la commande de lancement s’est arrêtée (code ${child.exitCode}) avant de répondre` };
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer().catch(() => null);
      return { ok: true, status: r.status };
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok: false, why: `${url} ne répond pas après ${Math.round(ms / 1000)} s` };
}

/** The browser (playwright-core, Edge then Chrome; ORCH_DESIGN_BROWSER = an executable). */
async function launchBrowser() {
  let pw;
  try { pw = await import('playwright-core'); } catch (e) { return { ok: false, why: `playwright-core introuvable (${e.message})` }; }
  const tries = process.env.ORCH_DESIGN_BROWSER ? [{ executablePath: process.env.ORCH_DESIGN_BROWSER }] : [{ channel: 'msedge' }, { channel: 'chrome' }];
  const errs = [];
  for (const t of tries) {
    try { return { ok: true, browser: await pw.chromium.launch({ ...t, headless: true }) }; } catch (e) { errs.push(String(e.message || e).split('\n')[0]); }
  }
  return { ok: false, why: `aucun navigateur headless n’a démarré (Edge, Chrome) : ${errs.join(' ; ').slice(0, 300)}` };
}

async function runAction(page, a) {
  const [k, v] = Object.entries(a)[0];
  if (k === 'click') await page.click(String(v), { timeout: 10_000 });
  else if (k === 'fill') await page.fill(String(v[0]), String(v[1] ?? ''), { timeout: 10_000 });
  else if (k === 'press') await page.keyboard.press(String(v));
  else if (k === 'wait') await page.waitForTimeout(Math.min(10_000, Math.max(0, Number(v) || 0)));
  else if (k === 'waitFor') await page.waitForSelector(String(v), { timeout: 15_000 });
  else if (k === 'hash') await page.evaluate((h) => { location.hash = h; }, String(v));
  else if (k === 'eval') await page.evaluate(String(v));
}

/**
 * Capture every screen × viewport × colour scheme into outDir.
 * → { ok, shots, mode, notes[] } | { ok: false, why, log? }
 */
export async function captureScreens({ cwd, cfg = {}, outDir, env = process.env }) {
  const dc = designConfig(cwd, cfg);
  if (!dc.ok) return dc;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const notes = [];
  if (dc.defaulted) notes.push(`aucun « design » déclaré : page(s) statique(s) capturée(s) par défaut (${dc.screens.map(s => s.file).join(', ')})`);
  if (dc.mode === 'command') {
    const quoted = `"${outDir.replace(/"/g, '')}"`;
    const command = dc.command.split('{out}').join(quoted);
    const t0 = Date.now();
    const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: dc.timeoutMs, env, maxBuffer: 32 * 1024 * 1024 });
    const log = `${r.stdout || ''}${r.stderr || ''}`.slice(-4000);
    if (r.status !== 0) return { ok: false, why: `la commande de capture du projet a échoué (${dc.command}, code ${r.status ?? (r.error?.code || '?')}) : ${log.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`, log };
    const shots = collectShots(outDir);
    if (!shots.length) return { ok: false, why: `la commande de capture du projet (${dc.command}) n’a écrit aucune image PNG dans {out}`, log };
    notes.push(`captures écrites par la commande du projet (${dc.command}) en ${Math.round((Date.now() - t0) / 1000)} s`);
    return finishShots(shots, notes, dc);
  }
  let child = null;
  let baseUrl = null;
  if (dc.mode === 'serve') {
    const port = await freePort();
    baseUrl = dc.start.url.split('{port}').join(String(port));
    const childEnv = { ...env, ...Object.fromEntries(Object.entries(dc.start.env).map(([k, v]) => [k, String(v).split('{port}').join(String(port))])), PORT: String(port) };
    let out = '';
    try {
      child = spawn(dc.start.command.split('{port}').join(String(port)), { cwd, shell: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', (b) => { out = (out + b).slice(-4000); });
      child.stderr.on('data', (b) => { out = (out + b).slice(-4000); });
      child.on('error', () => {});
    } catch (e) { return { ok: false, why: `lancement impossible de « ${dc.start.command} » : ${e.message}` }; }
    const w = await waitForUrl(baseUrl, dc.start.readyMs, child);
    if (!w.ok) { killTree(child.pid); return { ok: false, why: `${w.why} (commande « ${dc.start.command} »)${out.trim() ? ` — sortie : ${out.trim().split('\n').slice(-4).join(' | ').slice(0, 400)}` : ''}` }; }
    notes.push(`application lancée par « ${dc.start.command} » sur ${baseUrl}`);
  }
  const b = await launchBrowser();
  if (!b.ok) { if (child) killTree(child.pid); return b; }
  const deadline = Date.now() + dc.timeoutMs;
  const errors = [];
  try {
    for (const vp of dc.viewports) {
      for (const scheme of dc.schemes) {
        const v = VIEWPORTS[vp];
        const context = await b.browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1, isMobile: v.isMobile, hasTouch: v.hasTouch, colorScheme: scheme });
        try {
          for (const s of dc.screens) {
            if (Date.now() > deadline) { errors.push(`délai de capture dépassé (${Math.round(dc.timeoutMs / 1000)} s)`); break; }
            const page = await context.newPage();
            try {
              const url = s.file ? pathToFileURL(path.join(cwd, s.file)).href : new URL(String(s.url || s.path || '/'), baseUrl).href;
              await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
              for (const a of s.actions || []) await runAction(page, a);
              if (dc.settleMs) await page.waitForTimeout(dc.settleMs);
              const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
              const height = Math.min(MAX_EDGE, Math.max(v.height, Number(h) || v.height));
              const file = path.join(outDir, vp, `${slug(s.id)}${scheme === 'light' ? '' : `-${scheme}`}.png`);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: v.width, height } });
              if (h > MAX_EDGE) notes.push(`${vp}/${s.id} : page de ${h} px coupée à ${MAX_EDGE} px`);
            } catch (e) {
              errors.push(`${vp}/${s.id} : ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
            } finally { await page.close().catch(() => {}); }
          }
        } finally { await context.close().catch(() => {}); }
      }
    }
  } finally {
    await b.browser.close().catch(() => {});
    if (child) killTree(child.pid);
  }
  if (errors.length) return { ok: false, why: `capture impossible : ${errors.slice(0, 4).join(' ; ')}` };
  return finishShots(collectShots(outDir), notes, dc);
}
function finishShots(shots, notes, dc) {
  if (shots.length > MAX_SHOTS) {
    notes.push(`${shots.length} captures : seules les ${MAX_SHOTS} premières sont gardées pour la critique (les autres sont listées dans captures.json)`);
    return { ok: true, mode: dc.mode, shots: shots.slice(0, MAX_SHOTS), dropped: shots.slice(MAX_SHOTS).map(s => s.id), notes };
  }
  return { ok: true, mode: dc.mode, shots, dropped: [], notes };
}

/** Which shots are joined as images (≤ MAX_ATTACH, ≤ MAX_EDGE px) and which are to be opened with Read. */
export function attachPlan(shots) {
  // Views alternate, mobile first (real replay, 2026-10-24: the first 20 in
  // name order were all desktop, and the critic skipped most mobile screens).
  const groups = new Map();
  for (const s of shots || []) { const k = s.viewport || '?'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const order = [...groups.keys()].sort((a, b) => (a === 'mobile' ? -1 : b === 'mobile' ? 1 : a.localeCompare(b)));
  const mixed = [];
  for (let i = 0; mixed.length < (shots || []).length; i++) for (const k of order) if (groups.get(k)[i]) mixed.push(groups.get(k)[i]);
  const attach = [], read = [];
  for (const s of mixed) (attach.length < MAX_ATTACH && s.width <= MAX_EDGE && s.height <= MAX_EDGE ? attach : read).push(s);
  return { attach, read };
}

// ---------------------------------------------------------------------------
// Critique (judged by the code)
// ---------------------------------------------------------------------------

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\\/g, '/').replace(/\.png$/, '').trim();

/**
 * A critique (or a second opinion): every screen judged, every problem with its
 * gravity, the stop criterion written, « arret » consistent with the problems.
 * Screens not joined as images must have been opened with Read in the turn.
 * → { ok, importants[], counts{P1,P2,P3}, problems[] } | { ok: false, why }
 */
export function checkCritique(json, { shots = [], readInTurn = [], attachedIds = null } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, why: 'JSON invalide' };
  if (!Array.isArray(json.ecrans)) return { ok: false, why: 'champ « ecrans » (liste) absent' };
  const byId = new Map(shots.map(s => [norm(s.id), s]));
  const seen = new Set();
  const problems = [];
  for (const [i, e] of json.ecrans.entries()) {
    const id = norm(e?.ecran);
    if (!id) return { ok: false, why: `ecrans[${i}] : « ecran » (identifiant de la capture) absent` };
    if (byId.size && !byId.has(id)) return { ok: false, why: `ecrans[${i}] : « ${e.ecran} » n’est pas une capture de ce tour (captures : ${[...byId.values()].map(s => s.id).slice(0, 12).join(', ')})` };
    seen.add(id);
    if (!Array.isArray(e.problemes)) return { ok: false, why: `« ${e.ecran} » : champ « problemes » (liste, vide si l’écran est irréprochable) absent` };
    for (const [j, p] of e.problemes.entries()) {
      const g = String(p?.gravite || '').toUpperCase().trim();
      if (!GRAVITIES.includes(g)) return { ok: false, why: `« ${e.ecran} », problème ${j + 1} : « gravite » doit valoir P1, P2 ou P3 (reçu « ${p?.gravite ?? '—'} »)` };
      const txt = String(p?.probleme || '').replace(/\s+/g, ' ').trim();
      if (txt.length < 8) return { ok: false, why: `« ${e.ecran} », problème ${j + 1} : « probleme » trop court ou absent (dis ce qui se voit)` };
      problems.push({ ecran: String(e.ecran), gravite: g, probleme: txt, correction: String(p?.correction || '').replace(/\s+/g, ' ').trim() });
    }
  }
  const missing = [...byId.keys()].filter(k => !seen.has(k));
  if (missing.length) return { ok: false, why: `écran(s) non critiqué(s) : ${missing.slice(0, 10).map(k => byId.get(k).id).join(', ')} — chaque capture doit avoir son entrée (problemes : [] si rien à redire)` };
  // A capture not joined as an image must have been looked at with Read.
  if (attachedIds) {
    const attached = new Set(attachedIds.map(norm));
    const reads = readInTurn.map(norm);
    const unseen = shots.filter(s => !attached.has(norm(s.id)) && !reads.some(r => r.endsWith(norm(posix(s.relPath || s.id)))));
    if (unseen.length) return { ok: false, why: `capture(s) non regardée(s) : ${unseen.slice(0, 8).map(s => s.id).join(', ')} — ouvre chaque capture listée « à lire » avec l’outil Read` };
  }
  const critere = String(json.critere_arret || '').replace(/\s+/g, ' ').trim();
  if (critere.length < 10) return { ok: false, why: '« critere_arret » absent : écris le critère d’arrêt que tu appliques (ex. « plus aucun P1 ni P2 »)' };
  if (json.arret === 'true' || json.arret === 'false') json.arret = json.arret === 'true';
  if (typeof json.arret !== 'boolean') return { ok: false, why: '« arret » (true ou false) absent' };
  const importants = problems.filter(p => IMPORTANT.has(p.gravite));
  if (json.arret && importants.length) return { ok: false, why: `« arret » vaut true alors que ${importants.length} problème(s) P1/P2 reste(nt) : ${importants.slice(0, 3).map(p => `${p.ecran} — ${p.gravite} — ${p.probleme.slice(0, 80)}`).join(' ; ')}` };
  if (!json.arret && !importants.length) return { ok: false, why: '« arret » vaut false sans aucun problème P1 ni P2 : il n’y a plus rien d’important à corriger (arret = true)' };
  const counts = { P1: 0, P2: 0, P3: 0 };
  for (const p of problems) counts[p.gravite]++;
  return { ok: true, problems, counts, critere, importants: importants.map(p => `${p.ecran} — ${p.gravite} — ${p.probleme}${p.correction ? ` (correction proposée : ${p.correction})` : ''}`) };
}

// ---------------------------------------------------------------------------
// Correction guardrail: no external resource added without saying so
// ---------------------------------------------------------------------------

// External references a page loads: <link href>, <script src>, <img src>,
// @import, url(…), fetch of a stylesheet or a font. Machine text, not routing.
const EXT_RE = /(?:href|src)\s*=\s*["'](https?:)?\/\/[^"'\s>]+|@import\s+(?:url\()?\s*["']?(https?:)?\/\/[^"')\s;]+|url\(\s*["']?(https?:)?\/\/[^"')\s]+/gi;
const TEXT_EXT = /\.(html?|css|scss|sass|less|m?js|cjs|jsx|tsx?|vue|svelte|astro|ejs|hbs|njk|twig|php|svg|json|md|kt|xml)$/i;
function hostsIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(EXT_RE)) {
    const u = /(https?:)?\/\/[^"')\s;>]+/i.exec(m[0]);
    if (u) out.add(u[0].replace(/^(https?:)?\/\//i, '//').replace(/[.,]+$/, ''));
  }
  return out;
}
/** New external references in the changed files: [{file, url}]. before(file) → old text or null. */
export function newExternalRefs(files, { before, after }) {
  const out = [];
  for (const f of files || []) {
    if (!TEXT_EXT.test(f)) continue;
    const old = hostsIn(before(f));
    for (const u of hostsIn(after(f))) if (!old.has(u)) out.push({ file: posix(f), url: u });
  }
  return out;
}
/** Every new external reference must be named in « ## Ressources externes » of the artefact. */
export function checkExternalDeclared(art, refs) {
  const s = String(art || '').replace(/\r\n/g, '\n');
  const m = /^##\s+Ressources externes\s*$/im.exec(s);
  if (!m) return { ok: false, why: 'section « ## Ressources externes » absente : liste chaque ressource externe ajoutée (police, feuille de style, script, image d’un autre site) avec sa raison, ou écris « aucune »' };
  const body = s.slice(m.index + m[0].length).split(/^##\s/m)[0].toLowerCase();
  const undeclared = refs.filter(r => {
    const host = r.url.replace(/^\/\//, '').split('/')[0].toLowerCase();
    return !body.includes(host);
  });
  if (undeclared.length) return { ok: false, why: `ressource(s) externe(s) ajoutée(s) sans le dire : ${undeclared.slice(0, 5).map(r => `${r.url} (${r.file})`).join(', ')} — préfère une ressource locale du projet, sinon déclare-la dans « ## Ressources externes » avec sa raison` };
  return { ok: true, declared: refs };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const CRITIQUE_JSON = '{"ecrans": [{"ecran": "identifiant exact de la capture (ex. mobile/accueil)", "avis": "ce qui va et ce qui ne va pas, en une ou deux phrases", "problemes": [{"gravite": "P1|P2|P3", "probleme": "ce qui se VOIT, précis (élément, endroit)", "correction": "la correction d’affichage proposée"}]}], "critere_arret": "le critère d’arrêt que tu appliques, ex. « plus aucun P1 ni P2 »", "arret": "true seulement s’il ne reste AUCUN P1 ni P2, sinon false"}';
const GRID = 'Classe chaque problème : P1 = empêche l’impression d’un produit professionnel (rien n’est mis en page, illisible, cassé, éléments qui se chevauchent ou sortent de l’écran, incohérence flagrante) ; P2 = gêne nettement (hiérarchie confuse, espacements irréguliers, contraste faible, boutons incohérents, écran vide sans explication) ; P3 = finition (détail d’alignement, nuance de couleur, micro-interaction).';
export const CRITIQUE_ROLE = 'CRITIQUER LE RENDU RÉEL de l’interface : les captures jointes à ce message sont des écrans réellement rendus par un navigateur (mobile 390×844 et bureau 1280×800). Regarde CHAQUE capture et juge-la comme un designer exigeant juge un produit professionnel : mise en page et alignements, hiérarchie visuelle et typographie, espacements et densité, couleurs et contrastes, cohérence des composants (boutons, champs, cartes), lisibilité sur mobile, états vides ou d’erreur, finition. Seul compte ce qui SE VOIT : le code n’est pas l’objet (tu peux le lire pour proposer une correction précise). Si une charte graphique du projet est indiquée, elle est le cadre : juge l’écart à la charte. '
  + `${GRID} Écris le critère d’arrêt que tu appliques (« critere_arret ») et « arret » : true seulement s’il ne reste AUCUN P1 ni P2 (l’orchestrateur le vérifie : il relance une correction tant qu’il en reste, au plus quelques tours). Une entrée par capture, « problemes » vide si l’écran est irréprochable. Ne modifie aucun fichier.`;
export const SECOND_ROLE = 'SECOND AVIS INDÉPENDANT sur le rendu FINAL : les captures jointes sont les écrans tels qu’ils sont maintenant, réellement rendus par un navigateur. Les critiques précédentes ne te sont PAS fournies (retirées par l’orchestrateur) : fais ton propre examen, comme un designer d’une autre école, sur les mêmes critères (mise en page, hiérarchie, typographie, espacements, couleurs et contrastes, cohérence des composants, lisibilité mobile, états vides et d’erreur, finition ; charte du projet si elle est indiquée). '
  + `${GRID} Écris ton critère d’arrêt et « arret » : true seulement s’il ne reste AUCUN P1 ni P2 (sinon l’orchestrateur relance une correction sur tes constats). Une entrée par capture. Ne modifie aucun fichier.`;
export const CORRECT_ROLE = 'CORRIGER L’AFFICHAGE : corrige chaque problème P1 et P2 de a-corriger.json (écrit par l’orchestrateur à partir de la dernière critique ; les captures concernées sont jointes à ce message), et les P3 qui ne coûtent presque rien. UNIQUEMENT la présentation : HTML, CSS, gabarits, classes, textes affichés, icônes, mise en page côté client. Aucun changement de comportement, d’API, de données ni de test (les tests existants doivent rester inchangés ET verts ; aucun test par détail de style n’est demandé). Si une charte graphique du projet est indiquée, respecte-la (couleurs, polices, composants). N’ajoute AUCUNE ressource externe (police, feuille de style, script ou image servie par un autre site, CDN) sans la déclarer : préfère une ressource locale ; chaque URL externe nouvelle doit être listée dans la section « ## Ressources externes » de l’artefact avec sa raison (sinon « aucune ») — l’orchestrateur compare. Écris dans l’artefact une section « ## Corrections » : chaque problème traité et comment. Ne commite pas.';
export const CORRECT_SECTIONS = ['Corrections', 'Ressources externes'];

/** The lines describing the captures for a step prompt (paths relative to the project). */
export function captureLines(shots, plan, { round, charte }) {
  const L = [];
  const rel = (s) => posix(s.relPath || s.file);
  L.push(`Captures du tour ${round === 0 ? '0 (avant toute correction)' : round} — ${shots.length} écran(s) ; identifiants à reprendre EXACTEMENT dans « ecran » :`);
  const joined = new Set(plan.attach.map(s => s.id));
  for (const s of shots) L.push(`- ${s.id} (${s.viewport || 'vue'} ${s.width}×${s.height}) — \`${rel(s)}\`${joined.has(s.id) ? ' — jointe en image à ce message' : ' — À LIRE avec l’outil Read (non jointe : trop de captures ou image trop grande)'}`);
  L.push(charte ? `Charte graphique du projet : \`${charte}\` (lis-la : c’est le cadre).` : 'Aucune charte graphique trouvée dans le projet : juge selon les standards d’un produit professionnel sobre et cohérent.');
  return L;
}

/** Copy the first and last captures out of the project, for the report (outside the repository). */
export function keepCaptures(rounds, destDir) {
  const kept = {};
  const pick = rounds.length ? { avant: rounds[0], apres: rounds.length > 1 ? rounds.at(-1) : null } : {};
  for (const [name, r] of Object.entries(pick)) {
    if (!r?.dir || !fs.existsSync(r.dir)) continue;
    const to = path.join(destDir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(r.dir, to, { recursive: true });
    kept[name] = { dir: to, shots: collectShots(to).length };
  }
  return kept;
}

/** verification.md: what the run did, read by the user (the run's result). */
export function designReport({ rounds = [], critiques = [], second = null, maxRounds: max, test = null, kept = {}, relKept = (p) => p, notes = [], charte = null, sameFamily = null }) {
  const first = critiques[0]?.counts || null;
  const last = critiques.at(-1) || null;
  const p3 = (second?.problems || last?.problems || []).filter(p => p.gravite === 'P3');
  const fmt = (c) => (c ? `P1 ${c.P1}, P2 ${c.P2}, P3 ${c.P3}` : '—');
  const corrections = Math.max(0, rounds.length - 1);
  const L = ['## Résultat', ''];
  L.push(`- Captures réelles : ${rounds.map(r => `${r.label} (${r.shots} écran(s))`).join(', ') || '—'} ; mobile 390×844 et bureau 1280×800.`);
  L.push(`- Tours de correction : ${corrections} (au plus ${max}).`);
  L.push(`- Problèmes relevés au départ : ${fmt(first)} ; à la dernière critique : ${fmt(last?.counts)}${last?.critere ? ` — critère d’arrêt du critique : « ${last.critere} »` : ''}.`);
  if (second) L.push(`- Second avis indépendant${second.model ? ` (${second.model})` : ''} : ${fmt(second.counts)}${second.critere ? ` — critère : « ${second.critere} »` : ''}.${sameFamily ? ` ⚠ ${sameFamily}` : ''}`);
  if (charte) L.push(`- Charte graphique appliquée : \`${charte}\`.`);
  if (test) L.push(`- Tests du projet : ${test.skipped ? test.skipped : `\`${test.command}\` → ${test.ok ? 'vert' : 'ROUGE'} (code ${test.code}${test.ms ? `, ${Math.round(test.ms / 1000)} s` : ''})`}.`);
  for (const n of notes) L.push(`- ${n}`);
  L.push('', '## Captures avant / après (hors dépôt)', '');
  if (kept.avant) L.push(`- Avant : \`${relKept(kept.avant.dir)}\` (${kept.avant.shots} image(s))`);
  if (kept.apres) L.push(`- Après : \`${relKept(kept.apres.dir)}\` (${kept.apres.shots} image(s))`);
  if (!kept.avant && !kept.apres) L.push('- aucune capture gardée');
  if (!kept.apres) L.push('- Aucune correction : l’état capturé est aussi l’état final.');
  L.push('', '## Points de finition restants (P3)', '');
  L.push(...(p3.length ? p3.slice(0, 30).map(p => `- ${p.ecran} — ${p.probleme}`) : ['- aucun']));
  return `${L.join('\n')}\n`;
}

/** Same family of models for the critique and the second opinion: said, never refused. */
export function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (/^claude|opus|sonnet|haiku|fable/.test(m)) return 'anthropic';
  if (/^gpt|^o\d|codex/.test(m)) return 'openai';
  return m.split(/[/-]/)[0] || null;
}
