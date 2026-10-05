// ============================================================================
// public/projets.js — v0.29.0 « PROJETS » : le statut de chacun en un coup d'œil
// ============================================================================
//
// Niveau routé `#/projets` de la salle (conception : docs/dashboard-status/
// SYNTHESE.md). Aucune donnée propre : l'ÉTAT vient du réducteur client
// (`App.musicians`, temps réel SSE, non-lu fidèle au marqueur de lecture), la
// SANTÉ et les métadonnées de l'instantané `/api/pupitre` déjà pollé. Aucun
// poll, aucune requête par projet.
//
// Trois groupes DISJOINTS, ordre imposé : À votre attention · Actifs et en
// attente · Au repos.
//
// Le DOM est clé par `data-name` : une tuile est patchée, jamais recréée ; une
// permutation dans un groupe attend 1,5 s, et rien ne bouge tant que le
// pointeur ou le focus est dans la grille.
//
// Désactivable sans redéploiement : `config.json` → `"ui": {"projectsView":
// false}` (à chaud) ou `?projets=0` (ce navigateur). Défaut : activée.
//
// GARDE-FOU : le vocabulaire `idle|live|think|input|error|unread` n'est pas
// étendu ; `data-kind` ne porte que des libellés d'affichage.
// ============================================================================
(function (global) {
  "use strict";

  const $  = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const GROUPS = [
    { key: "attention", title: "À votre attention" },
    { key: "active",    title: "Actifs et en attente" },
    { key: "rest",      title: "Au repos" },
  ];

  // Affichage par « sorte » (dérivée, jamais un nouvel état moteur).
  const KIND = {
    question: { glyph: "?", word: "Votre réponse attendue", state: "input" },
    dead:     { glyph: "✗", word: "Processus perdu",        state: "error" },
    error:    { glyph: "✕", word: "Échec",                  state: "error" },
    stopped:  { glyph: "■", word: "Arrêté par le chef",     state: "error" },
    stall:    { glyph: "!", word: "Sans progrès",           state: "live" },
    live:     { glyph: "●", word: "En cours",               state: "live" },
    think:    { glyph: "◐", word: "Réflexion",              state: "think" },
    chef:     { glyph: "⇄", word: "Attend le chef",         state: "unread" },
    queued:   { glyph: "⏳", word: "En file",                state: "idle" },
    unread:   { glyph: "✓", word: "Terminé · non lu",       state: "unread" },
    idle:     { glyph: "○", word: "Prêt",                   state: "idle" },
  };

  const LS = {
    details: "pv.details",
    disabled: "pv.disabled", level: "pv.lastLevel",
  };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* privé */ } };

  const st = {
    serverOn: true,          // config.json ui.projectsView (défaut : activée)
    open: false,
    filter: "",
    only: null,              // groupe isolé par un compteur
    details: lsGet(LS.details) === "1",
    orders: {},              // groupe → noms affichés
    pendingSince: {},        // groupe → début d'une permutation en attente
    hold: false,             // pointeur/focus dans la grille : rien ne bouge
    items: new Map(),        // nom → { li, btn, html, group }
    kinds: new Map(),        // nom → sorte au dernier rendu (annonces)
    firstPaint: true,
    retryTimer: null,
    gPending: 0,
  };

  // ------------------------------------------------------------------------
  // Activation
  // ------------------------------------------------------------------------
  function localOff() { return lsGet(LS.disabled) === "1"; }
  function enabled() { return st.serverOn && !localOff(); }

  /** `?projets=0|1` : désactivation locale mémorisée (retour arrière client). */
  function readUrlParam() {
    const m = /[?&]projets=([^&#]*)/.exec(location.search);
    if (!m) return;
    const v = decodeURIComponent(m[1]).toLowerCase();
    if (v === "0" || v === "off" || v === "non") lsSet(LS.disabled, "1");
    if (v === "1" || v === "on"  || v === "oui") lsSet(LS.disabled, null);
  }

  /** Drapeaux serveur (`/api/config.ui`, `/api/pupitre.ui`). Absents = ancien
   *  serveur = activée. */
  function applyUi(ui) {
    const on = !(ui && ui.projectsView === false);
    if (on === st.serverOn) return;
    st.serverOn = on;
    syncEntryPoints();
    if (!enabled() && isRoute()) location.replace("#/");
  }

  function syncEntryPoints() {
    const on = enabled();
    const pill = document.getElementById("btn-projects");
    if (pill) pill.hidden = !on;
    const mi = document.querySelector('#topmenu [data-act="projects"]');
    if (mi) mi.hidden = !on;
  }

  function isRoute() { return String(location.hash || "") === "#/projets"; }

  // ------------------------------------------------------------------------
  // Classement
  // ------------------------------------------------------------------------
  function snapRow(name) { return global.Salle ? global.Salle.snapRow(name) : null; }
  function conductor() { return global.App?.composer?.CONDUCTOR || "chef"; }

  function classify(m, r) {
    const inFlight = m.state === "live" || m.state === "think";
    const h = global.Salle ? global.Salle.healthFlag(r) : null;
    if (m.state === "input")         return { group: "attention", kind: "question", rank: 0 };
    if (h && h.kind === "dead")      return { group: "attention", kind: "dead",     rank: 1 };
    if (m.state === "error")         return { group: "attention", kind: m.stopped ? "stopped" : "error", rank: 2 };
    if (h && h.kind === "stall")     return { group: "attention", kind: "stall",    rank: 3 };
    if (inFlight)                    return { group: "active",    kind: m.state,    rank: 0 };
    // `awaitingChef` n'est connu du client qu'en direct (SSE) ; après un
    // rechargement, l'instantané serveur (deriveState) le porte.
    if (m.state === "unread" && (m.awaitingChef || r?.awaitingChef)) return { group: "active", kind: "chef", rank: 1 };
    if ((r?.queueDepth || 0) > 0)    return { group: "active",    kind: "queued",   rank: 2 };
    if (m.state === "unread")        return { group: "rest",      kind: "unread",   rank: 0 };
    return { group: "rest", kind: "idle", rank: 1 };
  }

  /** Sorte, glyphe et mot d'un musicien — partagés avec les cadres du
   *  Pilotage (salle.js, 0.31.0) pour qu'un état ne se dise qu'une façon. */
  function describe(m, r) {
    const c = classify(m, r);
    const k = KIND[c.kind] || KIND.idle;
    return { kind: c.kind, group: c.group, glyph: k.glyph, word: k.word };
  }

  function recvElapsed() {
    const p = global.App?.pupitreRecvPerf;
    return p ? Math.max(0, performance.now() - p) : 0;
  }

  function lastActivityAt(m, r) {
    const a = Number(r?.lastActivityAt) || 0;
    const b = Number(m.lastActivityMs) || 0;        // événement SSE reçu depuis le chargement
    return Math.max(a, b) || null;
  }

  // ------------------------------------------------------------------------
  // Formats
  // ------------------------------------------------------------------------
  function fmtDur(ms) { return global.Salle ? global.Salle.fmtAge(ms) : "—"; }

  function fmtAgo(ts) {
    if (!ts) return "jamais observé";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "à l'instant";
    const mn = Math.floor(s / 60);
    if (mn < 60) return `il y a ${Math.max(1, mn)} min`;
    const h = Math.floor(mn / 60);
    if (h < 48) return `il y a ${h} h`;
    return `il y a ${Math.floor(h / 24)} j`;
  }

  function shortModel(r) {
    const served = r?.model;
    const planned = r?.configModel;
    const m = served || planned;
    if (!m || m === "<synthetic>") return null;
    const short = String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "");
    return { text: served ? short : `prévu ${short}`, title: served ? `model servi : ${m}` : `model configuré (pas encore observé) : ${m}` };
  }

  function lineOf(m, r, kind) {
    // Les résultats sont du markdown : `**gras**` et `code` gênent sur une ligne.
    const clean = (s) => String(s || "").replace(/^NEEDS_(USER|CHEF)_INPUT:\s*/i, "")
      .replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
    switch (kind) {
      case "question": return clean(r?.needsInput || m.lastLine) || "question sans texte";
      case "error":    return clean(r?.lastTurn?.subtype && r.lastTurn.subtype !== "success" ? r.lastTurn.subtype : m.lastLine) || "échec du tour";
      case "dead":     return "le tour n'a plus de processus" + (r?.activity ? " · " + clean(r.activity) : "");
      case "stall":    return clean(r?.activity || m.lastLine) || "aucun événement récent";
      case "live":     return clean(r?.activity || m.lastLine || r?.mission) || "démarrage…";
      case "think":    return clean(r?.activity && r.activity !== "(réflexion…)" ? r.activity : "") || "réflexion…";
      case "chef":     return "décision demandée au chef" + (m.lastLine ? " · " + clean(m.lastLine) : "");
      case "queued": {
        const n = r?.queueDepth || 0;
        return `${n} tâche${n > 1 ? "s" : ""} en file, démarrage à la fin du tour`;
      }
      default: {
        if (m.state === "idle" && m.questionResolved) {
          return "✓ question marquée répondue" + (m.questionResolved.note ? " — " + clean(m.questionResolved.note) : "");
        }
        return clean(m.lastLine || r?.mission) || "—";
      }
    }
  }

  /** Âge affiché : tour en vol, silence si sans progrès, sinon dernière activité. */
  function ageOf(m, r, kind) {
    const el = recvElapsed();
    if (kind === "stall" && r?.silentMs != null) return { text: "silence " + fmtDur(r.silentMs + el), live: true };
    if ((kind === "live" || kind === "think" || kind === "dead") && r?.turnElapsedMs != null) {
      return { text: "tour " + fmtDur(r.turnElapsedMs + el), live: true };
    }
    const ts = lastActivityAt(m, r);
    const approx = ts && r?.lastActivitySource === "mtime" && !(m.lastActivityMs >= ts) ? "~ " : "";
    return { text: approx + fmtAgo(ts), live: false, title: ts ? new Date(ts).toLocaleString("fr-FR") : "" };
  }

  function detailsOf(r) {
    const bits = [];
    if (r?.version?.value) bits.push(`code v${r.version.value}`);
    if (r?.build?.apkAt) bits.push(`APK copié ${fmtAgo(r.build.apkAt)}`);
    const t = r?.lastTurn;
    if (t) {
      const parts = ["dernier tour"];
      if (Number.isFinite(t.durationMs)) parts.push(fmtDur(t.durationMs));
      parts.push(Number.isFinite(t.costUsd) ? `coût rapporté $${t.costUsd.toFixed(2)}` : "coût non fourni");
      bits.push(parts.join(" "));
    }
    return bits.join(" · ") || "aucune métadonnée de livrable";
  }

  // ------------------------------------------------------------------------
  // Modèle d'affichage
  // ------------------------------------------------------------------------
  function viewModel() {
    const App = global.App;
    if (!App?.musicians) return [];
    const out = [];
    for (const m of App.musicians.values()) {
      const r = snapRow(m.name);
      const c = classify(m, r);
      const line = lineOf(m, r, c.kind);
      out.push({ m, r, ...c, line, isChef: m.name === conductor(), la: lastActivityAt(m, r) || 0 });
    }
    return out;
  }

  function sortGroup(key, list) {
    const byName = (a, b) => a.m.name.localeCompare(b.m.name);
    if (key === "rest")   return list.sort((a, b) => a.rank - b.rank || b.la - a.la || byName(a, b));
    return list.sort((a, b) => a.rank - b.rank || byName(a, b));
  }

  function matches(it) {
    const f = st.filter.trim().toLowerCase();
    if (!f) return true;
    return it.m.name.toLowerCase().includes(f) || it.line.toLowerCase().includes(f) ||
      KIND[it.kind].word.toLowerCase().includes(f);
  }

  function tileHtml(it) {
    const k = KIND[it.kind];
    const r = it.r;
    const age = ageOf(it.m, r, it.kind);
    const chips = [];
    const q = r?.queueDepth || 0;
    if (q > 0) chips.push(`<span class="pv-chip pv-chip-queue" title="${q} tâche(s) en file derrière son tour">⏳ ${q}</span>`);
    if (r?.callbackTo) chips.push(`<span class="pv-chip pv-chip-cb" title="rapport promis à ${esc(r.callbackTo)} à la fin du tour">⇄ ${esc(r.callbackTo)}</span>`);
    if (it.isChef) chips.push(`<span class="pv-chip pv-chip-badge">CHEF</span>`);
    const mdl = shortModel(r);
    if (mdl) chips.push(`<span class="pv-chip pv-chip-model" title="${esc(mdl.title)}">${esc(mdl.text)}</span>`);
    const word = k.word;
    return `<span class="pv-glyph" aria-hidden="true">${esc(k.glyph)}</span>` +
      `<span class="pv-name">${esc(it.m.name)}</span>` +
      `<span class="pv-word">${esc(word)}</span>` +
      `<span class="pv-chips">${chips.join("")}</span>` +
      `<span class="pv-line" title="${esc(it.line)}">${esc(it.line)}</span>` +
      `<span class="pv-age${age.live ? " is-live" : ""}" title="${esc(age.title || "")}">${esc(age.text)}</span>` +
      `<span class="pv-more">${esc(detailsOf(r))}</span>`;
  }

  function ariaLabel(it) {
    const k = KIND[it.kind];
    const age = ageOf(it.m, it.r, it.kind);
    const bits = [it.m.name, k.word, it.line, age.text];
    const q = it.r?.queueDepth || 0;
    if (q) bits.push(`${q} en file`);
    if (it.r?.callbackTo) bits.push(`rapport promis à ${it.r.callbackTo}`);
    if (it.isChef) bits.push("chef d'orchestre");
    return bits.join(", ");
  }

  // ------------------------------------------------------------------------
  // Ordre stable (règle du rail)
  // ------------------------------------------------------------------------
  function stableOrder(key, desired) {
    const present = new Set(desired);
    const prev = st.orders[key] || [];
    const kept = prev.filter(n => present.has(n));
    const added = desired.filter(n => !kept.includes(n));
    const current = kept.concat(added);
    const same = current.length === desired.length && current.every((n, i) => n === desired[i]);
    if (same) { st.pendingSince[key] = 0; st.orders[key] = desired; return desired; }
    if (!st.pendingSince[key]) st.pendingSince[key] = Date.now();
    if (Date.now() - st.pendingSince[key] >= 1500) {
      st.pendingSince[key] = 0; st.orders[key] = desired; return desired;
    }
    st.orders[key] = current;
    scheduleRetry(1600);
    return current;
  }

  function scheduleRetry(ms) {
    if (st.retryTimer) return;
    st.retryTimer = setTimeout(() => { st.retryTimer = null; render(); }, ms);
  }

  // ------------------------------------------------------------------------
  // Rendu
  // ------------------------------------------------------------------------
  function root() { return document.getElementById("projects"); }

  function ensureItem(name) {
    let rec = st.items.get(name);
    if (rec) return rec;
    const li = document.createElement("div");
    li.className = "pv-item";
    li.setAttribute("role", "listitem");
    li.dataset.name = name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pv-tile";
    btn.dataset.name = name;
    li.appendChild(btn);
    rec = { li, btn, html: "", group: null };
    st.items.set(name, rec);
    return rec;
  }

  function counts(vm) {
    const c = { all: vm.length, attention: 0, active: 0, rest: 0, live: 0, questions: 0 };
    for (const it of vm) {
      c[it.group]++;
      if (it.kind === "live" || it.kind === "think") c.live++;
      if (it.kind === "question") c.questions++;
    }
    return c;
  }

  function renderPill(c) {
    const pill = document.getElementById("btn-projects");
    if (!pill) return;
    const bits = [];
    if (c.attention) bits.push(`<span class="pp-att">⚠ ${c.attention}</span>`);
    if (c.live) bits.push(`<span class="pp-live">● ${c.live}</span>`);
    const html = `<span class="pp-k">▦ Projets</span>${bits.join("")}`;
    if (pill._html !== html) { pill.innerHTML = html; pill._html = html; }
    pill.setAttribute("aria-label",
      `Statut des projets : ${c.all} projets, ${c.attention} à votre attention, ${c.live} en cours`);
    pill.classList.toggle("is-alert", c.attention > 0);
    pill.setAttribute("aria-pressed", String(st.open));
  }

  function renderBar(c) {
    const el = root();
    if (!el) return;
    const bar = $(".pv-counts", el);
    const defs = [
      ["all", "Tous", c.all], ["attention", "Attention", c.attention],
      ["active", "Actifs / attente", c.active], ["rest", "Repos", c.rest],
    ];
    const html = defs.map(([k, lbl, n]) => {
      const on = (k === "all" && !st.only) || st.only === k;
      return `<button type="button" class="pv-count" data-only="${k}" data-group="${k}" aria-pressed="${on}">${esc(lbl)} <b>${n}</b></button>`;
    }).join("");
    if (bar._html !== html) { bar.innerHTML = html; bar._html = html; }

    const sync = $(".pv-sync", el);
    const S = global.Salle;
    let txt = "instantané non reçu";
    const stale = S ? S.snapStale() : false;
    if (global.App?._pollOkAt) txt = stale ? `données anciennes (${fmtDur(S.snapAgeMs())})` : `synchronisé il y a ${fmtDur(S.snapAgeMs())}`;
    sync.textContent = txt;
    el.classList.toggle("is-stale", !!(global.App?._pollOkAt && stale));
  }

  function announce(vm) {
    const live = $(".pv-live", root() || document);
    const fresh = [];
    for (const it of vm) {
      const prev = st.kinds.get(it.m.name);
      if (!st.firstPaint && it.kind === "question" && prev !== "question") fresh.push(it.m.name);
      st.kinds.set(it.m.name, it.kind);
    }
    st.firstPaint = false;
    if (live && fresh.length) live.textContent = `Nouvelle question : ${fresh.join(", ")}`;
  }

  function render() {
    const vm = viewModel();
    const c = counts(vm);
    renderPill(c);
    announce(vm);
    const el = root();
    if (!el || !st.open) return;
    renderBar(c);
    el.classList.toggle("pv-details-on", st.details);
    const chk = $(".pv-details input", el);
    if (chk) chk.checked = st.details;

    const groups = { attention: [], active: [], rest: [] };
    for (const it of vm) groups[it.group].push(it);

    for (const g of GROUPS) {
      const sec = $(`.pv-section[data-group="${g.key}"]`, el);
      const grid = $(".pv-grid", sec);
      const list = sortGroup(g.key, groups[g.key]);
      const vis = list.filter(matches);

      // Contenu : patché sur place (le bouton — et donc le focus — survit).
      for (const it of list) {
        const rec = ensureItem(it.m.name);
        const html = tileHtml(it);
        if (rec.html !== html) { rec.btn.innerHTML = html; rec.html = html; }
        const k = KIND[it.kind];
        rec.btn.dataset.state = k.state;
        rec.btn.dataset.kind = it.kind;
        rec.btn.dataset.health = it.kind === "dead" ? "dead" : it.kind === "stall" ? "stall" : "";
        rec.btn.setAttribute("aria-label", ariaLabel(it));
        rec.li.hidden = !matches(it);
        rec.want = g.key;
      }

      // En-tête du groupe.
      const head = $(".pv-head", sec);
      const n = st.filter ? `${vis.length}/${list.length}` : `${list.length}`;
      const hh = `${esc(g.title)} <span class="pv-n">(${n})</span>`;
      if (head._html !== hh) { head.innerHTML = hh; head._html = hh; }

      const hiddenByOnly = st.only && st.only !== g.key;
      sec.hidden = hiddenByOnly || (!!st.filter && !vis.length);
      const empty = $(".pv-empty", sec);
      empty.hidden = list.length > 0;

      if (st.hold) continue;   // pointeur/focus dans la grille : aucun déplacement
      const order = stableOrder(g.key, list.map(it => it.m.name));
      for (let i = 0; i < order.length; i++) {
        const rec = st.items.get(order[i]);
        if (!rec) continue;
        if (grid.children[i] !== rec.li) grid.insertBefore(rec.li, grid.children[i] || null);
        rec.group = g.key;
      }
    }

    // Projets retirés de la configuration.
    const alive = new Set(vm.map(it => it.m.name));
    for (const [name, rec] of st.items) {
      if (!alive.has(name)) { rec.li.remove(); st.items.delete(name); st.kinds.delete(name); }
    }
  }

  /** Ticker 1 s : seuls les âges « vivants » (tour, silence) sont réécrits. */
  function tick() {
    if (!st.open || document.hidden) return;
    const el = root();
    if (!el) return;
    for (const [name, rec] of st.items) {
      const ageEl = rec.btn.querySelector(".pv-age.is-live");
      if (!ageEl) continue;
      const m = global.App?.musicians?.get(name);
      if (!m) continue;
      const r = snapRow(name);
      const a = ageOf(m, r, rec.btn.dataset.kind);
      if (ageEl.textContent !== a.text) ageEl.textContent = a.text;
    }
    renderBar(counts(viewModel()));
  }

  // ------------------------------------------------------------------------
  // Ouverture / fermeture (appelées par Salle.router)
  // ------------------------------------------------------------------------
  function show() {
    const el = root();
    if (!el) return false;
    if (!enabled()) return false;
    st.open = true;
    el.hidden = false;
    document.getElementById("main-row")?.classList.add("is-projects");
    lsSet(LS.level, "projets");
    render();
    return true;
  }

  function hide(remember) {
    const el = root();
    if (!st.open) return;
    st.open = false;
    st.hold = false;
    if (el) el.hidden = true;
    document.getElementById("main-row")?.classList.remove("is-projects");
    if (remember) lsSet(LS.level, "salle");
    renderPill(counts(viewModel()));
  }

  function open() {
    if (!enabled()) return;
    if (isRoute()) global.Salle?.router();
    else location.hash = "#/projets";
  }

  function backToSalle() {
    lsSet(LS.level, "salle");
    location.hash = "#/";
  }

  // ------------------------------------------------------------------------
  // Câblage
  // ------------------------------------------------------------------------
  function visibleTiles() {
    const el = root();
    return el ? [...el.querySelectorAll(".pv-section:not([hidden]) .pv-grid:not([hidden]) .pv-item:not([hidden]) .pv-tile")] : [];
  }

  function wire() {
    const el = root();
    if (!el || el._wired) return;
    el._wired = true;

    const body = $(".pv-body", el);
    const release = () => { st.hold = false; render(); };
    body.addEventListener("pointerenter", () => { st.hold = true; });
    body.addEventListener("pointerleave", () => { if (!body.contains(document.activeElement)) release(); });
    body.addEventListener("focusin", () => { st.hold = true; });
    body.addEventListener("focusout", (e) => {
      if (!body.contains(e.relatedTarget) && !body.matches(":hover")) release();
    });

    el.addEventListener("click", (e) => {
      const tile = e.target.closest(".pv-tile");
      if (tile) { global.App?.openMusician(tile.dataset.name); return; }
      const only = e.target.closest("[data-only]");
      if (only) {
        const k = only.dataset.only;
        st.only = (k === "all" || st.only === k) ? null : k;
        render();
        return;
      }
      if (e.target.closest(".pv-back")) { backToSalle(); return; }
    });

    const inp = $(".pv-filter", el);
    inp.addEventListener("input", () => { st.filter = inp.value; render(); });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && inp.value) { e.stopPropagation(); inp.value = ""; st.filter = ""; render(); }
      if (e.key === "Enter") { const t = visibleTiles()[0]; if (t) t.click(); }
    });

    $(".pv-details input", el).addEventListener("change", (e) => {
      st.details = !!e.target.checked;
      lsSet(LS.details, st.details ? "1" : null);
      render();
    });

    // Flèches : tuile précédente / suivante dans l'ordre affiché.
    body.addEventListener("keydown", (e) => {
      if (!e.target.classList?.contains("pv-tile")) return;
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      const tiles = visibleTiles();
      const i = tiles.indexOf(e.target);
      const next = tiles[i + dir];
      if (next) { e.preventDefault(); next.focus(); }
    });

    const pill = document.getElementById("btn-projects");
    if (pill) pill.addEventListener("click", () => (st.open ? backToSalle() : open()));

    // Phase de capture : on voit l'overlay AVANT que la salle ne le ferme sur
    // ce même Échap (sinon un Échap fermerait l'overlay ET quitterait la vue).
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest?.("input, textarea, [contenteditable='true']");
      const overlayOpen = !!document.querySelector(".overlay:not([hidden])");
      if (st.open && !global.Salle?.diveName && !overlayOpen) {
        if (e.key === "Escape" && !typing) { e.preventDefault(); backToSalle(); return; }
        if (e.key === "/" && !typing) { e.preventDefault(); inp.focus(); inp.select(); return; }
      }
      // « g » puis « p » : ouvrir la vue de n'importe où.
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "g") { st.gPending = Date.now(); return; }
      if (e.key === "p" && Date.now() - st.gPending < 1200) { st.gPending = 0; open(); }
    }, true);
  }

  function init() {
    readUrlParam();
    syncEntryPoints();
    wire();
  }

  /** Au chargement, sans lien direct : rouvrir le dernier niveau mémorisé. */
  function restoreLevel() {
    const h = String(location.hash || "");
    if ((h === "" || h === "#" || h === "#/") && enabled() && lsGet(LS.level) === "projets") {
      location.replace("#/projets");
    }
  }

  global.Projets = {
    init, applyUi, render, tick, show, hide, open, restoreLevel, enabled, isRoute,
    classify, describe, get isOpen() { return st.open; },
  };
})(window);
