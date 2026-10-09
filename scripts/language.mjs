// ============================================================================
// scripts/language.mjs — language of discussion (0.51.0)
// ============================================================================
//
// User request (2026-10-09, verbatim): « La langue de la discussion doit pouvoir
// etre fixee et tu dois t'y tenir. Seul le code et les documents qui s'y
// attachent (doc, ...) doivent etre en anglais. » — and: « Cette regle doit
// s'appliquer aux musiciens aussi, si la langue choisie n'est pas un probleme
// pour le model utilise ».
//
// A prompt instruction alone is not enough (the chef answered in English for long
// series of turns despite the rule in its CLAUDE.md). Hence three layers:
//   1. the SETTING: `language-settings.json` (root, not versioned, written by the
//      server; never config.json, which several chefs share) — global language,
//      per-project override and the models table;
//   2. INJECTION by code at the END of EVERY turn (dispatch.mjs: chef, pool slots,
//      musicians, pipeline steps, codex/NVIDIA/OpenRouter, dual model);
//   3. VERIFICATION by code: the language of the final user-facing text is
//      detected; on a mismatch, a short, cheap call rewrites it into the right
//      language without changing the substance, and the original stays
//      available (« ⚠ langue » badge).
// A model that handles the chosen language poorly (models × reliable languages
// table: data/model-languages.json + overrides) works in English; its user-facing
// output is rewritten the same way.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const LANGS = {
  fr: { label: 'Français', name: 'français', en: 'French' },
  en: { label: 'English', name: 'anglais', en: 'English' },
  es: { label: 'Español', name: 'espagnol', en: 'Spanish' },
  de: { label: 'Deutsch', name: 'allemand', en: 'German' },
  it: { label: 'Italiano', name: 'italien', en: 'Italian' },
  pt: { label: 'Português', name: 'portugais', en: 'Portuguese' },
};
export const DEFAULT_LANG = 'fr';
export const SETTINGS_FILE = 'language-settings.json';
export const REFORMULATE_MODEL = 'claude-haiku-5-5';
const LANG_RE = /^(fr|en|es|de|it|pt)$/;

// ---------------------------------------------------------------------------
// Setting
// ---------------------------------------------------------------------------
export function readSettings(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, SETTINGS_FILE), 'utf8')); } catch { /* absent */ }
  const s = j && typeof j === 'object' ? j : {};
  return {
    version: 1,
    default: LANG_RE.test(s.default) ? s.default : DEFAULT_LANG,
    projects: Object.fromEntries(Object.entries(s.projects || {}).filter(([, v]) => LANG_RE.test(v))),
    models: s.models && typeof s.models === 'object' ? s.models : {},
    reformulateModel: typeof s.reformulateModel === 'string' && s.reformulateModel ? s.reformulateModel : REFORMULATE_MODEL,
    check: s.check !== false,
    history: Array.isArray(s.history) ? s.history : [],
    updatedAt: s.updatedAt || null,
  };
}

function writeSettings(root, s, change) {
  const at = new Date().toISOString();
  s.updatedAt = at;
  if (change) { s.history.push({ at, ...change }); if (s.history.length > 300) s.history = s.history.slice(-300); }
  const f = path.join(root, SETTINGS_FILE);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return s;
}

/** Discussion language of a project: its override, else the global one. */
export function languageFor(root, project) {
  const s = readSettings(root);
  return (project && s.projects[project]) || s.default;
}

export function setDefaultLanguage(root, lang, by = 'dashboard') {
  if (!LANG_RE.test(lang)) return { ok: false, status: 400, error: `langue inconnue : ${lang}` };
  const s = readSettings(root);
  const from = s.default;
  s.default = lang;
  writeSettings(root, s, { what: 'default', from, to: lang, by: String(by).slice(0, 40) });
  return { ok: true, status: 200, settings: s };
}

/** `lang` null removes the override (the project follows the global language). */
export function setProjectLanguage(root, project, lang, by = 'dashboard') {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(project || ''))) return { ok: false, status: 400, error: 'projet invalide' };
  if (lang != null && !LANG_RE.test(lang)) return { ok: false, status: 400, error: `langue inconnue : ${lang}` };
  const s = readSettings(root);
  const from = s.projects[project] || null;
  if (lang == null) delete s.projects[project]; else s.projects[project] = lang;
  writeSettings(root, s, { what: `project:${project}`, from, to: lang, by: String(by).slice(0, 40) });
  return { ok: true, status: 200, settings: s };
}

// ---------------------------------------------------------------------------
// Models × reliable languages
// ---------------------------------------------------------------------------
let defaultsCache = null;
export function modelLanguageDefaults(root) {
  if (defaultsCache && defaultsCache.root === root) return defaultsCache.data;
  let d = null;
  for (const f of [path.join(root, 'data', 'model-languages.json'), new URL('../data/model-languages.json', import.meta.url)]) {
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { /* suivant */ }
  }
  const data = d && Array.isArray(d.rules) ? d : { usual: Object.keys(LANGS), rules: [], default: ['en'] };
  defaultsCache = { root, data };
  return data;
}

/**
 * Reliable languages of a model: override (Models page, « Tester » button), then
 * pattern rule (data/model-languages.json), then the cautious default (English).
 * Returns { langs: [...], source: 'override'|'rule'|'default', note }.
 */
export function reliableLanguages(root, model) {
  const d = modelLanguageDefaults(root);
  const all = d.usual || Object.keys(LANGS);
  const id = String(model || '');
  const s = readSettings(root);
  const ov = s.models[id];
  if (ov && Array.isArray(ov.langs)) return { langs: ov.langs.filter(l => LANG_RE.test(l)), source: 'override', note: ov.note || null, test: ov.test || null };
  for (const r of d.rules) {
    let re; try { re = new RegExp(r.match, 'i'); } catch { continue; }
    if (re.test(id)) return { langs: r.langs === '*' ? all : (r.langs || []).filter(l => LANG_RE.test(l)), source: 'rule', note: r.note || null };
  }
  return { langs: d.default || ['en'], source: 'default', note: 'model inconnu : anglais seulement, jusqu’à vérification' };
}

export function setModelLanguages(root, model, langs, { by = 'dashboard', test = null, note = null } = {}) {
  const id = String(model || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/@+~-]{0,159}$/.test(id)) return { ok: false, status: 400, error: 'identifiant de model invalide' };
  const s = readSettings(root);
  const from = s.models[id]?.langs || null;
  if (langs == null) delete s.models[id];
  else {
    const clean = [...new Set((Array.isArray(langs) ? langs : []).filter(l => LANG_RE.test(l)))];
    if (!clean.length) return { ok: false, status: 400, error: 'au moins une langue' };
    s.models[id] = { langs: clean, at: new Date().toISOString(), by: String(by).slice(0, 40), ...(test ? { test } : {}), ...(note ? { note } : {}) };
  }
  writeSettings(root, s, { what: `model:${id}`, from, to: langs == null ? null : s.models[id].langs, by: String(by).slice(0, 40) });
  return { ok: true, status: 200, entry: s.models[id] || null };
}

/** Working language of a turn: the discussion language if the model handles it, else English. */
export function workingLanguage(root, model, target) {
  const r = reliableLanguages(root, model);
  return { working: r.langs.includes(target) ? target : 'en', reliable: r.langs.includes(target), source: r.source };
}

// ---------------------------------------------------------------------------
// The instruction appended at the end of every turn
// ---------------------------------------------------------------------------
export function languageRule(target, working = target) {
  const T = LANGS[target] || LANGS[DEFAULT_LANG];
  if (working === target && target === 'fr') {
    return '\n\n---\nLANGUE (réglage de l’utilisateur, prioritaire sur la langue du contexte) : la langue de discussion est le FRANÇAIS. ' +
      'Tout ce que tu écris à l’utilisateur ou au chef — réponses, rapports, résumés, questions, lignes NEEDS_USER_INPUT / NEEDS_CHEF_INPUT, ' +
      'messages de pause — est en français, même si le contexte, les fichiers, les outils ou les résultats reçus sont en anglais. ' +
      'En revanche, le code, les commentaires de code, les messages de commit et la documentation technique (README, docs techniques) sont en anglais ; ' +
      'dans un document existant, garde sa langue actuelle tant que l’utilisateur n’a pas décidé de le traduire. ' +
      'L’orchestrateur vérifie la langue de ta réponse finale.';
  }
  if (working === target) {
    return `\n\n---\nLANGUAGE (user setting, overrides the language of the context): the discussion language is ${T.en.toUpperCase()}. ` +
      `Everything you write to the user or to the conductor — answers, reports, summaries, questions, NEEDS_USER_INPUT / NEEDS_CHEF_INPUT lines, ` +
      `pause messages — must be written in ${T.en}, even if the context, files, tools or received results are in another language. ` +
      'Code, code comments, commit messages and technical documentation (README, technical docs) stay in English; ' +
      'in an existing document, keep its current language until the user decides to translate it. ' +
      'The orchestrator checks the language of your final answer.';
  }
  return `\n\n---\nLANGUAGE: write everything addressed to the user or to the conductor in ENGLISH (your most reliable language); ` +
    `the orchestrator will translate it automatically into ${T.en} for the user. Keep NEEDS_USER_INPUT / NEEDS_CHEF_INPUT prefixes as they are. ` +
    'Code, code comments, commit messages and technical documentation (README, technical docs) are in English; ' +
    'in an existing document, keep its current language.';
}

// ---------------------------------------------------------------------------
// Detection: function words per language, on PROSE only
// ---------------------------------------------------------------------------
// Chosen method (light, local, no dependency, no key): share of each language's
// function words (articles, prepositions, auxiliaries) in the text stripped of
// code, paths, URLs and identifiers. Reliable from about fifteen words; below
// that, no verdict ('unknown').
const STOP = {
  fr: 'le la les un une des du de et est sont été être ce cette ces il elle ils elles nous vous je tu on ne pas plus pour sur dans avec par que qui quoi dont où mais ou donc car au aux son sa ses leur leurs mon ma mes ton ta tes été fait faire peut doit sans aussi très tout tous toute cela ça déjà encore entre après avant comme quand si alors chez moins bien',
  en: 'the a an and is are was were be been being this that these those it its they them we you he she i not no for on in with by of to from at as or but so if then than there their which who what when where will would should could can may might has have had do does did done also just only very into about after before over all any each some such our your his her',
  es: 'el la los las un una unos unas y es son fue ser este esta estos estas lo que en por para con del al se su sus no más pero como cuando donde muy también ya hay está están porque sin sobre entre hasta desde nos les',
  de: 'der die das den dem des ein eine einen einem und ist sind war waren sein nicht mit auf für von zu im in als auch es ich wir sie er wie aber oder wenn dann noch nur schon sehr bei aus nach über unter durch wird werden hat haben',
  it: 'il lo la gli le un una uno e è sono era essere questo questa questi che di da in con su per non più ma come quando dove anche già molto del della dei delle nel nella al alla si ci ha hanno',
  pt: 'o a os as um uma uns umas e é são foi ser este esta estes estas que de do da dos das em no na nos nas por para com não mais mas como quando onde muito também já se ao aos à às tem têm',
};
const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(/\s+/))]));

export function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')            // blocs de code
    .replace(/`[^`\n]*`/g, ' ')                 // code en ligne
    .replace(/https?:\/\/\S+/g, ' ')            // URL
    .replace(/\b[\w.-]*[\\/][\w.\\/-]+/g, ' ')  // chemins
    .replace(/\b[A-Z_]{3,}[A-Z0-9_]*\b/g, ' ')  // CONSTANTES, NEEDS_USER_INPUT
    .replace(/\b\w*[_\d]\w*\b/g, ' ')           // identifiants avec _ ou chiffres
    .replace(/[|#*>~=\-[\](){}<>]+/g, ' ');     // Markdown
}

/** { lang, confidence, words, scores }; lang = 'unknown' when too short or ambiguous. */
export function detectLanguage(text) {
  const words = proseOf(text).toLowerCase().split(/[^\p{L}']+/u).flatMap(w => w.split("'")).filter(w => w.length > 0);
  const scores = {};
  for (const [k, set] of Object.entries(STOPSETS)) scores[k] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  // French-specific accented letters break ties between fr/es/pt/it.
  const prose = proseOf(text);
  scores.fr += Math.floor((prose.match(/[éèêàçùâîôûë]/gi) || []).length / 4);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1][1];
  if (words.length < 12 || topScore < 4) return { lang: 'unknown', confidence: 0, words: words.length, scores };
  const confidence = (topScore - second) / topScore;
  return { lang: confidence >= 0.25 ? top : 'unknown', confidence: Math.round(confidence * 100) / 100, words: words.length, scores };
}

/** Is the text in another language than the target? (unknown = no). */
export function languageMismatch(text, target) {
  const d = detectLanguage(text);
  return { mismatch: d.lang !== 'unknown' && d.lang !== target, detected: d };
}

// ---------------------------------------------------------------------------
// Short, cheap call (rewriting, language test)
// ---------------------------------------------------------------------------
export function resolveClaudeBin(env = process.env) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  const home = env.USERPROFILE || env.HOME;
  const c = [];
  if (home) c.push(path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'));
  try { for (const u of fs.readdirSync('C:\\Users')) c.push(`C:\\Users\\${u}\\.local\\bin\\claude.exe`); } catch {}
  for (const f of c) { try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return 'claude';
}

/** A single exchange, no tools, no project context. Returns { ok, text, why }. */
export function oneShotClaude(prompt, { model = REFORMULATE_MODEL, timeoutMs = 90_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin(env);
    // `--verbose` (no value, required by stream-json) goes last: the test double
    // skips each flag's value, so this order keeps the prompt readable to it.
    const args = ['--print', prompt, '--output-format', 'stream-json', '--model', model,
      '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--max-turns', '1', '--verbose'];
    const childEnv = { ...env };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'ORCH_TURN_PROJECT', 'ORCH_TURN_STEP', 'ORCH_STEP_TOKEN', 'ORCH_OBS_ID']) delete childEnv[k];
    const isJs = /\.(mjs|js|cjs)$/i.test(bin);
    let c;
    try { c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: os.tmpdir(), env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, why: `lancement impossible : ${e.message}` }); return; }
    let out = '', err = '';
    const t0 = Date.now();
    // Raw trace (0.60.0, additive): what the model test writes to its log file.
    const raw = (code) => ({ raw: { bin, args, code, ms: Date.now() - t0, stdout: out, stderr: err } });
    const t = setTimeout(() => { try { c.kill(); } catch {} resolve({ ok: false, why: 'délai dépassé', ...raw(null) }); }, timeoutMs);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => { clearTimeout(t); resolve({ ok: false, why: e.message, ...raw(null) }); });
    c.on('close', (code) => {
      clearTimeout(t);
      let text = '', isErr = false, served = null;
      for (const line of out.split(/\r?\n/)) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) served = ev.model;
        if (ev.type === 'result') { text = typeof ev.result === 'string' ? ev.result : text; isErr = !!ev.is_error; }
      }
      if (!text && !out.trim().startsWith('{')) text = out.trim();
      if (code !== 0 || isErr || !text.trim()) resolve({ ok: false, why: (isErr ? text : err || `code ${code}`).replace(/\s+/g, ' ').slice(0, 300), served, ...raw(code) });
      else resolve({ ok: true, text: text.trim(), served, ...raw(code) });
    });
  });
}

export function reformulationPrompt(text, target) {
  const T = LANGS[target] || LANGS[DEFAULT_LANG];
  return `[REFORMULATION] Rewrite the text below in ${T.en}, faithfully: do not add, remove or change anything in substance, keep the tone. ` +
    'Keep exactly as they are: Markdown, code blocks, inline code, file names, commands, identifiers, numbers, URLs, and the prefixes ' +
    '« NEEDS_USER_INPUT: » / « NEEDS_CHEF_INPUT: » (translate only the question after them). Answer with the rewritten text only.\n\n<<<\n' + text + '\n>>>';
}

/** Rewrites `text` into `target`. Returns { ok, text, why, model }. */
export async function reformulate(root, text, target, opts = {}) {
  const s = readSettings(root);
  const model = opts.model || s.reformulateModel;
  const r = await oneShotClaude(reformulationPrompt(String(text).slice(0, 60_000), target), { model, timeoutMs: opts.timeoutMs || 90_000, env: opts.env || process.env });
  if (!r.ok) return { ok: false, why: r.why, model };
  const out = r.text.replace(/^<<<\s*/, '').replace(/\s*>>>$/, '').trim();
  // The rewrite itself is checked too.
  const d = detectLanguage(out);
  if (d.lang !== 'unknown' && d.lang !== target) return { ok: false, why: `la reformulation est encore en ${d.lang}`, model };
  return { ok: true, text: out, model };
}

/**
 * Language gate for a final user-facing text. Returns { text, events[] }: the
 * text to publish (rewritten if needed) and the events to write BEFORE the
 * result (journal, badge, original kept available).
 */
export async function languageGate(root, { text, target, working, model, project, reformulator = reformulate }) {
  const s = readSettings(root);
  if (!s.check || !text || !String(text).trim()) return { text, events: [] };
  const { mismatch, detected } = languageMismatch(text, target);
  if (!mismatch) return { text, events: [] };
  const reason = working && working !== target ? 'model-language' : 'mismatch';
  const base = { target, detected: detected.lang, confidence: detected.confidence, reason, model: model || null, project: project || null };
  const r = await reformulator(root, text, target);
  if (!r.ok) {
    return { text, events: [{ type: 'system', subtype: 'language_mismatch', lang: { ...base, reformulated: false, error: r.why },
      text: `⚠ langue : réponse en ${LANGS[detected.lang]?.name || detected.lang} au lieu du ${LANGS[target]?.name || target} — reformulation impossible (${r.why})` }] };
  }
  const lang = { ...base, reformulated: true, by: r.model, original: String(text).slice(0, 60_000) };
  return {
    text: r.text,
    lang,
    events: [{ type: 'system', subtype: 'language_mismatch', lang: { ...base, reformulated: true, by: r.model },
      text: reason === 'model-language'
        ? `↺ langue : ${model || 'le model'} travaille en ${LANGS[working]?.name || working} ; réponse reformulée en ${LANGS[target]?.name || target}`
        : `⚠ langue : réponse en ${LANGS[detected.lang]?.name || detected.lang} au lieu du ${LANGS[target]?.name || target} — reformulée automatiquement` }],
  };
}

/** A message produced by the orchestrator itself (written in French), in the discussion language. */
export async function localize(root, text, target, opts = {}) {
  if (!text || target === 'fr') return text;
  const r = await (opts.reformulator || reformulate)(root, text, target);
  return r.ok ? r.text : text;
}

// ---------------------------------------------------------------------------
// « Tester la langue » (Models page): a short trial, judged by the detector
// ---------------------------------------------------------------------------
const TEST_PROMPT = {
  fr: 'Réponds uniquement en français, en trois phrases simples : pourquoi écrit-on des tests automatisés avant de modifier un programme ?',
  en: 'Answer only in English, in three simple sentences: why do we write automated tests before changing a program?',
};
function testPrompt(lang) {
  return TEST_PROMPT[lang] || `Answer only in ${(LANGS[lang] || LANGS.en).en}, in three simple sentences: why do we write automated tests before changing a program?`;
}

export async function chatCompletion({ url, key, model, prompt, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0.3 }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}${j?.error?.message ? ` : ${String(j.error.message).slice(0, 200)}` : ''}` };
    const text = j?.choices?.[0]?.message?.content || '';
    return text.trim() ? { ok: true, text } : { ok: false, why: 'réponse vide' };
  } catch (e) { return { ok: false, why: e.name === 'AbortError' ? 'délai dépassé' : e.message }; }
  finally { clearTimeout(t); }
}

/**
 * Language trial of a model. `keys(name)` returns a provider key (never logged).
 * Returns { ok, lang, detected, sample, why } and, when `record`, updates the
 * table (language added on success, removed otherwise).
 */
export async function testModelLanguage(root, { provider, model, lang, keys = () => null, env = process.env, fetchImpl, record = true }) {
  if (!LANG_RE.test(lang)) return { ok: false, why: `langue inconnue : ${lang}` };
  const prompt = testPrompt(lang);
  let r;
  if (provider === 'anthropic' || provider === 'claude') r = await oneShotClaude(prompt, { model, env });
  else if (provider === 'openrouter') {
    const key = keys('OPENROUTER_API_KEY');
    r = key ? await chatCompletion({ url: `${env.ORCH_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, key, model, prompt, fetchImpl }) : { ok: false, why: 'clé OpenRouter absente' };
  } else if (provider === 'nvidia') {
    const key = keys('NVIDIA_API_KEY');
    r = key ? await chatCompletion({ url: `${env.ORCH_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, key, model, prompt, fetchImpl }) : { ok: false, why: 'clé NVIDIA absente' };
  } else if (provider === 'openai' || provider === 'codex') {
    // OpenAI goes through codex (subscription); its models are multilingual: the
    // default rule is enough, the trial is accepted without a call.
    r = { ok: true, text: null, skipped: 'OpenAI : multilingue (règle par défaut), pas d’essai nécessaire' };
  } else return { ok: false, why: `fournisseur non géré : ${provider}` };
  if (!r.ok) return { ok: false, lang, why: r.why };
  const d = r.text ? detectLanguage(r.text) : { lang, confidence: 1 };
  const ok = d.lang === lang;
  const result = { ok, lang, detected: d.lang, confidence: d.confidence, sample: r.text ? String(r.text).slice(0, 400) : null, note: r.skipped || null, at: new Date().toISOString() };
  if (record) {
    const cur = reliableLanguages(root, model).langs;
    const next = ok ? [...new Set([...cur, lang])] : cur.filter(l => l !== lang);
    setModelLanguages(root, model, next.length ? next : ['en'], { by: 'test', test: result });
  }
  return result;
}
