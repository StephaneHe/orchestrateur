// ============================================================================
// scripts/model-reco.mjs — suggestions de la page Models (0.46.0)
// ============================================================================
//
// Demande utilisateur (relayée par le chef, réponse « Continue ») : appliquer à
// la page Models la recommandation consolidée de l'étude comparative, EN
// SUGGESTIONS, sans toucher à ses choix.
//
// - Toutes les valeurs viennent de `data/model-recommendations.json` (versionné,
//   régénéré à chaque étude) : ce module ne contient aucun model en dur.
// - `catalogRules()` : models retirés, dominés, annoncés (appliqués au catalogue
//   par model-routing.mjs).
// - `resolve()` : la suggestion de chaque case, et si elle est applicable ici
//   (présente dans les listes, compatible, outil installé…).
// - `applyPlan()` : ce qu'« Appliquer » ferait. « Étapes vides seulement » ne
//   touche jamais une case déjà choisie.
// ============================================================================

import fs from 'node:fs';

const DAY = 86_400_000;

export function createRecommendations({ file, now = () => Date.now() }) {
  let cache = null;   // { mtimeMs, data, error }

  function load() {
    let st;
    try { st = fs.statSync(file); } catch { return { data: null, error: 'fichier de suggestions absent' }; }
    if (cache && cache.mtimeMs === st.mtimeMs) return cache;
    let data = null, error = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      error = validate(data);
      if (error) data = null;
    } catch (e) { error = `fichier de suggestions illisible : ${e.message}`; }
    cache = { mtimeMs: st.mtimeMs, data, error };
    return cache;
  }

  function catalogRules() {
    const d = load().data;
    return d?.catalog || { remove: [], dominated: [], announced: [] };
  }

  /** Âge du rapport : frais, vieillissant (à refaire d'ici 1-2 mois), dépassé. */
  function age(report = load().data?.report) {
    if (!report?.date) return null;
    const days = Math.floor((now() - Date.parse(report.date + 'T00:00:00Z')) / DAY);
    const level = days >= (report.staleAfterDays ?? 60) ? 'stale' : days >= (report.warnAfterDays ?? 30) ? 'aging' : 'fresh';
    return { days: Math.max(0, days), level };
  }

  /** Suggestion d'une case : la sienne, sinon celle de son étape (variante). */
  function mappingOf(d, slotId) {
    const own = d.slots[slotId];
    if (own) return { m: typeof own === 'string' ? { step: own } : own, inherited: false };
    const parts = slotId.split('.');
    if (parts.length === 3) {
      const parent = d.slots[parts.slice(0, 2).join('.')];
      if (parent) return { m: typeof parent === 'string' ? { step: parent } : parent, inherited: true };
    }
    return null;
  }

  /**
   * @param slots       cases effectives (model-routing.effective().slots)
   * @param catalog     catalogue décoré
   * @param incompat    (need, provider, entry, slot) → raison | null
   */
  function resolve(slots, catalog, incompat) {
    const { data, error } = load();
    if (!data) return { ok: false, error, slots: {} };
    const entryOf = (ref) => catalog?.providers?.[ref.provider]?.models?.find(m => m.id === ref.model) || null;
    const availability = (ref, slot) => {
      if (!ref) return { applicable: false, reason: 'aucune suggestion' };
      if (ref.external) return { applicable: false, reason: 'outil ou service hors des listes (pas encore câblé dans l’orchestrateur)' };
      const entry = entryOf(ref);
      if (!entry) return { applicable: false, reason: 'absent des listes actuelles' };
      if (entry.unavailable) return { applicable: false, reason: entry.announced?.note || 'annoncé, pas encore disponible' };
      const why = incompat(slot.need, ref.provider, entry, slot);
      if (why) return { applicable: false, reason: why };
      return { applicable: true };
    };
    const out = {};
    for (const slot of slots) {
      const map = mappingOf(data, slot.id);
      const step = map && data.steps[map.m.step];
      if (!step) continue;
      const principal = map.m.principal || step.principal;
      const alts = (map.m.alternatives || step.alternatives || []).map(a => {
        // Cible (model annoncé) : dès qu'il est réellement dans les listes, il
        // devient l'alternative ; sinon on montre le repli disponible aujourd'hui.
        if (a.target) {
          const live = availability(a, slot);
          return { ...a, available: live.applicable, ...(live.applicable ? {} : { reason: live.reason }) };
        }
        return { ...a, ...(a.external ? {} : { available: availability(a, slot).applicable }) };
      });
      out[slot.id] = {
        step: map.m.step,
        stepLabel: step.label,
        inherited: map.inherited,
        confidence: step.confidence,
        section: step.section,
        why: step.why,
        undecided: !!step.undecided,
        extrapolated: map.m.extrapolated || null,
        note: map.m.note || null,
        principal: { ...principal, ...availability(principal, slot) },
        alternatives: alts,
      };
    }
    return { ok: true, slots: out };
  }

  /**
   * Ce qu'« Appliquer » ferait. mode 'one' : la case demandée (remplace, sur
   * clic explicite). mode 'empty' : les cases sans choix seulement ; une
   * variante dont la suggestion est celle de son étape est laissée vide (elle
   * hérite déjà) — sinon on figerait la variante contre un choix futur de l'étape.
   */
  function applyPlan(resolved, assignments, { mode, slots: wanted = [] }) {
    const plan = [], skipped = [];
    const ids = mode === 'one' ? wanted : Object.keys(resolved);
    for (const id of ids) {
      const r = resolved[id];
      if (!r) { skipped.push({ slot: id, reason: 'aucune suggestion pour cette case' }); continue; }
      if (!r.principal.applicable) { skipped.push({ slot: id, reason: r.principal.reason }); continue; }
      if (mode === 'empty') {
        if (assignments[id]) { skipped.push({ slot: id, reason: 'déjà choisie : jamais modifiée' }); continue; }
        const parts = id.split('.');
        if (parts.length === 3) {
          const parent = resolved[parts.slice(0, 2).join('.')];
          const same = parent && parent.principal.provider === r.principal.provider && parent.principal.model === r.principal.model;
          if (same) { skipped.push({ slot: id, reason: 'hérite déjà de son étape' }); continue; }
        }
      }
      plan.push({ slot: id, provider: r.principal.provider, model: r.principal.model, from: assignments[id] ? `${assignments[id].provider}:${assignments[id].model}` : null });
    }
    return { plan, skipped };
  }

  function view(slots, catalog, incompat) {
    const { data, error } = load();
    if (!data) return { ok: false, error };
    const r = resolve(slots, catalog, incompat);
    const vals = Object.values(r.slots);
    return {
      ok: true,
      report: data.report,
      age: age(data.report),
      catalog: data.catalog,
      slots: r.slots,
      counts: {
        slots: slots.length,
        withSuggestion: vals.length,
        applicable: vals.filter(v => v.principal.applicable).length,
        undecided: vals.filter(v => v.undecided).length,
      },
    };
  }

  return { load, catalogRules, age, resolve, applyPlan, view };
}

/** Contrôle de forme : un fichier mal régénéré est refusé en entier, jamais à moitié. */
export function validate(d) {
  if (!d || typeof d !== 'object') return 'contenu vide';
  if (d.schema !== 1) return `schéma ${d.schema} inconnu (attendu 1)`;
  if (!d.report?.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.report.date)) return 'report.date manquante ou mal formée';
  if (!d.steps || typeof d.steps !== 'object') return 'steps manquant';
  if (!d.slots || typeof d.slots !== 'object') return 'slots manquant';
  const refOk = (r) => r && (typeof r.external === 'string' || (typeof r.provider === 'string' && typeof r.model === 'string'));
  for (const [k, s] of Object.entries(d.steps)) {
    if (!refOk(s.principal)) return `étape ${k} : principal invalide`;
    if (!Array.isArray(s.alternatives)) return `étape ${k} : alternatives manquantes`;
    if (!s.confidence || !s.section) return `étape ${k} : confiance ou section manquante`;
  }
  for (const [id, m] of Object.entries(d.slots)) {
    const step = typeof m === 'string' ? m : m?.step;
    if (!d.steps[step]) return `case ${id} : étape « ${step} » inconnue`;
    if (typeof m === 'object' && m.principal && !refOk(m.principal)) return `case ${id} : principal invalide`;
  }
  return null;
}
