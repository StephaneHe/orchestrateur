// ============================================================================
// scripts/plan-repair.mjs — the chef's plan, repaired by the code (Routage v3)
// ============================================================================
//
// Routage v3, phase 2 (user decision of 2026-10-22 « vas y »;
// docs/ROUTAGE-SYNTHESE.md §3.2 the plan, §3.3 the repair table). The chef's
// single turn ends with a ```plan block; this module checks and repairs it.
// « La forme toujours, le sens jamais »:
//   - a FORM problem is repaired by the code and said (« [Routeur] … »):
//     missing or ambiguous title, project name with a unique match, more than
//     6 tasks (waves), `hors_pipeline` without the user's words (launched in a
//     pipeline), a resume of a run that is not paused, duplicates;
//   - a MEANING problem (dependency out of bounds or cycle, task addressed to
//     the chef, unknown action, task without text) asks for ONE targeted retry
//     of the chef; after it (`final`), the task becomes `à_traiter` and the
//     independent tasks still go;
//   - a constraint is NEVER removed: an `apres` stays, even broken (the task
//     waits for a correction instead of leaving early), a pipeline or mode
//     stays, a resume is only what `reprises[]` says (a run cited in a text is
//     a reference, never a resume — decision 4).
// Pure: everything it needs is passed in (projects, runs, pending entries).
// ============================================================================

import { cleanTitle, titleProblem, titleKey, TITLE_MAX, contentHash, identities, readPending } from './routage-pending.mjs';
import { OPERATIONS, CHEF_OPERATION_IDS, CHEF_ACTION_TARGET } from './typed-operations.mjs';

export const WAVE_SIZE = 6;
export const REF_RE = /^[A-Za-z0-9_-]{1,16}$/;
const RUN_RE = /^p-\d{8}T\d{6}-[0-9a-f]{6}$/;
const RUN_TERMINAL = new Set(['done', 'abandoned', 'failed', 'interrupted']);
const MODES = ['leger', 'complet', 'document', 'verification', 'interne'];

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plain = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const say = (s) => `[Routeur] ${s}`;

// ---------------------------------------------------------------------------
// Extraction of the ```plan block
// ---------------------------------------------------------------------------

/**
 * The chef's answer → { ok, prose, plan } | { ok:false, prose, why }. The plan
 * is the LAST fenced block tagged `plan` (a ```json block holding a plan object
 * is accepted too); the prose is the answer without it. The block is mandatory
 * (an empty plan is `{}`): its absence is a form problem, retried once.
 */
export function extractPlan(text) {
  const s = String(text || '');
  const blocks = [...s.matchAll(/```[ \t]*(plan|json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const pick = [...blocks].reverse().find(m => m[1] === 'plan') || [...blocks].reverse().find(m => m[1] === 'json' && /"(taches|actions|reprises|question)"/.test(m[2]));
  if (!pick) return { ok: false, prose: s.trim(), why: 'bloc ```plan absent (il est obligatoire, `{}` quand il n’y a rien à lancer)' };
  const prose = (s.slice(0, pick.index) + s.slice(pick.index + pick[0].length)).trim();
  let plan;
  try { plan = JSON.parse(pick[2]); } catch (e) { return { ok: false, prose, why: `bloc plan illisible (JSON : ${e.message.slice(0, 120)})` }; }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, prose, why: 'bloc plan : un objet JSON est attendu' };
  for (const k of ['taches', 'actions', 'reprises']) if (plan[k] != null && !Array.isArray(plan[k])) return { ok: false, prose, why: `bloc plan : « ${k} » doit être une liste` };
  return { ok: true, prose, plan };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Levenshtein distance (small strings: project names). */
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const projectKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');

/** A project name → { name } (exact or unique case/accent-insensitive match) | { unknown, near: [3] }. */
export function matchProject(name, projects) {
  if (projects.includes(name)) return { name };
  const k = projectKey(name);
  const hits = projects.filter(p => projectKey(p) === k);
  if (k && hits.length === 1) return { name: hits[0], repaired: true };
  const near = [...projects].sort((a, b) => lev(projectKey(a), k) - lev(projectKey(b), k) || a.localeCompare(b)).slice(0, 3);
  return { unknown: true, near };
}

/** The user's own words contain `quote` (case, accents, quotes and spacing ignored); relayed lines never count. */
export function userSaid(userTexts, quote) {
  const n = (s) => norm(s).replace(/[«»"“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = n(quote);
  if (q.length < 3) return false;
  const relayed = (s) => /\[(NEEDS_CHEF_INPUT_FROM:|CALLBACK_WAKE)/.test(s);
  return (userTexts || []).filter(t => t && !relayed(t)).some(t => n(t).includes(q));
}

function fallbackTitle(demande) {
  const s = plain(demande);
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…` : (s || 'sans titre');
}
function requiredParams(id) {
  return Object.entries(OPERATIONS[id]?.params || {}).filter(([, v]) => /obligatoire/.test(v)).map(([k]) => k);
}
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/**
 * plan → {
 *   items: [{ kind: 'tache'|'action'|'reprise', ref, …, apres: [refs], state, vague?, error? }],
 *   question, notes: ['[Routeur] …'], retry: null | { problems: [{ref, field, why}], prompt },
 *   counts }
 * states: `prête` (would start now; wave `vague`), `en_attente_de` (has apres),
 * `à_traiter` (error {code, why, actions}), `écartée` (duplicate), `refusée`
 * (resume of a run that is not paused: said, nothing to do).
 *
 * opts: { projects, conductor, userTexts (the user's message and own lines),
 *         runInfo(run) → {status, project, alive} | null, pending (entries of
 *         routage-pending.json), final (after the one retry) }
 */
export function repairPlan(plan, { projects = [], conductor = 'chef', userTexts = [], runInfo = () => null, pending = [], final = false } = {}) {
  const notes = [];
  const problems = [];
  const items = [];
  const refs = new Map();
  const seq = { t: 0, a: 0, r: 0 };
  const newRef = (k) => { let r; do r = `${k}${++seq[k]}`; while (refs.has(r)); return r; };
  const register = (it, raw, k) => {
    let ref = typeof raw.ref === 'string' && REF_RE.test(raw.ref) ? raw.ref : null;
    if (ref && refs.has(ref)) { problems.push({ ref, field: 'ref', why: `référence « ${ref} » utilisée deux fois` }); ref = null; }
    it.ref = ref || newRef(k);
    it.givenRef = raw.ref ?? null;
    refs.set(it.ref, it);
    items.push(it);
  };

  // 1. Tasks
  const taches = asList(plan?.taches);
  for (const [i, raw0] of taches.entries()) {
    const raw = raw0 && typeof raw0 === 'object' ? raw0 : { demande: String(raw0 ?? '') };
    const it = { kind: 'tache', index: i + 1, projet: plain(raw.projet), demande: String(raw.demande || '').trim(), titre: cleanTitle(raw.titre), apres: [], notes: [] };
    register(it, raw, 't');
    it.rawApres = asList(raw.apres);
    if (typeof raw.pipeline === 'string' && raw.pipeline.trim()) it.pipeline = raw.pipeline.trim();
    if (typeof raw.mode === 'string' && raw.mode.trim()) {
      const m = norm(raw.mode).trim();
      it.mode = MODES.includes(m) ? m : raw.mode.trim();
    }
    if (raw.session_neuve === true) it.sessionNeuve = true;
    if (raw.meme_tache === true) it.memeTache = true;
    if (raw.hors_pipeline != null && raw.hors_pipeline !== false) it.horsPipelineAsked = typeof raw.hors_pipeline === 'string' ? raw.hors_pipeline : (raw.hors_pipeline?.autorisation || '');
    if (!it.demande) problems.push({ ref: it.ref, field: 'demande', why: `tâche ${it.ref} : « demande » vide` });
    if (it.sessionNeuve && it.memeTache) problems.push({ ref: it.ref, field: 'session_neuve', why: `tâche ${it.ref} : « session_neuve » et « meme_tache » s’excluent` });
  }
  // 2. Actions of the chef (typed, with postconditions)
  for (const raw0 of asList(plan?.actions)) {
    const raw = raw0 && typeof raw0 === 'object' ? raw0 : { action: String(raw0 ?? '') };
    const it = { kind: 'action', action: plain(raw.action), params: raw.params && typeof raw.params === 'object' ? { ...raw.params } : {}, apres: [], notes: [] };
    register(it, raw, 'a');
    it.rawApres = asList(raw.apres);
    if (!CHEF_OPERATION_IDS.includes(it.action)) { problems.push({ ref: it.ref, field: 'action', why: `action ${it.ref} : « ${it.action || '?'} » n’est pas une action typée (liste : ${CHEF_OPERATION_IDS.join(', ')})` }); continue; }
    const target = CHEF_ACTION_TARGET[it.action];
    for (const k of ['raison', 'note', 'titre', 'type']) if (raw[k] != null && it.params[k] == null && k in OPERATIONS[it.action].params) it.params[k] = raw[k];
    if (target && raw.cible != null) {
      if (target === 'run') it.params.run = it.params.run ?? plain(raw.cible);
      else it.params.project = it.params.project ?? plain(raw.cible);
    }
    if (target === 'project' || target === 'run') it.cible = target === 'run' ? it.params.run : it.params.project;
    const bad = Object.keys(it.params).filter(k => !(k in OPERATIONS[it.action].params));
    if (bad.length) { for (const k of bad) delete it.params[k]; it.notes.push(say(`action ${it.ref} : paramètre(s) inconnu(s) ignoré(s) : ${bad.join(', ')}`)); }
    const missing = requiredParams(it.action).filter(k => !(typeof it.params[k] === 'string' ? it.params[k].trim() : it.params[k]));
    if (missing.length) problems.push({ ref: it.ref, field: missing[0], why: `action ${it.ref} (${it.action}) : ${missing.join(', ')} obligatoire` });
  }
  // 3. Explicit resumes only
  for (const raw0 of asList(plan?.reprises)) {
    const raw = raw0 && typeof raw0 === 'object' ? raw0 : { run: String(raw0 ?? '') };
    const it = { kind: 'reprise', run: plain(raw.run), message: String(raw.message || '').trim(), apres: [], notes: [] };
    register(it, raw, 'r');
    it.rawApres = asList(raw.apres);
  }

  // 4. Projects (tasks and project-targeted actions)
  const unknownProjects = [];
  for (const it of items) {
    const field = it.kind === 'tache' ? 'projet' : it.kind === 'action' && CHEF_ACTION_TARGET[it.action] === 'project' ? 'project' : null;
    if (!field) continue;
    const name = it.kind === 'tache' ? it.projet : it.params.project;
    if (!name) { if (it.kind === 'tache') problems.push({ ref: it.ref, field: 'projet', why: `tâche ${it.ref} : « projet » absent` }); continue; }
    const m = matchProject(name, projects);
    if (m.name) {
      if (m.repaired) { it.notes.push(say(`${it.ref} : projet « ${name} » lu comme « ${m.name} » (seule correspondance)`)); }
      if (it.kind === 'tache') it.projet = m.name; else { it.params.project = m.name; it.cible = m.name; }
    } else unknownProjects.push({ it, name, near: m.near });
  }
  for (const it of items.filter(x => x.kind === 'tache' && x.projet && (x.projet === conductor || new RegExp(`^${conductor}-\\d+$`).test(x.projet)))) {
    problems.push({ ref: it.ref, field: 'projet', why: `tâche ${it.ref} adressée au chef : le chef ne se lance pas de tâche — fais-le dans ce tour, ou mets une action typée` });
  }

  // 5. Dependencies: resolved, never removed
  for (const it of items) {
    for (const a of it.rawApres) {
      let r = typeof a === 'string' ? a.trim() : null;
      // An index (old shape) names the n-th task.
      if (Number.isInteger(a) || /^\d+$/.test(String(a))) {
        const t = items.filter(x => x.kind === 'tache')[Number(a) - 1];
        if (t) { r = t.ref; it.notes.push(say(`${it.ref} : « apres » ${a} lu comme la tâche ${t.ref}`)); } else r = String(a);
      }
      it.apres.push(r);
      if (!refs.has(r)) problems.push({ ref: it.ref, field: 'apres', why: `${it.ref} : « apres » désigne « ${r} », inconnu dans ce plan` });
      else if (r === it.ref) problems.push({ ref: it.ref, field: 'apres', why: `${it.ref} attend sa propre fin` });
    }
    delete it.rawApres;
  }
  const cyc = new Set();
  const visit = (it, stack) => {
    if (stack.includes(it.ref)) { stack.slice(stack.indexOf(it.ref)).forEach(r => cyc.add(r)); return; }
    for (const r of it.apres) if (refs.has(r) && r !== it.ref) visit(refs.get(r), [...stack, it.ref]);
  };
  for (const it of items) visit(it, []);
  for (const r of cyc) problems.push({ ref: r, field: 'apres', why: `${r} fait partie d’un cycle de dépendances (${[...cyc].join(' → ')})` });

  // 6. Titles: fallback, then « (2) » for ambiguous ones
  const seenTitles = new Map();
  for (const it of items.filter(x => x.kind === 'tache')) {
    if (titleProblem(it.titre)) {
      const before = it.titre;
      it.titre = fallbackTitle(it.demande);
      it.notes.push(say(`${it.ref} : titre ${before ? `« ${before} » invalide` : 'absent'}, titre de repli « ${it.titre} »`));
    }
    const k = titleKey(it.titre);
    const n = (seenTitles.get(k) || 0) + 1;
    seenTitles.set(k, n);
    if (n > 1) {
      const suffix = ` (${n})`;
      const base = it.titre.length + suffix.length > TITLE_MAX ? `${it.titre.slice(0, TITLE_MAX - suffix.length - 1)}…` : it.titre;
      it.notes.push(say(`${it.ref} : même titre qu’une autre tâche, renommée « ${base}${suffix} »`));
      it.titre = `${base}${suffix}`;
    }
  }

  // 7. hors_pipeline only with the user's own words
  for (const it of items.filter(x => x.kind === 'tache' && x.horsPipelineAsked != null)) {
    const w = plain(it.horsPipelineAsked);
    if (w && userSaid(userTexts, w)) it.horsPipeline = w;
    else it.notes.push(say(`${it.ref} : « hors pipeline » sans citation retrouvée des mots de l’utilisateur${w ? ` (« ${w.slice(0, 80)} »)` : ''} — lancée en pipeline`));
    delete it.horsPipelineAsked;
  }

  // 8. Resumes: only a paused (or orphaned) run
  for (const it of items.filter(x => x.kind === 'reprise')) {
    if (!RUN_RE.test(it.run)) { it.state = 'refusée'; it.notes.push(say(`${it.ref} : « ${it.run} » n’est pas un identifiant d’exécution`)); continue; }
    const info = runInfo(it.run);
    it.projet = info?.project || null;
    if (!info) { it.state = 'refusée'; it.notes.push(say(`${it.ref} : exécution ${it.run} inconnue : rien à reprendre`)); }
    else if (info.status === 'paused') it.state = null;
    else if (info.status === 'running' && !info.alive) { it.state = null; it.orphan = true; it.notes.push(say(`${it.ref} : exécution ${it.run} orpheline (processus mort) : mise en pause puis reprise (reclaimOrphanedRun)`)); }
    else if (info.status === 'running') { it.state = 'refusée'; it.notes.push(say(`${it.ref} : exécution ${it.run} en cours : rien à reprendre`)); }
    else if (RUN_TERMINAL.has(info.status)) { it.state = 'refusée'; it.notes.push(say(`${it.ref} : exécution ${it.run} déjà terminée (${info.status}) : rien à reprendre`)); }
    else it.state = null;
  }

  // 9. Duplicates (within the plan, then against the pending entries)
  const seen = new Map();
  for (const e of pending || []) for (const k of identities(e)) if (!seen.has(k)) seen.set(k, { pending: e });
  for (const it of items.filter(x => x.kind === 'tache' || (x.kind === 'reprise' && !x.state))) {
    const afterProj = it.apres.map(r => refs.get(r)).find(x => x?.kind === 'tache')?.projet;
    const shape = it.kind === 'tache' ? { projet: it.projet, demande: it.demande, pipeline: it.pipeline || '', mode: it.mode || '', ...(afterProj ? { after: { projet: afterProj } } : {}) } : { projet: it.projet, reprise: it.run, demande: it.message };
    const ks = it.kind === 'tache' ? [`content:${contentHash(shape)}`] : [`run:${it.projet}|${it.run}`];
    const hit = ks.find(k => seen.has(k));
    if (hit) {
      const kept = seen.get(hit);
      it.state = 'écartée';
      it.duplicateOf = kept.pending ? `attente ${kept.pending.id || '?'}` : kept.ref;
      it.notes.push(say(`${it.ref} écartée : doublon de ${kept.pending ? `la tâche en attente ${kept.pending.id || '?'}${kept.pending.titre ? ` « ${kept.pending.titre} »` : ''}` : kept.ref}`));
      continue;
    }
    for (const k of ks) seen.set(k, { ref: it.ref });
  }

  // 10. Meaning problems: one targeted retry, then « à traiter »
  const problemRefs = new Map();
  for (const p of problems) { if (!problemRefs.has(p.ref)) problemRefs.set(p.ref, []); problemRefs.get(p.ref).push(p); }
  let retry = null;
  if (problems.length && !final) {
    retry = { problems, prompt: retryPrompt(problems) };
  } else if (problems.length) {
    for (const [ref, ps] of problemRefs) {
      const it = refs.get(ref);
      if (!it || it.state === 'écartée') continue;
      const code = ps.some(p => p.field === 'apres' || p.field === 'ref') ? 'dépendance' : ps[0].field === 'projet' ? 'projet' : ps[0].field;
      it.state = 'à_traiter';
      it.error = { code, why: ps.map(p => p.why).join(' ; '), actions: code === 'dépendance' ? ['corriger la dépendance', 'lancer sans la dépendance (autorisation)', 'annuler'] : ['corriger', 'annuler'] };
      it.notes.push(say(`${ref} à traiter : ${it.error.why}`));
    }
  }

  // 11. Unknown projects: one grouped question, the other tasks go
  let question = typeof plan?.question === 'string' && plan.question.trim() ? plan.question.trim() : null;
  if (unknownProjects.length) {
    const lines = unknownProjects.map(({ it, name, near }) => {
      it.state = 'à_traiter';
      it.error = { code: 'projet', why: `projet inconnu « ${name} »`, actions: ['choisir le projet', 'annuler'], near };
      return `- ${it.ref}${it.titre ? ` « ${it.titre} »` : ''} : projet « ${name} » inconnu — lequel ? (proches : ${near.join(', ')})`;
    });
    const q = `Projet(s) à préciser :\n${lines.join('\n')}`;
    question = question ? `${question}\n\n${q}` : q;
  }

  // 12. States: dependants of a task to handle wait for a decision too
  for (const it of items) if (!it.state) it.state = it.apres.length ? 'en_attente_de' : 'prête';
  let moved = true;
  while (moved) {
    moved = false;
    for (const it of items.filter(x => x.state === 'en_attente_de')) {
      const blocker = it.apres.map(r => refs.get(r)).find(p => p && ['à_traiter', 'refusée'].includes(p.state));
      if (blocker) { it.state = 'à_traiter'; it.error = { code: 'prédécesseur', why: `${blocker.ref} est ${blocker.state === 'refusée' ? 'refusée' : 'à traiter'} : ${it.ref} ne part pas sans elle`, actions: [`réparer ${blocker.ref}`, `lancer ${it.ref} sans ${blocker.ref} (autorisation)`, `annuler ${it.ref}`] }; moved = true; }
    }
  }
  // A duplicate that others wait for: they wait for the kept one.
  for (const it of items) it.apres = it.apres.map(r => refs.get(r)?.state === 'écartée' && refs.get(r).duplicateOf && refs.has(refs.get(r).duplicateOf) ? refs.get(r).duplicateOf : r);

  // 13. Waves of at most WAVE_SIZE tasks starting now
  const ready = items.filter(x => x.kind === 'tache' && x.state === 'prête');
  ready.forEach((it, i) => { it.vague = Math.floor(i / WAVE_SIZE) + 1; });
  if (ready.length > WAVE_SIZE) notes.push(say(`${ready.length} tâches à lancer : par vagues de ${WAVE_SIZE} au plus (${Math.ceil(ready.length / WAVE_SIZE)} vagues)`));

  for (const it of items) notes.push(...it.notes);
  const counts = {};
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;
  return { items, question, notes, retry, counts };
}

/** The targeted correction sent with the one retry. */
export function retryPrompt(problems) {
  return '[CHEF_V3] CORRECTION DU PLAN. Ton bloc ```plan a des problèmes que le code ne corrige pas seul (il ne retire jamais une contrainte). ' +
    'Corrige SEULEMENT ces champs, garde tout le reste à l’identique, et réponds avec la même prose suivie du bloc ```plan corrigé :\n' +
    problems.map(p => `- ${p.why} (champ « ${p.field} »)`).join('\n');
}

/** Pending entries of routage-pending.json, for the duplicate check (read only). */
export function pendingFor(logsDir) { try { return readPending(logsDir); } catch { return []; } }
