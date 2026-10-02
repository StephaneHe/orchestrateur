// ============================================================================
// public/activite.js — v0.31.0 « JOURNAL D'ACTIVITÉ » et cadres du Pilotage
// ============================================================================
//
// Le volet d'un musicien s'ouvre sur son JOURNAL : ses tours, du plus récent au
// plus ancien, avec la demande (sans boilerplate), ce qu'il a fait (1 à 3
// lignes de son result, commits, versions, URL), l'issue, la durée, le coût et
// le model. Le log brut reste à un clic (onglet « Log brut »).
//
// Une seule logique : le serveur réduit le log avec TurnCore.createJournal
// (public/turn-core.js) et sert GET /api/project/:name/journal. Le client ne
// recalcule rien : il redemande le journal (le serveur ne relit que les octets
// ajoutés) quand un événement de bord arrive pour le musicien ouvert — début ou
// fin de tour, « vu », question acquittée — et au plus toutes les 4 s sinon.
//
// Désactivable sans redéploiement :
//   · config.json → "ui": { "activityJournal": false } (journal) et/ou
//     "railCards": false (cadres du Pilotage), relus à chaud ;
//   · pour un seul navigateur : ?journal=0 / ?cadres=0 (=1 rétablit).
// ============================================================================
(function (global) {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LS = { journal: "act.journalOff", cards: "act.cardsOff" };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* privé */ } };

  const st = {
    serverJournal: true,
    serverCards: true,
    name: null,          // musicien dont le journal est chargé
    data: null,          // { turns, truncated }
    loading: false,
    error: "",
    lastFetch: 0,
    timer: null,
  };

  function readUrlParams() {
    for (const [param, key] of [["journal", LS.journal], ["cadres", LS.cards]]) {
      const m = new RegExp(`[?&]${param}=([^&#]*)`).exec(location.search);
      if (!m) continue;
      const v = decodeURIComponent(m[1]).toLowerCase();
      if (v === "0" || v === "off" || v === "non") lsSet(key, "1");
      if (v === "1" || v === "on" || v === "oui") lsSet(key, null);
    }
  }
  readUrlParams();

  function journalOn() { return st.serverJournal && lsGet(LS.journal) !== "1"; }
  function cardsOn()   { return st.serverCards && lsGet(LS.cards) !== "1"; }

  /** Drapeaux `ui` de /api/config et /api/pupitre (absents = activés). */
  function applyUi(ui) {
    const j = !(ui && ui.activityJournal === false);
    const c = !(ui && ui.railCards === false);
    const changed = j !== st.serverJournal || c !== st.serverCards;
    st.serverJournal = j;
    st.serverCards = c;
    if (changed) {
      global.Salle?.renderRail();
      if (global.Salle?.diveName) global.Salle.renderDive();
    }
  }

  // ------------------------------------------------------------------------
  // Chargement
  // ------------------------------------------------------------------------
  async function load(name) {
    if (st.loading && st.name === name) return;
    if (st.name !== name) { st.name = name; st.data = null; st.error = ""; }
    st.loading = true;
    st.lastFetch = Date.now();
    try {
      const resp = await fetch(`/api/project/${encodeURIComponent(name)}/journal?n=60`,
        { headers: { Accept: "application/json" }, credentials: "same-origin" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (st.name !== name) return;
      st.data = data;
      st.error = "";
    } catch (e) {
      if (st.name === name) st.error = e.message || String(e);
    } finally {
      st.loading = false;
      if (global.Salle?.diveName === name) paint();
    }
  }

  function open(name) {
    clearTimeout(st.timer);
    st.name = null;
    load(name);
  }

  const BOUNDARY = (raw) =>
    raw && (raw.type === "result" || raw.type === "user_prompt" || raw.type === "notification" ||
            (raw.type === "system" && raw.subtype === "init"));

  /** Un événement live du musicien ouvert : on redemande le journal. */
  function onLiveEvent(name, raw) {
    if (!journalOn() || st.name !== name || !raw || raw.type === "stream_event") return;
    clearTimeout(st.timer);
    const wait = BOUNDARY(raw) ? 300 : Math.max(0, 4000 - (Date.now() - st.lastFetch));
    st.timer = setTimeout(() => load(name), wait);
  }

  // ------------------------------------------------------------------------
  // Rendu
  // ------------------------------------------------------------------------
  const OUTCOME = {
    ok:          { mark: "✓", word: "terminé" },
    error:       { mark: "✕", word: "échec" },
    question:    { mark: "?", word: "question posée" },
    ask_chef:    { mark: "⇄", word: "attend le chef" },
    stopped:     { mark: "■", word: "arrêté par le chef" },
    system:      { mark: "⟲", word: "clos par le système" },
    interrupted: { mark: "⟲", word: "interrompu" },
    running:     { mark: "●", word: "en cours" },
  };

  function fmtWhen(iso) {
    if (!iso) return "date inconnue";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "date inconnue";
    const today = new Date();
    const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return `aujourd'hui ${hm}`;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " + hm;
  }
  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return global.Salle ? global.Salle.fmtAge(ms) : Math.round(ms / 1000) + "s";
  }
  function shortModel(m) {
    return String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  }

  function turnHtml(t) {
    const o = OUTCOME[t.outcome] || OUTCOME.ok;
    let word = o.word;
    if (t.outcome === "error" && t.subtype) word += ` · ${t.subtype}`;
    const meta = [fmtDur(t.durationMs), Number.isFinite(t.costUsd) ? `$${t.costUsd.toFixed(2)}` : null, shortModel(t.model) || null]
      .filter(Boolean).join(" · ");
    const ask = t.prompt
      ? `<div class="jt-ask"><span class="jt-k">Demande</span> ${esc(t.prompt)}</div>`
      : `<div class="jt-ask is-unknown"><span class="jt-k">Demande</span> non visible dans le log (tour lancé sans demande écrite)</div>`;
    let did = "";
    if (t.outcome === "running") {
      did = `<div class="jt-did">en cours · ${t.tools} appel${t.tools > 1 ? "s" : ""} d'outil</div>`;
    } else if (t.outcome === "stopped") {
      did = `<div class="jt-did">${esc(t.stop?.reason || "arrêté par la supervision du chef (motif non précisé)")}</div>`;
    } else if (t.summary && t.summary.length) {
      did = `<ul class="jt-did">${t.summary.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
    }
    const q = t.outcome === "question" && t.question ? `<div class="jt-q">? ${esc(t.question)}</div>` : "";
    const chips = [];
    for (const c of t.commits || []) chips.push(`<span class="jt-chip" title="${esc(c.msg || "")}">commit ${esc(c.sha)}</span>`);
    if (t.pushed) chips.push(`<span class="jt-chip">poussé</span>`);
    for (const v of t.versions || []) chips.push(`<span class="jt-chip">v${esc(v)}</span>`);
    for (const u of t.urls || []) chips.push(`<a class="jt-chip is-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 48))}</a>`);
    const after = [];
    if (t.ack) after.push(`✓ marqué vu${t.ack.by && t.ack.by !== "utilisateur" ? " par " + esc(t.ack.by) : ""}${t.ack.ts ? " · " + esc(fmtWhen(t.ack.ts)) : ""}${t.ack.note ? " — " + esc(t.ack.note) : ""}`);
    if (t.resolved) after.push(`✓ question marquée répondue${t.resolved.note ? " — " + esc(t.resolved.note) : ""}`);
    return `<article class="jt" data-outcome="${esc(t.outcome)}">
        <header class="jt-head">
          <span class="jt-mark">${esc(o.mark)}</span>
          <span class="jt-when">${esc(fmtWhen(t.start || t.end))}</span>
          <span class="jt-outcome">${esc(word)}</span>
          <span class="jt-meta">${esc(meta)}</span>
        </header>
        ${ask}${did}${q}
        ${chips.length ? `<div class="jt-chips">${chips.join("")}</div>` : ""}
        ${after.length ? `<div class="jt-after">${after.join(" · ")}</div>` : ""}
      </article>`;
  }

  function paint() {
    const pane = document.querySelector("#dive .dive-turns");
    if (!pane) return;
    const links = `<div class="jt-links">
        <button class="jt-link" type="button" data-dive-tab="activity">Activité en direct ›</button>
        <button class="jt-link" type="button" data-dive-tab="journal">Log brut ›</button>
      </div>`;
    let body;
    if (st.error && !st.data) body = `<div class="dj-note">journal illisible : ${esc(st.error)}</div>`;
    else if (!st.data) body = `<div class="dj-note">chargement du journal…</div>`;
    else if (!st.data.turns.length) body = `<div class="dj-note">Aucun tour dans le log de ce musicien.</div>`;
    else {
      body = st.data.turns.map(turnHtml).join("") +
        (st.data.truncated ? `<div class="dj-note">tours plus anciens : non chargés (seule la fin du log est lue)</div>` : "");
    }
    const html = links + body;
    if (pane._html !== html) { pane.innerHTML = html; pane._html = html; }
  }

  global.Activite = {
    applyUi, journalOn, cardsOn, open, load, onLiveEvent, paint,
    get name() { return st.name; },
  };
})(window);
