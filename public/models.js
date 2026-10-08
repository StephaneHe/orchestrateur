// ============================================================================
// public/models.js — v0.39.0 « MODELS PAR TÂCHE »
// ============================================================================
//
// Niveau routé `#/models` de la salle. Les 20 types de tâche, en 6 étapes
// successives (Réfléchir → Écrire → Corriger → Vérifier → Livrer → Écrire sur
// le code) ; sur chacun, un menu déroulant de model groupé par fournisseur.
//
// Données : `/api/model-catalog` (listes, rafraîchissables) et
// `/api/model-routing` (choix + historique). Un choix est enregistré dès qu'il
// change (PUT), avec un indicateur par carte. Rien ici ne lance de tour : le
// branchement sur dispatch.mjs viendra plus tard.
//
// Désactivable sans redéploiement : `config.json` → `"ui": {"modelRouting":
// false}` (à chaud) ou `?models=0` (ce navigateur).
// ============================================================================
(function (global) {
  "use strict";

  const $  = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const PROVIDERS = ["anthropic", "openai", "nvidia", "openrouter"];
  const PLABEL = { anthropic: "Anthropic", openai: "OpenAI", nvidia: "NVIDIA", openrouter: "OpenRouter" };
  const PSHORT = { anthropic: "ANT", openai: "OAI", nvidia: "NV", openrouter: "OR" };

  const LS = { disabled: "mr.disabled" };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* privé */ } };

  const st = {
    serverOn: true,
    open: false,
    loading: null,
    catalog: null,
    routing: null,
    optionsHtml: "",
    status: {},          // task → { kind: "saving"|"saved"|"error", text }
    error: null,         // erreur de chargement globale
    refreshing: false,
    showHistory: false,
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
        st.catalog = catalog;
        st.routing = routing;
        st.error = null;
        st.optionsHtml = buildOptions(catalog);
      } catch (e) {
        st.error = e.status === 404
          ? "Le serveur ne connaît pas encore cette vue : il doit être redémarré (version ≥ 0.39.0)."
          : `Chargement impossible : ${e.message}`;
      } finally {
        st.loading = null;
      }
    })();
    return st.loading;
  }

  function providerOf(task) {
    const a = st.routing?.assignments?.[task];
    return a ? a.provider : "";
  }

  function valueOf(task) {
    const a = st.routing?.assignments?.[task];
    return a ? `${a.provider}|${a.model}` : "";
  }

  function buildOptions(catalog) {
    let html = '<option value="">(défaut du projet)</option>';
    for (const p of PROVIDERS) {
      const c = catalog?.providers?.[p];
      const models = c?.models || [];
      let label = `${PLABEL[p]} (${models.length})`;
      if (p === "openrouter" && c?.disabled) label = `${PLABEL[p]} — clé non configurée (${models.length})`;
      if (!models.length) label = `${PLABEL[p]} — liste indisponible`;
      html += `<optgroup label="${esc(label)}" data-provider="${p}"${c?.disabled ? " disabled" : ""}>`;
      for (const m of models) {
        html += `<option value="${esc(p + "|" + m.id)}"${m.hint ? ` title="${esc(m.hint)}"` : ""}>${esc(m.label || m.id)}</option>`;
      }
      html += "</optgroup>";
    }
    return html;
  }

  /** Un choix enregistré qui n'est plus dans la liste reste visible et sélectionné. */
  function ensureOption(sel, value) {
    if (!value || [...sel.options].some(o => o.value === value)) return;
    const [p, ...rest] = value.split("|");
    const og = sel.querySelector(`optgroup[data-provider="${p}"]`);
    const o = document.createElement("option");
    o.value = value;
    o.textContent = `${rest.join("|")} (absent de la liste actuelle)`;
    (og || sel).appendChild(o);
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

  function taskLabel(id) {
    const t = st.routing?.tasks?.find(x => x.id === id);
    return t ? `${t.n}. ${t.label}` : id;
  }

  function sourcesHtml() {
    const c = st.catalog?.providers || {};
    return PROVIDERS.map(p => {
      const s = c[p] || {};
      const n = (s.models || []).length;
      let extra = "";
      if (p === "openrouter") {
        extra = s.keyPresent
          ? ` · clé présente (${esc((s.keyWhere || []).join(", "))})`
          : ' · <b class="mr-warn">clé non configurée</b>';
        if (s.total) extra += ` · ${n}/${s.total} ${esc(s.filter || "")}`;
      }
      if (p === "nvidia") {
        const miss = (s.models || []).filter(m => m.missing).length;
        if (miss) extra += ` · <b class="mr-warn">${miss} model(s) du failover absent(s) du catalogue</b>`;
      }
      const err = s.error ? ` · <b class="mr-warn">${esc(s.error)}${s.stale ? " — dernière liste connue" : ""}</b>` : "";
      // Anthropic : une date de vérification (pas d'heure), pas une lecture.
      const when = !s.fetchedAt ? ""
        : p === "anthropic" ? ` · vérifiée le ${esc(new Date(s.fetchedAt).toLocaleDateString("fr-FR"))}`
        : ` · ${esc(fmtTime(s.fetchedAt) || s.fetchedAt)}`;
      return `<li class="mr-src" data-provider="${p}" title="${esc(s.source || "")}">
        <span class="mr-ptag" data-provider="${p}">${PSHORT[p]}</span>
        <b>${PLABEL[p]}</b> ${n} models${when}${extra}${err}</li>`;
    }).join("");
  }

  function historyHtml() {
    const h = st.routing?.history || [];
    if (!h.length) return '<p class="mr-empty">Aucun changement enregistré.</p>';
    return `<ol class="mr-hist-list">${h.map(e => `
      <li><time datetime="${esc(e.at)}">${esc(fmtTime(e.at))}</time>
        <span class="mr-hist-task">${esc(taskLabel(e.task))}</span>
        <span class="mr-hist-from">${esc(e.from || "(défaut du projet)")}</span>
        <span aria-hidden="true">→</span><span class="sr-only">devient</span>
        <span class="mr-hist-to">${esc(e.to || "(défaut du projet)")}</span></li>`).join("")}</ol>
      ${st.routing.historyTotal > h.length ? `<p class="mr-empty">${h.length} derniers sur ${st.routing.historyTotal}.</p>` : ""}`;
  }

  function summaryText() {
    const tasks = st.routing?.tasks || [];
    const n = tasks.filter(t => st.routing.assignments[t.id]).length;
    const saving = Object.values(st.status).some(s => s.kind === "saving");
    const last = st.routing?.updatedAt ? ` · dernier enregistrement ${fmtTime(st.routing.updatedAt)}` : "";
    return `${n}/${tasks.length} affectées${saving ? " · enregistrement…" : " · tout est enregistré"}${last}`;
  }

  function statusHtml(task) {
    const s = st.status[task];
    if (!s) {
      const a = st.routing?.assignments?.[task];
      return a?.at ? `✓ enregistré · ${esc(fmtTime(a.at))}` : "";
    }
    return esc(s.text);
  }

  function renderShell() {
    const el = root();
    const body = $(".mr-body", el);
    if (st.error && !st.routing) {
      body.innerHTML = `<p class="mr-error" role="alert">${esc(st.error)}</p>`;
      return;
    }
    if (!st.routing) { body.innerHTML = '<p class="mr-empty">Chargement des listes de models…</p>'; return; }

    const stages = st.routing.stages;
    body.innerHTML = `${st.error ? `<p class="mr-error" role="alert">${esc(st.error)}</p>` : ""}
      <ul class="mr-sources" aria-label="Sources des listes">${sourcesHtml()}</ul>
      <section class="mr-history" ${st.showHistory ? "" : "hidden"} aria-label="Historique des changements">
        <h2 class="mr-h2">Historique</h2>${historyHtml()}
      </section>
      <ol class="mr-flow" aria-label="Étapes successives">
        ${stages.map((s, i) => {
          const tasks = st.routing.tasks.filter(t => t.stage === s.id);
          return `<li class="mr-stage" data-stage="${esc(s.id)}">
            <h2 class="mr-stage-head"><span class="mr-step" aria-hidden="true">${i + 1}</span>
              <span class="mr-stage-name">${esc(s.label)}</span>
              <span class="mr-stage-count" data-stage-count="${esc(s.id)}"></span></h2>
            <div class="mr-cards">
              ${tasks.map(t => `
                <article class="mr-card" data-task="${esc(t.id)}" data-provider="${esc(providerOf(t.id))}">
                  <header class="mr-card-head"><span class="mr-num">${t.n}</span>
                    <h3 class="mr-card-title" id="mr-t-${esc(t.id)}">${esc(t.label)}</h3>
                    <span class="mr-ptag" data-provider="${esc(providerOf(t.id))}"></span></header>
                  <p class="mr-desc">${esc(t.description)}</p>
                  <select class="mr-select" data-task="${esc(t.id)}" aria-labelledby="mr-t-${esc(t.id)}"
                          aria-describedby="mr-s-${esc(t.id)}"></select>
                  <div class="mr-status" id="mr-s-${esc(t.id)}" aria-live="polite"></div>
                </article>`).join("")}
            </div>
          </li>`;
        }).join("")}
      </ol>`;
    for (const sel of body.querySelectorAll(".mr-select")) {
      sel.innerHTML = st.optionsHtml;
      const v = valueOf(sel.dataset.task);
      ensureOption(sel, v);
      sel.value = v;
    }
    patch();
  }

  /** Mise à jour sans recréer les menus (le focus et l'ouverture restent). */
  function patch() {
    const el = root();
    if (!el || !st.routing) return;
    $(".mr-summary", el).textContent = summaryText();
    const hb = $(".mr-hist-btn", el);
    hb.textContent = `Historique (${st.routing.historyTotal || 0})`;
    hb.setAttribute("aria-expanded", st.showHistory ? "true" : "false");
    const rb = $(".mr-refresh", el);
    rb.disabled = st.refreshing;
    rb.textContent = st.refreshing ? "↻ Rafraîchissement…" : "↻ Rafraîchir les listes";
    for (const card of el.querySelectorAll(".mr-card")) {
      const t = card.dataset.task;
      const p = providerOf(t);
      card.dataset.provider = p;
      const tag = $(".mr-ptag", card);
      tag.dataset.provider = p;
      tag.textContent = p ? PLABEL[p] : "défaut";
      const s = $(".mr-status", card);
      s.innerHTML = statusHtml(t);
      s.dataset.kind = st.status[t]?.kind || (st.routing.assignments[t] ? "saved" : "");
    }
    for (const c of el.querySelectorAll("[data-stage-count]")) {
      const tasks = st.routing.tasks.filter(t => t.stage === c.dataset.stageCount);
      c.textContent = `${tasks.filter(t => st.routing.assignments[t.id]).length}/${tasks.length}`;
    }
    const hist = $(".mr-history", el);
    if (hist) { hist.hidden = !st.showHistory; if (st.showHistory) hist.innerHTML = '<h2 class="mr-h2">Historique</h2>' + historyHtml(); }
  }

  // ------------------------------------------------------------------------
  // Enregistrement
  // ------------------------------------------------------------------------
  async function save(sel) {
    const task = sel.dataset.task;
    const before = valueOf(task);
    const v = sel.value;
    if (v === before) return;
    const [provider, ...rest] = v.split("|");
    const body = v ? { provider, model: rest.join("|") } : { default: true };
    st.status[task] = { kind: "saving", text: "enregistrement…" };
    patch();
    try {
      const r = await getJson(`/api/model-routing/${encodeURIComponent(task)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const routing = await getJson("/api/model-routing");
      st.routing = routing;
      st.status[task] = { kind: "saved", text: `✓ enregistré · ${fmtTime(r.updatedAt || new Date().toISOString())}` };
    } catch (e) {
      ensureOption(sel, before);
      sel.value = before;
      st.status[task] = { kind: "error", text: `✕ non enregistré : ${e.message}` };
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
      load(false).then(renderShell);
    } else {
      // Retour sur la vue : relire les choix (un autre navigateur a pu changer).
      getJson("/api/model-routing").then(r => { st.routing = r; patch(); }).catch(() => {});
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
      const sel = e.target.closest(".mr-select");
      if (sel) save(sel);
    });
    el.addEventListener("click", (e) => {
      if (e.target.closest(".mr-back")) { back(); return; }
      if (e.target.closest(".mr-refresh")) { refreshLists(); return; }
      if (e.target.closest(".mr-hist-btn")) { st.showHistory = !st.showHistory; patch(); }
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
  }

  global.Models = {
    init, applyUi, show, hide, open, enabled, isRoute,
    get isOpen() { return st.open; },
  };
})(window);
