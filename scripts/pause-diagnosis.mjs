// ============================================================================
// scripts/pause-diagnosis.mjs — the cause of a pause, and choices that act on it
// ============================================================================
//
// User report (2026-10-20): « Une chose qui me gene c'est de porposer des choix
// stupides. Si quelque chose a provoquer une erreur, proposer de continuer ou de
// changer de modele ne resoudra pas l'erreur. Il faudrait un choix plus
// intelligent ».
//
// Before this module every pause offered the same menu (continuer, simplifier,
// changer le model, abandonner). Now, before any pause:
//   1. DIAGNOSIS, by the code first, in this order: refused criterion and its
//      reason, test output, diff, provider error, limit reached, missing file.
//      A model is asked only when the code finds nothing (`diagnoseWithModel`:
//      one short choice on the model of the case routage.classifier).
//      The cause is stated in one plain French sentence.
//   2. MENU derived from the cause (`smartMenu`): each option acts on it and
//      says concretely what it will do; one is recommended, with its reason.
//      - « continuer » only for a transient cause (outage, limit, network,
//        interruption);
//      - « changer le model » only with a proof that the model is at fault
//        (unknown model, failed model test, refusal) — a usage limit is not one;
//      - « abandonner » always.
//   `checkMenu` enforces those rules; the engine never pauses with a menu that
//   breaks them.
//
// Matching on error messages here reads MACHINE output (orchestrator criteria,
// test runners, provider errors), never the user's text: it is not routing by
// keywords (0.66.0 rule), which concerns the meaning of a request.
// ============================================================================

import path from 'node:path';

// ---------------------------------------------------------------------------
// Detection patterns (machine messages)
// ---------------------------------------------------------------------------
const AUTH_RE = /Failed to authenticate|OAuth (?:session|token)[^\n]{0,60}(?:expired|invalid|revoked|could not be refreshed)|authentication_error|invalid (?:x-)?api[ -]?key|please run \/login|not logged in/i;
const LIMIT_RE = /you'?ve hit your (?:session|usage) limit|(?:session|usage) limit reached|\d+-hour limit reached|usage limit|limite de session|limite d.utilisation|rate[ _-]?limit|\b429\b|quota/i;
const REFUSAL_RE = /can['’]t help with (?:this|that)|usage policy|\baup\b/i;
const PERMANENT_MODEL_RE = /not[ _-]?found|invalid[ _-]?model|unknown[ _-]?model|unrecognized[ _-]?model|no such model|model_not_found|does not exist|n['’]existe pas/i;
const TRANSIENT_RE = /sans result|\b5\d\d\b|overload|unavailable|indisponible|timed? ?out|délai dépassé|ECONN\w*|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|réseau/i;
const NET_RE = /\bE(?:TIMEDOUT|CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b|getaddrinfo|Name or service not known|Temporary failure in name resolution|Network is unreachable|No such host is known|ConnectionError|ReadTimeout|ConnectTimeout|socket\.timeout/i;
const PORT_RE = /EADDRINUSE[^\n]*?(?::(\d{2,5}))?|address already in use[^\n]*?(?::(\d{2,5}))?/i;
const DISK_RE = /ENOSPC|no space left on device|espace disque insuffisant|There is not enough space on the disk/i;
const NODE_PKG_RE = /Cannot find (?:module|package) ['"]([^'"\n]+)['"]/;
const PY_PKG_RE = /(?:ModuleNotFoundError|ImportError): No module named ['"]?([\w.]+)['"]?/;
const ENOENT_RE = /ENOENT[^\n]*?['"]([^'"\n]+)['"]|No such file or directory:? ['"]?([^'"\n]+?)['"]?(?:\n|$)|FileNotFoundError[^\n]*?['"]([^'"\n]+)['"]/;
const TEST_FILE_RE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.[a-z]+$|^test_[\w-]+\.py$|[\\/]test_[\w-]+\.py$|Test\.(kt|java)$/i;
const TEST_SELF_ERROR_RE = /\b(SyntaxError|ReferenceError|IndentationError|NameError)\b[^\n]*/;
const ASSERT_RE = /(AssertionError[^\n]*|assert(?:ion)? failed[^\n]*|Expected[^\n]*|expected[^\n]*(?:to|but)[^\n]*|✖[^\n]*|FAIL[^\n]*|not ok \d+[^\n]*|E\s+assert[^\n]*)/;

const clean = (s, n = 220) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || '';
const STRIP = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Causes the user calls « passagères » (outage, limit, network, interruption). */
export const TRANSIENT_KINDS = Object.freeze(['provider_transient', 'limit', 'network', 'launch', 'interrupted']);

/** Plain description of every cause kind (also the options of the model diagnosis). */
export const CAUSE_KINDS = Object.freeze({
  test_passes: 'le nouveau test passe déjà sans code nouveau (il ne vérifie pas ce qui manque, ou le comportement existe déjà)',
  no_test: 'aucun test n’a été écrit ni modifié',
  test_wrong: 'le test lui-même est en erreur (syntaxe, nom inconnu), pas le code testé',
  code_wrong: 'le code ne fait pas encore passer le test (assertion en échec)',
  no_change: 'l’étape n’a modifié aucun fichier',
  missing_sections: 'le compte rendu de l’étape n’a pas les sections exigées',
  scope_violation: 'l’étape a modifié des fichiers qu’elle n’a pas le droit de toucher',
  bad_format: 'le compte rendu de l’étape n’a pas le format exigé (JSON…)',
  cited_paths: 'l’étape cite des chemins introuvables dans le projet',
  missing_file: 'un fichier ou un compte rendu attendu est absent',
  no_commit: 'la livraison n’a créé aucun commit',
  criterion_strict: 'un critère automatique est plus strict que le travail ne le justifie',
  too_big: 'la demande est trop grosse pour une seule exécution',
  review_defects: 'la relecture relève encore des défauts précis',
  env_dependency: 'une dépendance n’est pas installée',
  env_port: 'un port réseau est déjà occupé',
  env_disk: 'le disque est plein',
  env_auth: 'la connexion du fournisseur a expiré (OAuth)',
  network: 'le réseau ou un service distant ne répond pas',
  provider_transient: 'le fournisseur du model a une panne passagère',
  limit: 'une limite d’utilisation du model est atteinte',
  model_unknown: 'le model choisi n’existe pas ou n’est pas servi',
  refusal: 'le fournisseur du model refuse la demande',
  launch: 'le model ne démarre pas (sorties sans résultat)',
  orchestrator: 'l’orchestrateur a refusé de lancer l’étape',
  base_red: 'les tests du projet échouent déjà avant toute modification',
  classifier: 'le choix automatique (routage interne, variante) a échoué',
  missing_info: 'une information de l’utilisateur est nécessaire',
  items_blocked: 'des items ont été mis de côté',
  aside_conflict: 'un item mis de côté ne s’applique plus',
  git_commit: 'git a refusé le commit',
  interrupted: 'l’exécution a été interrompue (processus arrêté)',
  repeated: 'la même erreur se répète d’un essai à l’autre',
  authorization: 'une action irréversible attend l’autorisation explicite de l’utilisateur',
  operation_failed: 'une opération n’a pas produit l’effet vérifié (condition préalable ou postcondition fausse)',
  unknown: 'cause non établie',
});

// ---------------------------------------------------------------------------
// Pieces of diagnosis
// ---------------------------------------------------------------------------

/** Paths cited by a refused step, each judged: orchestrator name, abbreviated, outside, absent. */
export function judgeMissingPaths(list, { files = [], orchNames = new Set() } = {}) {
  const byBase = new Map();
  for (const f of files) {
    const b = path.posix.basename(String(f).replace(/\\/g, '/')).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(String(f).replace(/\\/g, '/'));
  }
  return list.map((p0) => {
    const p = String(p0).trim();
    const n = p.replace(/\\/g, '/');
    const base = path.posix.basename(n).toLowerCase();
    if (/^(system|notification|result|assistant|user|user_prompt)\/[a-z_]+$/.test(n)) return { path: p, verdict: 'not_a_path', why: 'type d’événement de l’orchestrateur, pas un fichier' };
    if (/…|\.\.\.$/.test(n)) return { path: p, verdict: 'elided', why: 'chemin abrégé (…)' };
    if (orchNames.has(base) && !n.includes('/')) return { path: p, verdict: 'orchestrator', why: 'fichier de l’orchestrateur (artefact d’exécution), pas du projet' };
    if (/^[A-Za-z]:\//.test(n) || n.startsWith('/')) return { path: p, verdict: 'outside', why: 'chemin d’un autre dossier que le projet' };
    const cands = (byBase.get(base) || []).filter(c => c.toLowerCase() !== n.toLowerCase());
    if (cands.length) return { path: p, verdict: 'elsewhere', where: cands.slice(0, 3), why: `existe sous ${cands.slice(0, 3).map(c => `\`${c}\``).join(', ')}` };
    return { path: p, verdict: 'absent', why: 'introuvable dans le projet' };
  });
}

/** What a failing test output says, read by the code. */
export function readTestOutput(out) {
  const text = String(out || '');
  if (!text.trim()) return null;
  let m;
  if ((m = DISK_RE.exec(text))) return { kind: 'env_disk', line: clean(m[0]) };
  if ((m = PORT_RE.exec(text))) return { kind: 'env_port', port: m[1] || m[2] || null, line: clean(m[0]) };
  if ((m = NET_RE.exec(text))) return { kind: 'network', line: clean(m[0]) };
  if ((m = NODE_PKG_RE.exec(text))) {
    const mod = m[1];
    if (/^[./]|^[A-Za-z]:[\\/]/.test(mod)) return { kind: 'missing_file', file: mod, line: clean(m[0]) };
    return { kind: 'env_dependency', ecosystem: 'node', package: mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0], line: clean(m[0]) };
  }
  if ((m = PY_PKG_RE.exec(text))) return { kind: 'env_dependency', ecosystem: 'python', package: m[1].split('.')[0], line: clean(m[0]) };
  if ((m = ENOENT_RE.exec(text))) return { kind: 'missing_file', file: m[1] || m[2] || m[3], line: clean(m[0]) };
  if ((m = TEST_SELF_ERROR_RE.exec(text))) {
    // Where the error is: a frame of a test file ⇒ the test itself is broken.
    const after = text.slice(Math.max(0, m.index - 600), m.index + 1200);
    const frame = [...after.matchAll(/([\w./\\:-]+\.(?:m?js|cjs|ts|tsx|py|kt|java))(?::(\d+))?/g)].map(x => ({ file: x[1], line: x[2] || null }));
    const inTest = frame.find(f => TEST_FILE_RE.test(f.file));
    if (inTest) return { kind: 'test_wrong', file: inTest.file, at: inTest.line, line: clean(m[0]) };
    return { kind: 'code_wrong', line: clean(m[0]) };
  }
  if ((m = ASSERT_RE.exec(text))) return { kind: 'code_wrong', line: clean(m[1]) };
  return { kind: 'code_wrong', line: clean(text.split('\n').filter(l => l.trim()).slice(-1)[0] || '') };
}

/** A provider message read by the code (auth, limit, refusal, unknown model, outage). */
export function readProviderError(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  let m;
  if ((m = AUTH_RE.exec(t))) return { kind: 'env_auth', line: clean(lineAt(t, m.index)) };
  if ((m = REFUSAL_RE.exec(t))) return { kind: 'refusal', line: clean(lineAt(t, m.index)) };
  if ((m = LIMIT_RE.exec(t))) return { kind: 'limit', line: clean(lineAt(t, m.index)), until: (/jusqu'?à\s+(\S+)|until\s+(\S+)|resets?\s+(?:at\s+)?([^\s.]+)/i.exec(t) || []).slice(1).find(Boolean) || null };
  if ((m = PERMANENT_MODEL_RE.exec(t)) && /model|modèle/i.test(t)) return { kind: 'model_unknown', line: clean(lineAt(t, m.index)) };
  if ((m = TRANSIENT_RE.exec(t))) return { kind: 'provider_transient', line: clean(lineAt(t, m.index)) };
  return null;
}
function lineAt(t, i) { return t.slice(t.lastIndexOf('\n', i) + 1).split('\n')[0]; }

// Budget limits: their reason is a message of the orchestrator itself, which
// quotes the work (item text, review defects). « Voix indisponible » in an item
// is not a provider outage (run of 2026-10-23): only a real provider error,
// passed apart, is read for them.
export const BUDGET_LIMITS = Object.freeze(['items', 'duration', 'review', 'item_tests']);
const QUOTED_RE = /«[^»]*»?/g;

/** The text where a provider error may be read: never the work quoted in the reason. */
export function providerText(input = {}) {
  const why = BUDGET_LIMITS.includes(input.limit) ? '' : String(input.why || '').replace(QUOTED_RE, '« … »');
  const apart = input.providerError && input.providerError !== input.why ? String(input.providerError) : '';
  return [apart, why].filter(Boolean).join('\n');
}

/** The same refusal twice in a row (numbers and hashes aside). */
export function isRepeated(attempts) {
  const sig = (w) => STRIP(firstLine(w)).replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, 'n').slice(0, 160);
  const ws = (attempts || []).map(a => (typeof a === 'string' ? a : a?.why)).filter(Boolean);
  return ws.length >= 2 && sig(ws.at(-1)) === sig(ws.at(-2));
}

// ---------------------------------------------------------------------------
// The diagnosis
// ---------------------------------------------------------------------------

/**
 * input: {
 *   limit, step: {id, label}, why, attempts: [why], testOutput, changed: [file],
 *   providerError, model, slot, itemsLeft: [{n,text}], itemsDone, itemsMax,
 *   item: {n,text,declared}, written, files: [project files], orchNames: Set,
 *   modelTest: {model, ok, why}, defects: [text], aside: [...], extra: {...}
 * }
 * → { kind, transient, cause, evidence: [{source, text}], source: 'code', proof?, ...details }
 */
export function diagnosePause(input = {}) {
  const ev = [];
  const why = String(input.why || '');
  const motif = firstLine(why);
  const step = input.step?.label || input.step?.id || 'l’étape';
  const out = (kind, cause, extra = {}) => ({ kind, transient: TRANSIENT_KINDS.includes(kind), cause, evidence: ev, source: 'code', ...extra });
  const proof = modelProof(input);

  // A cause already established by the caller (infrastructure hold).
  if (input.known?.kind) {
    const k = input.known;
    return out(k.kind, k.cause || `${cap(CAUSE_KINDS[k.kind] || k.kind)}.`, { ...(k.proof ? { proof: k.proof } : {}), ...(k.until ? { until: k.until } : {}) });
  }
  // Pauses whose cause is their very nature (no criterion to read).
  switch (input.limit) {
    // Generics (pipelines phase 1): an irreversible operation without the user's words; an operation that failed.
    case 'autoriser': return out('authorization', `Ces opérations sont irréversibles et votre demande ne les autorise pas en toutes lettres : ${(input.extra?.operations || []).join(' ; ') || 'voir la liste'}. Rien n’a été lancé.`, { operations: input.extra?.operations || [] });
    case 'operation': return out('operation_failed', `${input.extra?.stage === 'precondition' ? 'Une condition préalable n’est pas remplie' : input.extra?.stage === 'execution' ? 'Une opération de fichiers a échoué' : `L’opération ${input.extra?.operation || ''} n’a pas produit l’effet vérifié`} : ${clean(motif, 260)}.`, { stage: input.extra?.stage || 'postcondition', operation: input.extra?.operation || null });
    case 'doutes': return out('missing_info', `Avant toute suppression, ${input.extra?.doubts || 'des'} fichier(s) sont en doute : seule votre réponse dit s’il faut les supprimer.`);
    case 'orphaned': return out('interrupted', `L’exécution s’est arrêtée sans finir : ${clean(why || 'son processus n’existe plus', 200)}.`);
    case 'items_blocked': return out('items_blocked', `${(input.aside || []).length} item(s) ont été mis de côté pour une raison précise (${(input.aside || []).map(a => `item ${a.group} : ${clean(a.reason || a.why, 80)}`).join(' ; ')}), les autres sont livrés.`, { aside: input.aside || [] });
    case 'aside_conflict': return out('aside_conflict', `Les modifications d’un item mis de côté ne s’appliquent plus sur le travail livré depuis : ${clean(motif, 200)}.`);
    case 'launch_refused': return out('orchestrator', `L’orchestrateur (dispatch.mjs) a refusé de lancer l’étape « ${step} » avant d’appeler le model : ${clean(motif, 200)}.`);
    case 'classifier': {
      const empty = /case[^\n]*(vide|absent|aucun model|pas de model)|no model|non affect/i.test(why);
      if (empty) return out('classifier', `Le choix automatique a échoué parce qu’aucun model n’est affecté à la case « routage.classifier » : ${clean(motif, 160)}.`, { repair: 'case' });
      const p = readProviderError(why);
      if (p && TRANSIENT_KINDS.includes(p.kind)) { ev.push({ source: 'fournisseur', text: p.line }); return out(p.kind, `Le choix automatique a échoué à cause d’une panne passagère du model de la case « routage.classifier » : ${p.line}.`); }
      return out('classifier', `Le model de la case « routage.classifier » n’a pas pu faire le choix : ${clean(motif, 200)}.`);
    }
    default: break;
  }

  // 1. Refused criterion and its reason (orchestrator messages).
  if (motif) ev.push({ source: 'critère', text: clean(motif, 300) });
  let m;
  if (/^la suite passe encore/i.test(motif)) {
    const item = input.item?.text ? ` « ${input.item.text} »` : '';
    return withRepeat(out('test_passes', `Le nouveau test${item} passe déjà sans aucun code nouveau : soit il ne vérifie pas le comportement qui manque, soit ce comportement existe déjà dans le code.`), input);
  }
  if ((m = /^chemins cités inexistants\s*:\s*(.+)$/i.exec(motif))) {
    const judged = judgeMissingPaths(m[1].split(/\s*,\s*/).filter(Boolean), { files: input.files || [], orchNames: input.orchNames || new Set() });
    const parts = judged.map(j => `\`${j.path}\` (${j.why})`);
    const absent = judged.filter(j => j.verdict === 'absent');
    const falsePos = judged.filter(j => j.verdict !== 'absent' && j.verdict !== 'elsewhere');
    const kind = absent.length ? 'cited_paths' : 'criterion_strict';
    const head = absent.length ? `L’étape « ${step} » a été refusée parce qu’elle cite ${judged.length} chemin(s) introuvable(s) dans le projet` : `L’étape « ${step} » a été refusée à tort : les ${judged.length} chemin(s) qu’elle cite ne sont pas inventés`;
    return out(kind, `${head} : ${parts.join(', ')}.`, { paths: judged, criterion: 'citedPaths', falsePositives: falsePos.length });
  }
  if (/aucun test ajouté ni modifié/i.test(motif)) return withRepeat(out('no_test', `L’étape « ${step} » n’a ajouté ni modifié aucun fichier de test${input.item?.text ? ` pour « ${input.item.text} »` : ''}.`), input);
  if ((m = /^artefact\s+(\S+)\s+absent ou vide/i.exec(motif))) return withRepeat(out('missing_file', `L’étape « ${step} » n’a pas écrit son compte rendu \`${m[1]}\`, exigé pour la valider.`, { file: m[1] }), input);
  if (/aucun commit créé/i.test(motif)) return withRepeat(out('no_commit', 'La livraison n’a créé aucun commit : rien n’est enregistré dans git.'), input);
  if (/^aucune modification\b/i.test(motif) && input.limit !== 'review') return withRepeat(out('no_change', `L’étape « ${step} » n’a modifié aucun fichier du projet.`), input);
  if ((m = /^(\S+)\s*:\s*sections? manquantes?\s*:?\s*(.+)$/i.exec(motif)) || (m = /^()sections? manquantes?\s*:?\s*(.+)$/i.exec(motif))) {
    return withRepeat(out('missing_sections', `Le compte rendu${m[1] ? ` \`${m[1]}\`` : ''} de l’étape « ${step} » n’a pas les sections exigées : ${clean(m[2], 200)}.`, { file: m[1] || null, sections: clean(m[2], 200) }), input);
  }
  if ((m = /lecture seule, mais des fichiers du projet ont changé\s*:\s*(.+)$/i.exec(motif)) || (m = /ne touche que des tests ; modifiés hors tests\s*:\s*(.+)$/i.exec(motif))
    || (m = /fichiers de test modifiés \([^)]*\)\s*:\s*(.+)$/i.exec(motif))) {
    return withRepeat(out('scope_violation', `L’étape « ${step} » a modifié des fichiers hors de ce qu’elle a le droit de toucher : ${clean(m[1], 200)}.`, { files: clean(m[1], 200) }), input);
  }
  if (/\bJSON\b[^\n]*(invalide|illisible|attendu)|(invalide|illisible)[^\n]*\bJSON\b|n.est pas un JSON/i.test(motif)) return withRepeat(out('bad_format', `Le compte rendu de l’étape « ${step} » n’a pas le format exigé : ${clean(motif, 220)}.`), input);
  // An argument refusal of dispatch.mjs (exit 64/65), not a provider failure it relays.
  if (/\(code 6[45]\)/.test(why) && (m = /\[dispatch\]\s*(.+)$/.exec(why)) && !readProviderError(m[1])) return out('orchestrator', `L’orchestrateur (dispatch.mjs) a refusé de lancer l’étape « ${step} » avant d’appeler le model : ${clean(m[1], 200)}.`);
  if (input.limit === 'item_tests') {
    const d = input.item?.declared, w = input.written;
    return out('criterion_strict', `L’item n° ${input.item?.n ?? '?'}${input.item?.text ? ` « ${clean(input.item.text, 80)} »` : ''} annonçait ${d ?? '?'} test(s) mais en a écrit ${w ?? '?'} : le critère du nombre de tests le refuse.`, { criterion: 'itemTests', declared: d, written: w });
  }

  // 2. Test output.
  const t = readTestOutput(input.testOutput || (/la suite échoue/i.test(motif) ? why : ''));
  if (t) {
    ev.push({ source: 'sortie des tests', text: t.line });
    if (t.kind === 'env_disk') return out('env_disk', `Les tests échouent parce que le disque est plein (${t.line}).`);
    if (t.kind === 'env_port') return out('env_port', `Les tests échouent parce que le port ${t.port || '(voir la sortie)'} est déjà occupé par un autre processus (${t.line}).`, { port: t.port });
    if (t.kind === 'network') return out('network', `Les tests échouent à cause du réseau ou d’un service distant injoignable (${t.line}), pas d’un test cassé.`);
    if (t.kind === 'env_dependency') return out('env_dependency', `Les tests échouent parce que la dépendance « ${t.package} » n’est pas installée (${t.line}).`, { package: t.package, ecosystem: t.ecosystem });
    if (t.kind === 'missing_file') return withRepeat(out('missing_file', `Les tests échouent parce que le fichier \`${t.file}\` est introuvable (${t.line}).`, { file: t.file }), input);
    if (t.kind === 'test_wrong') return withRepeat(out('test_wrong', `Le test lui-même est en erreur (${t.line}, dans \`${t.file}${t.at ? `:${t.at}` : ''}\`), pas le code qu’il vérifie.`, { file: t.file }), input);
    if (input.limit === 'green' || /la suite échoue encore/i.test(motif)) return withRepeat(out('code_wrong', `Le code ne fait pas encore passer le test${input.item?.text ? ` « ${clean(input.item.text, 80)} »` : ''} : ${t.line || 'la suite reste rouge'}.`, { failure: t.line }), input);
  }

  // 3. Diff of the last attempt.
  if (Array.isArray(input.changed)) ev.push({ source: 'diff', text: input.changed.length ? `${input.changed.length} fichier(s) modifié(s) : ${input.changed.slice(0, 5).join(', ')}` : 'aucun fichier modifié' });

  // 4. Provider error.
  const p = readProviderError(providerText(input));
  if (p) {
    ev.push({ source: 'fournisseur', text: p.line });
    const mdl = input.model ? `le model ${input.model}` : 'le model';
    const ofMdl = input.model ? `du model ${input.model}` : 'du model';
    if (p.kind === 'env_auth') return out('env_auth', `La connexion de Claude a expiré (OAuth) : ${p.line}. Plus aucun model Claude ne peut répondre tant qu’elle n’est pas renouvelée.`);
    if (p.kind === 'refusal') return out('refusal', `Le fournisseur ${ofMdl} refuse la demande (politique d’usage) : ${p.line}.`, { proof: { kind: 'refusal', text: p.line } });
    // A usage limit is not the model's fault: it comes back by itself (no proof, no « changer le model »).
    if (p.kind === 'limit') return out('limit', `${cap(mdl)} a atteint sa limite d’utilisation${p.until ? ` (jusqu’à ${p.until})` : ''} : ${p.line}.`, { until: p.until });
    if (p.kind === 'model_unknown') return out('model_unknown', `${cap(mdl)} n’existe pas ou n’est pas servi par son fournisseur : ${p.line}.`, { proof: { kind: 'unknown-model', text: p.line } });
    if (p.kind === 'provider_transient') {
      if (input.limit === 'launch') return out('launch', `${cap(mdl)} n’a rien produit ${input.extra?.failures || 'plusieurs'} fois de suite malgré des attentes de plus en plus longues : ${p.line}.`, proof ? { proof } : {});
      return out('provider_transient', `Le fournisseur ${ofMdl} a une panne passagère : ${p.line}.`);
    }
  }
  if (input.limit === 'launch') return out('launch', `${cap(input.model ? `le model ${input.model}` : 'le model')} n’a rien produit ${input.extra?.failures || 'plusieurs'} fois de suite : ${clean(motif || 'sortie sans résultat', 200)}.`, proof ? { proof } : {});
  if (input.limit === 'model_unavailable') return out('provider_transient', `Le model ${input.model || ''} est momentanément indisponible : ${clean(motif, 200)}.`);

  // 5. Limit reached.
  const left = input.itemsLeft || [];
  const max = input.itemsMax || 15;
  if (input.limit === 'items') return out('too_big', (input.itemsDone || 0) === 0
    ? `La liste prévoit ${left.length} tests alors qu’une exécution en fait au plus ${max} : la demande est trop grosse pour une seule exécution.`
    : `${input.itemsDone} tests sont faits (le maximum d’une exécution) et il en reste ${left.length} : la demande est trop grosse pour une seule exécution.`, { left: left.map(i => i.text), max });
  if (input.limit === 'duration') {
    if (left.length > 5) return out('too_big', `La durée maximale de travail est atteinte et il reste ${left.length} tests à faire : la demande est trop grosse pour une seule exécution.`, { left: left.map(i => i.text), max: input.itemsMax });
    return out('criterion_strict', `La durée maximale de travail d’une exécution (${input.extra?.duration || '90 min'}) est atteinte${left.length ? ` alors que la fin est proche (${left.length} test(s) restant(s))` : ' ; le travail n’est pas trop gros (aucune liste de tests en attente)'}.`, { criterion: 'duration' });
  }
  if (input.limit === 'review') {
    const ds = (input.defects || []).map(d => clean(d, 160));
    return out('review_defects', `La relecture relève encore ${ds.length || 'des'} défaut(s) précis après ${input.extra?.rounds || 'plusieurs'} tour(s) de corrections${ds.length ? ` : ${ds.slice(0, 3).join(' ; ')}` : ` : ${clean(motif.replace(/^la revue relève encore\s*:\s*/i, ''), 240)}`}.`, { defects: ds });
  }
  if (input.limit === 'item_commit') return out('git_commit', `git a refusé le commit de l’item : ${clean(motif.replace(/^.*a échoué\s*:\s*/, ''), 220)}.`);
  if (input.limit === 'precondition') {
    if (input.extra?.environment) return out('network', `Les tests du projet échouent avant toute modification pour une raison d’environnement (${clean(input.extra.environment, 160)}), pas d’un test cassé.`);
    return out('base_red', `Les tests du projet échouent déjà avant toute modification${input.extra?.failing ? ` (${clean(input.extra.failing, 200)})` : ''} : impossible de vérifier qu’un nouveau test échoue à cause de lui seul.`);
  }

  // 6. Missing file named by the reason.
  if ((m = ENOENT_RE.exec(why))) { const f = m[1] || m[2] || m[3]; return out('missing_file', `Le fichier \`${f}\` est introuvable.`, { file: f }); }

  return withRepeat(out('unknown', `Cause non établie par le code : ${clean(motif || input.limit || 'aucun motif enregistré', 240)}.`), input);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Same refusal on the last two attempts: noted (the menu offers another approach). */
function withRepeat(d, input) {
  if (isRepeated(input.attempts)) { d.repeated = true; d.cause += ' La même erreur s’est produite à chaque essai.'; }
  return d;
}

/** Proof that the MODEL is at fault, or null (« changer de model » requires one). */
export function modelProof(input = {}) {
  if (input.modelTest && input.modelTest.ok === false && (!input.model || input.modelTest.model === input.model)) return { kind: 'model-test', text: `le test du model ${input.modelTest.model || ''} a échoué : ${clean(input.modelTest.why, 160)}` };
  if (input.succeededElsewhere) return { kind: 'succeeded-elsewhere', text: clean(input.succeededElsewhere, 200) };
  const p = readProviderError(providerText(input));
  if (p?.kind === 'model_unknown') return { kind: 'unknown-model', text: p.line };
  if (p?.kind === 'refusal') return { kind: 'refusal', text: p.line };
  return null;
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

/**
 * Every menu word, with what the engine does with it. `resume`: the run goes
 * on (the option's `effect` is applied first); `abandon`: closed; `test`,
 * `model`: answered, still paused; `accept`, `deleteDoubts`: resume variants.
 */
export const OPTION_KEYS = Object.freeze({
  'continuer': 'resume', 'corriger le test': 'resume', 'écrire le test': 'resume', 'changer d’approche': 'resume',
  'corriger le code': 'resume', 'corriger les références': 'resume', 'créer le fichier': 'resume', 'ajuster le critère': 'resume',
  'découper': 'resume', 'prolonger': 'resume', 'corriger les défauts': 'resume', 'réduire les tests': 'resume',
  'compléter le compte rendu': 'resume', 'respecter le périmètre': 'resume', 'corriger le format': 'resume',
  'réparer': 'resume','réparé': 'resume', 'reconnecté': 'resume', 'relancer après correction': 'resume', 'garder les doutes': 'resume',
  'reprendre les items': 'resume', 'écarter l’item': 'resume', 'relancer l’étape': 'resume', 'refaire le commit': 'resume',
  'autoriser': 'resume', 'relancer l’opération': 'resume',
  'accepter': 'accept', 'tout supprimer': 'deleteDoubts',
  'abandonner': 'abandon', 'simplifier': 'abandon', 'livrer sans eux': 'abandon',
  'tester le model': 'test', 'changer le model': 'model',
});
const keyNorm = (s) => STRIP(s).replace(/[’']/g, '\'').replace(/\s+/g, ' ').trim();

/** The menu word a reply starts with (longest first), or null. Explicit menu words only. */
export function matchOptionKey(reply, keys = Object.keys(OPTION_KEYS)) {
  const r = keyNorm(String(reply || '').replace(/^\s*\[CHEF_ANSWER\]\s*/i, '').replace(/^[«"\s]+/, ''));
  for (const k of [...keys].sort((a, b) => b.length - a.length)) {
    const n = keyNorm(k);
    if (r === n || r.startsWith(`${n} `) || r.startsWith(`${n}.`) || r.startsWith(`${n},`) || r.startsWith(`${n}!`) || r.startsWith(`${n}»`) || r.startsWith(`${n} »`)) return k;
  }
  return null;
}

/**
 * Options derived from the diagnosis. ctx: { project, step: {id,label}, slot,
 * model, delivered: n, canAccept, itemsMax, greenAttempts, criteriaAttempts,
 * reviewRounds, durationText, cwdKind: 'node'|'python'|null, restoreQueue }.
 * → { options: [{key, does, effect?}], recommend: {key, why} }
 */
export function smartMenu(d, ctx = {}) {
  const O = [];
  const add = (key, does, effect = null) => { if (!O.some(o => o.key === key)) O.push({ key, does, ...(effect ? { effect } : {}) }); };
  let rec = null;
  const step = ctx.step?.label || 'l’étape';
  const delivered = ctx.delivered > 0;
  const abandonText = delivered
    ? 'j’arrête : les items déjà livrés restent dans leurs commits, le reste n’est pas livré (ses modifications restent dans le projet).'
    : 'j’arrête et je ne livre rien ; les modifications déjà faites restent dans le projet, non enregistrées dans git.';
  const approach = (text) => add('changer d’approche', `je relance « ${step} » avec une autre méthode : ${text}`, { message: `CHANGER D’APPROCHE (décision prise à la pause, cause : ${d.cause}) — ne refais pas la même tentative. ${text}` });

  switch (d.kind) {
    case 'test_passes':
      add('corriger le test', `je relance « ${step} » avec la consigne : réécrire le test pour qu’il vérifie précisément le comportement qui manque et échoue tant qu’il n’est pas codé ; si ce comportement existe déjà, le déclarer DEJA_COUVERT avec la preuve (fichier:ligne ou commit).`,
        { message: `CORRIGER LE TEST : ${d.cause} Réécris le test pour qu’il vérifie exactement le comportement demandé et ÉCHOUE sur le code actuel. Si le comportement existe déjà dans le code, écris DEJA_COUVERT en tête de l’artefact avec la preuve (fichier:ligne du code de production, ou commit).` });
      if (d.repeated) approach('chercher d’abord dans le code (Grep) où ce comportement est implémenté ; s’il existe, déclarer DEJA_COUVERT avec cette preuve ; sinon écrire un test qui cible l’écart précis trouvé.');
      rec = d.repeated ? ['changer d’approche', 'le même test passant a été refusé à chaque essai : réécrire le test de la même façon échouerait encore ; il faut d’abord établir si le comportement existe déjà.']
        : ['corriger le test', 'c’est le test qui ne vérifie pas ce qui manque : le corriger agit directement sur la cause.'];
      break;
    case 'no_test':
      add('écrire le test', `je relance « ${step} » avec la consigne : nommer d’abord le fichier de test et le cas exact, puis l’écrire réellement (un test qui échoue).`,
        { message: `ÉCRIRE LE TEST : ${d.cause} Commence par écrire dans l’artefact le chemin du fichier de test et le nom du cas, puis crée ou modifie réellement ce fichier.` });
      if (d.repeated) approach('écrire le test dans un NOUVEAU fichier de test dédié à cet item, à côté des tests existants du projet.');
      rec = [d.repeated ? 'changer d’approche' : 'écrire le test', d.repeated ? 'deux essais ont fini sans test : la consigne seule ne suffit pas, un fichier dédié lève l’ambiguïté.' : 'aucun test n’a été écrit : c’est exactement ce qui manque.'];
      break;
    case 'test_wrong':
      add('corriger le test', `je relance « ${step} » avec la consigne : corriger l’erreur du test lui-même (${d.evidence.at(-1)?.text || 'voir la sortie'}${d.file ? `, dans \`${d.file}\`` : ''}) sans toucher au code de production.`,
        { message: `CORRIGER LE TEST : ${d.cause} Corrige d’abord cette erreur dans le fichier de test, puis vérifie que le test échoue ou passe pour la bonne raison.` });
      rec = ['corriger le test', 'l’erreur est dans le test : tant qu’il ne s’exécute pas, aucun code ne peut le faire passer.'];
      break;
    case 'code_wrong':
      add('corriger le code', `je relance « ${step} » en lui donnant l’échec exact à résoudre (${clean(d.failure || '', 120)}).`,
        { message: `CORRIGER LE CODE : ${d.cause} Pars de cet échec exact, lis la fonction en cause, et fais la plus petite modification qui le fait passer.` });
      if (d.repeated) approach('repartir de l’écart exact (valeur attendue contre valeur obtenue), écrire dans l’artefact l’hypothèse de cause AVANT de modifier, et ne modifier que la fonction en cause.');
      rec = d.repeated ? ['changer d’approche', 'la même correction a échoué à chaque essai : la refaire échouerait encore.'] : ['corriger le code', 'l’échec est précis : le donner tel quel à l’étape agit sur la cause.'];
      break;
    case 'no_change':
      add('changer d’approche', `je relance « ${step} » avec une autre méthode : désigner d’abord dans l’artefact le fichier et la fonction à modifier, d’après l’erreur du test, puis les modifier réellement.`,
        { message: `CHANGER D’APPROCHE : ${d.cause} Écris d’abord dans l’artefact quel fichier et quelle fonction tu vas modifier et pourquoi, puis modifie-les réellement.` });
      rec = ['changer d’approche', 'l’étape n’a rien modifié : lui faire nommer la cible avant d’agir lève le blocage.'];
      break;
    case 'cited_paths':
    case 'criterion_strict': {
      if (d.criterion === 'citedPaths') {
        const els = (d.paths || []).filter(p => p.verdict === 'elsewhere');
        const abs = (d.paths || []).filter(p => p.verdict === 'absent');
        if (els.length || abs.length) {
          add('corriger les références', `je relance « ${step} » avec ${els.length ? `les chemins exacts (${els.map(p => `${p.path} → ${p.where[0]}`).join(', ')})` : 'la consigne'}${abs.length ? `${els.length ? ' et ' : ' : '}de ne plus citer ${abs.map(p => p.path).join(', ')} comme existant (le dire « à créer » s’il doit l’être)` : ''}.`,
            { message: `CORRIGER LES RÉFÉRENCES : ${d.cause} ${els.length ? `Chemins exacts : ${els.map(p => `${p.path} → ${p.where[0]}`).join(' ; ')}. ` : ''}${abs.length ? `Ne cite pas ${abs.map(p => p.path).join(', ')} comme un fichier existant : écris « à créer » s’il doit être créé.` : ''}` });
        }
        if (d.falsePositives || (!abs.length)) {
          add('ajuster le critère', 'pour cette exécution seulement, les chemins de l’orchestrateur, abrégés, d’un autre dossier ou présents ailleurs dans le projet sont SIGNALÉS au lieu d’être refusés (trace dans le journal) ; un chemin inventé du projet reste refusé ; je relance l’étape.',
            { relax: { criterion: 'citedPaths' } });
        }
        rec = !abs.length ? ['ajuster le critère', `aucun des chemins n’est inventé (${d.paths.map(p => p.why).join(' ; ')}) : c’est le critère qui se trompe ici.`]
          : ['corriger les références', `${abs.map(p => p.path).join(', ')} n’existe(nt) pas dans le projet : l’étape doit corriger sa référence.`];
      } else if (d.criterion === 'itemTests') {
        const over = (Number(d.written) || 0) - (Number(d.declared) || 0);
        add('ajuster le critère', `j’accepte les ${d.written} tests pour cet item seulement (noté dans le journal et dans le résultat), je le coche et je passe au suivant.`, { relax: { criterion: 'itemTests' } });
        add('réduire les tests', `je relance l’écriture du test de cet item avec la consigne : garder au plus ${d.declared} test(s) (fusionner ou retirer les autres), puis je recompte.`,
          { message: `RÉDUIRE LES TESTS : ${d.cause} Garde au plus ${d.declared} cas de test pour cet item : fusionne ou retire les autres.` });
        rec = over <= 2 ? ['ajuster le critère', `l’écart est faible (${over} test(s) de plus) : les tests en plus protègent le comportement, les retirer n’apporterait rien.`]
          : ['réduire les tests', `l’écart est grand (${over} tests de plus) : l’item est trop large, il faut le resserrer.`];
      } else if (d.criterion === 'duration') {
        add('prolonger', `${ctx.durationText || '90 min'} de travail de plus pour cette exécution seulement, à partir de là où je me suis arrêté.`, { extend: true });
        rec = ['prolonger', 'rien n’indique un travail trop gros : la limite de durée est ici plus stricte que nécessaire.'];
      }
      break;
    }
    case 'missing_file':
      add('créer le fichier', `je relance « ${step} » avec la consigne explicite de créer \`${d.file}\`${/\.md$/.test(d.file || '') ? ' (le compte rendu exigé, avec ses sections)' : ''}, ou de corriger la référence s’il ne doit pas exister.`,
        { message: `CRÉER LE FICHIER : ${d.cause} Crée \`${d.file}\` (au chemin exact attendu), ou corrige la référence qui le désigne s’il ne doit pas exister.` });
      if (d.repeated) approach(`écrire \`${d.file}\` EN PREMIER, avant tout autre travail de l’étape, puis le compléter.`);
      rec = [d.repeated ? 'changer d’approche' : 'créer le fichier', d.repeated ? 'le fichier manquait déjà au premier essai : il faut l’écrire en premier.' : 'c’est exactement le fichier qui manque.'];
      break;
    case 'missing_sections':
      add('compléter le compte rendu', `je relance « ${step} » avec la consigne : écrire les sections manquantes (${d.sections}) dans ${d.file ? `\`${d.file}\`` : 'le compte rendu'}, sous ces titres exacts.`,
        { message: `COMPLÉTER LE COMPTE RENDU : ${d.cause} Ajoute ces sections, sous ces titres exacts, avec leur contenu.` });
      if (d.repeated) approach(`écrire d’abord le squelette du compte rendu avec TOUS les titres exigés (${d.sections}), puis remplir chaque section.`);
      rec = [d.repeated ? 'changer d’approche' : 'compléter le compte rendu', d.repeated ? 'les sections manquaient déjà : partir du squelette des titres évite de les oublier.' : 'il ne manque que ces sections : les nommer suffit.'];
      break;
    case 'scope_violation':
      add('respecter le périmètre', `je relance « ${step} » (ses modifications refusées ont été annulées) avec la consigne : ne modifier que ce que l’étape a le droit de toucher ; ce qu’il faudrait changer ailleurs (${d.files}) est seulement noté dans le compte rendu.`,
        { message: `RESPECTER LE PÉRIMÈTRE : ${d.cause} Ne modifie pas ces fichiers dans cette étape ; si un changement y est nécessaire, écris-le dans l’artefact pour l’étape suivante.` });
      rec = ['respecter le périmètre', 'le travail était refusé pour ce débordement seul : rester dans le périmètre suffit.'];
      break;
    case 'bad_format':
      add('corriger le format', `je relance « ${step} » avec le motif exact du refus de format, pour qu’elle écrive un compte rendu conforme.`,
        { message: `CORRIGER LE FORMAT : ${d.cause} Écris l’artefact exactement au format demandé (JSON valide seul, sans texte autour, si un JSON est attendu).` });
      rec = ['corriger le format', 'le fond n’est pas en cause : seul le format est refusé.'];
      break;
    case 'no_commit':
      add('refaire le commit', 'je relance la livraison avec la consigne : faire réellement le commit (git add des fichiers du travail, puis git commit) et vérifier qu’il existe.',
        { message: `REFAIRE LE COMMIT : ${d.cause} Fais réellement le commit (git add puis git commit), puis vérifie avec git log qu’il existe.` });
      rec = ['refaire le commit', 'le travail est fait, seul le commit manque.'];
      break;
    case 'too_big': {
      const keep = Math.max(0, ctx.keep ?? 0);
      const rest = (d.left || []).slice(keep);
      const names = rest.slice(0, 6).map(t => `« ${clean(String(t).replace(/\(\s*tests?\s*:\s*\d+\s*\)\s*/i, ''), 70)} »`).join(', ');
      add('découper', `${keep ? `je fais les ${keep} premiers tests dans cette exécution, puis je livre` : 'je livre ce qui est déjà fait'} ; les ${rest.length} restants deviennent des demandes séparées, nommées : ${names}${rest.length > 6 ? `, … (+${rest.length - 6})` : ''} (listées dans le résultat, à envoyer ensuite).`,
        { split: { keep } });
      const over = (d.left || []).length - keep;
      if (over <= 3) add('prolonger', `j’accepte les ${(d.left || []).length} tests dans cette exécution seulement (limite agrandie, notée dans le journal).`, { extend: true });
      rec = over <= 3 ? ['prolonger', `la liste ne dépasse que de ${over} test(s) : la découper coûterait plus qu’elle n’apporte.`]
        : ['découper', `il reste ${rest.length} tests : une exécution plus courte par sous-tâche reste vérifiable et livrable.`];
      break;
    }
    case 'review_defects':
      add('corriger les défauts', `un tour de correction ciblé sur ces défauts précis (${(d.defects || []).length || 'les'} défaut(s) cités), puis une nouvelle relecture.`, { extend: true,
        message: `CORRIGER LES DÉFAUTS : ${d.cause}` });
      if (ctx.canAccept) add('accepter', 'vous acceptez ces défauts tels quels : je livre quand même et ils sont notés comme problèmes connus dans le CHANGELOG.');
      rec = ['corriger les défauts', 'les défauts sont nommés et localisés : un tour ciblé les corrige en général.'];
      break;
    case 'env_dependency': {
      const cmd = d.ecosystem === 'python' ? ['pip', 'install', d.package] : ctx.hasLock ? ['npm', 'ci'] : ['npm', 'install'];
      add('réparer', `je lance \`${cmd.join(' ')}\` dans le dossier du projet, puis je reprends l’étape.`, { repair: cmd });
      add('réparé', 'vous avez installé la dépendance vous-même : je reprends l’étape.');
      rec = ['réparer', `la dépendance « ${d.package} » manque : l’installer est la réparation exacte.`];
      break;
    }
    case 'env_port':
      add('réparé', `vous avez libéré le port ${d.port || ''} (arrêt du processus qui l’occupe — je n’arrête jamais un processus moi-même) : je relance les tests et je reprends.`);
      rec = ['réparé', `il faut libérer le port ${d.port || ''} ; l’orchestrateur ne tue jamais un processus qui ne lui appartient pas.`];
      break;
    case 'env_disk':
      add('réparé', 'vous avez libéré de la place sur le disque : je reprends l’étape.');
      rec = ['réparé', 'sans place sur le disque, aucun essai ne peut réussir.'];
      break;
    case 'env_auth':
      add('reconnecté', 'vous avez reconnecté Claude (commande « claude », puis /login) : je relance l’étape aussitôt ; sans réponse, la relance se fait seule dès que la connexion est renouvelée.');
      rec = ['reconnecté', 'seule une nouvelle connexion répare cette cause ; changer de model ou réessayer ne servirait à rien.'];
      break;
    case 'network':
    case 'provider_transient':
    case 'interrupted':
      add('continuer', d.kind === 'interrupted' ? 'je reprends l’exécution à l’étape où elle s’est arrêtée.' : 'je réessaie la même étape, avec le même model, une fois le service revenu.');
      rec = ['continuer', d.kind === 'interrupted' ? 'l’arrêt ne vient pas du travail : la reprise repart là où il s’est arrêté.' : 'la cause est passagère : un nouvel essai suffit en général.'];
      break;
    case 'limit':
      add('continuer', `je reprends quand la limite est levée${d.until ? ` (${d.until})` : ''} — une relance automatique est prévue.`);
      rec = ['continuer', 'la limite est passagère : rien n’est perdu en attendant.'];
      break;
    case 'launch':
      add('continuer', 'je recommence avec le même model, avec les mêmes attentes progressives (la cause peut être passagère).');
      add('tester le model', 'je lance un court test du model et je vous donne son journal complet ; s’il échoue, c’est la preuve que le model est en cause, et vous pourrez alors en changer.');
      rec = ['tester le model', 'le test dira si le model est en cause (alors en changer) ou si la panne est passagère (alors continuer).'];
      break;
    case 'model_unknown':
      rec = ['changer le model', 'le model choisi n’est pas servi : aucun nouvel essai ne le fera exister.'];
      break;
    case 'refusal':
      add('relancer l’étape', 'je relance l’étape dans une session neuve, avec la même consigne (un refus tient parfois à l’historique de la session).', { message: 'NOUVELLE SESSION : la précédente a été refusée par le fournisseur ; reformule sobrement, sans reprendre le contenu refusé.' });
      rec = ['changer le model', 'ce fournisseur refuse ce contenu : un autre model a plus de chances de l’accepter.'];
      break;
    case 'orchestrator':
      add('relancer après correction', 'à répondre une fois l’orchestrateur corrigé (le chef peut le demander à orchestrateur) : je relance l’étape telle quelle ; sans correction, le même refus se reproduirait.');
      rec = ['relancer après correction', 'le défaut est dans l’orchestrateur, pas dans le travail ni le model : seule sa correction débloque l’étape.'];
      break;
    case 'base_red':
      add('réparé', 'vous avez réparé les tests du projet : je les relance et, s’ils passent, je commence le travail.');
      rec = ['abandonner', 'il faut d’abord une base de tests qui passe : envoyez une demande qui répare les tests en échec, puis relancez celle-ci.'];
      break;
    case 'classifier':
      if (d.repair === 'case') add('réparé', 'vous avez affecté un model à la case « routage.classifier » de la page Models : je redemande le choix.');
      else add('relancer l’étape', 'je redemande ce choix au model de la case « routage.classifier » (utile si sa réponse était seulement invalide).');
      rec = [d.repair === 'case' ? 'réparé' : 'relancer l’étape', d.repair === 'case' ? 'sans model affecté, aucun choix ne peut être fait.' : 'une réponse invalide ne se répète pas toujours.'];
      break;
    case 'missing_info':
      add('garder les doutes', 'je supprime seulement les fichiers sûrs, je GARDE les fichiers en doute, puis je range, je vérifie et je livre.');
      add('tout supprimer', 'je supprime aussi les fichiers en doute (une copie de chaque fichier supprimé est gardée), puis je range, je vérifie et je livre.');
      rec = ['garder les doutes', 'rien n’est perdu : un fichier gardé pourra toujours être supprimé plus tard.'];
      break;
    case 'items_blocked':
      add('reprendre les items', 'je reprends les items mis de côté, un à un, avec une allocation de plus chacun, en tenant compte de la raison de chacun ; ceux qui aboutissent sont livrés.', { extend: true });
      if (ctx.canAccept) add('accepter', 'vous acceptez les défauts relevés par la relecture tels quels : je livre quand même, notés comme problèmes connus.');
      add('livrer sans eux', 'j’arrête ici : les items livrés restent dans leurs commits, les items mis de côté restent dans leurs correctifs (à redemander séparément).');
      rec = (d.aside || []).some(a => a.limit === 'item_tests') ? ['livrer sans eux', 'un item qui demande plus de tests que prévu est trop large : mieux vaut le redemander séparément.']
        : ['reprendre les items', 'chaque item mis de côté a une raison précise, donnée à la reprise.'];
      break;
    case 'aside_conflict':
      // Grouped pause (lever asideGroup, 0.139.0): one answer for every stale patch.
      if (ctx.conflicts > 1) add('écarter l’item', `j’écarte ces ${ctx.conflicts} items (leurs modifications restent gardées dans leurs correctifs) puis je passe à la suite (les autres items mis de côté s’il en reste, sinon la fin de l’exécution).`);
      else add('écarter l’item', `j’écarte cet item (ses modifications restent gardées dans son correctif) et je continue avec ${ctx.restoreQueue ? `les ${ctx.restoreQueue} autre(s) item(s) mis de côté` : 'la fin de l’exécution'}.`);
      rec = ['écarter l’item', 'ses modifications ont été dépassées par les items livrés depuis : les réappliquer échouerait toujours.'];
      break;
    case 'authorization':
      add('autoriser', `j’exécute ${(d.operations || []).join(' ; ') || 'ces opérations'}, puis je relis leur effet (postcondition) ; rien d’autre.`, { authorize: true });
      rec = ['autoriser', 'c’est l’action demandée ; seule votre réponse explicite peut l’autoriser (jamais une réponse automatique).'];
      break;
    case 'operation_failed':
      add('relancer l’opération', d.stage === 'precondition'
        ? 'une fois la condition remplie (par vous), je revérifie les conditions et je lance les opérations ; rien n’a été lancé jusqu’ici.'
        : 'une fois la cause corrigée (par vous), je reprends à l’opération en échec ; celles déjà vérifiées ne sont pas relancées.');
      rec = ['relancer l’opération', 'la cause est nommée et rien n’a été fait à l’aveugle : la corriger puis relancer reprend exactement là.'];
      break;
    case 'git_commit':
      add('refaire le commit', 'vous avez corrigé ce que git refuse (crochet, identité, verrou) : je refais le commit de l’item.');
      rec = ['refaire le commit', 'le travail est relu et prêt : seul le commit a échoué.'];
      break;
    default:
      add('relancer l’étape', `je relance « ${step} » en lui donnant le motif exact du refus, pour qu’elle agisse dessus.`, { message: `MOTIF À CORRIGER : ${d.cause}` });
      if (d.repeated) approach('écrire d’abord dans l’artefact ce qui a empêché les essais précédents, puis procéder autrement.');
      rec = [d.repeated ? 'changer d’approche' : 'relancer l’étape', d.repeated ? 'le même refus s’est répété : refaire pareil échouerait encore.' : 'le motif précis est transmis à l’étape.'];
  }
  // « changer le model »: only with a proof that the model is at fault.
  const proof = d.proof || null;
  if (proof) add('changer le model', `choisissez un autre model pour « ${step} » dans la page Models${ctx.slot ? ` (case « ${ctx.slot} »${ctx.model ? `, actuellement ${ctx.model}` : ''})` : ''}, puis répondez « continuer » : je reprends là où je me suis arrêté (preuve : ${clean(proof.text, 140)}).`);
  add('abandonner', abandonText);
  if (!rec || !O.some(o => o.key === rec[0])) rec = [O[0].key, rec?.[1] || 'c’est l’option qui agit sur la cause établie.'];
  return { options: O, recommend: { key: rec[0], why: rec[1] } };
}

/** Rules of the user's request; [] when the menu is valid. */
export function checkMenu(d, menu) {
  const pb = [];
  const keys = (menu?.options || []).map(o => o.key);
  if (!d || !String(d.cause || '').trim()) pb.push('aucune cause énoncée');
  if (keys.includes('continuer') && !d?.transient) pb.push(`« continuer » proposé pour une cause non passagère (${d?.kind})`);
  if (keys.includes('changer le model') && !d?.proof) pb.push('« changer le model » proposé sans preuve que le model est en cause');
  if (!keys.includes('abandonner')) pb.push('« abandonner » absent');
  if (!menu?.recommend?.key || !keys.includes(menu.recommend.key)) pb.push('aucune option recommandée parmi les choix');
  if (!String(menu?.recommend?.why || '').trim()) pb.push('recommandation sans justification');
  for (const o of menu?.options || []) if (!String(o.does || '').trim()) pb.push(`option « ${o.key} » sans description de ce qu’elle fera`);
  for (const k of keys) if (!OPTION_KEYS[k]) pb.push(`mot de menu inconnu : « ${k} »`);
  return pb;
}

/**
 * The menu made valid whatever happens: an option breaking a rule is removed
 * (« continuer » for a lasting cause, « changer le model » without proof),
 * « abandonner » added, the recommendation kept among the options.
 */
export function fixMenu(d, menu) {
  const options = (menu?.options || []).filter(o => OPTION_KEYS[o.key] && String(o.does || '').trim()
    && !(o.key === 'continuer' && !d?.transient) && !(o.key === 'changer le model' && !d?.proof));
  if (!options.some(o => o.key === 'abandonner')) options.push({ key: 'abandonner', does: 'j’arrête ; les modifications déjà faites restent dans le projet, non enregistrées dans git.' });
  let recommend = menu?.recommend;
  if (!recommend?.key || !options.some(o => o.key === recommend.key)) recommend = { key: options[0].key, why: recommend?.why || 'c’est l’option qui agit sur la cause établie.' };
  if (!String(recommend.why || '').trim()) recommend = { ...recommend, why: 'c’est l’option qui agit sur la cause établie.' };
  return { options, recommend };
}

/** The question line: answers and recommendation FIRST (the dashboard cuts at 160 characters). */
export function menuQuestion(project, d, menu) {
  const ks = menu.options.map(o => `« ${o.key} »`);
  const list = ks.length > 1 ? `${ks.slice(0, -1).join(', ')} ou ${ks.at(-1)}` : ks[0];
  return `${project} en pause — répondez ${list} (je recommande « ${menu.recommend.key} ») : ${clean(d.cause, 400)}`;
}

/** Markdown block of the pause message (cause, choices, recommendation). */
export function menuBlock(d, menu) {
  const src = d.source === 'model' ? ` _(cause établie par le model ${d.model || ''} de la case « routage.classifier », le code n’ayant rien trouvé)_` : '';
  return {
    cause: `**Cause** : ${d.cause}${src}`,
    choices: ['**Vos choix** (répondez simplement par le mot entre guillemets) :', ...menu.options.map(o => `- « **${o.key}** » : ${o.does}`)].join('\n'),
    recommend: `**Je recommande « ${menu.recommend.key} »** : ${menu.recommend.why}`,
  };
}

/**
 * The model, only when the code found nothing (kind 'unknown'): ONE short
 * choice among the cause kinds, by the model of the case routage.classifier.
 * `choose` = chooseOption of pipeline-classify.mjs (injected for tests).
 */
export async function diagnoseWithModel(d, input, { choose, root, logsDir, project }) {
  if (d.kind !== 'unknown' || typeof choose !== 'function') return d;
  const kinds = Object.entries(CAUSE_KINDS).filter(([k]) => !['unknown', 'repeated'].includes(k));
  const facts = [
    `Pause « ${input.limit || '?'} » à l’étape « ${input.step?.label || input.step?.id || '?'} ».`,
    `Motif enregistré : ${clean(input.why, 1500)}`,
    input.testOutput ? `Fin de la sortie des tests :\n${String(input.testOutput).slice(-1500)}` : '',
    Array.isArray(input.changed) ? `Fichiers modifiés au dernier essai : ${input.changed.slice(0, 20).join(', ') || 'aucun'}` : '',
  ].filter(Boolean).join('\n');
  let r;
  try {
    r = await choose({ root, logsDir, project, request: facts, question: 'Quelle est la cause la plus probable de cette pause d’un pipeline ? Une seule cause.',
      options: kinds.map(([id, what]) => ({ id, what })), timeoutMs: 60_000 });
  } catch (e) { r = { ok: false, why: e.message }; }
  if (!r?.ok) return { ...d, modelTried: { ok: false, why: clean(r?.why, 200) } };
  const k = r.id;
  return { ...d, kind: k, transient: TRANSIENT_KINDS.includes(k), source: 'model', model: r.model || null,
    cause: `${cap(CAUSE_KINDS[k])}${r.raison ? ` : ${clean(r.raison, 240)}` : ''}.`, evidence: [...d.evidence, { source: 'model', text: clean(r.raison, 240) }] };
}
