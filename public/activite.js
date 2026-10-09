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
    // Entrées dépliées, par musicien (0.33.0) : survivent au rafraîchissement
    // temps réel et au va-et-vient entre volets, le temps de la page.
    unfolded: new Map(),   // nom → Set(clé de tour)
  };

  function turnKey(t) { return String(t.id || t.start || t.end || t.prompt || "?"); }
  function unfoldedSet(name) {
    if (!st.unfolded.has(name)) st.unfolded.set(name, new Set());
    return st.unfolded.get(name);
  }
  function toggle(key, { reveal = false } = {}) {
    if (!st.name) return;
    const set = unfoldedSet(st.name);
    if (set.has(key)) set.delete(key); else set.add(key);
    paint();
    // Replié depuis le bas d'un long texte : on ramène l'entrée à l'écran.
    if (reveal) {
      const card = [...document.querySelectorAll("#dive .dive-turns .jt")].find(c => c.dataset.key === key);
      if (card) {
        card.scrollIntoView({ block: "nearest" });
        card.querySelector("[data-jt-toggle]")?.focus({ preventScroll: true });
      }
    }
  }
  function md(text) {
    return typeof global.mdToHtml === "function" ? global.mdToHtml(text) : esc(text).replace(/\n/g, "<br>");
  }
  /** Texte complet d'une entrée dépliée : demande puis résultat, en Markdown. */
  function fullHtml(t, key) {
    const part = (label, full) => {
      if (!full || !full.text) return "";
      const cut = full.cut ? `<div class="jt-cut">texte coupé à ${(global.TurnCore?.FULL_MAX || 12000).toLocaleString("fr-FR")} caractères — la suite est dans l'onglet « Log brut »</div>` : "";
      return `<section class="jt-part"><div class="jt-k">${label}</div><div class="jt-md md">${md(full.text)}</div>${cut}</section>`;
    };
    return part("Demande complète", t.promptFull) + part("Résultat complet", t.resultFull) +
      `<button class="jt-toggle jt-bottom" type="button" data-jt-collapse="${esc(key)}">▴ Réduire</button>`;
  }

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

  function turnHtml(t, i) {
    const o = OUTCOME[t.outcome] || OUTCOME.ok;
    const key = turnKey(t);
    const canUnfold = !!(t.promptFull?.text || t.resultFull?.text);
    const open = canUnfold && st.name && unfoldedSet(st.name).has(key);
    const fid = `jt-full-${i}`;
    const toggleBtn = canUnfold
      ? `<button class="jt-toggle" type="button" data-jt-toggle="${esc(key)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${fid}">${open ? "▾ Réduire" : "▸ Afficher tout"}</button>`
      : "";
    let word = o.word;
    if (t.outcome === "stopped" && t.stop && global.TurnCore?.stopWord) word = global.TurnCore.stopWord(t.stop).toLowerCase();
    if (t.outcome === "error" && t.subtype) word += ` · ${t.subtype}`;
    if (t.test) word = `🧪 ${word} · test « ${t.test.label} »`;
    const meta = [fmtDur(t.durationMs), Number.isFinite(t.costUsd) ? `$${t.costUsd.toFixed(2)}` : null, shortModel(t.model) || null]
      .filter(Boolean).join(" · ");
    const ask = t.prompt
      ? `<div class="jt-ask"><span class="jt-k">Demande</span> ${esc(t.prompt)}</div>`
      : `<div class="jt-ask is-unknown"><span class="jt-k">Demande</span> non visible dans le log (tour lancé sans demande écrite)</div>`;
    let did = "";
    if (t.outcome === "running") {
      did = `<div class="jt-did">en cours · ${t.tools} appel${t.tools > 1 ? "s" : ""} d'outil</div>`;
    } else if (t.outcome === "stopped") {
      did = `<div class="jt-did">${esc(t.stop?.reason || "motif non précisé")}</div>`;
    } else if (t.summary && t.summary.length) {
      did = `<ul class="jt-did">${t.summary.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
    }
    const q = t.outcome === "question" && t.question ? `<div class="jt-q">? ${esc(t.question)}</div>` : "";
    // Mode double model (0.44.0) : chaque branche et la relecture, séparément.
    let dual = "";
    if (t.dual) {
      const d = t.dual;
      const cost = (c) => (Number.isFinite(c) ? ` · $${c.toFixed(2)}` : "");
      const row = (label, b) => {
        const st2 = !b ? "en cours" : b.status === "ok" ? "✓ terminée" : b.status === "running" ? "en cours" : `✕ échec${b.error ? " — " + b.error : ""}`;
        return `<li data-dual-role="${esc(label)}"><b>${esc(label)}</b> ${esc(shortModel(b?.served || b?.model || ""))} · ${esc(st2)}${b && fmtDur(b.durationMs) ? " · " + esc(fmtDur(b.durationMs)) : ""}${esc(cost(b?.costUsd))}${b?.diffstat ? ` · <span class="jt-dim">${esc(b.diffstat)}</span>` : ""}</li>`;
      };
      const byRole = (r) => (d.branches || []).find(b => b.role === r) || null;
      dual = `<div class="jt-dual"><span class="jt-k">×2 mode double</span>${d.sameModel ? ' <span class="jt-warn">principal = second</span>' : ""}
        ${d.secondFailed ? `<div class="jt-warn">⚠ branche seconde en échec — relecture avec le seul principal</div>` : ""}
        ${d.paused ? `<div class="jt-warn">⏸ pause : le principal a échoué, aucune relecture sans lui</div>` : ""}
        ${d.interrupted ? `<div class="jt-warn">✕ exécution interrompue avant la relecture — travail des branches archivé</div>` : ""}
        <ul>${row("principal", byRole("principal") || (d.principal ? { model: d.principal.model } : null))}${row("second", byRole("second") || (d.second ? { model: d.second.model } : null))}${d.review ? row("relecture", d.review) : ""}</ul></div>`;
    }
    // Pipelines (0.48.0) : la frise des étapes — model de la case, model servi,
    // critère vérifié par le code (✓) ou refus motivé, avertissements, limite.
    let pipe = "";
    if (t.pipeline) {
      const p = t.pipeline;
      const PIPE_LABEL = { discussion: "Discussion", dev: p.mode === "complet" ? "Développement complet" : "Développement léger" };
      const ST = { ok: "✓", refused: "✕ refusé", failed: "✕ échec", model_unavailable: "⏸ model indisponible", running: "● en cours", skipped: "↷ sautée" };
      const titleOf = (id) => (p.planned.find(x => x.id === id) || {}).title || id;
      const rows = p.steps.map(s => `<li class="jt-step" data-step-status="${esc(s.status || "running")}" data-step="${esc(s.id)}">
          <b>${esc(titleOf(s.id))}</b>${s.item ? ` <span class="jt-item" title="${esc(s.itemText || "")}">item ${esc(s.item)}</span>` : ""}${s.attempt > 1 ? ` <span class="jt-dim">essai ${esc(s.attempt)}</span>` : ""}
          · ${esc(shortModel(s.served || s.model || "") || "défaut du projet")}${s.source === "project-default" ? ' <span class="jt-warn" title="aucune case affectée dans la page Models">⚠ défaut du projet</span>' : ""}
          · ${esc(ST[s.status] || s.status || "")}${s.covered ? ' <span class="jt-covered" title="le test passait d’emblée : comportement déjà assuré par le code existant">↺ déjà couvert</span>' : ""}${s.durationMs != null && fmtDur(s.durationMs) ? " · " + esc(fmtDur(s.durationMs)) : ""}
          ${s.why ? `<div class="jt-dim jt-why">${esc(String(s.why).split("\n")[0].slice(0, 220))}</div>` : ""}</li>`).join("");
      const todo = p.status === "running" || p.status === "paused"
        ? p.planned.filter(x => !p.steps.some(s => s.id === x.id && s.status === "ok")).filter(x => !p.steps.some(s => s.id === x.id && s.status === "running"))
          .map(x => `<li class="jt-step is-todo" data-step="${esc(x.id)}"><b>${esc(x.title)}</b> · ${esc(shortModel(x.model || "") || "défaut du projet")} · à venir</li>`).join("")
        : "";
      pipe = `<div class="jt-pipeline" data-run="${esc(p.run)}"><span class="jt-k">⇄ pipeline ${esc(PIPE_LABEL[p.pipeline] || p.pipeline)}</span>
        <span class="jt-dim">${esc(p.run)}${p.resumed ? " · reprise" : ""}${p.items ? ` · ${esc(p.items)} item(s) cochés` : ""}${p.covered ? ` dont ${esc(p.covered)} déjà couvert(s)` : ""}${p.loops ? ` · ${esc(p.loops)} retour(s) de revue` : ""}</span>
        ${p.escalated ? `<div class="jt-escalate">${esc(p.escalated)}</div>` : ""}
        ${p.extended ? `<div class="jt-dim">${esc(p.extended)}</div>` : ""}
        ${p.limit ? `<div class="jt-warn" data-limit="${esc(p.limit.limit)}">${esc(p.limit.text)}</div>` : ""}
        <ol class="jt-steps">${rows}${todo}</ol></div>`;
    } else if (t.bypass) {
      pipe = `<div class="jt-pipeline is-bypass"><span class="jt-k">hors pipeline</span> <span class="jt-dim">${esc(t.bypass.reason)}</span></div>`;
    }
    // Demandes d'autorisation du tour (0.45.0), avec leur issue.
    const PERM_TXT = { allow_once: "autorisé une fois", allow_always: "toujours autorisé", rule: "règle permanente", deny: "refusé", expired: "expiré sans réponse" };
    const perms = (t.permissions || []).length
      ? `<ul class="jt-perms">${t.permissions.map(p => `<li data-decision="${esc(p.decision || "pending")}">🔐 <b>${esc(p.tool)}</b> <code>${esc(String(p.preview || "").slice(0, 80))}</code> — ${esc(p.decision ? PERM_TXT[p.decision] || p.decision : "en attente de votre décision")}${p.rule ? ` <span class="jt-dim">(${esc(p.rule)})</span>` : ""}${p.message ? ` — « ${esc(p.message)} »` : ""}</li>`).join("")}</ul>`
      : "";
    const chips = [];
    for (const c of t.commits || []) chips.push(`<span class="jt-chip" title="${esc(c.msg || "")}">commit ${esc(c.sha)}</span>`);
    if (t.pushed) chips.push(`<span class="jt-chip">poussé</span>`);
    for (const v of t.versions || []) chips.push(`<span class="jt-chip">v${esc(v)}</span>`);
    for (const u of t.urls || []) chips.push(`<a class="jt-chip is-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 48))}</a>`);
    const after = [];
    if (t.ack) after.push(`✓ marqué vu${t.ack.by && t.ack.by !== "utilisateur" ? " par " + esc(t.ack.by) : ""}${t.ack.ts ? " · " + esc(fmtWhen(t.ack.ts)) : ""}${t.ack.note ? " — " + esc(t.ack.note) : ""}`);
    if (t.resolved) after.push(`✓ question marquée répondue${t.resolved.note ? " — " + esc(t.resolved.note) : ""}`);
    return `<article class="jt${open ? " is-open" : ""}" data-outcome="${esc(t.outcome)}" data-key="${esc(key)}">
        <header class="jt-head">
          <span class="jt-mark">${esc(o.mark)}</span>
          <span class="jt-when">${esc(fmtWhen(t.start || t.end))}</span>
          <span class="jt-outcome">${esc(word)}</span>
          <span class="jt-meta">${esc(meta)}</span>
        </header>
        ${ask}${pipe}${dual}${perms}${did}${q}
        ${chips.length ? `<div class="jt-chips">${chips.join("")}</div>` : ""}
        ${after.length ? `<div class="jt-after">${after.join(" · ")}</div>` : ""}
        ${toggleBtn}
        ${canUnfold ? `<div class="jt-full" id="${fid}"${open ? "" : " hidden"}>${open ? fullHtml(t, key) : ""}</div>` : ""}
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
      body = st.data.turns.map((t, i) => turnHtml(t, i)).join("") +
        (st.data.truncated ? `<div class="dj-note">tours plus anciens : non chargés (seule la fin du log est lue)</div>` : "");
    }
    const html = links + body;
    if (pane._html === html) return;
    // Le rafraîchissement temps réel réécrit le panneau : on rend le focus au
    // même contrôle (clavier) et on garde la position de lecture.
    const focusKey = document.activeElement?.closest?.(".dive-turns [data-jt-toggle]")?.dataset.jtToggle;
    const top = pane.scrollTop;
    pane.innerHTML = html;
    pane._html = html;
    pane.scrollTop = top;
    if (focusKey != null) {
      const b = [...pane.querySelectorAll("[data-jt-toggle]")].find(x => x.dataset.jtToggle === focusKey);
      if (b) b.focus({ preventScroll: true });
    }
  }

  global.Activite = {
    applyUi, journalOn, cardsOn, open, load, onLiveEvent, paint, toggle,
    get name() { return st.name; },
  };
})(window);
