// ============================================================================
// public/models.js — « MODELS PAR TÂCHE » (0.39.0 → 0.40.0 : pipelines)
// ============================================================================
//
// Niveau routé `#/models` de la salle. 13 pipelines en onglets ; chacun est un
// schéma de ses étapes dans l'ordre, avec ses boucles et ses retours dessinés.
// Sur chaque étape : quand / quoi, un exemple, et le menu de model (groupé par
// fournisseur, plus « Outil local » pour le travail média). Les étapes à
// variantes ont un menu par variante, repliable ; une variante vide hérite du
// model de l'étape.
//
// Données : `/api/model-catalog` (listes + capacités) et `/api/model-routing`
// (pipelines, choix, historique, migration). Un choix est enregistré dès qu'il
// change (PUT). Rien ici ne lance de tour : le branchement sur dispatch.mjs
// viendra plus tard.
//
// Désactivable sans redéploiement : `config.json` → `"ui": {"modelRouting":
// false}` (à chaud) ou `?models=0` (ce navigateur).
// ============================================================================
(function (global) {
  "use strict";

  const $  = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LLM = ["anthropic", "openai", "nvidia", "openrouter"];
  const PLABEL = { anthropic: "Anthropic", openai: "OpenAI", nvidia: "NVIDIA", openrouter: "OpenRouter", local: "Outil local / non-LLM" };
  const PSHORT = { anthropic: "ANT", openai: "OAI", nvidia: "NV", openrouter: "OR", local: "LOCAL" };

  const LS = { disabled: "mr.disabled", pipeline: "mr.pipeline", open: "mr.openVariants", migration: "mr.migrationSeen" };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* privé */ } };

  const st = {
    serverOn: true,
    open: false,
    loading: null,
    catalog: null,
    routing: null,
    pipeline: lsGet(LS.pipeline) || "dev",
    openVariants: new Set((lsGet(LS.open) || "").split(",").filter(Boolean)),
    optionsCache: new Map(),   // clé de besoin → HTML des options
    status: {},                // case → { kind: "saving"|"saved"|"error", text }
    error: null,
    refreshing: false,
    showHistory: false,
    showObs: false,            // panneau « Observation » (phase 1 des pipelines)
    obs: null,
    obsError: null,
    showKeys: false,           // panneau « Clés API » (0.43.0) — aucune valeur côté client
    keys: null,
    keysError: null,
    keyNotice: {},             // nom → message après une action
    showGaps: false,           // panneau « Lacunes proposées » (0.42.0)
    gaps: null,
    gapsError: null,
    gapNotice: null,           // message après Accepter / Rejeter
    highlight: null,           // case à mettre en évidence (lacune acceptée)
    reco: null,                // /api/model-recommendations (0.46.0), null si absent
    recoConfirm: null,         // { mode: one|empty, slot?, plan?, skipped?, busy?, error? }
    recoNotice: null,
    gPending: 0,
  };

  // ------------------------------------------------------------------------
  // Activation
  // ------------------------------------------------------------------------
  function localOff() { return lsGet(LS.disabled) === "1"; }
  function enabled() { return st.serverOn && !localOff(); }

  function readUrlParam() {
    const m = /[?&]models=([^&#]*)/.exec(location.search);
    if (!m) return;
    const v = decodeURIComponent(m[1]).toLowerCase();
    if (v === "0" || v === "off" || v === "non") lsSet(LS.disabled, "1");
    if (v === "1" || v === "on"  || v === "oui") lsSet(LS.disabled, null);
  }

  function applyUi(ui) {
    const on = !(ui && ui.modelRouting === false);
    if (on === st.serverOn) return;
    st.serverOn = on;
    syncEntryPoints();
    if (!enabled() && isRoute()) location.replace("#/");
  }

  function syncEntryPoints() {
    const on = enabled();
    const pill = document.getElementById("btn-models");
    if (pill) { pill.hidden = !on; pill.setAttribute("aria-pressed", st.open ? "true" : "false"); }
    const mi = document.querySelector('#topmenu [data-act="models"]');
    if (mi) mi.hidden = !on;
  }

  function isRoute() { return String(location.hash || "") === "#/models"; }
  function root() { return document.getElementById("models"); }

  // ------------------------------------------------------------------------
  // Données
  // ------------------------------------------------------------------------
  async function getJson(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch { /* corps vide */ }
    if (!r.ok) {
      const e = new Error(j?.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }

  async function load(refresh) {
    if (st.loading) return st.loading;
    st.loading = (async () => {
      try {
        const [catalog, routing] = await Promise.all([
          getJson("/api/model-catalog" + (refresh ? "?refresh=1" : "")),
          getJson("/api/model-routing"),
        ]);
        if (!Array.isArray(routing.pipelines)) {
          throw Object.assign(new Error("ancien serveur"), { status: 426 });
        }
        st.catalog = catalog;
        st.routing = routing;
        st.error = null;
        // Suggestions de l'étude comparative (0.46.0) : facultatives — un serveur
        // plus ancien ne les a pas, la vue reste utilisable sans elles.
        st.reco = await getJson("/api/model-recommendations").catch(() => null);
        st.optionsCache.clear();
        if (!pipeline()) st.pipeline = routing.pipelines[0].id;
      } catch (e) {
        st.error = e.status === 404 || e.status === 426
          ? "Le serveur ne connaît pas encore cette version de la vue : il doit être redémarré (version ≥ 0.40.0)."
          : `Chargement impossible : ${e.message}`;
      } finally {
        st.loading = null;
      }
    })();
    return st.loading;
  }

  const pipeline = () => st.routing?.pipelines?.find(p => p.id === st.pipeline) || null;
  const slotById = (id) => st.routing?.slots?.find(s => s.id === id) || null;
  const assigned = (slot) => st.routing?.assignments?.[slot] || null;
  const valueOf = (slot) => { const a = assigned(slot); return a ? `${a.provider}|${a.model}` : ""; };
  // Mode double model (0.44.0) : le second, optionnel, à côté du principal.
  const secondOf = (slot) => assigned(slot)?.second || null;
  const valueOf2 = (slot) => { const b = secondOf(slot); return b ? `${b.provider}|${b.model}` : ""; };

  function stepsOf(p) {
    const out = [];
    for (const n of p.flow) {
      if (n.kind === "loop") for (const s of n.steps) out.push(s);
      else out.push(n);
    }
    return out;
  }

  /** Model effectif d'une case : la sienne, sinon celle de son étape. */
  function effective(slotId) {
    const a = assigned(slotId);
    if (a) return a;
    const parts = slotId.split(".");
    return parts.length === 3 ? assigned(parts.slice(0, 2).join(".")) : null;
  }

  /** Famille d'un model (pour le conseil « autre famille »). */
  function family(a) {
    if (!a || a.provider === "local") return null;
    if (a.provider === "anthropic") return "Claude";
    if (a.provider === "openai") return "GPT";
    const v = String(a.model).replace(/^~/, "").split("/")[0].toLowerCase();
    const map = { anthropic: "Claude", openai: "GPT", google: "Gemini", meta: "Llama", "meta-llama": "Llama",
      "deepseek-ai": "DeepSeek", deepseek: "DeepSeek", moonshotai: "Kimi", qwen: "Qwen", "z-ai": "GLM",
      mistralai: "Mistral", "nv-mistralai": "Mistral", nvidia: "Nemotron", "x-ai": "Grok" };
    return map[v] || v;
  }

  // ------------------------------------------------------------------------
  // Menus déroulants
  // ------------------------------------------------------------------------
  function capLabel(c) { return st.routing?.caps?.[c] || c; }

  function optionsFor(slot) {
    const need = slot.need || { llm: "text", local: [] };
    const isVariant = !!slot.variant;
    // Étape d'action : un fournisseur sans harnais d'agent n'y est pas sélectionnable.
    const action = need.llm === "text" && !slot.judge;
    const key = `${need.llm}|${(need.local || []).join(",")}|${isVariant}|${action}`;
    if (st.optionsCache.has(key)) return st.optionsCache.get(key);
    let html = `<option value="">${isVariant ? "(model de l’étape)" : "(défaut du projet)"}</option>`;
    for (const p of LLM) {
      const c = st.catalog?.providers?.[p] || {};
      const all = c.models || [];
      const ok = need.llm ? all.filter(m => (m.caps || []).includes(need.llm)) : [];
      let label = `${PLABEL[p]} (${ok.length})`;
      let disabled = false;
      if (!need.llm) { label = `${PLABEL[p]} — un LLM ne convient pas ici`; disabled = true; }
      else if (!all.length) { label = `${PLABEL[p]} — liste indisponible`; disabled = true; }
      else if (!ok.length) { label = `${PLABEL[p]} — aucun model « ${capLabel(need.llm)} »`; disabled = true; }
      else if (action && st.routing?.agentHarness?.[p] === false) { label = `${PLABEL[p]} — 🔧 outillage en construction : pas encore pour une étape d’action (${ok.length})`; disabled = true; }
      else if (p === "openrouter" && c.disabled) { label = `${PLABEL[p]} — clé non configurée (${ok.length})`; disabled = true; }
      html += `<optgroup label="${esc(label)}" data-provider="${p}"${disabled ? " disabled" : ""}>`;
      for (const m of ok) {
        // Étude comparative : « dominé » (atténué, raison et source au survol),
        // « annoncé » (visible, non sélectionnable tant qu'il n'est pas dans la liste).
        const title = m.dominated ? `Dominé par ${m.dominated.by} : ${m.dominated.reason} (source : ${m.dominated.source})`
          : m.announced ? `${m.announced.note} (source : ${m.announced.source})` : (m.hint || "");
        const label = (m.label || m.id) + (m.dominated ? " · dominé" : "");
        html += `<option value="${esc(p + "|" + m.id)}"${title ? ` title="${esc(title)}"` : ""}${m.dominated ? ' class="is-dominated" data-dominated="1"' : ""}${m.unavailable ? ' disabled data-announced="1"' : ""}>${esc(label)}</option>`;
      }
      html += "</optgroup>";
    }
    if (need.local && need.local.length) {
      const tools = (st.catalog?.providers?.local?.models || []).filter(t => t.caps.some(x => need.local.includes(x)));
      const n = tools.filter(t => t.installed).length;
      html += `<optgroup label="${esc(`${PLABEL.local} (${n} installé${n > 1 ? "s" : ""})`)}" data-provider="local">`;
      for (const t of tools) html += `<option value="${esc("local|" + t.id)}"${t.installed ? "" : " disabled"}>${esc(t.label)}</option>`;
      html += "</optgroup>";
    }
    st.optionsCache.set(key, html);
    return html;
  }

  /** Un choix enregistré absent de la liste (ou incompatible) reste visible et sélectionné. */
  function ensureOption(sel, value) {
    if (!value) return;
    const existing = [...sel.options].find(o => o.value === value);
    if (existing && !existing.disabled && !existing.parentElement?.disabled) return;
    // Hors de tout groupe désactivé, juste sous l'option « hérité ».
    existing?.remove();
    const [p, ...rest] = value.split("|");
    const o = document.createElement("option");
    o.value = value;
    const gone = removedInfo(p, rest.join("|"));
    o.textContent = gone
      ? `⚠ obsolète : ${rest.join("|")} (retiré — ${gone.reason})`
      : `${PLABEL[p] || p} · ${rest.join("|")} (absent de la liste ou incompatible)`;
    if (gone) { o.dataset.obsolete = "1"; o.title = `Retiré : ${gone.reason} (source : ${gone.source}). Le choix est conservé tant que vous ne le changez pas.`; }
    // Juste après l'option « hérité », hors des groupes (options[1] est dans un
    // <optgroup> : insertBefore sur lui levait une exception).
    sel.insertBefore(o, sel.firstElementChild ? sel.firstElementChild.nextSibling : null);
  }

  /** Model retiré des listes par l'étude comparative (null sinon). */
  function removedInfo(provider, model) {
    return (st.catalog?.removed || []).find(r => r.provider === provider && r.model === model) || null;
  }

  function fillSelect(sel) {
    const slot = slotById(sel.dataset.slot);
    if (!slot) return;
    const second = sel.dataset.role === "second";
    sel.innerHTML = second
      ? optionsFor(slot).replace(/^<option value="">[^<]*<\/option>/, '<option value="">(aucun — exécution simple)</option>')
      : optionsFor(slot);
    const v = second ? valueOf2(slot.id) : valueOf(slot.id);
    ensureOption(sel, v);
    sel.value = v;
    sel.dataset.filled = "1";
  }

  // ------------------------------------------------------------------------
  // Rendu
  // ------------------------------------------------------------------------
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function slotLabel(id) { return slotById(id)?.label || id; }

  function shortModel(a) {
    if (!a) return "";
    const m = String(a.model);
    return m.length > 26 ? m.slice(0, 25) + "…" : m;
  }

  function sourcesHtml() {
    const c = st.catalog?.providers || {};
    const items = LLM.map(p => {
      const s = c[p] || {};
      const n = (s.models || []).length;
      let extra = "";
      if (p === "openrouter") {
        extra = s.keyPresent
          ? ` · clé présente (${esc((s.keyWhere || []).join(", "))})`
          : ' · <b class="mr-warn">clé non configurée</b>';
      }
      if (st.routing?.agentHarness?.[p] === false) extra += ' · <b class="mr-warn">🔧 outillage d’agent en construction (étapes de jugement seulement)</b>';
      if (p === "nvidia") {
        const miss = (s.models || []).filter(m => m.missing).length;
        if (miss) extra += ` · <b class="mr-warn">${miss} model(s) du failover absent(s) du catalogue</b>`;
      }
      const err = s.error ? ` · <b class="mr-warn">${esc(s.error)}${s.stale ? " — dernière liste connue" : ""}</b>` : "";
      const when = !s.fetchedAt ? ""
        : p === "anthropic" ? ` · vérifiée le ${esc(new Date(s.fetchedAt).toLocaleDateString("fr-FR"))}`
        : ` · ${esc(fmtTime(s.fetchedAt) || s.fetchedAt)}`;
      return `<li class="mr-src" data-provider="${p}" title="${esc(s.source || "")}">
        <span class="mr-ptag" data-provider="${p}">${PSHORT[p]}</span> <b>${PLABEL[p]}</b> ${n} models${when}${extra}${err}</li>`;
    });
    const loc = c.local?.models || [];
    const inst = loc.filter(t => t.installed);
    items.push(`<li class="mr-src" data-provider="local" title="${esc(c.local?.source || "")}">
      <span class="mr-ptag" data-provider="local">LOCAL</span> <b>Outils locaux</b> ${inst.length}/${loc.length} installés :
      ${esc(inst.map(t => t.id).join(", ") || "aucun")}</li>`);
    return items.join("");
  }

  function legendHtml() {
    const open = !(global.matchMedia && global.matchMedia("(max-width: 767.98px)").matches);
    return `<details class="mr-legend"${open ? " open" : ""}><summary>Légende des symboles</summary>
      <ul>
        <li><span class="mr-sym">→</span> étape suivante, dans l’ordre</li>
        <li><span class="mr-sym mr-sym-loop">↻</span> boucle : on recommence ces étapes</li>
        <li><span class="mr-sym mr-sym-ret">↩</span> retour possible vers une étape antérieure</li>
        <li><span class="mr-sym mr-sym-ref">⤳</span> renvoi vers un autre pipeline (ses models s’appliquent)</li>
        <li><span class="mr-sym mr-sym-opt">┄</span> cadre en pointillés : étape optionnelle ou conditionnelle</li>
        <li><span class="mr-sym">◇</span> variantes : un menu par cas ; vide = model de l’étape</li>
        <li><span class="mr-ptag" data-provider="anthropic">ANT</span><span class="mr-ptag" data-provider="openai">OAI</span><span class="mr-ptag" data-provider="nvidia">NV</span><span class="mr-ptag" data-provider="openrouter">OR</span><span class="mr-ptag" data-provider="local">LOCAL</span> couleur = fournisseur choisi (bordure de l’étape)</li>
        <li><span class="mr-sym">💡</span> conseil (non imposé) · <span class="mr-sym">⚠</span> conseil non suivi</li>
        <li><span class="mr-kind" data-kind="action">action</span> lit, écrit ou exécute dans le projet · <span class="mr-kind" data-kind="judge">jugement</span> rend un avis sur un texte fourni</li>
        ${Object.entries(st.routing?.agentHarness || {}).some(([, v]) => v === false)
          ? `<li><span class="mr-sym">🔧</span> outillage en construction : ${esc(Object.entries(st.routing.agentHarness).filter(([, v]) => v === false).map(([k]) => PLABEL[k] || k).join(" et "))}, étapes de jugement seulement pour l’instant</li>`
          : `<li><span class="mr-sym">🔧</span> tous les fournisseurs sont outillés : NVIDIA et OpenRouter agissent comme Claude et codex (harnais codex)</li>`}
      </ul></details>`;
  }

  function tabsHtml() {
    return st.routing.pipelines.map(p => {
      const slots = st.routing.slots.filter(s => s.pipeline === p.id);
      const n = slots.filter(s => assigned(s.id)).length;
      const sel = p.id === st.pipeline;
      return `<button class="mr-tab" role="tab" type="button" id="mr-tab-${esc(p.id)}" data-pipeline="${esc(p.id)}"
        aria-selected="${sel}" aria-controls="mr-panel" tabindex="${sel ? 0 : -1}">
        <span class="mr-tab-ic" aria-hidden="true">${esc(p.icon || "")}</span>${esc(p.label)}
        <span class="mr-tab-count" data-tab-count="${esc(p.id)}">${n}/${slots.length}</span></button>`;
    }).join("");
  }

  function historyHtml() {
    const h = st.routing?.history || [];
    if (!h.length) return '<p class="mr-empty">Aucun changement enregistré.</p>';
    return `<ol class="mr-hist-list">${h.map(e => `
      <li><time datetime="${esc(e.at)}">${esc(fmtTime(e.at))}</time>
        <span class="mr-hist-task">${esc(slotLabel(e.task))}${e.role === "second" ? ' <span class="mr-dual-badge">second</span>' : ""}</span>
        <span class="mr-hist-from">${esc(e.from || "(hérité)")}</span>
        <span aria-hidden="true">→</span><span class="sr-only">devient</span>
        <span class="mr-hist-to">${esc(e.to || "(hérité)")}</span>
        ${e.by && e.by !== "dashboard" ? `<span class="mr-hist-by">${esc(e.by)}</span>` : ""}</li>`).join("")}</ol>
      ${st.routing.historyTotal > h.length ? `<p class="mr-empty">${h.length} derniers sur ${st.routing.historyTotal}.</p>` : ""}`;
  }

  // --- Observation (phase 1) : classifications récentes, rien n'est imposé ---
  function pipelineLabel(id) { return st.routing?.pipelines?.find(p => p.id === id)?.label || id; }

  function obsHtml() {
    if (st.obsError) return `<p class="mr-error" role="alert">${esc(st.obsError)}</p>`;
    const o = st.obs;
    if (!o) return '<p class="mr-empty">Chargement des classifications…</p>';
    const by = o.counts?.byPipeline || {};
    const chips = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([p, n]) =>
      `<span class="mr-obs-chip" data-pipeline="${esc(p)}">${esc(pipelineLabel(p))} <b>${n}</b></span>`).join("");
    const rows = (o.items || []).map(r => `<tr data-entry="${esc(r.entry)}" data-pipeline="${esc(r.pipeline)}">
        <td><time datetime="${esc(r.at)}">${esc(fmtTime(r.at))}</time></td>
        <td title="${esc(o.entryKinds?.[r.entry] || r.entry)}">${esc(r.entry)}</td>
        <td>${esc(r.project || "—")}${r.target ? ` → ${esc(r.target)}` : ""}${r.caller ? ` <span class="mr-obs-dim">(par ${esc(r.caller)})</span>` : ""}</td>
        <td><b>${esc(pipelineLabel(r.pipeline))}</b>${r.mode ? ` · ${esc(r.mode === "leger" ? "léger" : r.mode)}` : ""}
          ${r.explicit ? '<span class="mr-obs-tag">explicite</span>' : ""}${r.unclassifiable ? '<span class="mr-obs-tag mr-warn">inclassable → Discussion</span>' : ""}
          ${r.modeUncertain ? '<span class="mr-obs-tag">mode incertain → léger</span>' : ""}${r.gap ? '<span class="mr-obs-tag mr-warn">⚑ lacune proposée</span>' : ""}</td>
        <td class="mr-obs-dim">${esc(r.confidence || "")}</td>
        <td class="mr-obs-head" title="${esc((r.reasons || []).join(" ; "))}">${esc(r.head || "")}</td>
      </tr>`).join("");
    return `<p class="mr-obs-intro"><b>Phase 1 — observation.</b> Chaque entrée (composer, @musicien, app, dispatch.mjs, file, réveil,
        relais, notify, session neuve, terminal interactif) est classée et journalisée ; <b>rien n’est encore imposé</b>.
        Inclassable = Discussion. Classifieur : ${esc(o.classifier || "")} (${o.total || 0} entrées journalisées).</p>
      <div class="mr-obs-chips">${chips || '<span class="mr-empty">Aucune entrée pour l’instant.</span>'}
        ${o.counts?.unclassifiable ? `<span class="mr-obs-chip mr-warn">inclassables <b>${o.counts.unclassifiable}</b></span>` : ""}</div>
      ${rows ? `<div class="mr-obs-scroll"><table class="mr-obs-table">
        <thead><tr><th>Heure</th><th>Entrée</th><th>Projet</th><th>Pipeline · mode</th><th>Confiance</th><th>Demande</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ""}
      <button type="button" class="mr-obs-reload">↻ Actualiser</button>`;
  }

  async function loadObs() {
    try {
      st.obs = await getJson("/api/pipeline-observe?n=100");
      st.obsError = null;
    } catch (e) {
      st.obsError = e.status === 404
        ? "Le serveur ne journalise pas encore les classifications : il doit être redémarré (version ≥ 0.41.0)."
        : `Chargement impossible : ${e.message}`;
    }
    const box = root()?.querySelector(".mr-obs");
    if (box) box.innerHTML = '<h2 class="mr-h2">Classifications récentes</h2>' + obsHtml();
    patch();
  }

  // --- Clés API (0.43.0) : la valeur n'est jamais lue, gardée ni affichée ---
  function keyStateHtml(k) {
    if (!k.configured) return '<span class="mr-key-state" data-state="absente">○ absente</span>';
    if (k.valid === false) return '<span class="mr-key-state" data-state="invalide">✕ invalide</span>';
    if (k.valid === true) return '<span class="mr-key-state" data-state="valide">✓ configurée · acceptée</span>';
    return '<span class="mr-key-state" data-state="configuree">✓ configurée · non vérifiée</span>';
  }

  function keysHtml() {
    if (st.keysError) return `<p class="mr-error" role="alert">${esc(st.keysError)}</p>`;
    if (!st.keys) return '<p class="mr-empty">Chargement de l’état des clés…</p>';
    return `<p class="mr-obs-intro">Les clés sont écrites dans le <code>.env</code> de l’orchestrateur (non versionné) et prises en compte
        immédiatement. <b>Leur valeur n’est jamais renvoyée ni affichée</b> : seuls ses 4 derniers caractères le sont.</p>
      ${st.keys.map(k => `<div class="mr-key" data-key="${esc(k.name)}">
        <div class="mr-key-head"><b>${esc(k.label)}</b> ${keyStateHtml(k)}
          ${k.last4 ? `<span class="mr-key-mask" title="4 derniers caractères">••••${esc(k.last4)}</span>` : ""}
          ${k.source ? `<span class="mr-obs-dim">source : ${esc(k.source)}</span>` : ""}
          ${k.checkedAt ? `<span class="mr-obs-dim">vérifiée ${esc(fmtTime(k.checkedAt))}</span>` : ""}</div>
        <p class="mr-key-usage">${esc(k.usage)}${k.detail ? ` — <span class="mr-obs-dim">${esc(k.detail)}</span>` : ""}</p>
        <form class="mr-key-form" data-key="${esc(k.name)}" autocomplete="off">
          <label class="sr-only" for="mr-key-in-${esc(k.name)}">Nouvelle clé ${esc(k.label)}</label>
          <input id="mr-key-in-${esc(k.name)}" class="mr-key-input" type="password" autocomplete="new-password" spellcheck="false"
                 placeholder="${k.configured ? "Remplacer la clé…" : `Coller la clé ${esc(k.label)}…`}">
          <button type="submit" class="mr-key-save">Enregistrer</button>
          <button type="button" class="mr-key-test" ${k.configured ? "" : "disabled"}>Tester</button>
          <button type="button" class="mr-key-del" ${k.deletable ? "" : "disabled"} title="${k.deletable ? "Retirer la clé du .env" : k.configured ? "Clé fournie par l’environnement du serveur" : "Aucune clé"}">Supprimer</button>
        </form>
        <p class="mr-key-notice" role="status">${esc(st.keyNotice[k.name] || "")}</p>
      </div>`).join("")}`;
  }

  function renderKeys() {
    const box = root()?.querySelector(".mr-keys");
    if (box) box.innerHTML = '<h2 class="mr-h2">Clés API</h2>' + keysHtml();
    const b = root()?.querySelector(".mr-keys-btn");
    if (b) {
      const missing = (st.keys || []).filter(k => !k.configured || k.valid === false).length;
      b.textContent = missing && st.keys ? `🔑 Clés API (${missing} à régler)` : "🔑 Clés API";
      b.setAttribute("aria-expanded", st.showKeys ? "true" : "false");
    }
    if (box) box.hidden = !st.showKeys;
  }

  async function loadKeys() {
    try {
      st.keys = (await getJson("/api/api-keys")).keys;
      st.keysError = null;
    } catch (e) {
      st.keysError = e.status === 404
        ? "Le serveur ne connaît pas encore cette section : il doit être redémarré (version ≥ 0.43.0)."
        : `Chargement impossible : ${e.message}`;
    }
    renderKeys();
  }

  /** Après un changement de clé : le catalogue (groupe OpenRouter grisé ou non) est relu. */
  async function afterKeyChange() {
    try { st.catalog = await getJson("/api/model-catalog"); st.optionsCache.clear(); } catch { /* menus inchangés */ }
    renderShell();
  }

  async function keyAction(name, action, input) {
    const k = (st.keys || []).find(x => x.name === name);
    try {
      let r;
      if (action === "save") {
        const value = input.value.trim();
        input.value = "";               // la valeur ne reste ni dans le champ ni dans l'état
        if (!value) { st.keyNotice[name] = "Collez d’abord une clé."; renderKeys(); return; }
        st.keyNotice[name] = "Enregistrement et vérification…"; renderKeys();
        r = await getJson(`/api/api-keys/${encodeURIComponent(name)}`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
        });
      } else if (action === "test") {
        st.keyNotice[name] = "Vérification…"; renderKeys();
        r = await getJson(`/api/api-keys/${encodeURIComponent(name)}/test`, { method: "POST" });
      } else {
        if (!confirm(`Retirer la clé ${k?.label || name} du .env ?`)) return;
        r = await getJson(`/api/api-keys/${encodeURIComponent(name)}`, { method: "DELETE" });
      }
      st.keyNotice[name] = action === "del" ? "Clé retirée."
        : r.key.valid === true ? "Clé enregistrée et acceptée par le fournisseur."
        : r.key.valid === false ? "Clé refusée par le fournisseur (invalide)."
        : `Clé enregistrée — vérification impossible : ${r.key.detail || "?"}`;
      await loadKeys();
      await afterKeyChange();
    } catch (e) {
      st.keyNotice[name] = `Échec : ${e.message}`;
      renderKeys();
    }
  }

  // --- Lacunes proposées (0.42.0) : rien n'est forcé, tout est proposé ---
  function gapProposalHtml(p, key, choice) {
    if (!p) return "";
    const kind = { pipeline: "nouveau pipeline", variante: "nouvelle variante", etape: "nouvelle étape", rattachement: "rattachement" }[p.kind] || p.kind;
    return `<div class="mr-gap-prop" data-choice="${choice}">
      <span class="mr-gap-kind">${esc(kind)}</span> ${esc(p.text || "")}
      <button type="button" class="mr-gap-accept" data-gap="${esc(key)}" data-choice="${choice}">✓ ${choice === "primary" ? "Accepter" : "Accepter l’alternative"}</button>
    </div>`;
  }

  function gapsHtml() {
    if (st.gapsError) return `<p class="mr-error" role="alert">${esc(st.gapsError)}</p>`;
    const g = st.gaps;
    if (!g) return '<p class="mr-empty">Chargement des lacunes…</p>';
    const notice = st.gapNotice ? `<p class="mr-gap-notice" role="status">${esc(st.gapNotice)}</p>` : "";
    const open = (g.open || []).map(x => `<article class="mr-gap" data-gap-key="${esc(x.key)}">
        <header><b>« ${esc(x.entries?.[0]?.head || "")} »</b>
          <span class="mr-obs-dim">${esc(x.entries?.[0]?.entry || "")}${x.entries?.[0]?.project ? " · " + esc(x.entries[0].project) : ""}
          · ${x.count} fois · ${esc(fmtTime(x.lastAt))}</span></header>
        <p class="mr-gap-why">${esc(x.why || "")} — traitée en ${esc(pipelineLabel(x.entries?.[0]?.pipeline || "discussion"))} en attendant.</p>
        ${gapProposalHtml(x.proposal, x.key, "primary")}
        ${gapProposalHtml(x.alternative, x.key, "alternative")}
        <button type="button" class="mr-gap-reject" data-gap="${esc(x.key)}">✕ Rejeter</button>
      </article>`).join("");
    const decided = (g.decided || []).map(x => `<li>${esc(x.entries?.[0]?.head || x.key)} —
        <b>${x.decision?.decision === "accepted" ? "acceptée" : "rejetée"}</b>${x.decision?.applied ? ` (${esc(x.decision.applied.kind)} ${esc(x.decision.applied.label || x.decision.applied.pipeline || "")})` : ""}</li>`).join("");
    return `${notice}<p class="mr-obs-intro">Quand une demande ou une étape ne rentre dans aucun pipeline, ou seulement de façon floue,
        elle n’est <b>pas classée de force</b> : elle est traitée en Discussion et une <b>proposition</b> arrive ici (et au chef).
        Accepter ajoute la tâche à la structure ; il reste à lui choisir un model.</p>
      ${open || '<p class="mr-empty">Aucune lacune ouverte.</p>'}
      ${decided ? `<details class="mr-gap-decided"><summary>Déjà traitées (${g.decided.length})</summary><ul>${decided}</ul></details>` : ""}`;
  }

  function syncGapBadges() {
    const n = st.gaps?.open?.length || 0;
    const el = root();
    const b = el && $(".mr-gaps-btn", el);
    if (b) {
      b.textContent = n ? `Lacunes proposées (${n})` : "Lacunes proposées";
      b.classList.toggle("has-gaps", n > 0);
      b.setAttribute("aria-expanded", st.showGaps ? "true" : "false");
    }
    const pill = document.querySelector("#btn-models .pm-k");
    if (pill) pill.textContent = n ? `⇄ Models · ${n} ⚑` : "⇄ Models";
    const box = el && $(".mr-gaps", el);
    if (box) box.hidden = !st.showGaps;
  }

  async function loadGaps() {
    try {
      st.gaps = await getJson("/api/pipeline-gaps");
      st.gapsError = null;
    } catch (e) {
      st.gapsError = e.status === 404
        ? "Le serveur ne connaît pas encore les lacunes : il doit être redémarré (version ≥ 0.42.0)."
        : `Chargement impossible : ${e.message}`;
    }
    const box = root()?.querySelector(".mr-gaps");
    if (box) box.innerHTML = '<h2 class="mr-h2">Lacunes proposées</h2>' + gapsHtml();
    syncGapBadges();
  }

  async function decideGap(key, action, choice) {
    try {
      const r = await getJson(`/api/pipeline-gaps/${encodeURIComponent(key)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "accept" ? { choice } : {}),
      });
      if (action === "accept" && r.applied) {
        st.routing = await getJson("/api/model-routing");
        st.optionsCache.clear();
        const a = r.applied;
        st.gapNotice = `✓ Acceptée : ${a.kind} « ${a.label || a.pipeline} » ajouté au pipeline ${pipelineLabel(a.pipeline)} — choisissez son model ci-dessous.`;
        if (a.slot) {
          const parts = a.slot.split(".");
          if (parts.length === 3) st.openVariants.add(parts.slice(0, 2).join("."));
          st.highlight = a.slot;
        }
        st.pipeline = a.pipeline;
        lsSet(LS.pipeline, a.pipeline);
        await loadGaps();
        renderShell();
        const sel = a.slot && root().querySelector(`.mr-select[data-slot="${CSS.escape(a.slot)}"]`);
        if (sel) { sel.closest(".mr-card, .mr-var")?.classList.add("is-new"); sel.scrollIntoView?.({ block: "center" }); sel.focus(); }
      } else {
        st.gapNotice = "✕ Lacune rejetée : rien n’est ajouté.";
        await loadGaps();
      }
    } catch (e) {
      st.gapNotice = `Échec : ${e.message}`;
      await loadGaps();
    }
  }

  function migrationHtml() {
    const m = st.routing?.migration;
    if (!m || lsGet(LS.migration) === m.at) return "";
    const lost = m.lost || [];
    return `<div class="mr-migration" role="status">
      <b>Migration depuis l’ancienne structure (20 types en 6 étapes)</b> :
      ${m.mapped.length} affectation(s) reprise(s)${lost.length ? `, <b class="mr-warn">${lost.length} perdue(s)</b>` : ", aucune perdue"}.
      <details><summary>Détail</summary><ul>
        ${m.mapped.map(x => `<li>${esc(x.from)} (${esc(x.model)}) → ${x.to.map(t => esc(slotLabel(t))).join(" ; ")}</li>`).join("")}
        ${lost.map(x => `<li class="mr-warn">${esc(x.from)} (${esc(x.model || "?")}) : perdue — ${esc(x.reason)}</li>`).join("")}
      </ul></details>
      <button type="button" class="mr-mig-ok">Compris</button></div>`;
  }

  function needHtml(need) {
    if (!need || (need.llm === "text" && !(need.local || []).length)) return "";
    const parts = [];
    if (need.llm) parts.push(`un model capable de <b>${esc(capLabel(need.llm))}</b>`);
    if ((need.local || []).length) parts.push("un outil local");
    return `<p class="mr-need">Exige : ${parts.join(" ou ")}.</p>`;
  }

  function selectHtml(slotId, label, isVariant) {
    const lazy = isVariant ? ' data-lazy="1"' : "";
    // Principal (obligatoire, ou défaut du projet) et second (optionnel) : avec
    // un second, la tâche tourne sur les deux puis le principal relit.
    return `<div class="mr-sel-pair">
        <div class="mr-sel-col"><label class="mr-sel-label" for="mr-sel-${esc(slotId)}">Principal · ${esc(label)}</label>
          <select class="mr-select" id="mr-sel-${esc(slotId)}" data-slot="${esc(slotId)}"${lazy}></select></div>
        <div class="mr-sel-col mr-sel-second"><label class="mr-sel-label" for="mr-sel2-${esc(slotId)}">Second (optionnel)</label>
          <select class="mr-select2" id="mr-sel2-${esc(slotId)}" data-slot="${esc(slotId)}" data-role="second"${lazy}></select></div>
      </div>
      <p class="mr-dual-note" data-dual="${esc(slotId)}" hidden></p>
      <p class="mr-obsolete" data-obsolete-warn="${esc(slotId)}" hidden></p>
      <div class="mr-status" data-status="${esc(slotId)}" aria-live="polite"></div>
      <div class="mr-reco" data-reco="${esc(slotId)}"></div>`;
  }

  // ------------------------------------------------------------------------
  // Suggestions de l'étude comparative (0.46.0) — affichées, jamais imposées.
  // Toutes les valeurs viennent de data/model-recommendations.json (servi par
  // /api/model-recommendations) : rien n'est codé ici.
  // ------------------------------------------------------------------------
  function refText(r) {
    if (!r) return "";
    if (r.external) return `${r.external}${r.note ? ` (${r.note})` : ""}`;
    return `${r.model}${r.effort ? ` · effort ${r.effort}` : ""}${r.note ? ` (${r.note})` : ""}`;
  }

  function altHtml(a) {
    if (a.external) return `<span class="mr-reco-ext" title="Hors des listes : pas encore câblé dans l’orchestrateur">${esc(refText(a))}</span>`;
    if (a.target && !a.available) {
      return `<span class="mr-reco-target" title="${esc(a.reason || "annoncé, pas encore disponible")}">${esc(a.model)} <i>(cible : pas encore dans codex)</i></span>`
        + (a.today ? ` → aujourd’hui <b>${esc(refText(a.today))}</b>` : "");
    }
    return `<b>${esc(a.model)}</b>${a.target ? " <i>(cible, désormais disponible)</i>" : ""}${a.note ? ` (${esc(a.note)})` : ""}${a.available === false ? ' <span class="mr-warn">— indisponible ici</span>' : ""}`;
  }

  function recoHtml(slotId) {
    const r = st.reco?.slots?.[slotId];
    if (!r) return "";
    const rep = st.reco.report || {};
    const a = assigned(slotId);
    const p = r.principal;
    const followed = a && !p.external && a.provider === p.provider && a.model === p.model;
    const stateTxt = !p.applicable ? `<span class="mr-reco-na">non applicable ici : ${esc(p.reason)}</span>`
      : followed ? '<span class="mr-reco-ok">✓ suivie</span>'
      : a ? '<span class="mr-reco-diff">votre choix est différent (conservé)</span>' : "";
    const conf = esc(r.confidence || "");
    const confirm = st.recoConfirm?.slot === slotId ? confirmHtml(st.recoConfirm) : "";
    return `<div class="mr-reco-head"><span aria-hidden="true">💡</span> <b>Suggestion${r.inherited ? " (celle de l’étape)" : ""}</b>
        <span class="mr-reco-conf" data-conf="${conf}" title="Niveau de confiance donné par le rapport">confiance ${conf}</span>
        ${r.undecided ? '<span class="mr-reco-und" title="Le rapport dit que les preuves ne départagent pas : choix de cohérence et de coût, pas une victoire mesurée">non tranché</span>' : ""}
        ${r.extrapolated ? `<span class="mr-reco-xtra" title="${esc(r.extrapolated)}">extrapolé</span>` : ""}</div>
      <p class="mr-reco-main">Principal suggéré : <b>${esc(refText(p))}</b> ${stateTxt}</p>
      ${r.alternatives?.length ? `<p class="mr-reco-alt">Alternative : ${r.alternatives.map(altHtml).join(" · ")}</p>` : ""}
      <details class="mr-reco-why"><summary>Pourquoi ? (${esc(r.section || "")})</summary>
        <p>${esc(r.why || "")}</p>
        ${r.extrapolated ? `<p><i>${esc(r.extrapolated)}</i></p>` : ""}${r.note ? `<p><i>${esc(r.note)}</i></p>` : ""}
        <p class="mr-reco-src">Source : rapport du ${esc(rep.date || "?")}, ${esc(r.section || "")} — ${esc(rep.file || "")}${rep.commit ? ` (commit ${esc(rep.commit)})` : ""}. ${esc(rep.author || "")}</p>
      </details>
      <button type="button" class="mr-reco-apply" data-reco-apply="${esc(slotId)}"${p.applicable && !followed ? "" : " disabled"}
        title="${esc(p.applicable ? (followed ? "Déjà suivie" : "Affecter le principal suggéré à cette case (avec confirmation)") : p.reason)}">Appliquer la suggestion</button>
      ${confirm}`;
  }

  function recoBoxHtml() {
    const R = st.reco;
    if (!R?.report) return "";
    const rep = R.report, age = R.age || {};
    const when = new Date(rep.date + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    const aging = age.level === "stale"
      ? `<p class="mr-reco-age" data-level="stale">⚠ Rapport de ${age.days} jours : dépassé — ${esc(rep.redoHint || "à refaire")}.</p>`
      : age.level === "aging" ? `<p class="mr-reco-age" data-level="aging">⚠ Rapport de ${age.days} jours : il vieillit — ${esc(rep.redoHint || "à refaire d’ici 1-2 mois")}.</p>` : "";
    const c = R.counts || {};
    const confirm = st.recoConfirm?.mode === "empty" ? confirmHtml(st.recoConfirm) : "";
    return `<section class="mr-reco-box" aria-label="Suggestions de l’étude comparative">
      <p><span aria-hidden="true">💡</span> <b>Suggestions</b> de l’étude comparative du <b data-reco-date>${esc(when)}</b>
        (${esc(rep.file || "")}${rep.commit ? `, commit ${esc(rep.commit)}` : ""}) :
        <b data-reco-count>${c.withSuggestion || 0}</b> cases sur ${c.slots || 0} ont une suggestion, dont ${c.applicable || 0} applicables ici ;
        ${c.undecided || 0} relèvent d’étapes que le rapport juge <span class="mr-reco-und">non tranchées</span>.
        Rien n’est modifié sans votre clic.</p>
      ${aging}
      <button type="button" class="mr-reco-empty">Appliquer les suggestions aux étapes vides seulement</button>
      ${confirm}
    </section>`;
  }

  function confirmHtml(c) {
    if (c.error) return `<div class="mr-reco-confirm" role="alert"><p class="mr-warn">✕ ${esc(c.error)}</p><button type="button" class="mr-reco-cancel">Fermer</button></div>`;
    if (!c.plan) return '<div class="mr-reco-confirm"><p>Préparation…</p></div>';
    const list = c.plan.map(p => `<li>${esc(slotLabel(p.slot))} : ${p.from ? `${esc(p.from)} → ` : ""}<b>${esc(p.provider)}:${esc(p.model)}</b></li>`).join("");
    const why = {};
    for (const s of c.skipped || []) why[s.reason] = (why[s.reason] || 0) + 1;
    const skipped = Object.entries(why).map(([k, n]) => `${n} ${esc(k)}`).join(" · ");
    const head = c.mode === "empty"
      ? `${c.plan.length} case(s) vide(s) recevront la suggestion.${skipped ? ` Laissées telles quelles : ${skipped}.` : ""}`
      : c.plan[0]?.from ? `Remplacer votre choix par la suggestion ?` : `Affecter la suggestion à cette case ?`;
    return `<div class="mr-reco-confirm" role="group" aria-label="Confirmation">
      <p>${head}</p>
      ${c.plan.length ? `<details${c.mode === "one" ? " open" : ""}><summary>Détail (${c.plan.length})</summary><ul>${list}</ul></details>` : ""}
      <button type="button" class="mr-reco-ok-btn"${c.plan.length && !c.busy ? "" : " disabled"}>Confirmer</button>
      <button type="button" class="mr-reco-cancel">Annuler</button>
      <span class="mr-reco-note">Chaque changement est inscrit dans l’historique (« suggestion du rapport »).</span>
    </div>`;
  }

  async function recoPrepare(mode, slot) {
    st.recoConfirm = { mode, slot: mode === "one" ? slot : null, plan: null };
    patch();
    try {
      const r = await getJson("/api/model-routing/apply-suggestions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, slots: mode === "one" ? [slot] : [], dryRun: true }),
      });
      if (st.recoConfirm?.mode !== mode) return;
      st.recoConfirm.plan = r.plan;
      st.recoConfirm.skipped = r.skipped;
    } catch (e) { if (st.recoConfirm) st.recoConfirm.error = e.message; }
    patch();
    root()?.querySelector(".mr-reco-confirm .mr-reco-ok-btn:not([disabled]), .mr-reco-confirm .mr-reco-cancel")?.focus();
  }

  async function recoConfirm() {
    const c = st.recoConfirm;
    if (!c?.plan) return;
    c.busy = true;
    patch();
    try {
      const r = await getJson("/api/model-routing/apply-suggestions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: c.mode, slots: c.mode === "one" ? [c.slot] : [] }),
      });
      st.routing = await getJson("/api/model-routing");
      st.recoConfirm = null;
      const msg = `✓ suggestion appliquée · ${fmtTime(new Date().toISOString())}`;
      for (const a of r.applied) st.status[a.slot] = { kind: "saved", text: msg };
      for (const f of r.failed) st.status[f.slot] = { kind: "error", text: `✕ non appliquée : ${f.error}` };
      st.recoNotice = c.mode === "empty" ? `${r.applied.length} case(s) vide(s) remplie(s) avec la suggestion${r.failed.length ? `, ${r.failed.length} en échec` : ""}.` : null;
      renderPanel();
    } catch (e) {
      c.busy = false;
      c.error = e.message;
      patch();
    }
  }

  function stepCard(p, s, ctx) {
    const slotId = `${p.id}.${s.id}`;
    const opt = (s.optional ? `<span class="mr-opt">${esc(s.optional)}</span>` : "")
      + (s.custom || p.custom ? '<span class="mr-opt mr-custom" title="Ajouté depuis une lacune acceptée">✦ ajouté</span>' : "");
    const incoming = ctx.incoming[s.id] || [];
    const ret = (s.returns || []).map(r => {
      const target = ctx.byId[r.to];
      return `<p class="mr-ret"><span class="mr-sym mr-sym-ret" aria-hidden="true">↩</span>
        <b>retour vers ${esc(target ? `${target.n} ${target.title}` : r.to)}</b> — ${esc(r.label)}</p>`;
    }).join("");
    const inc = incoming.map(f => `<p class="mr-inc">⟲ point de retour depuis ${esc(f.n)} ${esc(f.title)}</p>`).join("");
    const advice = s.advice ? `<p class="mr-advice">💡 ${esc(s.advice)}</p>` : "";
    if (s.ref) {
      const target = st.routing.pipelines.find(x => x.id === s.ref.pipeline);
      return `<article class="mr-card mr-ref" data-step="${esc(s.id)}" data-ref="${esc(s.ref.pipeline)}">
        <header class="mr-card-head"><span class="mr-num">${esc(s.n)}</span><h3 class="mr-card-title">${esc(s.title)}</h3>${opt}</header>
        <p class="mr-what">${esc(s.what)}</p>
        <p class="mr-ex"><b>Ex.</b> ${esc(s.example)}</p>
        ${ret}${inc}
        <button type="button" class="mr-goto" data-goto="${esc(s.ref.pipeline)}">
          <span class="mr-sym mr-sym-ref" aria-hidden="true">⤳</span> ${esc(s.ref.label)} — ouvrir « ${esc(target?.label || s.ref.pipeline)} »</button>
      </article>`;
    }
    const variants = s.variants || [];
    const openKey = slotId;
    const vars = variants.length ? `
      <details class="mr-vars" data-vars="${esc(openKey)}"${st.openVariants.has(openKey) ? " open" : ""}>
        <summary><span class="mr-sym" aria-hidden="true">◇</span> Variantes (${variants.length})
          <span class="mr-dots" data-dots="${esc(slotId)}"></span></summary>
        ${variants.map(v => `<div class="mr-var" data-variant="${esc(v.id)}">
          <div class="mr-var-head"><b>${esc(v.label)}</b> <span class="mr-dual-badge" data-dualbadge="${esc(slotId)}.${esc(v.id)}" hidden title="Mode double : deux models en parallèle, puis relecture par le principal">×2</span>${v.custom ? ' <span class="mr-opt mr-custom">✦ ajouté</span>' : ""} <span class="mr-var-what">${esc(v.what || "")}</span></div>
          ${needHtml(v.need && v.need !== s.need ? v.need : null)}
          ${selectHtml(`${slotId}.${v.id}`, `Model — ${v.label}`, true)}
        </div>`).join("")}
      </details>` : "";
    const isText = !s.need || s.need.llm === "text";
    const kind = isText ? `<span class="mr-kind" data-kind="${s.judge ? "judge" : "action"}" title="${s.judge
      ? "Jugement : avis sur un texte fourni — tout model peut la tenir"
      : "Action : lit, écrit ou exécute dans le projet — il faut un harnais d’agent"}">${s.judge ? "jugement" : "action"}</span>` : "";
    return `<article class="mr-card${s.optional ? " is-optional" : ""}" data-step="${esc(s.id)}" data-slot-card="${esc(slotId)}" data-kind="${isText ? (s.judge ? "judge" : "action") : "media"}">
      <header class="mr-card-head"><span class="mr-num">${esc(s.n)}</span><h3 class="mr-card-title">${esc(s.title)}</h3>${opt}${kind}
        <span class="mr-dual-badge" data-dualbadge="${esc(slotId)}" hidden title="Mode double : deux models en parallèle, puis relecture par le principal">×2</span>
        <span class="mr-ptag" data-ptag="${esc(slotId)}"></span></header>
      <p class="mr-what">${esc(s.what)}</p>
      <p class="mr-ex"><b>Ex.</b> ${esc(s.example)}</p>
      ${needHtml(s.need)}
      ${advice}<p class="mr-warn-live" data-warn="${esc(slotId)}" hidden></p>
      ${ret}${inc}
      ${selectHtml(slotId, variants.length ? "Model de l’étape (toutes variantes)" : "Model de l’étape", false)}
      ${vars}
    </article>`;
  }

  function flowHtml(p) {
    const byId = {};
    const incoming = {};
    for (const n of p.flow) {
      byId[n.id] = n;
      if (n.kind === "loop") for (const s of n.steps) byId[s.id] = s;
    }
    for (const s of stepsOf(p)) for (const r of s.returns || []) (incoming[r.to] = incoming[r.to] || []).push(s);
    const ctx = { byId, incoming };
    const items = [];
    p.flow.forEach((n, i) => {
      if (i) items.push('<li class="mr-arrow" aria-hidden="true"><span>→</span></li>');
      if (n.kind === "loop") {
        const from = byId[n.back.from], to = byId[n.back.to];
        const inc = (incoming[n.id] || []).map(f => `<p class="mr-inc">⟲ point de retour depuis ${esc(f.n)} ${esc(f.title)}</p>`).join("");
        items.push(`<li class="mr-node mr-loop" data-loop="${esc(n.id)}">
          <div class="mr-loop-head"><span class="mr-sym mr-sym-loop" aria-hidden="true">↻</span>
            <span class="mr-num">${esc(n.n)}</span> <b>${esc(n.title)}</b></div>
          <p class="mr-loop-what">${esc(n.what)}</p>${inc}
          <ol class="mr-loop-flow">
            ${n.steps.map((s, j) => `${j ? '<li class="mr-arrow" aria-hidden="true"><span>→</span></li>' : ""}<li class="mr-node">${stepCard(p, s, ctx)}</li>`).join("")}
          </ol>
          <div class="mr-loop-back" data-loop-back="${esc(n.id)}">
            <span class="mr-loop-line" aria-hidden="true"></span>
            <span class="mr-loop-label"><span class="mr-sym mr-sym-loop" aria-hidden="true">↺</span>
              ${esc(from.n)} ${esc(from.title)} → ${esc(to.n)} ${esc(to.title)} : ${esc(n.back.label)}</span>
          </div>
        </li>`);
      } else {
        items.push(`<li class="mr-node">${stepCard(p, n, ctx)}</li>`);
      }
    });
    return `<ol class="mr-flow" aria-label="Étapes du pipeline ${esc(p.label)}, dans l’ordre">${items.join("")}</ol>`;
  }

  /** Toutes les boucles et tous les retours du pipeline, en clair. */
  function loopsHtml(p) {
    const rows = [];
    const byId = {};
    for (const n of p.flow) { byId[n.id] = n; if (n.kind === "loop") for (const s of n.steps) byId[s.id] = s; }
    for (const n of p.flow) {
      if (n.kind === "loop") {
        rows.push(`<li data-kind="loop"><span class="mr-sym mr-sym-loop">↻</span> <b>${esc(byId[n.back.from].n)} ${esc(byId[n.back.from].title)} → ${esc(byId[n.back.to].n)} ${esc(byId[n.back.to].title)}</b> — ${esc(n.back.label)}</li>`);
      }
    }
    for (const s of stepsOf(p)) for (const r of s.returns || []) {
      const t = byId[r.to];
      rows.push(`<li data-kind="return"><span class="mr-sym mr-sym-ret">↩</span> <b>${esc(s.n)} ${esc(s.title)} → ${esc(t ? `${t.n} ${t.title}` : r.to)}</b> — ${esc(r.label)}</li>`);
    }
    for (const s of stepsOf(p)) if (s.ref) {
      const t = st.routing.pipelines.find(x => x.id === s.ref.pipeline);
      rows.push(`<li data-kind="ref"><span class="mr-sym mr-sym-ref">⤳</span> <b>${esc(s.n)} ${esc(s.title)} → pipeline ${esc(t?.label || s.ref.pipeline)}</b> — ${esc(s.ref.label)}</li>`);
    }
    if (!rows.length) return "";
    return `<section class="mr-loops" aria-label="Boucles et retours"><h3 class="mr-h3">Boucles, retours et renvois</h3><ul>${rows.join("")}</ul></section>`;
  }

  function panelHtml(p) {
    const vinfo = (p.variantsInfo || []).map(v => `<li><b>${esc(v.label)}</b> : ${esc(v.text)}</li>`).join("");
    const advice = (p.advice || []).map(a => `<p class="mr-advice">💡 ${esc(a)}</p>`).join("");
    return `<section class="mr-banner" aria-label="À quoi sert ce pipeline">
        <h2 class="mr-banner-title"><span aria-hidden="true">${esc(p.icon || "")}</span> ${esc(p.label)}</h2>
        <p><b>À quoi il sert :</b> ${esc(p.purpose)}</p>
        <p><b>Quand il s’applique :</b> ${esc(p.when)}</p>
        ${vinfo ? `<ul class="mr-vinfo">${vinfo}</ul>` : ""}
        ${advice}
        ${p.source ? `<p class="mr-srcref">Référence : <a href="${esc(p.source.url)}" target="_blank" rel="noopener noreferrer">${esc(p.source.label)}</a></p>` : ""}
        <p class="mr-distrib" data-distrib="${esc(p.id)}"></p>
      </section>
      ${flowHtml(p)}
      ${loopsHtml(p)}`;
  }

  function renderShell() {
    const el = root();
    const body = $(".mr-body", el);
    if (st.error && !st.routing) {
      body.innerHTML = `<p class="mr-error" role="alert">${esc(st.error)}</p>`;
      return;
    }
    if (!st.routing) { body.innerHTML = '<p class="mr-empty">Chargement des pipelines et des listes de models…</p>'; return; }
    // Les onglets d'abord : c'est la navigation. Les sources, techniques, en bas.
    body.innerHTML = `${st.error ? `<p class="mr-error" role="alert">${esc(st.error)}</p>` : ""}
      ${migrationHtml()}
      <section class="mr-history" ${st.showHistory ? "" : "hidden"} aria-label="Historique des changements">
        <h2 class="mr-h2">Historique</h2>${historyHtml()}
      </section>
      <section class="mr-keys" ${st.showKeys ? "" : "hidden"} aria-label="Clés API">
        <h2 class="mr-h2">Clés API</h2>${keysHtml()}
      </section>
      <section class="mr-gaps" ${st.showGaps ? "" : "hidden"} aria-label="Lacunes proposées">
        <h2 class="mr-h2">Lacunes proposées</h2>${gapsHtml()}
      </section>
      <section class="mr-obs" ${st.showObs ? "" : "hidden"} aria-label="Classifications récentes des entrées">
        <h2 class="mr-h2">Classifications récentes</h2>${obsHtml()}
      </section>
      <div class="mr-reco-wrap" data-reco-wrap></div>
      <div class="mr-tabs" role="tablist" aria-label="Pipelines">${tabsHtml()}</div>
      ${legendHtml()}
      <div class="mr-panel" id="mr-panel" role="tabpanel"></div>
      <section class="mr-sources-box" aria-label="Sources des listes">
        <h3 class="mr-h3">D’où viennent les listes</h3>
        <ul class="mr-sources">${sourcesHtml()}</ul>
      </section>`;
    renderPanel();
  }

  function renderPanel() {
    const el = root();
    const panel = $(".mr-panel", el);
    const p = pipeline();
    if (!panel || !p) return;
    panel.setAttribute("aria-labelledby", `mr-tab-${p.id}`);
    panel.dataset.pipeline = p.id;
    panel.innerHTML = panelHtml(p);
    for (const sel of panel.querySelectorAll(".mr-select, .mr-select2")) {
      const det = sel.closest("details.mr-vars");
      if (!sel.dataset.lazy || !det || det.open) fillSelect(sel);
    }
    patch();
  }

  function statusHtml(slotId) {
    const s = st.status[slotId];
    if (s) return esc(s.text);
    const a = assigned(slotId);
    return a?.at ? `✓ enregistré · ${esc(fmtTime(a.at))}` : "";
  }

  /** Mise à jour sans recréer les menus (le focus et l'ouverture restent). */
  function patch() {
    const el = root();
    if (!el || !st.routing) return;
    const all = st.routing.slots;
    const n = all.filter(s => assigned(s.id)).length;
    const saving = Object.values(st.status).some(s => s.kind === "saving");
    const last = st.routing.updatedAt ? ` · dernier enregistrement ${fmtTime(st.routing.updatedAt)}` : "";
    $(".mr-summary", el).textContent = `${n}/${all.length} cases affectées${saving ? " · enregistrement…" : " · tout est enregistré"}${last}`;
    const hb = $(".mr-hist-btn", el);
    hb.textContent = `Historique (${st.routing.historyTotal || 0})`;
    hb.setAttribute("aria-expanded", st.showHistory ? "true" : "false");
    const ob = $(".mr-obs-btn", el);
    if (ob) {
      ob.textContent = st.obs ? `Observation (${st.obs.total || 0})` : "Observation";
      ob.setAttribute("aria-expanded", st.showObs ? "true" : "false");
    }
    const obsBox = $(".mr-obs", el);
    if (obsBox) obsBox.hidden = !st.showObs;
    syncGapBadges();
    const rb = $(".mr-refresh", el);
    rb.disabled = st.refreshing;
    rb.textContent = st.refreshing ? "↻ Rafraîchissement…" : "↻ Rafraîchir les listes";

    for (const p of st.routing.pipelines) {
      const c = el.querySelector(`[data-tab-count="${p.id}"]`);
      if (!c) continue;
      const slots = all.filter(s => s.pipeline === p.id);
      c.textContent = `${slots.filter(s => assigned(s.id)).length}/${slots.length}`;
    }
    const p = pipeline();
    if (!p) return;
    for (const card of el.querySelectorAll("[data-slot-card]")) {
      const id = card.dataset.slotCard;
      const a = assigned(id);
      card.dataset.provider = a ? a.provider : "";
      const tag = card.querySelector(`[data-ptag="${id}"]`);
      if (tag) { tag.dataset.provider = a ? a.provider : ""; tag.textContent = a ? `${PSHORT[a.provider]} · ${shortModel(a)}` : "défaut"; tag.title = a ? `${PLABEL[a.provider]} : ${a.model}` : "défaut du projet"; }
      const dots = card.querySelector(`[data-dots="${id}"]`);
      if (dots) {
        const vs = all.filter(s => s.pipeline === p.id && s.step === id.split(".")[1] && s.variant);
        dots.innerHTML = vs.map(v => { const e = effective(v.id); return `<span class="mr-dot" data-provider="${e ? e.provider : ""}" title="${esc((slotById(v.id)?.label || v.id) + " : " + (e ? `${PLABEL[e.provider]} ${e.model}` : "défaut du projet"))}"></span>`; }).join("");
      }
    }
    for (const sel2 of el.querySelectorAll(".mr-select2")) {
      const has = !!assigned(sel2.dataset.slot);
      sel2.disabled = !has;
      sel2.title = has ? "Avec un second model, la tâche tourne sur les deux en parallèle, puis le principal relit et garde le meilleur." : "Choisissez d’abord le model principal de cette case.";
    }
    for (const b of el.querySelectorAll("[data-dualbadge]")) b.hidden = !secondOf(b.dataset.dualbadge);
    for (const n of el.querySelectorAll("[data-dual]")) {
      const a = assigned(n.dataset.dual), b = secondOf(n.dataset.dual);
      n.hidden = !b;
      if (!b) { n.textContent = ""; continue; }
      const same = a && a.provider === b.provider && a.model === b.model;
      n.dataset.same = same ? "1" : "";
      n.textContent = same
        ? "⚠ principal et second identiques : le mode double n’apporte presque rien."
        : `×2 : ${shortModel(a)} et ${shortModel(b)} travaillent en parallèle, chacun de son côté, puis ${shortModel(a)} relit et garde le meilleur — coût ≈ ×2,5, durée ≈ la plus longue des deux + la relecture.`;
    }
    for (const s of el.querySelectorAll("[data-status]")) {
      const id = s.dataset.status;
      s.innerHTML = statusHtml(id);
      s.dataset.kind = st.status[id]?.kind || (assigned(id) ? "saved" : "");
    }
    // Choix existant sur un model retiré : conservé, signalé « obsolète ».
    for (const o of el.querySelectorAll("[data-obsolete-warn]")) {
      const a = assigned(o.dataset.obsoleteWarn), b = secondOf(o.dataset.obsoleteWarn);
      const gone = [a, b].filter(Boolean).map(x => ({ x, r: removedInfo(x.provider, x.model) })).filter(g => g.r);
      o.hidden = !gone.length;
      o.textContent = gone.length ? gone.map(g => `⚠ ${g.x.model} est obsolète (${g.r.reason}). Votre choix est conservé : changez-le quand vous voulez.`).join(" ") : "";
    }
    // Suggestions : réécrites seulement si elles changent (focus et ouverture gardés).
    const wrap = el.querySelector("[data-reco-wrap]");
    if (wrap) {
      const html = recoBoxHtml() + (st.recoNotice ? `<p class="mr-reco-notice" role="status">✓ ${esc(st.recoNotice)}</p>` : "");
      if (wrap._html !== html) { wrap.innerHTML = html; wrap._html = html; }
    }
    for (const b of el.querySelectorAll("[data-reco]")) {
      const html = recoHtml(b.dataset.reco);
      if (b._html === html) continue;
      const open = b.querySelector("details.mr-reco-why")?.open;
      b.innerHTML = html;
      b._html = html;
      b.hidden = !html;
      if (open) { const d = b.querySelector("details.mr-reco-why"); if (d) d.open = true; }
      b.dataset.state = !html ? "" : st.reco.slots[b.dataset.reco].principal.applicable ? "ok" : "na";
    }
    const d = el.querySelector(`[data-distrib="${p.id}"]`);
    if (d) {
      const slots = all.filter(s => s.pipeline === p.id);
      const counts = {};
      for (const s of slots) { const a = assigned(s.id); const k = a ? a.provider : "inherit"; counts[k] = (counts[k] || 0) + 1; }
      d.innerHTML = `<b>Répartition :</b> ` + [...LLM, "local"].filter(k => counts[k]).map(k =>
        `<span class="mr-ptag" data-provider="${k}">${PSHORT[k]}</span> ${counts[k]}`).join(" · ")
        + `${counts.inherit ? `${Object.keys(counts).length > 1 ? " · " : ""}<span class="mr-ptag">hérité</span> ${counts.inherit}` : ""}`
        + (slots.some(s => secondOf(s.id)) ? ` · <span class="mr-dual-badge">×2</span> ${slots.filter(s => secondOf(s.id)).length}` : "");
    }
    adviceChecks(p);
    const hist = $(".mr-history", el);
    if (hist) { hist.hidden = !st.showHistory; if (st.showHistory) hist.innerHTML = '<h2 class="mr-h2">Historique</h2>' + historyHtml(); }
  }

  /** Conseils non imposés : on signale, on ne bloque rien. */
  function adviceChecks(p) {
    const el = root();
    const warn = (slot, text) => {
      const w = el.querySelector(`[data-warn="${slot}"]`);
      if (!w) return;
      w.hidden = !text;
      w.textContent = text ? `⚠ ${text}` : "";
    };
    const same = (x, y) => x && y && x.provider === y.provider && x.model === y.model;
    if (p.id === "dev") {
      const vert = assigned("dev.vert");
      const rouge = assigned("dev.rouge"), liste = assigned("dev.liste-tests");
      const clash = [same(rouge, vert) && "4a", same(liste, vert) && "3"].filter(Boolean);
      warn("dev.vert", clash.length ? `même model que ${clash.join(" et ")} : la preuve n’est plus indépendante (conseil : un model différent).` : "");
      warn("dev.rouge", same(rouge, vert) ? "même model que 4b (conseil : un model différent)." : "");
      warn("dev.liste-tests", same(liste, vert) ? "même model que 4b (conseil : un model différent)." : "");
    }
    if (p.id === "audit") {
      const f1 = family(assigned("audit.revue-manuelle")), f2 = family(assigned("audit.second-avis"));
      warn("audit.second-avis", f1 && f2 && f1 === f2 ? `même famille (${f1}) que la revue manuelle (conseil : une autre famille).` : "");
    }
  }

  // ------------------------------------------------------------------------
  // Enregistrement
  // ------------------------------------------------------------------------
  async function save(sel) {
    const slot = sel.dataset.slot;
    const role = sel.dataset.role === "second" ? "second" : "principal";
    const before = role === "second" ? valueOf2(slot) : valueOf(slot);
    const v = sel.value;
    if (v === before) return;
    const [provider, ...rest] = v.split("|");
    const body = { ...(v ? { provider, model: rest.join("|") } : { default: true }), ...(role === "second" ? { role } : {}) };
    st.status[slot] = { kind: "saving", text: "enregistrement…" };
    patch();
    try {
      const r = await getJson(`/api/model-routing/${encodeURIComponent(slot)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      st.routing = await getJson("/api/model-routing");
      st.status[slot] = { kind: "saved", text: `✓ enregistré${role === "second" ? " (second)" : ""} · ${fmtTime(r.updatedAt || new Date().toISOString())}${r.warning ? ` — ⚠ ${r.warning}` : ""}` };
      // Le principal retiré emporte le second : le menu du second suit.
      const s2 = root()?.querySelector(`.mr-select2[data-slot="${CSS.escape(slot)}"]`);
      if (s2 && s2.dataset.filled) fillSelect(s2);
    } catch (e) {
      ensureOption(sel, before);
      sel.value = before;
      st.status[slot] = { kind: "error", text: `✕ non enregistré : ${e.message}` };
    }
    patch();
  }

  async function refreshLists() {
    st.refreshing = true;
    patch();
    await load(true);
    st.refreshing = false;
    renderShell();
  }

  function selectPipeline(id, focus) {
    if (!st.routing?.pipelines?.some(p => p.id === id)) return;
    st.pipeline = id;
    lsSet(LS.pipeline, id);
    for (const t of root().querySelectorAll(".mr-tab")) {
      const on = t.dataset.pipeline === id;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
      if (on) t.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    renderPanel();
  }

  // ------------------------------------------------------------------------
  // Ouverture / fermeture (appelées par Salle.router)
  // ------------------------------------------------------------------------
  function show() {
    const el = root();
    if (!el || !enabled()) return false;
    st.open = true;
    el.hidden = false;
    document.getElementById("main-row")?.classList.add("is-models");
    syncEntryPoints();
    if (!st.routing) {
      renderShell();
      load(false).then(renderShell).then(loadGaps);
    } else {
      // Retour sur la vue : relire les choix (un autre navigateur a pu changer).
      getJson("/api/model-routing").then(r => { st.routing = r; patch(); }).catch(() => {});
      getJson("/api/model-recommendations").then(r => { st.reco = r; patch(); }).catch(() => {});
      loadGaps();
    }
    return true;
  }

  function hide() {
    if (!st.open) return;
    st.open = false;
    const el = root();
    if (el) el.hidden = true;
    document.getElementById("main-row")?.classList.remove("is-models");
    syncEntryPoints();
  }

  function open() {
    if (!enabled()) return;
    if (isRoute()) global.Salle?.router();
    else location.hash = "#/models";
  }

  function back() { location.hash = "#/"; }

  // ------------------------------------------------------------------------
  // Câblage
  // ------------------------------------------------------------------------
  function wire() {
    const el = root();
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener("change", (e) => {
      const sel = e.target.closest(".mr-select, .mr-select2");
      if (sel) save(sel);
    });
    el.addEventListener("submit", (e) => {
      const form = e.target.closest(".mr-key-form");
      if (!form) return;
      e.preventDefault();
      keyAction(form.dataset.key, "save", form.querySelector(".mr-key-input"));
    });
    el.addEventListener("toggle", (e) => {
      const det = e.target.closest?.("details.mr-vars");
      if (!det) return;
      const k = det.dataset.vars;
      if (det.open) { st.openVariants.add(k); for (const s of det.querySelectorAll(".mr-select:not([data-filled]), .mr-select2:not([data-filled])")) fillSelect(s); }
      else st.openVariants.delete(k);
      lsSet(LS.open, [...st.openVariants].join(",") || null);
    }, true);
    el.addEventListener("click", (e) => {
      if (e.target.closest(".mr-back")) { back(); return; }
      if (e.target.closest(".mr-refresh")) { refreshLists(); return; }
      if (e.target.closest(".mr-hist-btn")) { st.showHistory = !st.showHistory; patch(); return; }
      if (e.target.closest(".mr-obs-btn")) { st.showObs = !st.showObs; patch(); if (st.showObs) loadObs(); return; }
      if (e.target.closest(".mr-obs-reload")) { loadObs(); return; }
      const ra = e.target.closest("[data-reco-apply]");
      if (ra) { st.recoNotice = null; recoPrepare("one", ra.dataset.recoApply); return; }
      if (e.target.closest(".mr-reco-empty")) { st.recoNotice = null; recoPrepare("empty"); return; }
      if (e.target.closest(".mr-reco-ok-btn")) { recoConfirm(); return; }
      if (e.target.closest(".mr-reco-cancel")) { st.recoConfirm = null; patch(); return; }
      if (e.target.closest(".mr-keys-btn")) { st.showKeys = !st.showKeys; renderKeys(); if (st.showKeys) loadKeys(); return; }
      const kt = e.target.closest(".mr-key-test");
      if (kt) { keyAction(kt.closest("form").dataset.key, "test"); return; }
      const kd = e.target.closest(".mr-key-del");
      if (kd) { keyAction(kd.closest("form").dataset.key, "del"); return; }
      if (e.target.closest(".mr-gaps-btn")) { st.showGaps = !st.showGaps; st.gapNotice = null; syncGapBadges(); if (st.showGaps) loadGaps(); return; }
      const acc = e.target.closest(".mr-gap-accept");
      if (acc) { acc.disabled = true; decideGap(acc.dataset.gap, "accept", acc.dataset.choice); return; }
      const rej = e.target.closest(".mr-gap-reject");
      if (rej) { rej.disabled = true; decideGap(rej.dataset.gap, "reject"); return; }
      const tab = e.target.closest(".mr-tab");
      if (tab) { selectPipeline(tab.dataset.pipeline); return; }
      const go = e.target.closest(".mr-goto");
      if (go) { selectPipeline(go.dataset.goto, true); $(".mr-panel", el)?.scrollIntoView?.({ block: "start" }); return; }
      if (e.target.closest(".mr-mig-ok")) {
        lsSet(LS.migration, st.routing?.migration?.at || null);
        e.target.closest(".mr-migration")?.remove();
      }
    });
    // Onglets au clavier : flèches, Début, Fin.
    el.addEventListener("keydown", (e) => {
      const tab = e.target.closest?.(".mr-tab");
      if (!tab) return;
      const ids = st.routing.pipelines.map(p => p.id);
      const i = ids.indexOf(tab.dataset.pipeline);
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (j == null) return;
      e.preventDefault();
      selectPipeline(ids[(j + ids.length) % ids.length], true);
    });
    document.getElementById("btn-models")?.addEventListener("click", () => (st.open ? back() : open()));
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest?.("input, textarea, select, [contenteditable='true']");
      const overlayOpen = !!document.querySelector(".overlay:not([hidden])");
      if (st.open && !overlayOpen && e.key === "Escape" && !typing) { e.preventDefault(); back(); return; }
      // « g » puis « m » : ouvrir la vue de n'importe où.
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "g") { st.gPending = Date.now(); return; }
      if (e.key === "m" && Date.now() - st.gPending < 1200) { st.gPending = 0; open(); }
    }, true);
  }

  function init() {
    readUrlParam();
    syncEntryPoints();
    wire();
    // Badge « ⚑ » de la pill : les lacunes ouvertes se voient sans ouvrir la vue.
    if (enabled()) {
      loadGaps();
      setInterval(() => { if (!document.hidden && enabled()) loadGaps(); }, 60_000);
    }
  }

  global.Models = {
    init, applyUi, show, hide, open, enabled, isRoute, selectPipeline,
    get isOpen() { return st.open; },
  };
})(window);
