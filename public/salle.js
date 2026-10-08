// ============================================================================
// public/salle.js — v0.21.0 « SALLE DE DIRECTION »
// ============================================================================
//
// Rendu de la nouvelle conversation de direction, hors du fil lui-même :
//   · en-tête chef (état unique, sans carte dupliquée)
//   · rail PILOTAGE (EN COURS / À EXAMINER / Tous)
//   · bande d'attention + bandeau système unique
//   · lignes de mission (tour du chef) et « activité de l'orchestre »
//   · volet musicien routé par hash (#/m/<projet>) à trois onglets
//   · annuaire / recherche global (parkés inclus)
//
// Chargé AVANT app.js : les fonctions sont donc définies quand app.js les
// appelle, et `App` (const de portée script) est résolu à l'appel.
//
// GARDE-FOU : le vocabulaire d'états `idle|live|think|input|error|unread` est
// verrouillé (5 réducteurs en dépendent). Rien ici n'invente de chaîne d'état :
// on n'ajoute que des LIBELLÉS, des badges et des regroupements.
// ============================================================================
(function (global) {
  "use strict";

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Libellés d'affichage (table d'Astra). Les CLÉS ne changent jamais.
  const LABEL = {
    idle:   "Prêt",
    live:   "En cours",
    think:  "En cours · réflexion",
    input:  "Votre réponse attendue",
    unread: "Terminé",
    error:  "Échec",
  };
  // Marqueurs musicien (§6 « différenciation graphique »).
  const GLYPH = {
    idle: "○", live: "●", think: "◐", input: "?", error: "✕", unread: "✓",
  };

  function label(m) {
    if (m.state === "error" && m.stopped) return "Arrêté par le chef";
    if (m.state === "unread" && m.awaitingChef) return "Attend le chef";
    return LABEL[m.state] || LABEL.idle;
  }
  function glyph(m) {
    if (m.state === "error" && m.stopped) return "■";
    if (m.state === "unread" && m.awaitingChef) return "⇄";
    return GLYPH[m.state] || "○";
  }

  function fmtAge(ms) {
    if (!isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const mn = Math.floor(s / 60);
    if (mn < 60) return mn + "m" + String(s % 60).padStart(2, "0");
    const h = Math.floor(mn / 60);
    return h + "h" + String(mn % 60).padStart(2, "0");
  }

  // ------------------------------------------------------------------------
  // Accès à l'instantané /api/pupitre — source AUTORITAIRE pour la santé.
  // `pidAlive === null` = INCONNU (jamais « mort »). Un parké n'est pas scanné :
  // sa santé n'est pas suivie, et on le dit.
  // ------------------------------------------------------------------------
  function snapRow(name) {
    const snap = App.pupitreSnapshot;
    if (!snap || !Array.isArray(snap.fleet)) return null;
    return snap.fleet.find(r => r.name === name) || null;
  }
  function snapAgeMs() {
    return App._pollOkAt ? (Date.now() - App._pollOkAt) : Infinity;
  }
  /** Les mesures ont-elles plus de 15 s ? (⇒ grisées et datées, §6) */
  function snapStale() { return snapAgeMs() > 15000; }

  /** Anomalie prioritaire d'un musicien, ou null. Ordre : processus perdu >
   *  sans progrès. `pidAlive:null` ne produit JAMAIS « perdu ». */
  function healthFlag(r) {
    if (!r) return null;
    // 0.45.0 : en pause volontaire, il attend VOTRE décision (jamais « sans progrès »).
    if (r.awaitingPermission) return { kind: "perm", text: "🔐 attend autorisation · " + (r.awaitingPermission.tool || "outil") };
    if (r.deadInFlight === true) return { kind: "dead", text: "✗ processus perdu" };
    if (r.stalled) return { kind: "stall", text: "! sans progrès " + fmtAge(r.silentMs) };
    return null;
  }

  // ------------------------------------------------------------------------
  // FILE DE DIRECTION (0.22.0, P0-A)
  // ------------------------------------------------------------------------
  //
  // Un message envoyé pendant un tour du chef ne le tue plus : il attend, et
  // cette attente est VISIBLE — sous la bulle concernée d'abord (c'est là que
  // l'utilisateur regarde), dans une bande repliée ensuite (combien, dans quel
  // ordre, avec quoi faire). Honnêteté : « en file · position n » sans compte à
  // rebours, « pris par » seulement quand le log du slot le prouve.
  //
  // P0-A n'affiche qu'un chef. Les trois pastilles de slot sont P0-B.
  // ------------------------------------------------------------------------
  function poolSnap()  { return App.pupitreSnapshot?.pool || null; }
  function poolQueue() { const p = poolSnap(); return Array.isArray(p?.queue) ? p.queue : []; }
  function poolSlots() { const p = poolSnap(); return Array.isArray(p?.slots) ? p.slots : []; }
  function poolFreeSlots() {
    const s = poolSlots();
    if (!s.length) return null;                      // instantané non reçu : on ne prétend rien
    return s.filter(x => !x.pidAlive && !x.ticket).length;
  }
  function poolTicket(id) { return poolQueue().find(t => t.id === id) || null; }
  function poolRunningTicket(id) {
    return poolSlots().find(s => s.ticket && s.ticket.id === id) || null;
  }
  function hhmm(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /** Ligne de statut sous une bulle utilisateur. Rien si le message n'a pas de
   *  ticket (historique d'avant 0.22.0) ou si son tour est déjà fini. */
  function ticketStatusHtml(b) {
    if (!b || !b.ticket) return "";
    const qt = poolTicket(b.ticket);
    if (qt) {
      const bits = [`⏳ en file · position ${qt.position}`];
      if (qt.pinnedSlot) bits.push(`attend le CHEF ${qt.pinnedSlot}`);
      else {
        const free = poolFreeSlots();
        if (free === 0) bits.push("chef occupé");
      }
      if (qt.lost) bits.push("tour perdu · remis en tête");
      return `<div class="cv-ticket" data-phase="queued">
          <span class="ct-txt">${esc(bits.join(" · "))}</span>
          <button class="ct-act" data-pool-withdraw="${esc(qt.id)}">Retirer</button>
          <button class="ct-act" data-pool-interrupt="1">Interrompre le chef avec ce message</button>
        </div>`;
    }
    const run = poolRunningTicket(b.ticket);
    if (run) {
      const taken = run.ticket.state === "RUNNING";
      const when = run.ticket.since ? " · " + hhmm(run.ticket.since) : "";
      return `<div class="cv-ticket" data-phase="${taken ? "running" : "assigned"}">
          <span class="ct-txt">${taken
            ? `▸ pris par CHEF ${run.slot}${when}`
            : `▸ assigné au CHEF ${run.slot}`}</span>
        </div>`;
    }
    if (b.withdrawn) return `<div class="cv-ticket" data-phase="withdrawn"><span class="ct-txt">⟲ retiré de la file</span></div>`;
    return "";
  }

  let poolBandOpen = false;

  function renderPoolBand() {
    const el = document.getElementById("poolband");
    if (!el) return;
    const q = poolQueue();
    if (!q.length) { el.hidden = true; el.innerHTML = ""; poolBandOpen = false; return; }
    el.hidden = false;

    const users  = q.filter(t => t.class === "user" || t.class === "decision" || t.class === "delegation");
    const points = q.filter(t => t.class === "point");
    const free   = poolFreeSlots();
    const counts = [];
    counts.push(`${users.length} message${users.length > 1 ? "s" : ""} en attente`);
    if (free === 0) counts.push("chef occupé");
    else if (free != null && free > 0) counts.push(`${free} libre`);
    if (points.length) counts.push(`${points.length} point${points.length > 1 ? "s" : ""} en préparation`);

    const rowHtml = (t, i) => {
      const why = t.class === "decision" ? "décision demandée par un musicien"
        : t.class === "point" ? "point sur les résultats"
        : t.pinnedSlot ? `attend le CHEF ${t.pinnedSlot}`
        : "n'importe quel chef";
      const acts = t.class === "point" ? "" :
        `<button class="pb-act" data-pool-withdraw="${esc(t.id)}">Retirer</button>` +
        `<button class="pb-act" data-pool-interrupt="1">Interrompre le chef avec ce message</button>`;
      return `<div class="pb-item" data-class="${esc(t.class)}">
          <span class="pb-n">${i + 1}.</span>
          <span class="pb-time">${esc(hhmm(t.enqueuedAt))}</span>
          <span class="pb-head">${esc(t.head || "(sans texte)")}</span>
          <span class="pb-why">${esc(why)}</span>
          ${acts}
        </div>`;
    };

    el.innerHTML =
      `<button class="pb-line" type="button">
         <span class="pb-tag">⏳ File de direction</span>
         <span class="pb-counts">${esc(counts.join(" · "))}</span>
         <span class="pb-top">${esc(q[0].head || "")}</span>
         <span class="pb-caret">${poolBandOpen ? "▾" : "▸"}</span>
       </button>` +
      `<div class="pb-list"${poolBandOpen ? "" : " hidden"}>${q.map(rowHtml).join("")}</div>`;
  }

  function wirePoolBand() {
    const el = document.getElementById("poolband");
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".pb-line")) { poolBandOpen = !poolBandOpen; renderPoolBand(); return; }
      const w = e.target.closest("[data-pool-withdraw]");
      if (w) { App.withdrawTicket(w.dataset.poolWithdraw); return; }
      const it = e.target.closest("[data-pool-interrupt]");
      if (it) { App.interruptChef(Number(it.dataset.poolInterrupt) || 1); return; }
    });
  }

  // ------------------------------------------------------------------------
  // En-tête : l'état du chef vit ICI et nulle part ailleurs.
  // ------------------------------------------------------------------------
  function renderChefStatus(m) {
    const el = document.getElementById("chef-status");
    if (!el) return;
    if (!m) {
      el.dataset.state = "idle";
      el.classList.add("is-unconfigured");
      el.classList.remove("is-answering");
      $(".cs-label", el).textContent = "aucun chef configuré";
      $(".cs-sync", el).textContent = "";
      return;
    }
    el.classList.remove("is-unconfigured");
    el.dataset.state = m.state;
    $(".cs-name", el).textContent = m.name.toUpperCase();

    const waiting = App._awaitingConductorResponse;
    el.classList.toggle("is-answering", !!waiting);
    let txt;
    if (waiting) txt = m.state === "think" ? "réfléchit…" : "répond…";
    else txt = label(m).toLowerCase();

    const r = snapRow(m.name);
    const h = healthFlag(r);
    if (h) txt += " · " + h.text;
    // File de direction (0.22.0) : combien attendent, lisible sans clic.
    const nq = poolQueue().length;
    if (nq) txt += ` · file ${nq}`;
    $(".cs-label", el).textContent = txt;

    // Fraîcheur : âge de l'instantané, pas de l'horloge de rendu.
    const sync = $(".cs-sync", el);
    if (!App._pollOkAt) sync.textContent = "instantané non reçu";
    else if (snapStale()) sync.textContent = "données anciennes (" + fmtAge(snapAgeMs()) + ")";
    else sync.textContent = "synchronisé il y a " + fmtAge(snapAgeMs());
  }

  // ------------------------------------------------------------------------
  // Bandeau système — UN SEUL visible, le plus grave. Les autres en compteur.
  // Priorité : processus perdu > limite Claude > flux interrompu / données
  // anciennes. « flux interrompu » ne grise JAMAIS les cartes si l'instantané
  // est bon : les états restent actualisés.
  // ------------------------------------------------------------------------
  function renderSysBanner() {
    const el = document.getElementById("sysbanner");
    if (!el) return;
    const snap = App.pupitreSnapshot;
    const banners = [];

    const dead = (snap?.fleet || []).filter(r => r.deadInFlight === true);
    if (dead.length) {
      banners.push({ kind: "lost", text: `✗ processus perdu — ${dead.map(r => r.name).join(", ")}` });
    }
    const lim = snap?.limitedUntil ? Number(snap.limitedUntil) : 0;
    if (lim && lim > Date.now()) {
      const d = new Date(lim);
      const hh = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      banners.push({ kind: "limited", text: `⚡ limite Claude — reprise annoncée à ${hh}` });
    }
    if (App._sseUp === false) {
      banners.push({
        kind: "stale",
        text: snapStale() || App._pollFailing
          ? "⟲ flux interrompu — données anciennes, reconnexion automatique"
          : "⟲ flux interrompu — états actualisés par instantané, direct coupé",
      });
    } else if (App._pollFailing) {
      banners.push({ kind: "stale", text: "⟲ télémétrie muette — dernières valeurs connues affichées" });
    }

    if (!banners.length) { el.hidden = true; el.innerHTML = ""; return; }
    const top = banners[0];
    el.hidden = false;
    el.dataset.kind = top.kind;
    el.innerHTML = `<span>${esc(top.text)}</span>` +
      (banners.length > 1 ? `<span class="sb-more">+${banners.length - 1} autre${banners.length > 2 ? "s" : ""}</span>` : "");
  }

  // ------------------------------------------------------------------------
  // Bande d'attention — une ligne repliée, l'élément le plus grave lisible
  // sans clic. Priorité : question > processus perdu > échec > sans progrès.
  // ------------------------------------------------------------------------
  const ATT_RANK = { perm: -1, question: 0, dead: 1, error: 2, stopped: 2, stall: 3 };

  function attentionItems() {
    const out = [];
    for (const m of App.musicians.values()) {
      if (m.name === App.composer.CONDUCTOR) continue;
      const r = snapRow(m.name);
      const needs = r?.needsInput || (m.state === "input" ? m.lastLine : "");
      if (m.state === "input") {
        out.push({ kind: "question", name: m.name, mark: "?", text: needs || "question sans texte" });
        continue;
      }
      const h = healthFlag(r);
      if (h) { out.push({ kind: h.kind, name: m.name, mark: h.kind === "dead" ? "✗" : h.kind === "perm" ? "🔐" : "!", text: h.text }); continue; }
      if (m.state === "error" && m.stopped) {
        out.push({ kind: "stopped", name: m.name, mark: "■", text: "arrêté par le chef" + (m.stopped.reason ? " — " + m.stopped.reason : "") });
      } else if (m.state === "error") {
        out.push({ kind: "error", name: m.name, mark: "✕", text: m.lastLine || "échec du tour" });
      }
    }
    out.sort((a, b) => (ATT_RANK[a.kind] - ATT_RANK[b.kind]) || a.name.localeCompare(b.name));
    return out;
  }

  let attentionOpen = false;

  function renderAttention() {
    const el = document.getElementById("attention");
    if (!el) return;
    const items = attentionItems();
    if (!items.length) { el.hidden = true; el.innerHTML = ""; attentionOpen = false; return; }
    el.hidden = false;

    const counts = [];
    const nq = items.filter(i => i.kind === "question").length;
    const nd = items.filter(i => i.kind === "dead").length;
    const ne = items.filter(i => i.kind === "error").length;
    const ns = items.filter(i => i.kind === "stall").length;
    const nk = items.filter(i => i.kind === "stopped").length;
    const np = items.filter(i => i.kind === "perm").length;
    if (np) counts.push(`${np} autorisation${np > 1 ? "s" : ""} à décider`);
    if (nq) counts.push(`${nq} question${nq > 1 ? "s" : ""}`);
    if (nd) counts.push(`${nd} processus perdu${nd > 1 ? "s" : ""}`);
    if (ne) counts.push(`${ne} échec${ne > 1 ? "s" : ""}`);
    if (nk) counts.push(`${nk} arrêté${nk > 1 ? "s" : ""} par le chef`);
    if (ns) counts.push(`${ns} sans progrès`);
    const top = items[0];

    const itemHtml = (it) => {
      const acts = it.kind === "perm"
        ? `<button class="ai-act is-primary" data-perm-project="${esc(it.name)}" title="Voir tous les détails et décider">🔐 Décider</button>` +
          `<button class="ai-act" data-open-musician="${esc(it.name)}">Ouvrir</button>`
        : it.kind === "question"
        ? `<button class="ai-act is-primary" data-via-chef="${esc(it.name)}">Répondre via le chef</button>` +
          `<button class="ai-act" data-resolve-question="${esc(it.name)}" title="Déjà répondue ailleurs ou sans objet — aucun tour relancé">✓ Marquer comme répondue</button>` +
          `<button class="ai-act" data-open-musician="${esc(it.name)}">Ouvrir</button>`
        : (it.kind === "error" || it.kind === "stopped"
            ? `<button class="ai-act" data-ack="${esc(it.name)}" title="Vu : retire de « À examiner » — aucun tour relancé">✓ Marquer vu</button>` : "") +
          `<button class="ai-act" data-open-musician="${esc(it.name)}">Ouvrir</button>` +
          `<button class="ai-act" data-talk-chef="${esc(it.name)}">En parler au chef</button>`;
      return `<div class="att-item" data-kind="${esc(it.kind)}">
        <span class="ai-mark">${esc(it.mark)}</span>
        <span class="ai-name">${esc(it.name)}</span>
        <span class="ai-text">${esc(it.text)}</span>
        ${acts}
      </div>`;
    };

    el.innerHTML =
      `<button class="att-line" type="button">
         <span class="att-tag">⚠ À votre attention</span>
         <span class="att-counts">${esc(counts.join(" · "))}</span>
         <span class="att-top">${esc(top.name)} : ${esc(top.text)}</span>
         <span class="att-caret">${attentionOpen ? "▾" : "▸"}</span>
       </button>` +
      `<div class="att-list"${attentionOpen ? "" : " hidden"}>${items.map(itemHtml).join("")}</div>`;
  }

  function wireAttention() {
    const el = document.getElementById("attention");
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".att-line")) {
        attentionOpen = !attentionOpen;
        renderAttention();
        return;
      }
      const open = e.target.closest("[data-open-musician]");
      if (open) { App.openMusician(open.dataset.openMusician); return; }
      const via = e.target.closest("[data-via-chef]");
      if (via) { App.answerViaChef(via.dataset.viaChef); return; }
      const rq = e.target.closest("[data-resolve-question]");
      if (rq) { App.resolveQuestion(rq.dataset.resolveQuestion); return; }
      const ack = e.target.closest("[data-ack]");
      if (ack) { App.ackMusician(ack.dataset.ack); return; }
      const talk = e.target.closest("[data-talk-chef]");
      if (talk) { App.talkToChefAbout(talk.dataset.talkChef); return; }
    });
  }

  // ------------------------------------------------------------------------
  // Rail PILOTAGE
  // ------------------------------------------------------------------------
  // Tri d'attention STABLE (même règle que PupitreRow.rank) + nom à priorité
  // égale ; le réordonnancement est DIFFÉRÉ de 1,5 s et suspendu tant que le
  // pointeur survole le rail (« jamais sous le pointeur »).
  function railRank(m) {
    const r = snapRow(m.name);
    if (r && (r.stalled || r.deadInFlight || r.awaitingPermission)) return 0;
    if (m.state === "error") return 1;
    if (m.state === "input") return 2;
    if (m.state === "live" || m.state === "think") return 3;
    if (m.state === "unread") return 4;
    return 5;
  }

  const railState = {
    orders: {},           // clé de groupe → ordre actuellement affiché
    pendingSince: {},     // clé de groupe → début de la permutation en attente
    hovered: false,
    foldAll: true,        // « Tous les musiciens » replié par défaut
    foldCards: false,     // cadres des musiciens dépliés par défaut (0.31.0)
    open: false,          // mobile : feuille ouverte ?
  };

  const byAttention = (a, b) => railRank(a) - railRank(b) || a.name.localeCompare(b.name);

  function stableOrder(list, key, cmp = byAttention) {
    const desired = [...list].sort(cmp).map(m => m.name);
    const present = new Set(desired);
    // Les disparus sortent tout de suite ; les nouveaux entrent tout de suite
    // (rien ne bouge pour l'utilisateur) ; une PERMUTATION attend 1,5 s.
    const prev = railState.orders[key] || [];
    const kept = prev.filter(n => present.has(n));
    const added = desired.filter(n => !kept.includes(n));
    const current = kept.concat(added);
    const same = current.length === desired.length && current.every((n, i) => n === desired[i]);
    if (same) { railState.pendingSince[key] = 0; railState.orders[key] = desired; return desired; }
    if (!railState.pendingSince[key]) railState.pendingSince[key] = Date.now();
    if (!railState.hovered && Date.now() - railState.pendingSince[key] >= 1500) {
      railState.pendingSince[key] = 0;
      railState.orders[key] = desired;
      return desired;
    }
    railState.orders[key] = current;
    return current;
  }

  function railRowHtml(m, withAck = false) {
    const r = snapRow(m.name);
    const h = healthFlag(r);
    const stale = snapStale();
    const bits = [];
    if (h) {
      bits.push(`<span class="rr-warn">${esc(h.text)}</span>`);
    } else if (r && (m.state === "live" || m.state === "think")) {
      const act = r.activity ? String(r.activity).slice(0, 48) : "";
      const turn = r.turnElapsedMs != null ? fmtAge(r.turnElapsedMs) : null;
      if (act) bits.push(esc(act));
      if (turn) bits.push(esc(turn));
    } else if (m.state === "input") {
      bits.push(esc((r?.needsInput || m.lastLine || "").slice(0, 60)));
    } else if (m.state === "error" && m.stopped) {
      bits.push(esc(m.stopped.reason ? m.stopped.reason.slice(0, 60) : "motif non précisé"));
    } else if (m.state === "unread") {
      bits.push(m.awaitingChef ? "⇄ attend une décision du chef" : "✓ résultat non lu");
    } else if (m.lastLine) {
      bits.push(`<span class="rr-soft">${esc(m.lastLine.slice(0, 50))}</span>`);
    }
    if (stale) bits.push(`<span class="rr-soft">(données anciennes)</span>`);
    const alert = h ? " is-alert" : "";
    const stoppedAttr = m.stopped && m.state === "error" ? ' data-stopped="1"' : "";
    const row = `<button class="rail-row${alert}" data-state="${esc(m.state)}" data-name="${esc(m.name)}"${stoppedAttr} type="button">
        <span class="rr-dot"></span>
        <span class="rr-name">${esc(m.name)}</span>
        <span class="rr-state">${esc(glyph(m))} ${esc(label(m))}</span>
        <span class="rr-sub">${bits.join(" · ") || "&nbsp;"}</span>
      </button>`;
    if (!withAck) return row;
    // « À examiner » (0.31.0) : chaque élément s'acquitte depuis son cadre.
    const act = ackAction(m);
    return act ? `<div class="rail-item">${row}${act}</div>` : row;
  }

  /** Bouton « vu » d'un élément à examiner, ou "" (en vol : rien à acquitter). */
  function ackAction(m) {
    if (snapRow(m.name)?.awaitingPermission) {
      return `<button class="rr-ack" type="button" data-perm-project="${esc(m.name)}" title="Voir tous les détails et décider">🔐 Décider</button>`;
    }
    if (m.state === "input") {
      return `<button class="rr-ack" type="button" data-resolve-question="${esc(m.name)}" title="Déjà répondue ailleurs ou sans objet — aucun tour relancé">✓ Répondue</button>`;
    }
    if (m.state === "error" || m.state === "unread") {
      return `<button class="rr-ack" type="button" data-ack="${esc(m.name)}" title="Vu : retire de « À examiner » — aucun tour relancé">✓ Vu</button>`;
    }
    return "";
  }

  function railGroups() {
    const CONDUCTOR = App.composer.CONDUCTOR;
    const all = [...App.musicians.values()].filter(m => m.name !== CONDUCTOR);
    const active = all;

    const inFlight = active.filter(m => m.state === "live" || m.state === "think");
    const examine = active.filter(m => {
      if (inFlight.includes(m)) {
        const r = snapRow(m.name);
        return !!(r && (r.stalled || r.deadInFlight || r.awaitingPermission));
      }
      // À EXAMINER = ce qui réclame une décision : question, échec, blocage
      // sur le chef, et tout ce qui est en vol mais sans progrès / PID mort.
      // Un simple « terminé non lu » n'y entre pas (il tiendrait la barre).
      return m.state === "input" || m.state === "error" ||
             (m.state === "unread" && m.awaitingChef);
    });
    const running = inFlight.filter(m => !examine.includes(m));
    return { all, active, running, examine };
  }

  // ------------------------------------------------------------------------
  // Cadres des musiciens (0.31.0) — 2ᵉ partie du Pilotage : un cadre par
  // musicien, du plus récemment actif au plus ancien. L'état et son mot
  // viennent de la vue Projets (Projets.describe) : une seule classification.
  // Même règle de stabilité que les groupes (permutation différée, jamais sous
  // le pointeur).
  // ------------------------------------------------------------------------
  // Source : `lastActivityAt` de /api/pupitre (horodatage du dernier vrai
  // événement, sinon mtime du log), rafraîchi toutes les 5 s. Pas
  // `m.lastActivityMs` : c'est l'heure de RÉCEPTION, que le rejeu du SSE au
  // chargement met à « maintenant » pour tout le monde.
  function lastActivityMs(m) {
    return Number(snapRow(m.name)?.lastActivityAt) || 0;
  }
  /** À la minute près : un âge à la seconde réécrirait le rail chaque seconde
   *  (survol, focus et clic perdus sur un cadre recréé). */
  function coarseAge(ms) {
    const mn = Math.floor(Math.max(0, ms) / 60000);
    if (mn < 1) return "à l'instant";
    if (mn < 60) return `il y a ${mn} min`;
    const h = Math.floor(mn / 60);
    if (h < 48) return `il y a ${h} h ${String(mn % 60).padStart(2, "0")}`;
    return `il y a ${Math.floor(h / 24)} j`;
  }
  // 0.32.0 : le bloc « En cours » a disparu, ce sont les cadres qui montrent les
  // tours en cours — EN TÊTE, explicitement : un musicien qui réfléchit
  // longtemps sans rien écrire ne doit pas glisser sous un musicien au repos.
  const inFlight = (m) => m.state === "live" || m.state === "think";
  const byRecency = (a, b) => (inFlight(b) - inFlight(a)) ||
    (lastActivityMs(b) - lastActivityMs(a)) || a.name.localeCompare(b.name);

  function cardHtml(m, now) {
    const r = snapRow(m.name);
    const d = global.Projets?.describe ? global.Projets.describe(m, r) : { glyph: glyph(m), word: label(m), kind: m.state };
    const last = lastActivityMs(m);
    // En cours : la durée du tour (que portait l'ancien bloc « En cours »), à
    // la minute comme l'âge, pour ne pas réécrire le cadre chaque seconde.
    let age = last ? coarseAge(now - last) : "jamais observé";
    if (inFlight(m) && r?.turnElapsedMs != null) {
      const mn = Math.floor(r.turnElapsedMs / 60000);
      age = mn < 1 ? "tour < 1 min" : mn < 60 ? `tour ${mn} min` : `tour ${Math.floor(mn / 60)} h ${String(mn % 60).padStart(2, "0")}`;
    }
    if (snapStale()) age += " · données anciennes";
    const q = r?.queueDepth > 0 ? `<span class="rc-chip" title="tâches en file derrière son tour">⏳ ${r.queueDepth}</span>` : "";
    let line = "";
    if (m.state === "error" && m.stopped) line = m.stopped.reason || "arrêté par la supervision du chef";
    else if (m.state === "input") line = r?.needsInput || m.lastLine || "";
    else if ((m.state === "live" || m.state === "think") && r?.activity) line = r.activity;
    else line = m.lastLine || r?.activity || r?.mission || "";
    line = String(line).replace(/\s+/g, " ").slice(0, 90);
    return `<button class="rail-row rail-card" type="button" data-state="${esc(m.state)}" data-kind="${esc(d.kind)}" data-name="${esc(m.name)}" data-last="${last || 0}">
        <span class="rc-top"><span class="rr-dot"></span><span class="rr-name">${esc(m.name)}</span><span class="rc-age">${esc(age)}</span></span>
        <span class="rr-state">${esc(d.glyph)} ${esc(d.word)}${q}</span>
        <span class="rc-line">${line ? esc(line) : "&nbsp;"}</span>
      </button>`;
  }

  function cardsHtml(list) {
    const now = Date.now();
    const ordered = stableOrder(list, "cards", byRecency);
    const byName = new Map(list.map(m => [m.name, m]));
    const cards = railState.foldCards ? "" : ordered.filter(n => byName.has(n)).map(n => cardHtml(byName.get(n), now)).join("");
    return `<div class="rail-group rail-cards">
        <button class="rail-group-head" type="button" data-fold="cards">
          Musiciens · dernière activité <span class="rg-n">(${list.length})</span>
          <span class="rg-caret">${railState.foldCards ? "▸" : "▾"}</span>
        </button>
        ${cards}
      </div>`;
  }

  function renderRail() {
    const body = document.getElementById("rail-body");
    if (!body) return;
    const g = railGroups();

    // L'ordre affiché est celui de `stableOrder` (attention d'abord, nom à
    // priorité égale), appliqué au sein de chaque groupe. Une permutation
    // n'est commise qu'après 1,5 s stables et jamais sous le pointeur.
    const group = (title, list, withAck = false) => {
      if (!list.length) return "";
      const ordered = stableOrder(list, title);
      const byName = new Map(list.map(m => [m.name, m]));
      const rows = ordered.filter(n => byName.has(n)).map(n => railRowHtml(byName.get(n), withAck)).join("");
      return `<div class="rail-group">
          <div class="rail-group-head">${esc(title)} <span class="rg-n">(${list.length})</span></div>
          ${rows}
        </div>`;
    };

    // Avec les cadres, plus de bloc « En cours » : il doublonnait les cadres et
    // tassait la place (retour utilisateur, 0.32.0). Sans eux, il revient.
    const cardsOn = !!global.Activite?.cardsOn();
    const running = cardsOn ? "" : group("En cours", g.running);
    const examine = group("À examiner", g.examine, true);

    const othersList = [...g.active].sort((a, b) => a.name.localeCompare(b.name));
    const others = cardsOn ? cardsHtml(g.active) : `<div class="rail-group">
        <button class="rail-group-head" type="button" data-fold="all">
          Tous les musiciens <span class="rg-n">(${g.active.length})</span>
          <span class="rg-caret">${railState.foldAll ? "▸" : "▾"}</span>
        </button>
        ${railState.foldAll ? "" : othersList.map(m => railRowHtml(m)).join("")}
      </div>`;

    const empty = cardsOn
      ? (g.examine.length ? "" : `<div class="rail-empty">Rien à examiner.</div>`)
      : ((!g.running.length && !g.examine.length) ? `<div class="rail-empty">Aucun musicien en cours ni à examiner.</div>` : "");

    // Écriture seulement si le contenu a changé : pas de re-mount inutile, pas
    // de scroll qui saute pendant qu'on lit le rail.
    // Deux parties verticales (0.31.0) : en haut ce qui réclame l'attention, en
    // bas les cadres de tous les musiciens, chacune avec son défilement.
    const split = cardsOn;
    body.classList.toggle("is-split", split);
    if (split) {
      // Chaque partie a son propre cache : la durée d'un tour en cours (à la
      // seconde) ne recrée pas les cadres d'en bas sous le pointeur.
      if (!body.querySelector(":scope > .rail-top")) {
        body.innerHTML = `<div class="rail-top"></div><div class="rail-bottom"></div>`;
        body._html = null;
      }
      const top = body.querySelector(":scope > .rail-top");
      const bottom = body.querySelector(":scope > .rail-bottom");
      const th = running + examine + empty, bh = others;
      if (top._html !== th) { top.innerHTML = th; top._html = th; }
      if (bottom._html !== bh) { bottom.innerHTML = bh; bottom._html = bh; }
    } else {
      const html = running + examine + empty + others;
      if (body._html !== html) { body.innerHTML = html; body._html = html; }
    }
    renderMobilePilot(g);
  }

  function renderMobilePilot(g) {
    const el = document.getElementById("mobile-pilot");
    if (!el) return;
    g = g || railGroups();
    const parts = [];
    if (g.running.length) parts.push(`${g.running.length} en cours`);
    const nq = g.examine.filter(m => m.state === "input").length;
    if (nq) parts.push(`${nq} question${nq > 1 ? "s" : ""}`);
    const nOther = g.examine.length - nq;
    if (nOther > 0) parts.push(`${nOther} à examiner`);
    if (!parts.length) parts.push("orchestre au repos");
    el.hidden = false;
    el.innerHTML = `<span class="mp-k">Pilotage</span><span>${esc(parts.join(" · "))}</span><span class="mp-caret">›</span>`;
  }

  function wireRail() {
    const rail = document.getElementById("rail");
    if (!rail || rail._wired) return;
    rail._wired = true;
    rail.addEventListener("pointerenter", () => { railState.hovered = true; });
    rail.addEventListener("pointerleave", () => { railState.hovered = false; });
    rail.addEventListener("click", (e) => {
      const fold = e.target.closest("[data-fold]");
      if (fold) {
        if (fold.dataset.fold === "all") railState.foldAll = !railState.foldAll;
        else if (fold.dataset.fold === "cards") railState.foldCards = !railState.foldCards;
        renderRail();
        return;
      }
      const rq = e.target.closest("[data-resolve-question]");
      if (rq) { App.resolveQuestion(rq.dataset.resolveQuestion); return; }
      const ack = e.target.closest("[data-ack]");
      if (ack) { App.ackMusician(ack.dataset.ack); return; }
      const row = e.target.closest(".rail-row");
      if (row) App.openMusician(row.dataset.name);
    });
    const pilot = document.getElementById("mobile-pilot");
    if (pilot) pilot.addEventListener("click", () => toggleRailSheet());
  }

  function isMobile() { return window.innerWidth < 768; }

  function toggleRailSheet(force) {
    const rail = document.getElementById("rail");
    if (!rail) return;
    railState.open = (force === undefined) ? !railState.open : !!force;
    if (isMobile()) rail.hidden = !railState.open;
    else rail.hidden = false;
  }

  function syncRailVisibility() {
    const rail = document.getElementById("rail");
    const dive = document.getElementById("dive");
    if (!rail) return;
    const diveOpen = dive && !dive.hidden;
    if (global.Projets?.isOpen || global.Models?.isOpen) { rail.hidden = true; return; }   // ces vues remplacent fil + rail
    if (isMobile()) rail.hidden = !railState.open || diveOpen;
    else rail.hidden = !!diveOpen;   // le volet REMPLACE le rail sur desktop
  }

  // ------------------------------------------------------------------------
  // Missions — reconstruites depuis le `tool_use Bash` du chef.
  // Le nom capturé est VALIDÉ contre la flotte connue : pas de mission
  // inventée depuis une ligne de commande qui parle d'autre chose.
  // ------------------------------------------------------------------------
  /** Extrait les projets dispatchés par une commande Bash du chef. */
  function extractDispatches(command) {
    const cmd = String(command || "");
    if (!/dispatch\.mjs/i.test(cmd)) return [];
    const names = [];
    // Un `&&`/`;`/saut de ligne peut enchaîner plusieurs dispatches.
    const re = /dispatch\.mjs["']?([^\n;&|]*)/gi;
    let mm;
    while ((mm = re.exec(cmd)) !== null) {
      const tail = mm[1] || "";
      // Premier jeton positionnel : on saute les options et leurs valeurs
      // « évidentes » (un jeton qui suit une option connue à valeur).
      const toks = tail.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i].replace(/^["']|["']$/g, "");
        if (t.startsWith("-")) {
          if (/^--(callback|source|model|provider|prompt|resume|await)/.test(t) && !t.includes("=")) i++;
          continue;
        }
        if (!/^[A-Za-z0-9_.\-]+$/.test(t)) break;
        if (App.musicians.has(t) && t !== App.composer.CONDUCTOR) names.push(t);
        break;   // le projet est le PREMIER positionnel
      }
    }
    return [...new Set(names)];
  }

  /** L'état vivant d'une ligne de mission, depuis /api/pupitre + la flotte. */
  function missionRowHtml(it) {
    const m = App.musicians.get(it.name);
    const r = snapRow(it.name);
    let state = m ? m.state : "idle";
    let mark, text;

    if (it.outcome) {
      // Issue connue : la ligne porte l'issue et POINTE vers la carte du panier.
      if (it.outcome === "failed")        { mark = "✕"; state = "error"; }
      else if (it.outcome === "ask_chef") { mark = "⇄"; state = "unread"; }
      else if (it.outcome === "question") { mark = "?"; state = "input"; }
      else                                { mark = "✓"; state = "unread"; }
      const bits = [];
      bits.push(it.outcome === "failed" ? "échec" :
                it.outcome === "ask_chef" ? "attend le chef" :
                it.outcome === "question" ? "vous demande" : "terminé");
      if (Number.isFinite(it.durationMs)) bits.push(fmtAge(it.durationMs));
      bits.push(Number.isFinite(it.costUsd) ? `$${it.costUsd.toFixed(2)}` : "coût non fourni");
      text = esc(bits.join(" · "));
    } else if (!it.started) {
      // « lancée » ≠ « démarrée » : on n'affirme le démarrage qu'au system/init
      // réellement observé côté musicien.
      mark = "▸";
      text = "lancée — démarrage non encore observé";
    } else {
      mark = m ? glyph(m) : "●";
      const h = healthFlag(r);
      const bits = [];
      bits.push(m ? label(m).toLowerCase() : "en cours");
      if (r?.turnElapsedMs != null) bits.push(fmtAge(r.turnElapsedMs));
      if (r?.activity) bits.push(String(r.activity).slice(0, 40));
      text = esc(bits.join(" · "));
      if (h) text += ` · <span class="mr-warn">${esc(h.text)}</span>`;
    }

    const goto = it.outcome
      ? `<button class="mr-open" data-goto-result="${esc(it.name)}" title="Voir la carte du panier">résultat ↓</button>`
      : "";
    return `<div class="mission-row" data-state="${esc(state)}" data-name="${esc(it.name)}">
        <span class="mr-mark">${esc(mark)}</span>
        <span class="mr-name">${esc(it.name)}</span>
        <span class="mr-text">${text}</span>
        ${goto}<button class="mr-open" data-open-musician="${esc(it.name)}">Ouvrir ›</button>
      </div>`;
  }

  function missionsHtml(b) {
    if (!b.items || !b.items.length) return "";
    const title = b.observed ? "Activité de l'orchestre" : "Missions";
    const note = b.truncated
      ? `<div class="cv-missions-note">activité plus ancienne non chargée — fenêtre bornée (500 événements / 2 Mio)</div>`
      : "";
    return `<div class="cv-missions${b.observed ? " is-observed" : ""}">
        <div class="cv-missions-head">${esc(title)} <span class="cm-n">(${b.items.length})</span></div>
        <div class="cv-missions-body">${b.items.map(missionRowHtml).join("")}</div>
        ${note}
      </div>`;
  }

  /** Bloc « ACTIVITÉ DE L'ORCHESTRE » : musiciens en vol SANS dispatch chef
   *  observé (@X, file, relais). Jamais « mission » sans preuve. */
  function orchestraActivityHtml() {
    const piloted = new Set();
    for (const b of App.chat) {
      if (b.role !== "missions" || b.observed) continue;
      for (const it of b.items) if (!it.outcome) piloted.add(it.name);
    }
    const items = [];
    for (const m of App.musicians.values()) {
      if (m.name === App.composer.CONDUCTOR) continue;
      if (m.state !== "live" && m.state !== "think") continue;
      if (piloted.has(m.name)) continue;
      items.push({ name: m.name, started: true, outcome: null });
    }
    if (!items.length) return "";
    return missionsHtml({ items, observed: true });
  }

  // ------------------------------------------------------------------------
  // Volet musicien routé — #/m/<projet>
  // ------------------------------------------------------------------------
  const dive = {
    name: null,
    tab: "activity",
    detail: null,       // instance PupitreDetail
    events: [],         // fenêtre brute (journal + dernier résultat)
    truncated: false,
    returnFocus: null,
    fromApp: false,     // ouvert depuis l'app (⇒ history.back reste dans le site)
  };
  let pendingFromApp = false;

  /** Retour : `history.back()` si on est arrivé ici depuis le fil, sinon on
   *  revient à la racine sans sortir du site (lien direct `#/m/X`). */
  function goBack() {
    if (dive.fromApp) history.back();
    else location.hash = "#/";
  }

  function diveEl() { return document.getElementById("dive"); }

  function parseHash() {
    const h = String(location.hash || "");
    const mm = /^#\/m\/([^/?#]+)/.exec(h);
    return mm ? decodeURIComponent(mm[1]) : null;
  }

  function router() {
    // v0.29.0 — niveau « Projets » (public/projets.js). Désactivé (config ou
    // ?projets=0) : le lien renvoie au fil, rien d'autre ne change.
    const P = global.Projets;
    const M = global.Models;   // 0.39.0 — « Models par tâche » (public/models.js)
    if (String(location.hash || "") === "#/projets") {
      if (dive.name) closeDive();
      if (M) M.hide();
      if (!P || !P.show()) location.replace("#/");
      syncRailVisibility();
      return;
    }
    if (String(location.hash || "") === "#/models") {
      if (dive.name) closeDive();
      if (P) P.hide(false);
      if (!M || !M.show()) location.replace("#/");
      syncRailVisibility();
      return;
    }
    const want = parseHash();
    if (M) M.hide();
    if (P) P.hide(!want);   // retour au fil = dernier niveau « salle » ; un volet ne change rien
    if (want && App.musicians.has(want)) {
      if (dive.name !== want) openDive(want);
      else renderDive();
    } else {
      if (dive.name) closeDive();
      if (want) {
        // Nom inconnu : on ne prétend pas, on revient au fil.
        location.replace("#/");
      }
    }
    syncRailVisibility();
  }

  function openDive(name) {
    const el = diveEl();
    if (!el) return;
    dive.name = name;
    dive.tab = defaultTab();
    dive.events = [];
    dive.truncated = false;
    dive.fromApp = pendingFromApp;
    pendingFromApp = false;
    el.hidden = false;
    $(".dive-name", el).textContent = name;
    $$(".dive-tab", el).forEach(b => b.classList.toggle("is-on", b.dataset.tab === dive.tab));
    const act = $(".dive-activity", el);
    act.innerHTML = "";
    dive.detail = global.PupitreDetail
      ? global.PupitreDetail.create(act, {
          maxNodes: 600,
          onCount: (n) => { const c = $(".dive-count", el); if (c) c.textContent = n + " evts"; },
        })
      : null;
    if (dive.detail) dive.detail.setPinned(true);
    const m = App.musicians.get(name);
    if (m) m.markRead();
    // Règle « vu » (0.31.0) : ouvrir le volet vaut lecture. Un résultat non lu
    // l'était déjà (markRead) ; un échec ou un arrêt par le chef est acquitté de
    // même. Une QUESTION ne l'est pas : elle attend une réponse ou un « Marquer
    // comme répondue » explicite.
    if (m && m.state === "error" && name !== App.composer.CONDUCTOR) App.ackMusician(name, { auto: true });
    if (global.Activite?.journalOn()) global.Activite.open(name);
    renderDive();
    syncRailVisibility();
    App.ensurePupitrePoll();
    backfillDive(name);
  }

  function defaultTab() { return global.Activite?.journalOn() ? "turns" : "activity"; }

  function closeDive() {
    const el = diveEl();
    dive.name = null;
    dive.detail = null;
    dive.events = [];
    if (el) el.hidden = true;
    const adv = el && $(".dive-adv", el);
    if (adv) adv.hidden = true;
    syncRailVisibility();
    App.ensurePupitrePoll();
    // Restitution du focus à l'élément d'origine (§3.3).
    if (dive.returnFocus && document.contains(dive.returnFocus)) {
      try { dive.returnFocus.focus(); } catch { /* ignore */ }
    }
    dive.returnFocus = null;
  }

  function backfillDive(name) {
    fetch(`/api/project/${encodeURIComponent(name)}/events?n=200`,
          { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(r => r.ok ? r.json() : [])
      .then(list => {
        if (dive.name !== name) return;
        dive.events = Array.isArray(list) ? list : [];
        dive.truncated = dive.events.length >= 200;
        if (dive.detail) {
          dive.detail.reset();
          for (const raw of dive.events) dive.detail.addEvent(raw);
          dive.detail.setPinned(true); dive.detail.stick();
        }
        const m = App.musicians.get(name);
        if (m && dive.events.length) m.ring = dive.events.slice(-30);
        renderDive();
      })
      .catch(() => { /* non fatal */ });
  }

  /** Un événement live du musicien ouvert est poussé dans le flux du volet. */
  function onLiveEvent(name, raw) {
    if (dive.name !== name) return;
    global.Activite?.onLiveEvent(name, raw);
    if (dive.detail) dive.detail.onLive(raw);
    dive.events.push(raw);
    if (dive.events.length > 400) dive.events.splice(0, dive.events.length - 400);
    if (dive.tab !== "activity") renderDive();
  }

  function renderDive() {
    const el = diveEl();
    if (!el || !dive.name) return;
    const m = App.musicians.get(dive.name);
    const r = snapRow(dive.name);
    el.dataset.state = m ? m.state : "idle";

    // Sous-titre : le rôle du musicien + sa mission si le chef l'a lancée.
    const mission = findMission(dive.name);
    const sub = $(".dive-sub", el);
    if (mission) sub.textContent = `Musicien piloté par le chef · mission lancée ${new Date(mission.launchedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
    else sub.textContent = "Musicien de l'orchestre";

    // Ligne d'état + télémétrie (mêmes champs que /pupitre).
    const st = $(".dive-state", el);
    const h = healthFlag(r);
    st.innerHTML = m
      ? `${esc(glyph(m))} ${esc(label(m))}` + (h ? ` · <span style="color:var(--st-error)">${esc(h.text)}</span>` : "")
      : "—";
    // Question en attente : on peut l'acquitter d'ici. Déjà acquittée : on
    // garde la trace (note) tant que le musicien n'a pas repris la main.
    if (m && m.state === "input") {
      st.innerHTML += ` <button class="ds-resolve" data-resolve-question="${esc(m.name)}" title="Déjà répondue ailleurs ou sans objet — aucun tour relancé">✓ Marquer comme répondue</button>`;
    } else if (m && m.state === "error") {
      if (m.stopped?.reason) st.innerHTML += ` · <span class="ds-reason">${esc(m.stopped.reason)}</span>`;
      st.innerHTML += ` <button class="ds-resolve" data-ack="${esc(m.name)}" title="Vu : retire de « À examiner » — aucun tour relancé">✓ Marquer vu</button>`;
    } else if (m && m.state === "idle" && m.questionResolved) {
      st.innerHTML += ` · <span class="ds-resolved">✓ question marquée répondue${m.questionResolved.note ? " — " + esc(m.questionResolved.note) : ""}</span>`;
    }

    const meta = $(".dive-meta", el);
    if (!r) {
      meta.textContent = "instantané non disponible pour ce musicien";
    } else {
      const el2 = App.pupitreRecvPerf ? (performance.now() - App.pupitreRecvPerf) : 0;
      const pid = r.pid == null ? "processus —"
        : r.pidAlive === true ? `processus ✓ ${r.pid}`
        : r.pidAlive === false ? `processus ✗ ${r.pid}`
        : `processus inconnu ${r.pid}`;
      meta.textContent = [
        "tour " + (r.turnElapsedMs != null ? fmtAge(r.turnElapsedMs + el2) : "—"),
        "dernier progrès " + fmtAge(r.silentMs + el2),
        pid,
        (r.model || r.configModel || "modèle —"),
        (App._pollOkAt ? "instantané il y a " + fmtAge(snapAgeMs()) : "instantané non reçu"),
      ].join(" · ");
    }

    const jOn = !!global.Activite?.journalOn();
    if (!jOn && dive.tab === "turns") dive.tab = "activity";
    const tTab = $('.dive-tab[data-tab="turns"]', el);
    if (tTab) tTab.hidden = !jOn;
    $$(".dive-tab", el).forEach(b => b.classList.toggle("is-on", b.dataset.tab === dive.tab));
    const turns = $(".dive-turns", el);
    if (turns) turns.hidden = dive.tab !== "turns";
    if (dive.tab === "turns") global.Activite.paint();
    $(".dive-activity", el).hidden = dive.tab !== "activity";
    $(".dive-result",   el).hidden = dive.tab !== "result";
    $(".dive-journal",  el).hidden = dive.tab !== "journal";
    if (dive.tab === "result")  renderDiveResult(el);
    if (dive.tab === "journal") renderDiveJournal(el);

    // Notices de transport : uniquement au niveau 2 (§7).
    const notices = dive.events.filter(e =>
      e?.type === "notice" || e?.subtype === "log_growth_skipped" || e?.subtype === "oversized_line_skipped");
    $(".dive-notice", el).textContent = notices.length
      ? `⚠ ${notices.length} notice${notices.length > 1 ? "s" : ""} de transport — du contenu n'est pas passé par le flux (il reste sur disque)`
      : "";
    renderDiveQueue(el, r);
    renderDiveDenials(el, m);
  }

  // ------------------------------------------------------------------------
  // Refus d'autorisation (0.29.1) : ceux du tour en cours (réducteur client),
  // sinon ceux listés par le dernier `result` (`permission_denials` du CLI).
  // Toujours : outil, appel bloqué, et quoi faire. Rien si l'info manque.
  // ------------------------------------------------------------------------
  function renderDiveDenials(el, m) {
    const box = $(".dive-denials", el);
    const PD = global.PermissionDenial;
    if (!box || !PD) return;
    // 0.37.0 : nature de chaque refus (outil non accordé / chemin / commande
    // refusée par l'analyse du CLI) et refus déjà traités, qui ne reviennent pas.
    const systemById = Object.assign({}, m && m._systemDenials);
    for (const e of dive.events) if (e?.type === "system" && e.subtype === "permission_denied" && e.tool_use_id) systemById[e.tool_use_id] = e;
    // Sans system/permission_denied (outil non accordé), le motif n'est que dans
    // la tool_result en erreur du même appel.
    for (const e of dive.events) {
      if (e?.type !== "user") continue;
      for (const b of e.message?.content || []) {
        if (b?.type === "tool_result" && b.is_error && b.tool_use_id && !systemById[b.tool_use_id] && PD.isDenialResult(b)) {
          systemById[b.tool_use_id] = { message: PD.resultText(b).split("\n")[0] };
        }
      }
    }
    const acked = PD.acknowledgedIds(dive.events);
    if (m && m.ackedDenials) m.ackedDenials.forEach(id => acked.add(id));
    let list = (m && m.pendingDenials || []).filter(PD.isComplete);
    let when = "pendant ce tour";
    if (!list.length) {
      for (let i = dive.events.length - 1; i >= 0; i--) {
        const e = dive.events[i];
        if (e?.type !== "result") continue;
        list = PD.denialsFromResult(e);
        when = "au dernier tour";
        break;
      }
    }
    list = list.filter(d => !acked.has(String(d.toolId))).map(d => PD.enrich(d, systemById));
    box._denials = list;
    box._project = m.name;
    const html = list.map((d, i) => {
      // 0.45.0 : un refus passé peut devenir une règle permanente (overlay de portée).
      const forever = window.Permissions ? `<button class="dd-ack dd-forever" type="button" data-perm-forever="${i}" title="Créer une règle permanente : la prochaine fois, l'appel passera sans demande">Toujours autoriser à l'avenir</button>` : "";
      const todo = d.kind === "tool"
        ? `<button class="ev-perm-add-btn" data-project="${esc(m.name)}" data-tool="${esc(d.toolName)}" data-tool-ids="${esc(list.filter(x => x.kind === "tool" && x.toolName === d.toolName).map(x => x.toolId).join(","))}">+ Autoriser ${esc(d.toolName)}</button>`
        : "";
      return `<div class="dd-item" data-kind="${esc(d.kind)}" data-tool-id="${esc(d.toolId || "")}">🚫 <strong>${esc(d.toolName)}</strong> refusé ${esc(when)} : <code>${esc(d.preview)}</code>` +
        (d.reason ? `<div class="dd-reason">${esc(d.reason)}</div>` : "") +
        `<div class="dd-todo">${esc(PD.KIND_TEXT[d.kind] || "")}</div>` +
        `<div class="dd-act">${todo}<button class="dd-ack" type="button" data-ack-denial="${esc(d.toolId || "")}" title="Ne plus afficher ce refus">✓ Vu</button>${forever}</div></div>`;
    }).join("");
    if (box._html === html) return;
    box._html = html;
    const all = list.length > 1
      ? `<button class="dd-ack dd-ack-all" type="button" data-ack-denial="${esc(list.map(d => d.toolId).join(","))}">✓ Tout marquer vu</button>` : "";
    box.innerHTML = html ? `<div class="dd-title">Autorisations refusées à ${esc(m.name)} ${all}</div>${html}` : "";
    box.hidden = !html;
  }


  // ------------------------------------------------------------------------
  // File du musicien (0.24.0) : les tâches qui attendent la fin de son tour,
  // avec « Retirer ». La liste n'est redemandée que si le nombre annoncé par
  // l'instantané change (ou au changement de musicien) — pas de poll en plus.
  // ------------------------------------------------------------------------
  const diveQueue = { name: null, depth: -1, entries: [], loading: false, error: "" };

  async function loadDiveQueue(name) {
    diveQueue.loading = true;
    try {
      const resp = await fetch(`/api/queue/${encodeURIComponent(name)}`, { headers: { Accept: "application/json" } });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (diveQueue.name !== name) return;            // l'utilisateur a changé de volet
      diveQueue.entries = data.entries || [];
      diveQueue.error = "";
    } catch (e) {
      diveQueue.error = e.message || String(e);
    } finally {
      diveQueue.loading = false;
      const el = diveEl();
      if (el && dive.name === name) paintDiveQueue(el);
    }
  }

  function renderDiveQueue(el, r) {
    const depth = r?.queueDepth ?? 0;
    if (diveQueue.name !== dive.name) { diveQueue.name = dive.name; diveQueue.depth = -1; diveQueue.entries = []; }
    if (depth !== diveQueue.depth) {
      diveQueue.depth = depth;
      if (depth > 0) loadDiveQueue(dive.name);
      else diveQueue.entries = [];
    }
    paintDiveQueue(el);
  }

  function paintDiveQueue(el) {
    const box = $(".dive-queue", el);
    if (!box) return;
    const list = diveQueue.entries;
    if (!list.length && !diveQueue.error) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const rows = list.map(e => {
      const meta = [
        e.enqueuedAt ? new Date(e.enqueuedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null,
        e.model, e.callback ? `callback ${e.callback}` : null,
      ].filter(Boolean).join(" · ");
      return `<div class="dq-item">
          <span class="dq-n">${e.position}.</span>
          <span class="dq-head" title="${esc(e.id)}">${esc(e.head)}</span>
          <span class="dq-meta">${esc(meta)}</span>
          <button class="dq-rm" data-queue-rm="${esc(e.id)}">Retirer</button>
        </div>`;
    }).join("");
    box.innerHTML =
      `<div class="dq-title">⏸ En file derrière son tour (${list.length})</div>` +
      (diveQueue.error ? `<div class="dq-err">file illisible : ${esc(diveQueue.error)}</div>` : "") +
      rows;
  }

  async function removeQueued(id) {
    const name = dive.name;
    const e = diveQueue.entries.find(x => x.id === id);
    if (!name || !confirm(`Retirer cette tâche de la file de ${name} ?\n\n« ${e ? e.head.slice(0, 160) : id} »\n\nElle ne sera pas lancée.`)) return;
    try {
      const resp = await fetch(`/api/queue/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    } catch (err) {
      diveQueue.error = err.message || String(err);
    }
    diveQueue.depth = -1;                 // force le rechargement
    await loadDiveQueue(name);
    App.pollPupitre?.();
  }

  function findMission(name) {
    for (let i = App.chat.length - 1; i >= 0; i--) {
      const b = App.chat[i];
      if (b.role !== "missions" || b.observed) continue;
      const it = b.items.find(x => x.name === name);
      if (it) return it;
    }
    return null;
  }

  function renderDiveResult(el) {
    const pane = $(".dive-result", el);
    const evs = dive.events;
    let res = null, servedText = "";
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i]?.type === "result") { res = evs[i]; break; }
    }
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.type !== "assistant") continue;
      const t = (e.message?.content || []).filter(b => b?.type === "text").map(b => b.text).join("\n").trim();
      if (t) { servedText = t; break; }
    }
    if (!res && !servedText) {
      pane.innerHTML = `<div class="dj-note">Aucun résultat dans la fenêtre chargée.</div>`;
      return;
    }
    const isErr = res && (!!res.is_error || (typeof res.subtype === "string" && res.subtype.startsWith("error")));
    const synthetic = res && res.synthetic;
    let issue;
    if (res && res.subtype === "error_killed_by_conductor") issue = `■ arrêté par le chef${res.reason ? " — " + esc(res.reason) : ""}`;
    else if (synthetic) issue = `⟲ clos par le système — ${esc(res.subtype || "interrompu")}`;
    else if (isErr)     issue = `✕ échec — ${esc(res.subtype || "erreur")}`;
    else if (res)       issue = "✓ terminé";
    else                issue = "… tour en cours";
    const dur  = res && Number.isFinite(res.duration_ms) ? fmtAge(res.duration_ms) : "—";
    const cost = res && Number.isFinite(res.total_cost_usd) ? `$${res.total_cost_usd.toFixed(2)}` : "coût non fourni";
    const r = snapRow(dive.name);
    const q = r?.needsInput;

    // Livrables : liens /downloads/... trouvés dans le texte servi.
    const dl = [...new Set((servedText.match(/\/downloads\/[^\s)"'`]+/g) || []))];
    const dlHtml = dl.length
      ? `<div class="dr-k">Livrables</div><div class="dr-v">${dl.map(p =>
          `<a href="${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a>`).join("<br>")}</div>`
      : "";

    pane.innerHTML =
      `<div class="dr-k">Issue</div><div class="dr-v">${issue}${synthetic ? " (gris, ce n'est pas un échec)" : ""}</div>` +
      `<div class="dr-k">Durée · coût</div><div class="dr-v">${esc(dur)} · ${esc(cost)}</div>` +
      (q ? `<div class="dr-k">Question posée</div><div class="dr-v">${esc(q)}</div>` : "") +
      `<div class="dr-k">Texte servi</div><div class="dr-v md">${
        servedText ? (typeof global.mdToHtml === "function" ? global.mdToHtml(servedText) : esc(servedText).replace(/\n/g, "<br>")) : "—"
      }</div>` +
      dlHtml;
  }

  function renderDiveJournal(el) {
    const pane = $(".dive-journal", el);
    const rows = dive.events.slice(-300).map(e => {
      const ts = e?.timestamp ? new Date(e.timestamp) : null;
      const t = ts && !isNaN(ts.getTime())
        ? String(ts.getHours()).padStart(2, "0") + ":" + String(ts.getMinutes()).padStart(2, "0") + ":" + String(ts.getSeconds()).padStart(2, "0")
        : "--:--:--";
      const kind = e?.type + (e?.subtype ? "/" + e.subtype : "");
      let prev = "";
      if (e?.type === "assistant") {
        const b = (e.message?.content || [])[0] || {};
        prev = b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input || {}).slice(0, 90)}`
             : b.type === "thinking" ? String(b.thinking || "").slice(0, 90)
             : String(b.text || "").slice(0, 90);
      } else if (e?.type === "user_prompt") prev = String(e.text || "").slice(0, 90);
      else if (e?.type === "result") prev = (e.is_error ? "is_error " : "") + (e.subtype || "");
      else if (e?.type === "notification") prev = String(e.text || "").slice(0, 120);
      return `<div class="dj-line"><span class="dj-ts">${esc(t)}</span><span class="dj-type">${esc(kind)}</span>${esc(prev)}</div>`;
    }).join("");
    pane.innerHTML =
      `<div class="dj-note">fenêtre bornée (500 événements / 2 Mio côté serveur) — ce n'est pas tout l'historique</div>` +
      rows + (dive.truncated ? `<div class="dj-note">plus ancien : non chargé</div>` : "");
  }

  function wireDive() {
    const el = diveEl();
    if (!el || el._wired) return;
    el._wired = true;
    $(".dive-back", el).addEventListener("click", () => goBack());
    $(".dive-state", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-resolve-question]");
      if (b) App.resolveQuestion(b.dataset.resolveQuestion);
      const a = e.target.closest("[data-ack]");
      if (a) App.ackMusician(a.dataset.ack);
    });
    const turnsPane = $(".dive-turns", el);
    if (turnsPane) turnsPane.addEventListener("click", (e) => {
      const b = e.target.closest("[data-dive-tab]");
      if (b) { dive.tab = b.dataset.diveTab; renderDive(); return; }
      const tg = e.target.closest("[data-jt-toggle]");
      if (tg) global.Activite?.toggle(tg.dataset.jtToggle);
      const cl = e.target.closest("[data-jt-collapse]");
      if (cl) global.Activite?.toggle(cl.dataset.jtCollapse, { reveal: true });
    });
    $(".dive-denials", el)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ack-denial]");
      if (b && dive.name) App.ackDenials(dive.name, String(b.dataset.ackDenial).split(",").filter(Boolean));
      const f = e.target.closest("[data-perm-forever]");
      const box = e.currentTarget;
      const d = f && box._denials ? box._denials[Number(f.dataset.permForever)] : null;
      if (d) global.Permissions?.openRuleDialog({ project: box._project, tool: d.toolName, input: d.input, toolIds: d.toolId ? [String(d.toolId)] : [] });
    });
    $(".dive-queue", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-queue-rm]");
      if (b) removeQueued(b.dataset.queueRm);
    });
    $$(".dive-tab", el).forEach(b => b.addEventListener("click", () => {
      dive.tab = b.dataset.tab;
      renderDive();
    }));
    $(".dive-talk", el).addEventListener("click", () => {
      const n = dive.name;
      goBack();
      // Retour au composer chef, projet nommé, extrait cité (§3.3).
      setTimeout(() => App.talkToChefAbout(n), 0);
    });
    $(".dive-menu", el).addEventListener("click", (e) => {
      e.stopPropagation();
      const adv = $(".dive-adv", el);
      if (!adv.hidden) { adv.hidden = true; return; }
      const m = App.musicians.get(dive.name);
      adv.innerHTML =
        `<button class="da-item" data-adv="direct">Envoyer directement à ${esc(dive.name)}…</button>` +
        `<div class="da-sep"></div>` +
        `<button class="da-item" data-adv="session">Session Claude…</button>` +
        `<button class="da-item" data-adv="read">Marquer lu</button>` +
        `<a class="da-item" href="/pupitre" target="_blank" rel="noopener">Ouvrir /pupitre</a>`;
      adv.hidden = false;
    });
    $(".dive-adv", el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-adv]");
      if (!b) return;
      $(".dive-adv", el).hidden = true;
      const m = App.musicians.get(dive.name);
      if (!m) return;
      if (b.dataset.adv === "direct")  App.sendDirectTo(m.name);
      if (b.dataset.adv === "session") App.openSession(m);
      if (b.dataset.adv === "read")    { m.markRead(); renderRail(); }
    });
    document.addEventListener("click", (e) => {
      const adv = $(".dive-adv", el);
      if (adv && !adv.hidden && !e.target.closest(".dive-adv") && !e.target.closest(".dive-menu")) adv.hidden = true;
    });
  }

  // ------------------------------------------------------------------------
  // Annuaire / recherche — accessible partout, parkés inclus.
  // ------------------------------------------------------------------------
  function openSearch() {
    const ov = document.getElementById("overlay-search");
    if (!ov) return;
    ov.hidden = false;
    const inp = $(".psr-input", ov);
    inp.value = "";
    renderSearch("");
    setTimeout(() => inp.focus(), 40);
  }

  function renderSearch(q) {
    const ov = document.getElementById("overlay-search");
    if (!ov) return;
    const list = $(".psr-list", ov);
    const needle = String(q || "").toLowerCase();
    const all = [...App.musicians.values()]
      .filter(m => !needle || m.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || railRank(a) - railRank(b) || a.name.localeCompare(b.name);
      });
    if (!all.length) { list.innerHTML = `<div class="psr-empty">Aucun musicien ne correspond.</div>`; return; }
    list.innerHTML = all.map((m, i) => `
      <button class="psr-row${i === 0 ? " is-sel" : ""}" data-name="${esc(m.name)}" data-state="${esc(m.state)}" type="button">
        <span class="pr-dot"></span>
        <span class="pr-name">${esc(m.name)}</span>
        ${m.name === App.composer.CONDUCTOR ? `<span class="pr-tag">CHEF</span>` : ""}
        <span class="pr-state">${esc(glyph(m))} ${esc(label(m))}</span>
      </button>`).join("");
  }

  function wireSearch() {
    const ov = document.getElementById("overlay-search");
    if (!ov || ov._wired) return;
    ov._wired = true;
    const inp = $(".psr-input", ov);
    inp.addEventListener("input", () => renderSearch(inp.value));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const sel = $(".psr-row.is-sel", ov) || $(".psr-row", ov);
        if (sel) { ov.hidden = true; App.openMusician(sel.dataset.name); }
      }
      if (e.key === "Escape") ov.hidden = true;
    });
    ov.addEventListener("click", (e) => {
      if (e.target.classList.contains("overlay-scrim") || e.target.closest(".psr-close")) { ov.hidden = true; return; }
      const row = e.target.closest(".psr-row");
      if (row) { ov.hidden = true; App.openMusician(row.dataset.name); }
    });
  }

  // ------------------------------------------------------------------------
  function init() {
    wireAttention();
    wirePoolBand();
    wireRail();
    wireDive();
    wireSearch();
    window.addEventListener("hashchange", router);
    window.addEventListener("resize", () => { syncRailVisibility(); renderMobilePilot(); });
    // Le volet est un niveau de navigation : Échap = retour (history.back).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const ov = document.getElementById("overlay-search");
      if (ov && !ov.hidden) { ov.hidden = true; return; }
      if (dive.name) { e.preventDefault(); goBack(); }
      else if (railState.open && isMobile()) toggleRailSheet(false);
    });
  }

  global.Salle = {
    init, router, openDive, closeDive, renderDive, onLiveEvent, backfillDive,
    renderPoolBand, ticketStatusHtml, poolQueue, poolSlots, poolFreeSlots,
    renderChefStatus, renderSysBanner, renderAttention, renderRail, renderMobilePilot,
    syncRailVisibility, toggleRailSheet, openSearch, renderSearch,
    missionsHtml, orchestraActivityHtml, extractDispatches, findMission,
    label, glyph, fmtAge, snapRow, snapStale, snapAgeMs, healthFlag, railRank,
    goBack,
    get diveName() { return dive.name; },
    set returnFocus(el) { dive.returnFocus = el; },
    /** Signale que la prochaine ouverture vient du fil (et non d'un lien). */
    markInAppNavigation() { pendingFromApp = true; },
  };
})(window);
