/* ============================================================
   ORCHESTRE — client runtime
   Vanilla JS, single aggregate SSE, ring buffer per musician.
   ============================================================ */

"use strict";

// --------------------------------------------------------------------------
// Constants & small helpers
// --------------------------------------------------------------------------

const RING_MAX   = 30;             // per-musician event buffer
const CHAT_MAX   = 60;             // conductor chat messages kept in memory
const CARD_MIN_W = 110;

// A musician turn completing makes the server (autoNotifyConductor) BOTH write a
// `musician_done` notification AND dispatch that same "[musician] Tour terminé…"
// text to the chef as a real turn — whose user_prompt carries NO source, so it
// used to render as a *user* message (and duplicated the notification, and
// replayed from the persisted queue). This matches that relayed callback so we
// reclassify it as the musician's callback and dedup it.
const CALLBACK_RELAY_RE = /^\[([^\]\n]{1,80})\]\s+Tour\s+termin/i;
// A musician that ends its turn on NEEDS_CHEF_INPUT has FINISHED but is waiting
// on a chef decision — not the same thing as "terminé".
const NEEDS_CHEF_INPUT_RE = /NEEDS_CHEF_INPUT:/i;
const chatKey = (t) => String(t || "").replace(/\s+/g, " ").trim();
const CARD_MAX_W = 150;
const CARD_H     = 124;
const GAP_MIN    = 18;            // minimum horizontal gap between card centers
const ROW_GAP    = 14;            // min vertical breathing room between rows
const ARC_AMP    = 10;            // how far a card's Y is perturbed by the arc shape
const ROW_STEP   = CARD_H + ROW_GAP + 2 * ARC_AMP;  // guaranteed non-overlap
const TOP_PAD    = 96;            // room for topbar
const BOTTOM_PAD = 240;           // room for composer
const SIDE_PAD   = 40;
const STRIP_H    = 220;           // fan strip band height on desktop (below conductor view)
const CHEF_BAR_H = 160;           // height of the chef-bar (card + composer) — must match CSS
// Desktop grid layout — left panel (chat) + right panel (fleet grid)
const GRID_COLS       = 4;
const GRID_TOP_PAD    = 88;       // below topbar
const GRID_SIDE_PAD   = 24;
const GRID_ROW_GAP    = 18;

// Display labels only — the state *keys* (idle|live|think|input|error|unread)
// are the locked vocabulary shared by 5 reducers + the Android app and must
// never change. These are action-oriented French strings for the human.
const STATE_LABELS = {
  idle:   { label: "Prêt",                  icon: "○" },
  live:   { label: "En cours",              icon: "●" },
  think:  { label: "En cours · réflexion",  icon: "◐" },
  input:  { label: "Votre réponse attendue", icon: "?" },
  error:  { label: "Échec",                 icon: "✕" },
  unread: { label: "Terminé",               icon: "✓" },
};

// Claude Code's interactive UI draws lots of noise via box-drawing + cursor
// jumps. We filter lines that are pure decoration when displayed in focus
// view.
const DECOR_RE = /^[\s_\-=·›»▶▸…\u2010-\u2027\u2030-\u205F\u2190-\u21FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2800-\u28FF]*$/;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function stripReplyPrefixes(text) {
  text = text.replace(/^> \[(?:chef|moi)\] [^\n]*\n\n/, "");
  text = text.replace(/^Je réponds à ton message précédent :\n(?:> [^\n]*\n)+\n/, "");
  return text;
}
const fmtRel = (ms) => {
  const d = Date.now() - ms;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}j`;
};

// --------------------------------------------------------------------------
// Musician — data model per project, with ring buffer
// --------------------------------------------------------------------------

class Musician {
  constructor(project) {
    this.name = project.name;
    this.path = project.path || null;
    this.model = project.model;
    this.tools = project.tools;
    this.attachedSession = project.attachedSession || null;

    // Hydrate from the server-side snapshot so cards paint the right color
    // on page load. SSE only streams NEW events, so without this every
    // musician would start at `idle` after reload regardless of actual state.
    this.state = project.currentState || "idle";
    // Dernier acquittement de question (« répondue via le chef »), 0.25.0.
    this.questionResolved = project.questionResolved
      ? { ts: Date.parse(project.questionResolved.ts) || 0, note: project.questionResolved.note || "" }
      : null;
    this.lastLine = project.lastLine || "";
    // Arrêt par le chef du dernier tour ({by, reason, ts}), 0.31.0 — l'état
    // reste `error` (vocabulaire verrouillé), l'affichage dit « Arrêté par le chef ».
    this.stopped = project.stopped || null;
    this.lastAssistantText = "";         // last assistant text (for NEEDS_USER_INPUT detection)
    this.unreadCount = project.unreadCount || 0;
    // Last-read marker (ISO timestamp). Comes from the server at
    // /api/config (logs/<name>.read) and is updated by markRead() via
    // POST /api/mark-read so unread state survives reloads.
    this.readAt = project.readAt || null;
    this.lastActivityMs = 0;
    this.awaitingChef = false;           // finished, but blocked on a chef decision
    this.turnCount = 0;
    this.freq = 0;                       // communication frequency score

    // Token / cost accumulators — populated from each `result` event.
    this.totalCostUsd     = 0;
    this.totalInputTokens = 0;           // real input (excludes cache)
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreateTokens = 0;
    this.lastTurnUsage = null;           // { inTok, outTok, cacheRead, cacheCreate, cost, ctxUsed, ctxMax }

    // Ring buffer of RAW stream-json events (bounded) — each is a JSON obj.
    // The focused view renders up to RING_MAX recent entries.
    this.ring = [];

    this.el = null;                      // the DOM card, built lazily
    this.pos = { x: 0, y: 0, w: CARD_MAX_W, row: 0 };

    this.pendingDenials = [];            // [{toolName,toolId,preview,reason}] — VRAIS refus seulement (permission-denial.js)
    // 0.37.0 — refus déjà traités (« Vu » ou outil accordé) : identifiants
    // d'appels, lus dans le log (notification/denials_acknowledged) et, tant que
    // le serveur n'a pas la route, dans localStorage.
    this.ackedDenials = new Set(App.localAckedDenials(project.name));
    this._systemDenials = {};            // tool_use_id → system/permission_denied (motif, nature)
    this._toolIdToName  = {};            // tool_use_id → name within current turn
    this._toolUses      = {};            // tool_use_id → {name, input} : l'aperçu d'un refus en dépend

    this.provider = project.provider || 'claude';
  }

  push(ev) {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this.lastActivityMs = Date.now();
    this.freq = Math.min(100, this.freq * 0.98 + 1); // decays + adds
  }

  resetRing() {
    this.ring = [];
    this.state = "idle";
    this.lastAssistantText = "";
    this.unreadCount = 0;
    this.lastLine = "";
    this.lastTurnUsage = null;
  }

  transition(raw) {
    // Reducer: one stream-json event → possible state change + lastLine update.
    this.push(raw);

    const t = raw.type;
    if (t === "user_prompt") {
      // The orchestrator's prompt, injected synthetically by dispatch.mjs.
      // A SOURCED prompt (callback / @shortcut / notify) is not a turn start —
      // only a source-less prompt is (a --source dispatch also emits system/init).
      if (!raw.source) {
        this.stopped = null;
        this.lastLang = null;
        this.turnStartMs = Date.parse(raw.timestamp) || Date.now();
        this.setState(this.state === "idle" || this.state === "unread" ? "live" : this.state);
      }
      this.lastLine = stripReplyPrefixes(String(raw.text || "")).replace(/\s+/g, " ").trim().slice(0, 140);
    } else if (t === "system") {
      if (raw.subtype === "init") {
        this.stopped = null;
        this.pendingDenials = [];
        this._toolIdToName  = {};
        this._toolUses      = {};
        this.turnCount++;
        this.turnStartMs = Date.parse(raw.timestamp) || Date.now();
        this.setState(this.state === "idle" || this.state === "unread" ? "live" : this.state);
      }
    } else if (t === "notification" && raw.subtype === "question_resolved") {
      // Question acquittée sans relancer le musicien (même règle que les
      // réducteurs serveur) : seul `input` bascule, vers « prêt ».
      if (this.state === "input") this.setState("idle");
      this.questionResolved = { ts: Date.parse(raw.timestamp) || Date.now(), note: raw.note || "" };
      this.lastLine = String(raw.text || "✓ question marquée répondue").slice(0, 140);
    } else if (t === "notification" && raw.subtype === "denials_acknowledged") {
      for (const id of raw.toolIds || []) this.ackedDenials.add(String(id));
      this.pendingDenials = this.pendingDenials.filter(d => !this.ackedDenials.has(String(d.toolId)));
    } else if (t === "system" && raw.subtype === "permission_denied") {
      if (raw.tool_use_id) this._systemDenials[raw.tool_use_id] = raw;
    } else if (t === "notification" && raw.subtype === "acknowledged") {
      // « Vu » (0.31.0, window.TurnCore) : un échec ou un arrêt acquitté repasse
      // à « prêt », sans relancer de tour. Même règle que les réducteurs serveur.
      if (this.state === "error" || this.state === "unread") {
        this.awaitingChef = false;
        this.unreadCount = 0;
        this.setState("idle");
      }
      this.lastLine = String(raw.text || "✓ marqué vu").slice(0, 140);
    } else if (t === "stream_event") {
      // Partial message deltas — just bump activity timestamp so the heartbeat
      // moves. Rendering the deltas would require reassembling content blocks
      // across events; keep it simple and treat them as liveness pings.
      this.lastActivityMs = Date.now();
    } else if (t === "assistant") {
      const content = raw.message?.content || [];
      let hasTool = false, hasThink = false, gotText = null;
      for (const b of content) {
        if (b?.type === "text")     gotText = b.text || "";
        if (b?.type === "thinking") hasThink = true;
        if (b?.type === "tool_use") {
          hasTool = true;
          this.lastLine = `${(b.name || "TOOL").toLowerCase()} · ${toolArgPreview(b)}`;
          if (b.id && b.name) { this._toolIdToName[b.id] = b.name; this._toolUses[b.id] = { name: b.name, input: b.input }; }
        }
      }
      // Reformulation de langue (0.51.0) : le texte remplacé et son original.
      if (raw.lang?.reformulated) this.lastLang = raw.lang;
      if (gotText) {
        this.lastAssistantText = gotText;
        this.lastLine = gotText.replace(/\s+/g, " ").trim().slice(0, 140);
      }
      this.setState(hasTool ? "live" : (hasThink ? "think" : "live"));
    } else if (t === "user") {
      // Refus d'autorisation : UNIQUEMENT un vrai refus du CLI (is_error + libellé
      // réel), jamais la chaîne « requires approval » dans un fichier lu (0.29.1).
      for (const d of (window.PermissionDenial?.denialsFromUserEvent(raw, this._toolUses) || [])) {
        if (!this.pendingDenials.some(x => x.toolId === d.toolId)) this.pendingDenials.push(d);
      }
    } else if (t === "result") {
      // Un result qui suit un arrêt du chef dans le même tour ne change rien.
      if (this.stopped && !window.TurnCore?.isConductorStop(raw)) return;
      this.pendingDenials = [];
      this._toolIdToName  = {};
      this._toolUses      = {};
      const isErr = !!raw.is_error || (typeof raw.subtype === "string" && raw.subtype.startsWith("error"));
      // Harvest token/cost numbers from the terminal result event.
      const u = raw.usage || {};
      const inTok = Number(u.input_tokens || 0);
      const outTok = Number(u.output_tokens || 0);
      const cacheRead = Number(u.cache_read_input_tokens || 0);
      const cacheCreate = Number(u.cache_creation_input_tokens || 0);
      const cost = Number(raw.total_cost_usd || 0);
      const mu = raw.modelUsage ? Object.values(raw.modelUsage)[0] : null;
      const ctxMax = mu?.contextWindow || 0;
      const ctxUsed = inTok + cacheRead + cacheCreate;
      this.totalCostUsd         += cost;
      this.totalInputTokens     += inTok;
      this.totalOutputTokens    += outTok;
      this.totalCacheReadTokens += cacheRead;
      this.totalCacheCreateTokens += cacheCreate;
      this.lastTurnUsage = { inTok, outTok, cacheRead, cacheCreate, cost, ctxUsed, ctxMax };
      const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(this.lastAssistantText || "");
      // NEEDS_CHEF_INPUT = the turn is over but the musician is blocked on a chef
      // decision. State stays `unread` (locked vocabulary); this ADDITIVE flag is
      // what stops the card from claiming "terminé".
      this.awaitingChef = !needs && (
        NEEDS_CHEF_INPUT_RE.test(this.lastAssistantText || "") ||
        (typeof raw.result === "string" && NEEDS_CHEF_INPUT_RE.test(raw.result))
      );
      if (window.TurnCore?.isConductorStop(raw)) {
        this.stopped = window.TurnCore.stopInfo(raw);
        this.awaitingChef = false;
        this.lastLine = this.stopped.reason || (globalThis.TurnCore?.stopWord ? globalThis.TurnCore.stopWord(this.stopped).toLowerCase() : "arrêté par le chef");
        this.setState("error");
      } else if (isErr && raw.synthetic) {
        // Synthetic interrupts (orchestrator restart / child crash) — no question was asked.
        this.lastLine = raw.subtype || "interrompu";
        this.awaitingChef = false;
        this.setState("idle");
      } else if (isErr) {
        this.lastLine = raw.subtype || "échec du tour";
        this.setState("error");
      } else if (needs) {
        this.lastLine = needs[1].trim().slice(0, 140);
        this.setState("input");             // musician explicitly asked a question
      } else {
        // Only count this result as unread if it happened AFTER the last
        // server-side read marker. Otherwise the reload-replay would re-
        // inflate stale unreads forever.
        const evTs = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();
        const readTs = this.readAt ? Date.parse(this.readAt) : 0;
        if (!readTs || evTs > readTs) {
          this.setState("unread");
          this.unreadCount++;
        } else {
          this.setState("idle");
        }
      }
    }
    // stream_event (partial) — ignored in MVP
  }

  setState(next) {
    if (!STATE_LABELS[next]) return;
    const prev = this.state;
    this.state = next;
    if (this.el) this.el.dataset.state = next;
    if (prev !== next) App.reorderSoon();
  }

  markRead() {
    this.unreadCount = 0;
    if (this.state === "unread") this.setState("idle");
    const ts = new Date().toISOString();
    this.readAt = ts;
    // Fire-and-forget — persist on the server so reload / other clients
    // share the same read state.
    fetch("/api/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: this.name, timestamp: ts }),
    }).catch(() => {});
  }

  buildCard() {
    if (this.el) return this.el;
    const el = document.createElement("article");
    el.className = "musician";
    el.dataset.name = this.name;
    el.dataset.state = this.state;
    const corner = `
      <span class="m-cdot"></span>
      <span class="m-cname">${esc(this.name.slice(0, 4))}</span>
      <span class="m-cbadge" hidden>0</span>
    `;
    el.innerHTML = `
      <div class="m-halo"></div>
      <div class="m-body">
        <div class="m-corner m-corner-l">${corner}</div>
        <div class="m-corner m-corner-r">${corner}</div>
        <div class="m-tools">
          <button class="m-tool" data-act="session" title="Session Claude">⌬</button>
          <button class="m-tool danger" data-act="remove" title="Retirer de l'orchestre">✕</button>
        </div>
        <header class="m-header">
          <span class="m-dot"></span>
          <div class="m-name">${esc(this.name)}</div>
          <span class="m-badge" hidden>0</span>
        </header>
        <div class="m-feed"></div>
        <div class="m-state-row">
          <span class="m-activity" aria-hidden="true"></span>
          <span class="m-state-icon">○</span>
          <span class="m-state-label">AU REPOS</span>
        </div>
        <div class="m-telem" hidden></div>
        ${this.provider !== 'claude' ? `<span class="m-provider-tag">${esc(this.provider.toUpperCase())}</span>` : ''}
      </div>
    `;
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "session") { e.stopPropagation(); App.openSession(this); return; }
      if (act === "remove")  { e.stopPropagation(); App.removeProject(this); return; }
      App.openFocused(this);
    });
    this.el = el;
    return el;
  }

  updateCard() {
    if (!this.el) return;
    this.el.dataset.state = this.state;
    const label = STATE_LABELS[this.state];
    // Staleness check: live/think but no event in >30s → something may be stuck.
    const isInFlight = this.state === "live" || this.state === "think";
    const silentMs = this.lastActivityMs ? (Date.now() - this.lastActivityMs) : 0;
    const stale = isInFlight && silentMs > 30_000;
    this.el.classList.toggle("is-stale", stale);
    this.el.classList.toggle("has-denial", this.pendingDenials.length > 0);
    $(".m-state-icon",  this.el).textContent = label.icon;
    // A musician blocked on a chef decision must not read as "TERMINÉ".
    const baseLabel = (this.awaitingChef && this.state === "unread")
      ? "ATTEND LE CHEF"
      : (this.unreadCount > 1 && this.state === "unread"
          ? `${this.unreadCount} ${label.label}`
          : label.label);
    // Always surface elapsed time while a turn is in flight so the card
     // shows motion even when events are sparse — otherwise the card can
     // feel frozen while the model is thinking or a long tool runs.
    let suffix = "";
    if (stale) suffix = ` · silence ${formatElapsed(silentMs)}`;
    else if (isInFlight && silentMs > 2000) suffix = ` · ${formatElapsed(silentMs)}`;
    $(".m-state-label", this.el).textContent = baseLabel + suffix;

    const feedEl = $(".m-feed", this.el);
    setHtmlIfChanged(feedEl, buildFeedHtml(this.ring));

    const badge = $(".m-badge", this.el);
    const showBadge = this.unreadCount > 0 && this.state === "unread";
    if (showBadge) {
      badge.hidden = false;
      badge.textContent = String(this.unreadCount);
    } else {
      badge.hidden = true;
    }
    // Mirror unread count onto the corner tags so edge cards (which only
    // show their inner top corner) still surface the number.
    $$(".m-cbadge", this.el).forEach(el => {
      el.hidden = !showBadge;
      el.textContent = showBadge ? String(this.unreadCount) : "";
    });

    // Position
    this.el.style.setProperty("--x", this.pos.x + "px");
    this.el.style.setProperty("--y", this.pos.y + "px");
    this.el.style.setProperty("--w", this.pos.w + "px");
    if (this.pos.fan) {
      this.el.style.setProperty("--r", (this.pos.r || 0) + "deg");
      this.el.style.zIndex = this.pos.z || 0;
      this.el.classList.add("is-fan");
      this.el.dataset.hand = String(this.pos.hand ?? 0);
    } else {
      this.el.style.removeProperty("--r");
      this.el.style.zIndex = "";
      this.el.classList.remove("is-fan");
      delete this.el.dataset.hand;
    }
  }
}

function toolArgPreview(block) {
  const i = block.input || {};
  return (i.file_path || i.path || i.command || i.pattern || Object.keys(i).slice(0, 3).join(",") || "—")
    .toString().replace(/\s+/g, " ").slice(0, 80);
}

// Build the last N meaningful feed items from a musician's ring as HTML.
function buildFeedHtml(ring, max = 3) {
  const items = [];
  const uses = buildToolUseMap(ring);
  for (let i = ring.length - 1; i >= 0 && items.length < max * 2; i--) {
    const ev = ring[i];
    if (ev.type === "user") {
      const d = (window.PermissionDenial?.denialsFromUserEvent(ev, uses) || [])[0];
      if (d) items.push({ cls: "mf-denied", text: `🚫 ${d.toolName} bloqué · ${d.preview}` });
    } else if (ev.type === "assistant") {
      const content = ev.message?.content || [];
      for (const b of content) {
        if (b?.type === "tool_use") {
          items.push({ cls: "mf-tool", text: `⚙ ${(b.name || "tool").toLowerCase()} · ${toolArgPreview(b)}` });
        } else if (b?.type === "text" && b.text?.trim()) {
          items.push({ cls: "mf-text", text: b.text.replace(/\s+/g, " ").trim().slice(0, 100) });
        }
      }
    } else if (ev.type === "user_prompt" && ev.text?.trim()) {
      items.push({ cls: "mf-prompt", text: `→ ${stripReplyPrefixes(ev.text).replace(/\s+/g, " ").trim().slice(0, 80)}` });
    } else if (ev.type === "result") {
      const isErr = !!ev.is_error || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"));
      if (isErr) items.push({ cls: "mf-err", text: `✕ ${ev.subtype || "erreur"}` });
    }
  }
  if (!items.length) return `<span class="mf-empty">en attente…</span>`;
  return items.slice(0, max).reverse()
    .map(it => `<div class="mf-row ${it.cls}">${esc(it.text)}</div>`).join("");
}

// --------------------------------------------------------------------------
// Flicker-free DOM helpers
//
// The flash during live streaming came from clearing + rebuilding whole
// containers (`el.innerHTML = …`) on every SSE event — a blank frame plus a
// scroll jump. These helpers write only when the content actually changed and
// reconcile children in place (stable per-index nodes) instead of wiping the
// parent, so unchanged bubbles are never re-mounted.
// --------------------------------------------------------------------------

/** Cheap string hash (djb2-ish) for change detection. */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/** Set innerHTML only if it differs from the last write (sig cached on the
 *  element). Prevents needless clear+rebuild flashes on no-op refreshes. */
function setHtmlIfChanged(el, html) {
  if (!el) return;
  const sig = hashStr(html);
  if (el.dataset.sig === sig) return;
  el.innerHTML = html;
  el.dataset.sig = sig;
}

/** Reconcile a container's children against an array of HTML strings, keyed by
 *  index. Only nodes whose HTML changed are replaced; the rest keep their
 *  identity (no re-mount, no blank frame, scroll position preserved). Extra
 *  trailing nodes are removed; new ones appended. */
function reconcileChildren(container, htmlArray) {
  // Drop empty entries (some event renderers return "") so index alignment
  // between the desired list and the live DOM children stays exact.
  htmlArray = htmlArray.filter(h => h && h.trim());
  const children = container.children;
  for (let i = 0; i < htmlArray.length; i++) {
    const html = htmlArray[i];
    const sig = hashStr(html);
    const existing = children[i];
    if (existing && existing.dataset.sig === sig) continue;   // unchanged → leave in place
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild;
    if (!node) continue;
    node.dataset.sig = sig;
    if (existing) container.replaceChild(node, existing);
    else container.appendChild(node);
  }
  while (children.length > htmlArray.length) container.removeChild(container.lastElementChild);
}

// --------------------------------------------------------------------------
// Arc layout — multi-row, non-overlapping, apex = highest-freq
// --------------------------------------------------------------------------

// Outcome glyph shared by result cards and the chef's "prend en compte" header.
// done ✓ · failed ✕ · ask_chef ⇄ (finished but blocked on a chef decision).
function outcomeIcon(outcome) {
  if (outcome === "failed") return "✕";
  if (outcome === "ask_chef") return "⇄";
  if (outcome === "question") return "?";
  return "✓";
}

// "prend en compte : A ✓ · B ✕" — the link between the results already received
// and the chef turn that follows. Purely presentational: NO chef turn is ever
// triggered by a callback (that regression was removed in v0.14.3).
function takingHtml(b) {
  if (!b || !Array.isArray(b.taking) || !b.taking.length) return "";
  // Puces cliquables : la carte du panier correspondante + le musicien.
  // « prend en compte » reste une ASSOCIATION D'AFFICHAGE — le serveur
  // n'accuse rien, et aucun tour chef n'est déclenché par un callback.
  const list = b.taking
    .map(t => `<button class="cv-taking-chip" data-outcome="${esc(t.outcome || "done")}"` +
              ` data-goto-result="${esc(t.source || "")}">${esc(t.source || "?")} ${outcomeIcon(t.outcome)}</button>`)
    .join(" ");
  return `<div class="cv-taking">prend en compte : ${list}</div>`;
}

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = () => window.innerWidth < MOBILE_BREAKPOINT;

// Attention ordering for the fleet layout — mirrors PupitreRow.rank so cards and
// /pupitre rows agree: a silent error must never sit below a chatty agent.
// Lower rank = more attention = placed first. Ties broken by name for a STABLE
// order (no reshuffle on every token, unlike the old frequency sort).
function attentionRank(m) {
  const inFlight = m.state === "live" || m.state === "think";
  const silentMs = m.lastActivityMs ? (Date.now() - m.lastActivityMs) : 0;
  if (inFlight && silentMs > 30_000) return 0;   // sans progrès observé
  if (m.state === "error")  return 1;
  if (m.state === "input")  return 2;
  if (inFlight)             return 3;
  if (m.state === "unread") return 4;
  return 5;                                       // idle
}
function byAttentionThenName(a, b) {
  return attentionRank(a) - attentionRank(b) || a.name.localeCompare(b.name);
}

function computeLeftPanelW(viewportW) {
  return Math.max(420, Math.min(1000, Math.round(viewportW * 0.60)));
}

function computeLayout(musicians, viewport) {
  if (viewport.w < MOBILE_BREAKPOINT) return computeFanLayout(musicians, viewport);
  return computeGridLayout(musicians, viewport);
}

function computeGridLayout(musicians, viewport) {
  const leftW = computeLeftPanelW(viewport.w);
  // Expose left panel width to CSS so .conductor-view and .composer track it.
  document.getElementById("stage").style.setProperty("--left-panel-w", leftW + "px");

  const rightW  = viewport.w - leftW;
  const availW  = rightW - 2 * GRID_SIDE_PAD;
  const cardW   = CARD_MIN_W * 2;          // doubled card width
  const GAP     = 20;                       // fixed gap — no overlap possible
  // Fit as many columns as possible without overlap.
  const cols    = Math.max(1, Math.floor((availW + GAP) / (cardW + GAP)));
  const colStep = cardW + GAP;
  // Coordinates are relative to #fleet-panel (left: leftW, top: 72px).
  const FLEET_TOP = 72;
  const startX  = GRID_SIDE_PAD + cardW / 2;
  const startY  = (GRID_TOP_PAD - FLEET_TOP) + CARD_H / 2;
  const rowStep = CARD_H + GRID_ROW_GAP;

  // Sort by attention (errors/questions/stuck first), then name — stable.
  const sorted = [...musicians].sort(byAttentionThenName);
  sorted.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    m.pos = { x: startX + col * colStep, y: startY + row * rowStep, w: cardW, row };
  });

  // Stretch the arc so absolutely-positioned cards create scroll height.
  const arc = document.getElementById("arc");
  if (arc && sorted.length) {
    const maxY = Math.max(...sorted.map(m => m.pos.y));
    arc.style.height = (maxY + CARD_H / 2 + 180) + "px";
  }
}

// Mobile: hand-of-playing-cards fan. Each "hand" holds up to CARDS_PER_HAND
// cards. Within a hand:
//   • card bottoms lie on an arc (pivot below the hand line),
//   • card rotations increase from leftmost (negative) to rightmost (positive),
//   • rank 0 is centered and sits on top (highest z).
// When there are too many cards for one hand, extra hands stack above the
// primary, each dimmer and smaller for depth. User swipes the stage left or
// right (either direction) to rotate the deck.
const CARDS_PER_HAND = 5;

function computeFanLayout(musicians, viewport) {
  const n = musicians.length;
  if (!n) return;

  const sorted = [...musicians].sort(byAttentionThenName);
  const rot = App.deckOffset % n;
  const deck = [];
  for (let i = 0; i < n; i++) deck.push(sorted[(i + rot) % n]);

  const w = viewport.w;
  const h = viewport.h;
  const cx = w / 2;

  // Split into hands of up to CARDS_PER_HAND, primary-first.
  const hands = [];
  for (let i = 0; i < n; i += CARDS_PER_HAND) hands.push(deck.slice(i, i + CARDS_PER_HAND));
  const handCount = hands.length;

  // The conductor transcript owns the upper portion of the screen now —
  // the fan lives in a compact strip just above the composer.
  const bottomPad  = 160;               // composer + breathing room
  const stripH     = 140;               // max vertical band the fan can occupy

  // Hand baseline Y — where the CENTER card's bottom lives. Primary hand
  // sits near the composer; subsequent hands climb by handStepY.
  const cardH      = 120;
  const handStepY  = handCount <= 1
    ? 0
    : Math.min(cardH * 0.45, stripH / Math.max(1, handCount - 1));

  for (let hi = 0; hi < handCount; hi++) {
    const hand     = hands[hi];
    const size     = hand.length;
    const scale    = Math.max(0.82, 1 - hi * 0.10);
    // Playing-card aspect ratio (~5:7).
    const cardW    = Math.round(Math.min(98, w * 0.24) * scale);

    // Fan geometry: pivot BELOW this hand's baseline by R. Card bottoms
    // trace an arc of radius R around the pivot.
    const R        = 220 * scale;
    const baseY    = h - bottomPad - hi * handStepY;     // centre-card bottom
    const pivotY   = baseY + R;

    // Angular spread — keep outer cards mildly tilted so their corner
    // tags remain legible (steep rotation hid the state dots).
    const maxDeg   = size === 1 ? 0 : Math.min(14, 3.5 * (size - 1));
    const step     = size > 1 ? (2 * maxDeg) / (size - 1) : 0;
    const mid      = (size - 1) / 2;

    for (let k = 0; k < size; k++) {
      const m    = hand[k];
      const slot = apexSlot(size, k);      // 0 → centre, then ±1, ±2, …
      const slotIdx  = slot + mid;          // 0..size-1 left-to-right
      const thetaDeg = -maxDeg + slotIdx * step;
      const theta    = (thetaDeg * Math.PI) / 180;
      const bx = cx      + R * Math.sin(theta);
      const by = pivotY  - R * Math.cos(theta);

      m.pos = {
        x: bx,
        y: by,
        w: cardW,
        r: thetaDeg,
        // Primary hand on top; within a hand, rank 0 is topmost (centered).
        z: (handCount - hi) * 100 + (size - k),
        fan: true,
        hand: hi,
      };
    }
  }
}

// Given n cards, return the slot index (centered around 0) for rank k.
// rank 0 → centre slot, rank 1 → one-right, rank 2 → one-left, ...
function apexSlot(n, k) {
  if (n === 1) return 0;
  const mid = Math.floor((n - 1) / 2);
  // Reuse apexFirstIndices to get slot-from-left, then shift so centre=0.
  const idx = apexFirstIndices(n)[k];
  return idx - mid;
}

function computeDesktopArc(musicians, viewport) {
  const n = musicians.length;
  if (!n) return;

  // Sort by attention so the apex gets whoever needs it most (stable).
  const sorted = [...musicians].sort(byAttentionThenName);

  // 1. Work out how many rows we can afford vertically, then pick the largest
  //    card width that fits the full fleet within that budget.
  //    The arc is now a STRIP above the composer — not the whole stage —
  //    because the conductor transcript owns the main visual space.
  const usableW = viewport.w - 2 * SIDE_PAD;
  const usableH = Math.min(STRIP_H, viewport.h - TOP_PAD - BOTTOM_PAD);
  const maxRows = Math.max(1, Math.floor((usableH - CARD_H) / ROW_STEP) + 1);

  let cardW  = CARD_MAX_W;
  let perRow = Math.max(1, Math.floor((usableW + GAP_MIN) / (cardW + GAP_MIN)));
  let rows   = Math.ceil(n / perRow);

  // Shrink cards if we'd otherwise use more rows than fit vertically.
  while (rows > maxRows && cardW > CARD_MIN_W) {
    cardW -= 10;
    perRow = Math.max(1, Math.floor((usableW + GAP_MIN) / (cardW + GAP_MIN)));
    rows   = Math.ceil(n / perRow);
  }
  perRow = Math.min(perRow, n);
  rows   = Math.ceil(n / perRow);

  // 2. Balance row counts so the last row isn't nearly empty (prevents a
  //    lopsided look, e.g. 7 cards into [5, 2] becomes [4, 3]).
  const cardsPerRow = [];
  let left = n;
  for (let r = 0; r < rows; r++) {
    const c = Math.ceil(left / (rows - r));
    cardsPerRow.push(c);
    left -= c;
  }

  // 3. Lay out each row at a FIXED vertical baseline. The arc only perturbs
  //    Y within ±ARC_AMP, which is strictly less than ROW_GAP, so cards
  //    across rows can never share a Y band. Horizontally, odd rows nudge
  //    by a quarter-step (subtle quinconce) when it still fits on screen.
  const cx = viewport.w / 2;
  const y0 = viewport.h - BOTTOM_PAD - CARD_H / 2;     // centre-Y of the BOTTOM row

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const count     = cardsPerRow[r];
    const slotOrder = apexFirstIndices(count);

    const colStep   = count === 1 ? 0 : (usableW - cardW) / (count - 1);
    const bandW     = colStep * (count - 1);
    const bandLeft  = cx - bandW / 2;

    // Quinconce: shift odd rows by a quarter slot, clamped so we never push
    // off-screen. The first row (index 0) stays aligned with the composer's
    // axis for readability.
    const wantedOffset = (r % 2 === 1 && colStep > 0) ? colStep / 4 : 0;
    const maxOffset    = Math.max(0, (usableW - bandW) / 2 - 10);
    const qOffset      = Math.max(-maxOffset, Math.min(maxOffset, wantedOffset));

    const rowY = y0 - r * ROW_STEP;

    for (let k = 0; k < count; k++) {
      const m = sorted[idx + k];
      const slot = slotOrder[k];
      const theta = count === 1
        ? Math.PI / 2
        : Math.PI - (slot * Math.PI) / (count - 1);
      const x = bandLeft + slot * colStep + qOffset;
      const y = rowY - ARC_AMP * Math.sin(theta);
      m.pos = { x, y, w: cardW, row: r };
    }
    idx += count;
  }
}

/** Returns the slot indices in rank order:
 *  rank 0 → apex (middle slot), rank 1 → next to apex on the right,
 *  rank 2 → next-left, rank 3 → next-right, ...
 */
function apexFirstIndices(n) {
  const mid = Math.floor((n - 1) / 2);
  const out = [];
  let right = mid, left = mid;
  // Start at mid (rank 0), then alternate: right of mid, left of mid, ...
  const order = [];
  order.push(mid);
  for (let step = 1; order.length < n; step++) {
    const r = mid + step;
    const l = mid - step;
    if (r < n) order.push(r);
    if (l >= 0 && order.length < n) order.push(l);
  }
  return order;
}

// --------------------------------------------------------------------------
// Threads (SVG) — harp strings conductor ↔ musician
// --------------------------------------------------------------------------

function redrawThreads() {
  // v0.21.0 — la scène de cartes (et donc la nappe de fils) a disparu au
  // profit du fil + rail. La fonction reste un no-op gardé : plusieurs
  // appelants historiques la déclenchent encore (P2 les supprimera).
  const svg = $("#threads");
  if (!svg) return;
  svg.innerHTML = "";
  // Threads only make sense on desktop — the mobile view has no fan.
  if (isMobileViewport()) return;

  const CONDUCTOR = App.composer.CONDUCTOR;
  const conductor = App.musicians.get(CONDUCTOR);

  // Two anchors:
  //   composerCenter → top of the composer on the LEFT panel
  //   chefAnchor     → top-center of the chef card on the RIGHT panel
  // User-to-chef thread runs left→right across the pane divider;
  // chef-to-musician threads spread from the chef card out into the arc.
  const composerEl = $("#composer");
  const composerRect = composerEl ? composerEl.getBoundingClientRect() : null;
  const composerCenter = composerRect
    ? { x: composerRect.left + composerRect.width / 2, y: composerRect.top + 8 }
    : { x: window.innerWidth / 4, y: window.innerHeight - 55 };

  const chefEl = document.getElementById("chef-card");
  const chefRect = chefEl && !chefEl.classList.contains("is-unconfigured")
    ? chefEl.getBoundingClientRect()
    : null;
  const chefAnchor = chefRect
    ? { x: chefRect.left + chefRect.width / 2, y: chefRect.top }
    : null;

  // Build the curved path with a vertical arc — higher mid-point for
  // longer horizontal spans so the line doesn't look flat when user-to-
  // chef crosses the viewport.
  const addPath = (from, to, className, color) => {
    const dx = Math.abs(to.x - from.x);
    const lift = Math.min(140, 60 + dx * 0.18);
    const mid = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - lift,
    };
    const d = `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
    const SVGNS = "http://www.w3.org/2000/svg";
    // Soft glow companion — wide, translucent, NO filter. Replaces the removed
    // drop-shadow; static, so it's painted once and never re-blurs the cards.
    const glow = document.createElementNS(SVGNS, "path");
    glow.setAttribute("d", d);
    glow.setAttribute("class", "thread-glow " + className);
    glow.style.color = color;
    glow.style.stroke = "currentColor";
    svg.appendChild(glow);
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", className);
    path.style.color = color;
    path.style.stroke = "currentColor";
    svg.appendChild(path);
  };

  // User → Chef (left panel composer → chef card on the right).
  if (conductor && chefAnchor) {
    if (["live", "think", "input", "error"].includes(conductor.state)) {
      addPath(composerCenter, chefAnchor, "active", varByState(conductor.state));
    }
    if (App.composer.hasDraft) {
      addPath(composerCenter, chefAnchor, "pending", "var(--accent)");
    }
  }

  // Chef → musicien — originate from the TOP of the chef card and curve up
  // into each active musician's bottom edge. Fallback to the composer if
  // the chef card isn't configured/visible.
  const musicianAnchor = chefAnchor || composerCenter;
  for (const m of App.musicians.values()) {
    if (!m.el || !m.pos) continue;
    if (m.name === CONDUCTOR) continue;
    if (!["live", "think", "input", "error"].includes(m.state)) continue;
    const rect = m.el.getBoundingClientRect();
    if (!rect.width) continue;
    const to = { x: rect.left + rect.width / 2, y: rect.bottom };
    addPath(musicianAnchor, to, "active", varByState(m.state));
  }
}

function varByState(state) {
  return {
    idle: "var(--st-idle)", live: "var(--st-live)", think: "var(--st-think)",
    input: "var(--st-input)", error: "var(--st-error)", unread: "var(--st-unread)",
  }[state] || "var(--st-idle)";
}

// --------------------------------------------------------------------------
// Single aggregate SSE — one connection, serves all musicians.
// --------------------------------------------------------------------------

class FleetStream {
  constructor() {
    this.source = null;
    this.open();
  }
  open() {
    this.source = new EventSource("/api/sse/fleet");
    this.source.onopen = () => {
      App.setConnState(true);
      // SSE streams only new events (server starts at EOF). If the
      // connection just dropped and reopened, we may have missed events
      // during the gap. Re-pull the conductor chat history so bubbles
      // aren't silently lost. Skip on the very first open (initial
      // loadChatHistory already ran in App.init).
      if (this._hasOpenedBefore) {
        App.loadChatHistory().catch(() => {});
        // A result may have been missed during the SSE gap — reconcile the
        // "le chef répond…" indicator against the chef's real producer liveness.
        App._conductorLivenessCheck().catch(() => {});
      }
      this._hasOpenedBefore = true;
    };
    this.source.onmessage = (ev) => {
      let env; try { env = JSON.parse(ev.data); } catch { return; }
      // Hot config reload: a musician was added/removed in config.json server-side.
      // Re-fetch the list and reconcile without dropping live musician state.
      if (env.type === "fleet_config_changed") { App.refreshFleet(); return; }
      // File de direction : signal « quelque chose a changé » — l'instantané
      // /api/pupitre reste la vérité, on se contente de le redemander.
      if (env.type === "pool") { App.schedulePupitreHint(); return; }
      const m = App.musicians.get(env.project);
      if (!m) return;
      let raw; try { raw = JSON.parse(env.line); } catch { return; }
      // « Result fantôme » (même règle que isPhantomResult, fleet-status-core) :
      // mini-tour à 0 tour/0 ms rejoué par le CLI au milieu du tour suivant. Le
      // traiter terminerait le panneau en plein travail et, pour le chef,
      // couperait « le chef répond… » avant sa vraie réponse.
      if (raw?.type === "result" && !raw.synthetic && raw.num_turns === 0 && raw.duration_api_ms === 0) return;
      const prevDenials = m.pendingDenials.length;
      m.transition(raw);
      if (m.pendingDenials.length > prevDenials && App.focused !== m) {
        App.showPermDenialToast(m, m.pendingDenials[m.pendingDenials.length - 1]);
      }
      // Volet musicien ouvert : la ligne live est ajoutée EXACTEMENT comme
      // dans /pupitre (onLive) — pas de reconstruction complète.
      App.noteMusicianEvent(m, raw);
      window.Salle?.onLiveEvent(m.name, raw);
      window.Permissions?.onEvent(m.name, raw);
      // Conductor chat/reflection must observe every event, in order — but it's
      // infrequent vs. token deltas, so keep it synchronous.
      if (m.name === App.composer.CONDUCTOR) App.onConductorEvent(m, raw);
      // Quick /api/pupitre re-poll when the event concerns whichever musician
      // the telemetry is currently showing (desktop drawer OR mobile active
      // tab) — same 400ms-debounced hint /pupitre uses for its own SSE.
      if (m.name === App.pupitreTargetName()) App.schedulePupitreHint();
      // Card feed, chef card, tab bar and the mobile pane are COALESCED to one
      // repaint per animation frame (see markDirty): a burst of token deltas no
      // longer triggers an innerHTML rebuild per line, and nothing repaints at
      // all while the tab is hidden (rAF is suspended in background tabs).
      App.markDirty(m);
    };
    this.source.onerror = () => {
      // EventSource auto-reconnects, but the gap must be visible: stale cards
      // that stop updating should not look live. onopen flips this back.
      App.setConnState(false);
    };
  }
  close() { this.source?.close(); this.source = null; }
}

// --------------------------------------------------------------------------
// App — the singleton
// --------------------------------------------------------------------------

const App = {
  musicians: new Map(),           // name -> Musician
  focused: null,                  // currently focused musician (or null)
  stream: null,
  // Live "pupitre" telemetry for the focused card — same /api/pupitre
  // snapshot + same renderer (public/pupitre-row.js) as the /pupitre page,
  // so the two never show different data for the same musician.
  pupitreSnapshot: null,
  pupitreRecvPerf: 0,
  _pupitrePollTimer: null,
  _pupitreHintTimer: null,
  // The focused card renders EXACTLY like an opened /pupitre row: a shared
  // PupitreDetail instance drives its event-stream body (.pf-d-body).
  focusedDetail: null,
  composer: {
    target: "chef",               // the conductor — every typed message goes here
    CONDUCTOR: "chef",            // name of the conductor project (special routing)
    hasDraft: false,
    images: [],                   // pending attachments: {objectUrl, mediaType, blob, isVideo}
  },
  // true  → "Chef d'orchestre" mode: conductor chat, orchestration of the fleet.
  // false → "@orchestrateur" direct mode: raw event stream, task sent to the
  //          orchestrateur project as if it were any other musician.
  conductorMode: true,
  _reorderTimer: null,
  deckOffset: 0,                  // mobile: how many times the user swiped
  // Conductor transcript — user's messages + conductor's synthesised replies.
  // Each entry: { role: "user"|"conductor", text, ts }.
  chat: [],
  // True only when a user_prompt or callback SSE event arrived this session
  // and the chef hasn't yet sent a result. Drives the "le chef répond..."
  // indicator. Intentionally NOT initialised from scanProjectState() so a
  // crashed/stuck turn from a previous session doesn't show stale indicator.
  _awaitingConductorResponse: false,
  // Wall-clock ms when the waiting flag was last armed. Used by the PID-liveness
  // safety net (P0-b) to only disarm a flag that has been stuck a while.
  _awaitingSince: 0,
  // Results basket (0.18.0): musician results that landed WHILE a chef turn was
  // running. They are held here and flushed after the chef's reply so a callback
  // can never split a turn. Nothing here ever triggers a chef turn.
  _pendingResults: [],
  // v0.21.0 — état du tour chef courant pour les lignes de mission et le point.
  _currentMissions: null,     // entrée `{role:"missions"}` du tour en cours
  _wakeObservedAt: 0,         // réveil OBSERVÉ (jamais affiché) → prochain tour = point
  _turnIsReport: false,       // le tour courant est un « point sur les résultats »
  _lastTurnStartTs: 0,        // début du dernier tour chef (frontière des paniers)
  // Results received since the last chef turn started → rendered as the next
  // turn's "prend en compte : …" header.
  _resultsSinceChefTurn: [],
  _currentTurnTaking: [],
  _turnHadReflection: false,
  // Mobile only: which project the user is currently viewing in the main
  // pane. Defaults to the conductor. When != conductor, the body shows the
  // project's event stream and the composer dispatches there.
  activeTab: "chef",

  /** v0.21.0 — l'état du chef vit dans l'EN-TÊTE, une seule source visuelle
   *  (plus de carte chef dupliquée dans une scène de cartes). */
  syncChefCard(m) {
    window.Salle?.renderChefStatus(m || null);
  },

  /** Ancien peintre de la carte chef — conservé inerte le temps du P2 (des
   *  appelants historiques peuvent encore le viser). */
  _legacySyncChefCard(m) {
    const card = document.getElementById("chef-card");
    if (!card) return;
    // m may be null/undefined when no conductor is configured or when the
    // configured name doesn't match any project in the fleet.
    if (!m) {
      card.dataset.state = "unconfigured";
      card.classList.add("is-unconfigured");
      card.setAttribute("aria-disabled", "true");
      const nameEl = card.querySelector(".chef-name");
      if (nameEl) nameEl.textContent = "—";
      const pathEl = card.querySelector(".chef-path");
      if (pathEl) pathEl.textContent = "";
      const feed = card.querySelector(".chef-feed");
      if (feed) feed.innerHTML = "";
      const labelEl = card.querySelector(".chef-state-label");
      if (labelEl) labelEl.textContent = "NON CONFIGURÉ";
      return;
    }
    card.classList.remove("is-unconfigured");
    card.removeAttribute("aria-disabled");
    card.dataset.state = m.state;
    const nameEl = card.querySelector(".chef-name");
    if (nameEl && nameEl.textContent !== m.name) nameEl.textContent = m.name;
    const pathEl = card.querySelector(".chef-path");
    if (pathEl) {
      const p = m.path || "chemin inconnu";
      if (pathEl.textContent !== p) pathEl.textContent = p;
      pathEl.title = p;
    }
    const label = STATE_LABELS[m.state];
    const isInFlight = m.state === "live" || m.state === "think";
    const silentMs   = m.lastActivityMs ? (Date.now() - m.lastActivityMs) : 0;
    const stale      = isInFlight && silentMs > 30_000;
    card.classList.toggle("is-stale", stale);
    const iconEl = card.querySelector(".chef-state-icon");
    if (iconEl) iconEl.textContent = label.icon;
    const labelEl = card.querySelector(".chef-state-label");
    if (labelEl) {
      let suffix = "";
      if (stale) suffix = ` · silence ${formatElapsed(silentMs)}`;
      else if (isInFlight && silentMs > 2000) suffix = ` · ${formatElapsed(silentMs)}`;
      labelEl.textContent = label.label + suffix;
    }
    const feed = card.querySelector(".chef-feed");
    if (feed) setHtmlIfChanged(feed, buildFeedHtml(m.ring, 2));
  },

  async init() {
    this.wireTopbar();
    this.wireComposer();
    this.wireKeyboard();
    this.wireTweaks();
    this.wireOverlays();
    window.Salle?.init();
    window.Projets?.init();
    window.Models?.init();
    window.addEventListener("resize", () => { this.relayout(); this.renderChat(); });

    await this.loadConfig();
    fetch("/api/version")
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const el = document.getElementById("app-version");
        if (el && j?.version) el.textContent = "serveur v" + j.version;
      })
      .catch(() => {});
    await this.loadChatHistory();
    // Le hash est appliqué APRÈS le chargement de la flotte : #/m/<X> est un
    // lien direct partageable, il doit ouvrir le bon volet au chargement.
    window.Projets?.restoreLevel();
    window.Salle?.router();
    this.stream = new FleetStream();

    // Periodic freq decay + layout re-sort to surface recently-active musicians.
    setInterval(() => {
      if (document.hidden) return;   // no reordering work while the tab is hidden
      for (const m of this.musicians.values()) m.freq *= 0.98;
      this.reorderSoon();
    }, 5000);

    // Pause every looping CSS animation + skip background timers when the
    // dashboard isn't visible (big GPU/DWM saving when another window is
    // focused). rAF-driven flushes self-suspend; on resume we catch up once.
    const applyVisibility = () => {
      document.documentElement.classList.toggle("anim-paused", document.hidden);
      if (!document.hidden) { this.redrawThreadsIfChanged(); this._flushDirty(); }
    };
    document.addEventListener("visibilitychange", applyVisibility);
    applyVisibility();

    // Periodic thread refresh (handles idle timers) — now a no-op unless the
    // set of active threads actually changed, and skipped entirely when the
    // tab is hidden. The old version rebuilt the whole viewport SVG every second.
    setInterval(() => this.redrawThreadsIfChanged(), 1000);

    // 1s heartbeat ticker — updates the "in-flight" banner in the focused
    // panel so the user sees elapsed time and a sign of life even when the
    // sub-agent's stream is quiet between tool calls.
    this.startHeartbeatTicker();

    // Fleet-wide authoritative telemetry poll (Lot 2): refresh /api/pupitre
    // every 5s while the tab is visible, so every card shows PID liveness + turn
    // duration, not only the focused one. Visible-only keeps load bounded until
    // the Lot 3 server-side cache lands.
    setInterval(() => { if (!document.hidden) this.pollPupitre(); }, 5000);
    if (!document.hidden) this.pollPupitre();

    // 5s staleness ticker — refreshes the "silence Xs" indicator without waiting
    // for new events. Only in-flight / stale cards have a moving timer, so idle /
    // done / unread cards are skipped (they'd rebuild identical HTML otherwise).
    setInterval(() => {
      // Runs regardless of tab visibility: a stuck "le chef répond…" should
      // clear even in the background. Self-guarded + only fetches when armed.
      this._conductorLivenessCheck();
      if (document.hidden) return;
      this.syncChefCard(this.musicians.get(this.composer.CONDUCTOR) || null);
      window.Salle?.renderRail();
      window.Salle?.renderAttention();
      window.Projets?.render();
    }, 5000);
  },

  async loadConfig() {
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) throw new Error(`config ${resp.status}`);
      const cfg = await resp.json();
      // Honour the server-selected conductor. Default stays "chef" if the
      // server didn't send one (older build).
      if (cfg.conductor) {
        this.composer.CONDUCTOR = cfg.conductor;
        this.composer.target = cfg.conductor;
        this.activeTab = cfg.conductor;
      }
      // Sync provider toggle to the server-persisted value.
      if (cfg.defaults?.provider) {
        const provSeg = document.querySelector('[data-tweak="provider"]');
        if (provSeg) {
          provSeg.querySelectorAll("button").forEach(b =>
            b.classList.toggle("on", b.dataset.v === cfg.defaults.provider)
          );
        }
      }
      this.renderFleet(cfg.projects || []);
      window.Projets?.applyUi(cfg.ui); window.Activite?.applyUi(cfg.ui); window.Tts?.applyUi(cfg.ui); window.Models?.applyUi(cfg.ui);
    } catch (err) {
      console.error("[app] config fetch failed", err);
      $("#empty-hint").hidden = false;
      $(".empty-title", $("#empty-hint")).textContent = "Erreur de chargement";
      $(".empty-sub",   $("#empty-hint")).textContent = err.message;
    }
  },

  /** Reconcile the fleet against /api/config WITHOUT rebuilding everything —
   *  add new musicians, remove gone ones, and leave existing ones (and their
   *  live state) untouched. Called on the SSE `fleet_config_changed` signal so
   *  config.json edits appear/disappear without a page reload. */
  async refreshFleet() {
    let cfg;
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) return;
      cfg = await resp.json();
    } catch { return; }
    window.Projets?.applyUi(cfg.ui); window.Activite?.applyUi(cfg.ui); window.Tts?.applyUi(cfg.ui); window.Models?.applyUi(cfg.ui);   // `ui` rechargé à chaud (config.json)
    const projects = cfg.projects || [];
    const wanted = new Set(projects.map(p => p.name));
    let changed = false;
    // Add newcomers.
    for (const p of projects) {
      if (this.musicians.has(p.name)) continue;
      const m = new Musician(p);
      this.musicians.set(m.name, m);
      changed = true;
    }
    // Remove departed ones (keep the conductor even if absent — it's special).
    for (const name of [...this.musicians.keys()]) {
      if (wanted.has(name) || name === this.composer.CONDUCTOR) continue;
      const m = this.musicians.get(name);
      try { m.el?.remove(); } catch {}
      this.musicians.delete(name);
      if (window.Salle?.diveName === name) location.hash = "#/";
      changed = true;
    }
    if (!changed) return;
    this.syncChefCard(this.musicians.get(this.composer.CONDUCTOR) || null);
    this.relayout();
    this.toggleEmptyHint();
  },

  async loadChatHistory() {
    try {
      const resp = await fetch("/api/conductor-chat?n=60");
      if (!resp.ok) return;
      const msgs = await resp.json();
      const seen = new Set();
      const built = [];
      // Mirror the LIVE ordering rule so a reload shows the same thread: a
      // result that landed between a user prompt and the chef's reply was held
      // during that turn, so replay it after the reply — and group runs of
      // results into one basket. `held` = inside a turn, `pending` = the basket.
      let inTurn = false;
      let pending = [];
      let sinceChefTurn = [];
      let currentTaking = [];
      const flush = (ts) => {
        if (!pending.length) return;
        const tail = built[built.length - 1];
        // Merge into a trailing basket (same rule as live) so consecutive
        // results never show as two separate boxes.
        if (tail && tail.role === "results") tail.items.push(...pending);
        else built.push({ role: "results", items: pending, ts: ts || Date.now() });
        pending = [];
      };
      const fileItem = (it) => {
        sinceChefTurn.push({ source: it.source, outcome: it.outcome });
        pending.push(it);
        if (!inTurn) flush(it.ts);   // outside a turn → its own basket, in place
      };
      for (const m of msgs) {
        const e = {
          role: m.source ? "callback" : m.role,
          text: m.text,
          ts: m.ts,
          source: m.source || undefined,
          ...(m.attachmentPaths?.length ? { images: m.attachmentPaths } : {}),
          // 0.22.0 — file de direction : un rechargement doit retrouver
          // « ⏳ en file · position n » et « ▸ pris par CHEF n ».
          ...(m.ticket ? { ticket: m.ticket } : {}),
          ...(m.queued ? { queued: true } : {}),
          ...(m.answersTicket ? { answersTicket: m.answersTicket } : {}),
          ...(Number.isFinite(m.slot) ? { slot: m.slot } : {}),
          // 0.51.0 — badge « ⚠ langue » et original, retrouvés au rechargement.
          ...(m.lang ? { lang: m.lang } : {}),
        };
        // A source-less "[musician] Tour terminé…" is a relayed callback, not a
        // user message — reclassify so it's never shown as the user.
        if (e.role === "user" && !e.source) {
          const rm = CALLBACK_RELAY_RE.exec(e.text || "");
          if (rm) { e.role = "callback"; e.source = rm[1].trim(); }
        }
        if (e.role === "callback") {
          // Dedup (the notification + the relayed dispatch carry the same text;
          // old callbacks can also reappear in the tail).
          const k = chatKey(e.text);
          if (seen.has(k)) continue;
          seen.add(k);
          const item = this._makeResultItem(m, e.text, e.source || "musicien");
          if (item.outcome === "question") {
            built.push({ role: "question", source: item.source, text: item.summary || e.text, ts: e.ts });
          } else {
            fileItem(item);
          }
          continue;
        }
        if (e.role === "user") {
          flush(e.ts);           // anything still held belongs before the prompt
          inTurn = true;         // a turn opens
          // What came back since the PREVIOUS turn is what this one answers about.
          currentTaking = sinceChefTurn; sinceChefTurn = [];
          built.push(e);
          continue;
        }
        if (e.role === "conductor") {
          if (currentTaking.length) { e.taking = currentTaking; currentTaking = []; }
          if (m.question) e.question = true;
          built.push(e);
          inTurn = false;        // turn closed → release the held results
          flush(e.ts);
          continue;
        }
        built.push(e);
      }
      flush();
      this.chat = built;
      this.renderChat();
      // Les lignes de mission ne sont PAS dans /api/conductor-chat : on les
      // reconstruit depuis le journal du chef (signal `tool_use Bash`).
      await this.rehydrateMissions();
    } catch { /* non-fatal */ }
  },

  /** Reconstruit les blocs MISSIONS depuis `/api/project/<chef>/events`.
   *  Chaque dispatch observé est rattaché au tour chef qu'il précède ; les
   *  dispatches postérieurs au dernier tour restent ouverts (tour en cours).
   *  La fenêtre est bornée côté serveur (500 évts / 2 Mio) : on le DIT. */
  async rehydrateMissions() {
    const S = window.Salle;
    if (!S) return;
    // Le journal du chef se lit par une queue de 2 Mio côté serveur : on ne la
    // redemande pas à chaque battement de reconnexion SSE.
    if (Date.now() - (this._missionsRehydratedAt || 0) < 20000) return;
    this._missionsRehydratedAt = Date.now();
    let events;
    try {
      const resp = await fetch(`/api/project/${encodeURIComponent(this.composer.CONDUCTOR)}/events?n=500`,
                               { headers: { Accept: "application/json" } });
      if (!resp.ok) return;
      events = await resp.json();
    } catch { return; }
    if (!Array.isArray(events) || !events.length) return;
    const windowFull = events.length >= 500;

    const dispatches = [];
    for (const ev of events) {
      if (ev?.type !== "assistant") continue;
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      for (const b of ev.message?.content || []) {
        if (b?.type !== "tool_use" || b.name !== "Bash") continue;
        for (const name of S.extractDispatches(b.input?.command)) {
          dispatches.push({ name, ts: Number.isFinite(ts) ? ts : 0 });
        }
      }
    }
    if (!dispatches.length) return;

    // Bornes de tour : les bulles `conductor` du fil reconstruit.
    const bubbleIdx = [];
    this.chat.forEach((b, i) => { if (b.role === "conductor") bubbleIdx.push(i); });

    const buckets = new Map();      // index de bulle (ou -1 pour « en cours ») → items
    let prevTs = 0;
    for (const bi of bubbleIdx) {
      const ts = this.chat[bi].ts || 0;
      const slice = dispatches.filter(d => d.ts > prevTs && d.ts <= ts);
      if (slice.length) buckets.set(bi, slice);
      prevTs = ts;
    }
    const trailing = dispatches.filter(d => d.ts > prevTs);
    if (trailing.length) buckets.set(-1, trailing);
    if (!buckets.size) return;

    const mkItems = (slice, afterIdx) => {
      const seen = new Set();
      const items = [];
      for (const d of slice) {
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        const it = { name: d.name, launchedAt: d.ts || Date.now(), started: true, outcome: null };
        // Issue : première carte de résultat pour ce musicien APRÈS ce tour.
        for (let i = Math.max(0, afterIdx); i < this.chat.length; i++) {
          const e = this.chat[i];
          if (e.role !== "results") continue;
          const hit = e.items.find(x => x.source === d.name && !x.isInfo);
          if (!hit) continue;
          it.outcome = hit.outcome || "done";
          if (Number.isFinite(hit.durationMs)) it.durationMs = hit.durationMs;
          if (Number.isFinite(hit.costUsd)) it.costUsd = hit.costUsd;
          break;
        }
        items.push(it);
      }
      return items;
    };

    // Insertion de la fin vers le début pour ne pas décaler les index.
    const keys = [...buckets.keys()].filter(k => k >= 0).sort((a, b) => b - a);
    let firstBlock = null;
    for (const bi of keys) {
      const entry = { role: "missions", items: mkItems(buckets.get(bi), bi), ts: this.chat[bi].ts || Date.now() };
      if (!entry.items.length) continue;
      this.chat.splice(bi + 1, 0, entry);
      firstBlock = entry;
    }
    if (buckets.has(-1)) {
      const entry = { role: "missions", items: mkItems(buckets.get(-1), this.chat.length - 1), ts: Date.now() };
      if (entry.items.length) {
        this.chat.push(entry);
        this._currentMissions = entry;
        firstBlock = firstBlock || entry;
      }
    }
    if (windowFull && firstBlock) firstBlock.truncated = true;
    this.renderChat();
  },

  renderFleet(projects) {
    this.musicians.clear();
    for (const p of projects) {
      const m = new Musician(p);
      this.musicians.set(p.name, m);
    }
    // Paint the conductor card. If no project matches composer.CONDUCTOR,
    // pass null so the card renders its "unconfigured" visual state.
    const conductor = this.musicians.get(this.composer.CONDUCTOR);
    this.syncChefCard(conductor || null);
    this.relayout();
    this.toggleEmptyHint();
    this.renderChat();
  },

  toggleEmptyHint() {
    const hasMusicians = [...this.musicians.keys()]
      .some(name => name !== this.composer.CONDUCTOR);
    $("#empty-hint").hidden = hasMusicians;
  },

  /** v0.21.0 — « relayout » = repeindre le rail de pilotage, la bande
   *  d'attention et le bandeau système. Plus aucune géométrie de cartes. */
  relayout() {
    const S = window.Salle;
    if (!S) return;
    S.renderRail();
    S.renderAttention();
    S.renderSysBanner();
    S.syncRailVisibility();
    if (S.diveName) S.renderDive();
  },

  reorderSoon() {
    clearTimeout(this._reorderTimer);
    this._reorderTimer = setTimeout(() => this.relayout(), 250);
  },

  // ---------- Thread redraw: change-detected + bounded settle ----------
  //
  // A signature of everything that determines the set of threads (conductor
  // state, draft flag, each active musician's state). Positions are handled
  // separately by scheduleThreadSettle during the post-reorder slide.
  _threadSignature() {
    const c = this.musicians.get(this.composer.CONDUCTOR);
    const active = [];
    for (const m of this.musicians.values()) {
      if (m.name === this.composer.CONDUCTOR) continue;
      if (["live", "think", "input", "error"].includes(m.state)) active.push(m.name + ":" + m.state);
    }
    active.sort();
    return `c:${c ? c.state : "-"}|d:${this.composer.hasDraft ? 1 : 0}|${active.join(",")}`;
  },

  // Called by the 1s interval: rebuild only when the thread set changed.
  redrawThreadsIfChanged() {
    if (document.hidden) return;
    const sig = this._threadSignature();
    if (sig === this._threadSig) return;
    this._threadSig = sig;
    redrawThreads();
  },

  // Re-anchor threads to the moving cards for ~ms (one rAF loop, self-stopping),
  // so they track the slide after a reorder without a permanent redraw timer.
  scheduleThreadSettle(ms = 800) {
    redrawThreads();
    this._threadSig = this._threadSignature();
    this._threadSettleUntil = performance.now() + ms;
    if (this._threadSettleRaf) return;
    const step = () => {
      if (document.hidden || performance.now() >= this._threadSettleUntil) {
        this._threadSettleRaf = null;
        this._threadSig = this._threadSignature();
        return;
      }
      redrawThreads();
      this._threadSettleRaf = requestAnimationFrame(step);
    };
    this._threadSettleRaf = requestAnimationFrame(step);
  },

  // ---------- Coalesced SSE render flush ----------
  //
  // Musicians touched by SSE events this frame; their cards + tab bar + mobile
  // pane are repainted ONCE, on the next animation frame, instead of per event.
  // Because it rides rAF, zero render work happens while the tab is hidden.
  _dirty: null,
  _flushScheduled: false,
  markDirty(m) {
    (this._dirty || (this._dirty = new Set())).add(m);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    requestAnimationFrame(() => this._flushDirty());
  },
  _flushDirty() {
    this._flushScheduled = false;
    const dirty = this._dirty; this._dirty = null;
    if (!dirty || !dirty.size) return;
    const S = window.Salle;
    let diveNeedsRender = false;
    for (const m of dirty) {
      if (m.name === this.composer.CONDUCTOR) this.syncChefCard(m);
      if (S && S.diveName === m.name) diveNeedsRender = true;
    }
    S?.renderRail();
    S?.renderAttention();
    window.Projets?.render();
    if (diveNeedsRender) S.renderDive();
  },

  // Mobile-only: swipe left/right on the stage rotates the deck — the top
  // card goes to the back. Direction is ignored (user feedback: both should
  // do the same thing). Taps on a card still open the focused view; we use
  // a pointer-travel threshold to distinguish the two.
  wireFanSwipe() {
    const stage = $("#stage");
    let startX = null, startY = null, swiped = false;
    const THRESH = 40;
    stage.addEventListener("pointerdown", (e) => {
      if (!isMobileViewport()) return;
      if (e.target.closest(".composer") || e.target.closest(".topbar")) return;
      startX = e.clientX; startY = e.clientY; swiped = false;
    });
    stage.addEventListener("pointermove", (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!swiped && Math.abs(dx) > THRESH && Math.abs(dx) > Math.abs(dy)) {
        swiped = true;
        this.deckRotate();
        startX = null;
      }
    });
    stage.addEventListener("pointerup",   () => { startX = null; });
    stage.addEventListener("pointercancel", () => { startX = null; });
    // Swallow the click immediately following a successful swipe so it
    // doesn't open a focused panel.
    stage.addEventListener("click", (e) => {
      if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
    }, true);
  },

  deckRotate() {
    const n = this.musicians.size;
    if (n < 2) return;
    this.deckOffset = (this.deckOffset + 1) % n;
    this.relayout();
  },

  // ---------- Topbar wiring ----------
  wireTopbar() {
    $("#btn-tweaks").addEventListener("click", () => $("#tweaks").hidden = !$("#tweaks").hidden);
    $("#btn-search").addEventListener("click", () => window.Salle?.openSearch());

    // Menu ⋮ — les routes secondaires et l'administration sortent du fil.
    const menu = $("#topmenu");
    const btn  = $("#btn-menu");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    menu.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (act === "add")      this.openAdd();
      if (act === "briefing") this.openBriefing();
      if (act === "projects") window.Projets?.open();
      if (act === "models")   window.Models?.open();
      if (act === "perm-rules") window.Permissions?.openRules();
    });
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (e.target.closest("#topmenu") || e.target.closest("#btn-menu")) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });

    // L'en-tête chef ouvre le pupitre du chef (même chemin qu'un musicien).
    const chefStatus = $("#chef-status");
    const openChef = () => {
      if (chefStatus.classList.contains("is-unconfigured")) return;
      this.openMusician(this.composer.CONDUCTOR);
    };
    chefStatus.addEventListener("click", openChef);
    chefStatus.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openChef();
    });
  },

  // ---------- Composer wiring ----------
  wireComposer() {
    const input = $("#composer-input");
    const send = $("#composer-send");

    const setDraft = () => {
      const has = input.value.trim().length > 0 || this.composer.images.length > 0;
      send.disabled = !has;
      this.composer.hasDraft = has;
      this._syncComposerTarget();
    };

    // @mention picker — helps the user spell project names correctly so
    // the conductor (or direct target) gets an unambiguous reference.
    const mention = { open: false, anchor: -1, query: "", cursor: 0, matches: [] };
    const mentionEl = $("#mention-menu");

    const detectMention = () => {
      const v = input.value;
      const caret = input.selectionStart ?? v.length;
      // find the last '@' before the caret such that there's no whitespace
      // between it and the caret.
      let i = caret - 1;
      while (i >= 0 && !/\s/.test(v[i])) {
        if (v[i] === "@") {
          const prev = i === 0 ? "" : v[i - 1];
          if (i === 0 || /\s/.test(prev) || /[.,;:!?]/.test(prev)) {
            mention.anchor = i;
            mention.query = v.slice(i + 1, caret);
            return true;
          }
          break;
        }
        i--;
      }
      mention.anchor = -1;
      return false;
    };

    const renderMentionMenu = () => {
      const names = [...this.musicians.keys()];
      const q = mention.query.toLowerCase();
      mention.matches = names
        .map(n => ({ n, score: n.toLowerCase().startsWith(q) ? 2 : (n.toLowerCase().includes(q) ? 1 : 0) }))
        .filter(r => r.score > 0 || q === "")
        .sort((a, b) => b.score - a.score || a.n.localeCompare(b.n))
        .slice(0, 8);
      if (!mention.matches.length) { closeMention(); return; }
      if (mention.cursor >= mention.matches.length) mention.cursor = 0;
      mentionEl.innerHTML = mention.matches.map((r, i) => {
        const m = this.musicians.get(r.n);
        const state = m ? STATE_LABELS[m.state].label : "";
        const isConductor = r.n === this.composer.CONDUCTOR;
        return `<button class="mm-item ${i === mention.cursor ? "is-sel" : ""} ${isConductor ? "is-conductor" : ""}" data-name="${esc(r.n)}">
          <span class="mm-dot" style="background: ${m ? varByState(m.state) : "var(--fg-3)"};"></span>
          <span class="mm-name">${esc(r.n)}</span>
          <span class="mm-sub">${esc(state)}</span>
        </button>`;
      }).join("");
      $$(".mm-item", mentionEl).forEach((el, i) => {
        el.addEventListener("mouseenter", () => { mention.cursor = i; refreshSel(); });
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          confirmMention(i);
        });
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          // Safety net in case the mousedown path didn't fire (touch, etc.)
          if (!mentionEl.hidden) confirmMention(i);
        });
      });
      mentionEl.hidden = false;
      mention.open = true;
    };

    const refreshSel = () => {
      $$(".mm-item", mentionEl).forEach((el, i) => el.classList.toggle("is-sel", i === mention.cursor));
    };

    const closeMention = () => {
      mention.open = false;
      mention.anchor = -1;
      mention.cursor = 0;
      mentionEl.hidden = true;
    };

    const confirmMention = (idx) => {
      if (!mention.open || mention.anchor < 0) return;
      const pick = mention.matches[idx] ?? mention.matches[mention.cursor];
      if (!pick) return;
      const v = input.value;
      const caret = input.selectionStart ?? v.length;
      const before = v.slice(0, mention.anchor);
      const after = v.slice(caret);
      const needsSpace = !after.startsWith(" ") && !after.startsWith("\n");
      const insertion = `@${pick.n}${needsSpace ? " " : ""}`;
      input.value = before + insertion + after;
      const newCaret = (before + insertion).length;
      input.setSelectionRange(newCaret, newCaret);
      closeMention();
      setDraft();
      // NOTE: we used to auto-flip to "direct mode" (conductorMode=false)
      // when the user confirmed @orchestrateur. That hid the chat
      // transcript mid-type, which felt like a crash. The mention is now
      // purely a text insertion — direct mode is reachable via a different
      // entrypoint only.
    };

    input.addEventListener("input", () => {
      setDraft();
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 180) + "px";
      if (detectMention()) renderMentionMenu();
      else closeMention();
    });
    input.addEventListener("keydown", (e) => {
      if (mention.open) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mention.cursor = (mention.cursor + 1) % mention.matches.length;
          refreshSel();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mention.cursor = (mention.cursor - 1 + mention.matches.length) % mention.matches.length;
          refreshSel();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          confirmMention(mention.cursor);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    input.addEventListener("blur", () => setTimeout(closeMention, 120));
    input.addEventListener("click", () => { if (detectMention()) renderMentionMenu(); else closeMention(); });
    send.addEventListener("click", () => this.sendMessage());

    // Paste — images and videos from clipboard; text proceeds normally.
    input.addEventListener("paste", (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const mediaItems = items.filter(it => it.type.startsWith("image/") || it.type.startsWith("video/"));
      if (!mediaItems.length) return;
      e.preventDefault();
      for (const item of mediaItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const objectUrl = URL.createObjectURL(blob);
        this.composer.images.push({ objectUrl, mediaType: item.type, blob, isVideo: item.type.startsWith("video/") });
      }
      this.renderComposerImages();
      setDraft();
    });

    // File picker — paperclip button triggers the hidden input.
    const fileBtn   = $("#composer-attach");
    const fileInput = $("#composer-file");
    if (fileBtn && fileInput) {
      fileBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        this._addAttachFiles(Array.from(fileInput.files || []));
        fileInput.value = "";
      });
    }

    // Drag-drop onto the composer box.
    const box = $(".composer-box");
    if (box) {
      box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drag-over"); });
      box.addEventListener("dragleave", () => box.classList.remove("drag-over"));
      box.addEventListener("drop", (e) => {
        e.preventDefault();
        box.classList.remove("drag-over");
        this._addAttachFiles(Array.from(e.dataTransfer?.files || []));
      });
    }
  },

  _addAttachFiles(files) {
    const ACCEPTED_IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const ACCEPTED_VIDEO = new Set(["video/mp4", "video/webm", "video/quicktime"]);
    const rejected = [];
    for (const f of files) {
      if (ACCEPTED_IMAGE.has(f.type)) {
        const objectUrl = URL.createObjectURL(f);
        this.composer.images.push({ objectUrl, mediaType: f.type, blob: f, isVideo: false });
      } else if (ACCEPTED_VIDEO.has(f.type)) {
        const objectUrl = URL.createObjectURL(f);
        this.composer.images.push({ objectUrl, mediaType: f.type, blob: f, isVideo: true });
      } else {
        rejected.push(f.name);
      }
    }
    if (rejected.length) {
      this.showComposerError(`Type non supporté : ${rejected.join(", ")} — accepté : images (PNG/JPG/WEBP/GIF) et vidéos (MP4/WEBM/MOV).`);
    }
    if (files.length - rejected.length > 0) {
      this.renderComposerImages();
      const input = $("#composer-input");
      const send  = $("#composer-send");
      if (input && send) {
        const has = input.value.trim().length > 0 || this.composer.images.length > 0;
        send.disabled = !has;
      }
    }
  },

  showComposerError(msg) {
    const el = $("#composer-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._composerErrTimer);
    this._composerErrTimer = setTimeout(() => { el.hidden = true; }, 6000);
  },

  renderComposerImages() {
    const strip = $("#composer-image-strip");
    if (!strip) return;
    if (!this.composer.images.length) { strip.hidden = true; strip.innerHTML = ""; return; }
    strip.hidden = false;
    strip.innerHTML = this.composer.images.map((att, i) => {
      const preview = att.isVideo
        ? `<video src="${att.objectUrl}" class="cis-video-preview" muted preload="metadata" title="${att.blob?.name || "vidéo"}"></video>`
        : `<img src="${att.objectUrl}" alt="image ${i + 1}">`;
      return `<div class="cis-thumb${att.isVideo ? " cis-thumb--video" : ""}" data-idx="${i}">${preview}` +
        `<button class="cis-del" data-idx="${i}" aria-label="Supprimer">✕</button>` +
        `</div>`;
    }).join("");
    $$(".cis-del", strip).forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const removed = this.composer.images.splice(idx, 1)[0];
        URL.revokeObjectURL(removed.objectUrl);
        this.renderComposerImages();
        // Re-evaluate send button (may disable if no text AND no images left).
        const input = $("#composer-input");
        const send  = $("#composer-send");
        const has = input.value.trim().length > 0 || this.composer.images.length > 0;
        send.disabled = !has;
        this.composer.hasDraft = has;
      });
    });
  },

  // ---------- Conversation de direction ----------
  renderChat() {
    this.renderMainPane();
    window.Salle?.renderRail();
    window.Tts?.sync();   // état « écouter / arrêter » des bulles re-rendues
  },

  renderMainPane() {
    const scroll = $("#cv-scroll");
    if (!scroll) return;

    if (!this.chat.length) {
      this._setPaneMode(scroll, "empty:conductor");
      reconcileChildren(scroll, [`<div class="cv-empty">
          <div class="cv-empty-title">Salle de direction</div>
          <div class="cv-empty-sub">Écrivez au chef. Il délègue aux musiciens et vous fait le point.</div>
        </div>`]);
      this._syncComposerTarget();
      return;
    }
    const conductor = this.musicians.get(this.composer.CONDUCTOR);
    // Show "le chef répond..." only when a user_prompt SSE arrived this session
    // AND the chef hasn't yet sent a result.
    const isWaitingConductor = this._awaitingConductorResponse;

    const changedMode = this._setPaneMode(scroll, "conductor");
    // Only auto-scroll when already at (or near) the bottom, or when we just
    // switched into this pane.
    const wasAtBottom = changedMode || (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80);

    // Build the desired child HTML list and reconcile in place. During a live
    // turn only the growing "reflection" bubble (and the waiting pill) change,
    // so every other bubble keeps its DOM node — no whole-transcript rebuild,
    // no blank frame.
    const htmls = this.chat.map((b, idx) => this._conductorBubbleHtml(b, idx));
    // Un musicien en vol SANS dispatch du chef observé n'est pas une mission :
    // il va dans un bloc « Activité de l'orchestre » séparé, en pied de fil.
    const activity = window.Salle?.orchestraActivityHtml() || "";
    if (activity) htmls.push(activity);
    if (isWaitingConductor) {
      htmls.push(`<div class="cv-thinking">le chef ${conductor && conductor.state === "think" ? "réfléchit" : "répond"}<span class="cv-dots"></span></div>`);
    }
    reconcileChildren(scroll, htmls);
    this._wireCvDelegation(scroll);
    if (wasAtBottom) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    this.renderReplyChip();
    this._syncComposerTarget();
  },

  /** Clear the pane exactly once when its content MODE changes (tab switch,
   *  empty↔list) so reconciliation never tries to morph conductor bubbles into
   *  session events. Returns true when the mode changed. */
  _setPaneMode(scroll, mode) {
    if (scroll.dataset.mode === mode) return false;
    scroll.dataset.mode = mode;
    scroll.innerHTML = "";
    return true;
  },

  /** HTML for one conductor-transcript entry. Pure string builder so the
   *  reconciler can diff it; interactions are handled by delegation. */
  _conductorBubbleHtml(b, idx) {
    const tsChip = b.ts ? `<span class="cv-ts">${esc(fmtChatTs(b.ts))}</span>` : "";
    if (b.role === "user") {
      const replyQuote = b.replyingTo
        ? `<div class="cv-body-reply-quote">↩ ${esc(String(b.replyingTo).replace(/\s+/g, " ").slice(0, 140))}${b.replyingTo.length > 140 ? "…" : ""}</div>`
        : "";
      const imgThumbs = (b.images || []).map(url =>
        `<img class="cv-attach-thumb" src="${url}" alt="image jointe" loading="lazy">`
      );
      const vidThumbs = (b.videos || []).map(url =>
        `<video class="cv-attach-thumb cv-attach-thumb--video" src="${url}" muted preload="metadata"></video>`
      );
      const attachHtml = (imgThumbs.length || vidThumbs.length)
        ? `<div class="cv-attach-strip">${imgThumbs.join("") + vidThumbs.join("")}</div>`
        : "";
      // File de direction (0.22.0) : chaque message dit OÙ IL EN EST. Le
      // statut vient du pool (file) ou du log du slot (« pris par »), jamais
      // d'une supposition — et il n'y a pas de compte à rebours.
      const ticketHtml = window.Salle ? window.Salle.ticketStatusHtml(b) : "";
      return `<div class="cv-bubble is-user" data-idx="${idx}"${b.ticket ? ` data-ticket="${esc(b.ticket)}"` : ""}>
          <div class="cv-byline">
            <button class="cv-edit-btn" data-edit-idx="${idx}" title="Modifier et renvoyer">✎ éditer</button>
            vous${tsChip}
          </div>
          <div class="cv-body">${replyQuote}${esc(b.text)}${attachHtml}</div>
          ${ticketHtml}
        </div>`;
    }
    // Lignes de mission : une par musicien, elles VIVENT sur place jusqu'à
    // l'issue, puis POINTENT vers leur carte du panier (jamais de recopie).
    if (b.role === "missions") {
      return window.Salle ? window.Salle.missionsHtml(b) : "";
    }
    if (b.role === "callback") {
      // Legacy shape (pre-0.18 logs / plain /api/notify): no outcome fields.
      return `<div class="cv-bubble is-callback">
          <div class="cv-byline">${esc(b.source || "musicien")}${tsChip}</div>
          <div class="cv-body md">${mdToHtml(b.text || "")}</div>
        </div>`;
    }
    // A musician REPORTS — it does not converse. Results are rendered as a
    // basket of cards (state-coloured), never as dialogue bubbles, and the
    // basket is placed AFTER the chef's reply so it can't split a turn.
    if (b.role === "results") {
      const n = b.items.length;
      const cards = b.items.map(it => {
        // « coût non fourni » : jamais un faux 0,00 $ (honnêteté des affichages).
        const dur  = Number.isFinite(it.durationMs) ? esc(formatElapsed(it.durationMs)) : "";
        const cost = Number.isFinite(it.costUsd)
          ? `$${it.costUsd.toFixed(2)}`
          : `<span class="rc-cost-missing">coût non fourni</span>`;
        const meta = [dur, cost].filter(Boolean).join(" · ");
        const badge = it.awaitingChef ? `<span class="rc-badge">attend le chef</span>` : "";
        // Un notify manuel n'est pas un tour terminé : « Information de X ».
        const outcome = it.isInfo ? "info" : (it.outcome || "done");
        const mark = it.isInfo ? "ⓘ" : outcomeIcon(it.outcome);
        const who = it.isInfo
          ? `Information de ${esc(it.source || "musicien")}`
          : esc(it.source || "musicien");
        return `<div class="cv-result-card" data-outcome="${esc(outcome)}" data-name="${esc(it.source || "")}">
            <div class="rc-head">
              <span class="rc-name">${who}</span>
              <span class="rc-mark">${mark}</span>
              ${meta ? `<span class="rc-meta">${meta}</span>` : ""}
              ${badge}
            </div>
            <div class="rc-summary md">${mdToHtml(it.summary || it.text || "")}</div>
            <div class="rc-actions">
              <button class="rc-act" data-open-musician="${esc(it.source || "")}">Ouvrir ${esc(it.source || "")} ›</button>
              <button class="rc-act is-primary" data-talk-chef="${esc(it.source || "")}">En parler au chef</button>
            </div>
          </div>`;
      }).join("");
      const names = b.items
        .map(it => `${esc(it.source || "?")} ${it.isInfo ? "ⓘ" : outcomeIcon(it.outcome)}`)
        .join(" · ");
      const nDone    = b.items.filter(it => !it.isInfo && (!it.outcome || it.outcome === "done")).length;
      const nFailed  = b.items.filter(it => it.outcome === "failed").length;
      const nWaiting = b.items.filter(it => it.outcome === "ask_chef").length;
      const nInfo    = b.items.filter(it => it.isInfo).length;
      const issues = [
        nDone    ? `${nDone} terminé${nDone > 1 ? "s" : ""}` : "",
        nFailed  ? `${nFailed} échec${nFailed > 1 ? "s" : ""}` : "",
        nWaiting ? `${nWaiting} attend le chef` : "",
        nInfo    ? `${nInfo} information${nInfo > 1 ? "s" : ""}` : "",
      ].filter(Boolean).join(" · ");
      // Progressive disclosure: a lone result opens (level 1); several collapse
      // to ONE line (level 0) so a burst never floods the thread.
      const openAttr = n === 1 ? " open" : "";
      return `<details class="cv-results"${openAttr}>
          <summary class="cv-results-summary">
            <span class="cv-results-label">Résultat${n > 1 ? "s" : ""} reçu${n > 1 ? "s" : ""}</span>
            <span class="cv-results-count">${n}</span>
            <span class="cv-results-issues">${esc(issues)}</span>
            <span class="cv-results-names">${names}</span>
          </summary>
          <div class="cv-results-body">${cards}</div>
        </details>`;
    }
    // A musician asking the USER jumps the basket: it needs an answer now.
    // Défaut = répondre VIA LE CHEF (règle dure du CLAUDE.md : le routage des
    // réponses est le travail du chef). L'envoi direct reste atteignable, mais
    // explicite — et sans `--callback`, donc sans réveil ni point.
    if (b.role === "question") {
      const who = esc(b.source || "musicien");
      // 0.25.0 — une question déjà traitée ne réclame plus d'action. Acquittée
      // APRÈS cette bulle ⇒ « ✓ répondue » ; c'est la plus récente question de
      // ce musicien et il attend encore ⇒ on propose aussi de l'acquitter.
      const m = this.musicians.get(b.source || "");
      const res = m?.questionResolved;
      const resolved = res && res.ts && b.ts && res.ts >= b.ts;
      const latest = !this.chat.some(e => e.role === "question" && e.source === b.source && e.ts > b.ts);
      if (resolved) {
        return `<div class="cv-bubble is-question is-resolved">
            <div class="cv-byline">Question de ${who} · ✓ marquée répondue${tsChip}</div>
            <div class="cv-body md">${mdToHtml(b.text || "")}</div>
            ${res.note ? `<div class="cv-q-resolved">${esc(res.note)}</div>` : ""}
          </div>`;
      }
      const canResolve = latest && m?.state === "input";
      return `<div class="cv-bubble is-question">
          <div class="cv-byline">Question de ${who} · votre décision${tsChip}</div>
          <div class="cv-body md">${mdToHtml(b.text || "")}</div>
          <div class="cv-q-actions">
            <button class="cv-q-primary" data-via-chef="${who}">Répondre via le chef</button>
            <button class="cv-q-secondary" data-direct-to="${who}">Répondre directement à ${who}</button>
            ${canResolve ? `<button class="cv-q-secondary" data-resolve-question="${who}" title="Déjà répondue ailleurs ou sans objet — aucun tour relancé">✓ Marquer comme répondue</button>` : ""}
            <span class="cv-q-note">mis en file si ${who} est occupé · pas de retour au chef</span>
          </div>
        </div>`;
    }
    if (b.role === "reflection") {
      const n = b.events.length;
      const elapsed = formatElapsed((b.endTs || Date.now()) - b.startTs);
      const statusTxt = b.closed ? `${n} étape${n > 1 ? "s" : ""} · ${elapsed}` : `en cours · ${n} étape${n > 1 ? "s" : ""} · ${elapsed}`;
      const evHtml = b.events.map(ev => {
        if (ev.kind === "tool") return `<div class="cv-refl-ev cv-refl-tool">⚙ <span class="cv-refl-tn">${esc(ev.name)}</span> <span class="cv-refl-arg">${esc(ev.preview || "")}</span></div>`;
        if (ev.kind === "thinking") return `<div class="cv-refl-ev cv-refl-think">◌ ${esc(ev.text)}</div>`;
        if (ev.kind === "text") return `<div class="cv-refl-ev cv-refl-text">${esc(ev.text)}</div>`;
        if (ev.kind === "result") return `<div class="cv-refl-ev cv-refl-res">↳ ${esc(ev.text)}</div>`;
        return "";
      }).join("");
      // Divulgation progressive : l'activité du chef est REPLIÉE par défaut
      // (résumé « n étapes · durée »), et le dépliage de l'utilisateur est
      // mémorisé sur l'entrée — sinon chaque nouvel événement le refermerait.
      const openAttr = b.userOpen ? " open" : "";
      const details = `<details class="cv-reflection${b.closed ? " is-closed" : " is-live"}"${openAttr} data-idx="${idx}">
          <summary class="cv-refl-summary">
            <span class="cv-refl-label">Activité du chef</span>
            <span class="cv-refl-meta">${esc(statusTxt)}</span>
          </summary>
          <div class="cv-refl-body">${evHtml || '<div class="cv-refl-empty">…</div>'}</div>
        </details>`;
      // reconcileChildren keeps only the FIRST root element per entry, so when a
      // "prend en compte" header exists it must be wrapped together with the
      // details in a single root.
      return takingHtml(b) ? `<div class="cv-chefgroup">${takingHtml(b)}${details}</div>` : details;
    }
    const usageChip = b.usage ? `<span class="cv-usage">${esc(fmtTurnUsage(b.usage))}</span>` : "";
    const qCls = b.question ? " is-chef-question" : "";
    const qTag = b.question ? `<span class="cv-qtag">question</span>` : "";
    // Un tour consécutif à un réveil OBSERVÉ est un POINT sur les résultats :
    // liseré double, en-tête explicite, aide « reçus avant ce tour ». Au
    // rechargement l'origine wake est perdue (le serveur saute ce prompt) ⇒
    // bulle chef ordinaire portant quand même « prend en compte » (P1-2).
    const rCls = b.report ? " is-report" : "";
    const byline = b.report ? "chef — point sur les résultats" : "chef d'orchestre";
    const hint = b.report ? `<div class="cv-report-hint">ⓘ résultats reçus avant ce tour</div>` : "";
    // « ↩ répond à … » — affiché SEULEMENT si la bulle visée n'est pas juste
    // au-dessus (sinon c'est du bruit). Avec un seul chef c'est rare ; avec
    // trois (P0-B) ce sera la règle, et le lien est déjà porté par la donnée.
    let answers = "";
    if (b.answersTicket) {
      const prev = this.chat[idx - 1];
      if (!(prev && prev.role === "user" && prev.ticket === b.answersTicket)) {
        const target = this.chat.find(e => e.role === "user" && e.ticket === b.answersTicket);
        if (target) {
          answers = `<button class="cv-answers" data-goto-ticket="${esc(b.answersTicket)}" title="Aller au message concerné">↩ répond à « ${esc(String(target.text).replace(/\s+/g, " ").slice(0, 60))} »</button>`;
        }
      }
    }
    // Langue (0.51.0) : badge, et l'original reste consultable.
    const L = b.lang;
    const langTag = L ? `<span class="cv-langtag" title="Réponse ${L.reason === 'model-language' ? 'écrite par un model qui travaille' : 'reçue'} en ${esc(L.detected || '?')}, reformulée automatiquement en ${esc(L.target || '?')}${L.by ? ` (${esc(L.by)})` : ''}">⚠ langue</span>` : "";
    const langOrig = L?.original ? `<details class="cv-lang-orig"><summary>voir l'original (${esc(L.detected || '?')})</summary><div class="md">${mdToHtml(L.original)}</div></details>` : "";
    return `<div class="cv-bubble is-conductor${qCls}${rCls}${L ? " is-lang-fixed" : ""}">
          <div class="cv-byline">${esc(byline)}${tsChip}${qTag}${langTag}${usageChip}
            <button class="cv-reply-btn" data-reply-idx="${idx}" title="Répondre à ce message">↩ répondre</button>
            ${window.Tts ? window.Tts.buttonHtml(idx) : ""}
          </div>
          ${answers}${hint}${takingHtml(b)}
          <div class="cv-body md">${mdToHtml(b.text || "")}</div>
          ${langOrig}
        </div>`;
  },

  /** Attach the transcript's click/dblclick handlers ONCE via delegation, so
   *  reconciled nodes need no per-render re-wiring (they used to be re-bound on
   *  every full rebuild). */
  _wireCvDelegation(scroll) {
    if (scroll._cvWired) return;
    scroll._cvWired = true;
    scroll.addEventListener("click", (e) => {
      // Dépliage de l'activité du chef : mémorisé sur l'entrée pour qu'un
      // nouvel événement ne referme pas ce qu'on est en train de lire.
      const reflSum = e.target.closest(".cv-refl-summary");
      if (reflSum) {
        e.preventDefault();
        const idx = Number(reflSum.closest("details")?.dataset.idx);
        const entry = this.chat[idx];
        if (entry) { entry.userOpen = !entry.userOpen; this.renderChat(); }
        return;
      }
      // Déplier un panier vaut « lu » côté serveur — « lu » n'efface rien et
      // n'acquitte rien, c'est seulement la fin du compteur non-lu.
      const basket = e.target.closest(".cv-results-summary");
      if (basket) {
        const det = basket.closest("details");
        if (det && !det.open) {
          for (const card of $$(".cv-result-card", det)) {
            const m = this.musicians.get(card.dataset.name || "");
            if (m) m.markRead();
          }
        }
        return;   // laisse le <details> natif basculer
      }
      const replyBtn = e.target.closest(".cv-reply-btn");
      if (replyBtn) {
        e.stopPropagation();
        const target = this.chat[Number(replyBtn.dataset.replyIdx)];
        if (target) this.startReply(target);
        return;
      }
      const editBtn = e.target.closest(".cv-edit-btn");
      if (editBtn) {
        e.stopPropagation();
        this.startInlineEdit(scroll, Number(editBtn.dataset.editIdx));
        return;
      }
      // Nom de musicien (ligne de mission, carte, bande) → volet routé.
      const openBtn = e.target.closest("[data-open-musician]");
      if (openBtn) {
        e.stopPropagation();
        this.openMusician(openBtn.dataset.openMusician);
        return;
      }
      // Une puce « prend en compte » ou l'issue d'une mission POINTE vers la
      // carte du panier : on y défile, on la surligne. Jamais de recopie.
      const goto = e.target.closest("[data-goto-result]");
      if (goto) {
        e.stopPropagation();
        this.revealResultCard(goto.dataset.gotoResult);
        return;
      }
      // File de direction : retirer / interrompre / aller au message visé.
      const wd = e.target.closest("[data-pool-withdraw]");
      if (wd) { e.stopPropagation(); this.withdrawTicket(wd.dataset.poolWithdraw); return; }
      const itr = e.target.closest("[data-pool-interrupt]");
      if (itr) { e.stopPropagation(); this.interruptChef(Number(itr.dataset.poolInterrupt) || 1); return; }
      const gt = e.target.closest("[data-goto-ticket]");
      if (gt) {
        e.stopPropagation();
        const node = scroll.querySelector(`.cv-bubble.is-user[data-ticket="${CSS.escape(gt.dataset.gotoTicket)}"]`);
        if (node) {
          node.scrollIntoView({ block: "center", behavior: "smooth" });
          node.classList.add("is-flash");
          setTimeout(() => node.classList.remove("is-flash"), 1600);
        }
        return;
      }
      const rq = e.target.closest("[data-resolve-question]");
      if (rq) { e.stopPropagation(); this.resolveQuestion(rq.dataset.resolveQuestion); return; }
      // Question d'un musicien : défaut = via le chef.
      const viaBtn = e.target.closest("[data-via-chef]");
      if (viaBtn) { e.stopPropagation(); this.answerViaChef(viaBtn.dataset.viaChef); return; }
      const talkBtn = e.target.closest("[data-talk-chef]");
      if (talkBtn) { e.stopPropagation(); this.talkToChefAbout(talkBtn.dataset.talkChef); return; }
      // Envoi DIRECT — action secondaire, jamais implicite.
      const directBtn = e.target.closest("[data-direct-to]");
      if (directBtn) {
        e.stopPropagation();
        const name = directBtn.dataset.directTo;
        const input = $("#composer-input");
        if (input && name) {
          if (!input.value.trim().startsWith("@" + name)) input.value = `@${name} `;
          this.composer.answerFor = null;
          this.renderComposerContext();
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
          this._syncComposerTarget();
        }
      }
    });
    scroll.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      const bubble = e.target.closest(".cv-bubble.is-user");
      if (bubble) this.startInlineEdit(scroll, Number(bubble.dataset.idx));
    });
  },

  /** Attach a "replying to" context to the composer. Shows a chip above
   *  the textarea; when the user sends, the payload includes a quoted
   *  reference to the chef's message so Claude sees exactly what the
   *  reply is about without the user having to repeat the target name. */
  startReply(target) {
    this.composer.replyingTo = {
      text: String(target.text || "").trim(),
      ts: target.ts || null,
    };
    this.renderReplyChip();
    const input = $("#composer-input");
    input?.focus();
  },

  cancelReply() {
    this.composer.replyingTo = null;
    this.renderReplyChip();
  },

  renderReplyChip() {
    let chip = $("#composer-reply-chip");
    const composer = $("#composer");
    const r = this.composer.replyingTo;
    if (!r) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "composer-reply-chip";
      chip.className = "composer-reply-chip";
      composer.insertBefore(chip, composer.firstChild);
    }
    const snippet = r.text.replace(/\s+/g, " ").slice(0, 180);
    chip.innerHTML = `
      <span class="crc-icon">↩</span>
      <span class="crc-label">En réponse au chef</span>
      <span class="crc-quote">${esc(snippet)}${r.text.length > 180 ? "…" : ""}</span>
      <button class="crc-close" aria-label="Annuler la réponse">✕</button>
    `;
    $(".crc-close", chip).addEventListener("click", () => this.cancelReply());
  },

  // v0.21.0 — la barre d'onglets mobile est remplacée par la ligne
  // « Pilotage » + la feuille du rail : les musiciens sont des SUBORDONNÉS,
  // pas des interlocuteurs. Conservés en no-op gardés (appelants historiques).
  renderTabs() {
    const bar = $("#tab-bar");
    if (bar) bar.hidden = true;
    window.Salle?.renderMobilePilot();
  },

  setActiveTab(name) {
    // Tout message part au chef par défaut ; ouvrir un musicien = #/m/<X>.
    if (name && name !== this.composer.CONDUCTOR) { this.openMusician(name); return; }
    this.activeTab = this.composer.CONDUCTOR;
    this.composer.target = this.composer.CONDUCTOR;
    this._syncComposerTarget();
  },

  _syncComposerPlaceholder() { this._syncComposerTarget(); },

  /** Cible affichée du composer : « À : CHEF » par défaut, « À : X (direct) »
   *  quand la saisie commence par @X. Si le chef a un tour vivant, l'envoi est
   *  annoncé comme une interruption coopérative. */
  _syncComposerTarget() {
    const input = $("#composer-input");
    const chip  = $("#composer-target");
    const send  = $("#composer-send");
    if (!input) return;
    const mm = /^@([A-Za-z0-9_.\-]+)/.exec(input.value.trim());
    const direct = mm && this.musicians.has(mm[1]) ? mm[1] : null;
    // Combien de chefs sont disponibles MAINTENANT. `null` = instantané non
    // reçu : on n'affiche alors aucun compte plutôt qu'un chiffre inventé.
    const free = window.Salle?.poolFreeSlots?.() ?? null;
    const queued = (window.Salle?.poolQueue?.() || []).length;
    if (chip) {
      chip.textContent = direct
        ? `À : ${direct.toUpperCase()} (direct)`
        : (free == null ? "À : CHEF" : `À : CHEF (${free} libre)`);
      chip.classList.toggle("is-direct", !!direct);
    }
    input.placeholder = direct
      ? `Envoi direct à ${direct} — aucun retour au chef`
      : "Écrivez au chef — tape @ pour citer un musicien";
    const chefRow = this.pupitreSnapshot?.fleet?.find(r => r.name === this.composer.CONDUCTOR);
    const chefBusy = !direct && chefRow?.pidAlive === true;
    // 0.22.0 : l'envoi n'interrompt PLUS. On l'annonce AVANT l'envoi, et le
    // libellé du bouton ne change pas (l'action reste « envoyer »).
    if (send) send.title = chefBusy ? "Envoyer — le message sera mis en file" : "Envoyer au chef";
    const hint = $(".composer-hint");
    if (hint) {
      const base = "<kbd>↵</kbd> envoyer · <kbd>⇧ ↵</kbd> nouvelle ligne · <kbd>Esc</kbd> fermer";
      const warn = chefBusy
        ? ` · <span class="composer-warn">le chef a un tour en cours — votre message sera mis en file${queued ? ` (${queued} devant)` : ""}</span>`
        : "";
      const html = base + warn;
      if (hint.innerHTML !== html) hint.innerHTML = html;
    }
  },

  /** Répondre à un musicien VIA LE CHEF (défaut) : le composer vise le chef,
   *  le message cite la question et nomme X. C'est le chef qui route. */
  answerViaChef(name) {
    if (!name) return;
    const m = this.musicians.get(name);
    const snapQ = this.pupitreSnapshot?.fleet?.find(r => r.name === name)?.needsInput;
    const q = (snapQ || m?.lastLine || "").trim();
    this.composer.answerFor = { name, question: q };
    const input = $("#composer-input");
    if (input) {
      const prefix = `Réponse pour ${name} à sa question « ${q.slice(0, 160)}${q.length > 160 ? "…" : ""} » : `;
      if (!input.value.startsWith(prefix)) input.value = prefix + input.value.replace(/^@\S+\s*/, "");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input"));
    }
    this.renderComposerContext();
    this._syncComposerTarget();
  },

  /** « En parler au chef » : retour au composer chef, projet nommé. */
  talkToChefAbout(name) {
    if (!name) return;
    this.composer.answerFor = { name, question: "", about: true };
    const input = $("#composer-input");
    if (input) {
      const prefix = `À propos de ${name} : `;
      if (!input.value.startsWith(prefix)) input.value = prefix + input.value.replace(/^@\S+\s*/, "");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input"));
    }
    this.renderComposerContext();
    this._syncComposerTarget();
  },

  renderComposerContext() {
    const el = $("#composer-context");
    if (!el) return;
    const ctx = this.composer.answerFor;
    if (!ctx) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML =
      `<span class="cc-label">${ctx.about ? "Au chef, à propos de" : "Réponse via le chef pour"} ${esc(ctx.name)}</span>` +
      (ctx.question ? `<span class="cc-quote">« ${esc(ctx.question.slice(0, 160))} »</span>` : `<span class="cc-quote"></span>`) +
      `<button class="cc-close" aria-label="Retirer le contexte">✕</button>`;
    $(".cc-close", el).addEventListener("click", () => {
      this.composer.answerFor = null;
      this.renderComposerContext();
    });
  },

  /** Défile jusqu'à la carte du panier d'un musicien et la surligne. La ligne
   *  de mission POINTE vers la carte, elle ne la duplique pas. */
  revealResultCard(name) {
    if (!name) return;
    const scroll = $("#cv-scroll");
    if (!scroll) return;
    const cards = $$(`.cv-result-card[data-name="${CSS.escape(name)}"]`, scroll);
    const card = cards[cards.length - 1];
    if (!card) { this.openMusician(name); return; }
    const det = card.closest("details.cv-results");
    if (det && !det.open) det.open = true;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.style.transition = "outline-color .8s";
    card.style.outline = "2px solid var(--st-think)";
    setTimeout(() => { card.style.outline = "2px solid transparent"; }, 1400);
  },

  /**
   * Called from Musician.transition() whenever the conductor project sees a
   * new event. We harvest its final assistant text on `result` turns and
   * append it as a conductor bubble.
   */
  /** Ensure a pending "reflection" entry exists at the tail of the chat
   *  array and return it. The reflection accumulates tool_use / thinking /
   *  assistant-text events emitted by the conductor between the user's
   *  prompt and its final `result` — surfacing why a dispatch took its
   *  time. Closed (frozen) when the turn emits `result`. */
  _ensureReflection() {
    const last = this.chat[this.chat.length - 1];
    if (last && last.role === "reflection" && !last.closed) return last;
    const entry = {
      role: "reflection", events: [], startTs: Date.now(), endTs: null, closed: false,
      ...(this._currentTurnTaking.length ? { taking: this._currentTurnTaking.slice() } : {}),
    };
    this._turnHadReflection = true;
    this.chat.push(entry);
    if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    return entry;
  },

  /** Arm the "le chef répond…" indicator and stamp when — only on PROOF of a
   *  real chef turn (a source-less user_prompt, or a system/init). Callbacks
   *  and @shortcuts carry a source and must NOT arm it. */
  _armConductorWait() {
    this._awaitingConductorResponse = true;
    this._awaitingSince = Date.now();
  },

  /** Disarm the indicator and close any still-open reflection bubble. Used by
   *  the result handler and by the PID-liveness safety net (P0-b). */
  _disarmConductorWait() {
    this._awaitingConductorResponse = false;
    this._awaitingSince = 0;
    for (let i = this.chat.length - 1; i >= 0; i--) {
      const e = this.chat[i];
      if (e.role !== "reflection") continue;
      if (!e.closed) { e.closed = true; e.endTs = Date.now(); }
      break;
    }
    // The turn is over (no producer) — never strand results in the basket.
    this._currentTurnTaking = [];
    this._turnHadReflection = false;
    this._turnIsReport = false;
    this._flushPendingResults();
  },

  /** True if a callback bubble with this exact text is already in the chat.
   *  Makes callback rendering idempotent: the musician_done notification and the
   *  relayed chef dispatch carry the same text, and reconnect/queue replays can
   *  repost an old one — all collapse to a single occurrence. */
  _callbackDup(text) {
    const k = chatKey(text);
    if (!k) return false;
    if (this._pendingResults.some(it => chatKey(it.text) === k)) return true;
    return this.chat.some(e =>
      (e.role === "callback" && chatKey(e.text) === k) ||
      (e.role === "results" && e.items.some(it => chatKey(it.text) === k))
    );
  },

  /** Build a result-card item from a musician coordination event (notification
   *  or the relayed sourced user_prompt). Pre-0.18 events carry no outcome
   *  fields — they degrade to a plain "done" card showing their raw text. */
  _makeResultItem(raw, txt, source) {
    return {
      source,
      // Un événement SANS champ `outcome` n'est pas un tour terminé : c'est un
      // /api/notify manuel (ou un log pré-0.18). On l'affiche « Information de
      // X », sans coche — on ne prétend pas qu'un tour s'est achevé.
      isInfo: !raw.outcome && raw.subtype !== "musician_done" && raw.subtype !== "musician_question",
      outcome: raw.outcome || (raw.subtype === "musician_question" ? "question" : "done"),
      summary: typeof raw.summary === "string" && raw.summary ? raw.summary : "",
      text: txt,
      durationMs: Number.isFinite(raw.duration_ms) ? raw.duration_ms : undefined,
      costUsd: Number.isFinite(raw.cost_usd) ? raw.cost_usd : undefined,
      awaitingChef: !!raw.awaitingChef,
      ts: Date.parse(raw.timestamp) || Date.now(),
    };
  },

  /** Route one musician result: held while the chef is mid-turn, otherwise
   *  appended to the trailing basket (merged if recent). */
  _fileResult(item) {
    this._resultsSinceChefTurn.push({ source: item.source, outcome: item.outcome });
    // La ligne de mission correspondante prend son issue et POINTE vers la
    // carte du panier — elle ne recopie jamais le contenu.
    this._closeMission(item);
    if (this._awaitingConductorResponse) { this._pendingResults.push(item); return; }
    this._appendResultGroup([item]);
  },

  _appendResultGroup(items) {
    if (!items.length) return;
    const last = this.chat[this.chat.length - 1];
    // Fusion dans le panier de queue seulement s'il appartient à la MÊME vague :
    // un résultat arrivé après le début d'un tour chef ouvre un NOUVEAU panier
    // (jamais ajouté rétroactivement à un panier que le chef a déjà traité).
    const sameWave = last && last.role === "results" &&
      (Date.now() - last.ts) < 60_000 &&
      (!this._lastTurnStartTs || last.ts >= this._lastTurnStartTs);
    if (sameWave) {
      last.items.push(...items);
      last.ts = Date.now();
      return;
    }
    this.chat.push({ role: "results", items: items.slice(), ts: Date.now() });
    if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
  },

  // ---------- Missions (P0-2) ----------
  //
  // Une ligne de mission n'existe QUE sur preuve : un `tool_use Bash` du chef
  // dont la commande contient `dispatch.mjs <X>`, X validé contre la flotte.
  // Sans ce signal, le musicien actif va dans « Activité de l'orchestre ».

  /** Ouvre (ou complète) le bloc MISSIONS du tour chef courant. */
  _openMission(name) {
    if (!name || !this.musicians.has(name) || name === this.composer.CONDUCTOR) return;
    let entry = this._currentMissions;
    if (!entry || this.chat.indexOf(entry) === -1) {
      entry = { role: "missions", items: [], ts: Date.now() };
      this._currentMissions = entry;
      this.chat.push(entry);
      if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    }
    if (entry.items.some(it => it.name === name && !it.outcome)) return;
    entry.items.push({ name, launchedAt: Date.now(), started: false, outcome: null });
  },

  /** Le musicien a réellement démarré (son propre system/init a été observé). */
  _markMissionStarted(name) {
    for (let i = this.chat.length - 1; i >= 0; i--) {
      const b = this.chat[i];
      if (b.role !== "missions") continue;
      const it = b.items.find(x => x.name === name && !x.outcome);
      if (it) { it.started = true; return; }
    }
  },

  /** Issue reçue : la mission ouverte la plus récente pour ce musicien la prend. */
  _closeMission(item) {
    for (let i = this.chat.length - 1; i >= 0; i--) {
      const b = this.chat[i];
      if (b.role !== "missions") continue;
      const it = b.items.find(x => x.name === item.source && !x.outcome);
      if (!it) continue;
      it.outcome = item.isInfo ? null : (item.outcome || "done");
      if (Number.isFinite(item.durationMs)) it.durationMs = item.durationMs;
      if (Number.isFinite(item.costUsd)) it.costUsd = item.costUsd;
      if (it.outcome) it.started = true;
      return;
    }
  },

  /** Observation d'un événement musicien (hors chef) — démarrage de mission. */
  noteMusicianEvent(m, raw) {
    if (!m || m.name === this.composer.CONDUCTOR) return;
    const isStart = (raw?.type === "system" && raw.subtype === "init") ||
                    (raw?.type === "user_prompt" && !raw.source);
    if (isStart) this._markMissionStarted(m.name);
  },

  _flushPendingResults() {
    if (!this._pendingResults.length) return;
    this._appendResultGroup(this._pendingResults.splice(0));
  },

  onConductorEvent(musician, raw) {
    if (raw?.type === "notification" &&
        (raw.subtype === "musician_done" || raw.subtype === "musician_question")) {
      const txt = String(raw.text || "").trim();
      const source = raw.source || null;
      // Dedup: skip if this callback is already shown (the relayed chef dispatch
      // carries the same text, and reconnect/queue replays can repeat it).
      if (txt && source && !this._callbackDup(txt)) {
        const item = this._makeResultItem(raw, txt, source);
        if (item.outcome === "question") {
          // Asking the USER — jumps the basket, it needs an answer now.
          this.chat.push({
            role: "question", source,
            text: item.summary || txt,
            ts: item.ts,
          });
          if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
        } else {
          this._fileResult(item);
        }
        this.showCallbackToast(source, txt);
        this.renderChat();
      }
      return;
    }
    if (raw?.type === "user_prompt") {
      const txt = stripReplyPrefixes(String(raw.text || "")).trim();
      if (txt) {
        let source = raw.source || null;
        // A source-less "[musician] Tour terminé…" is a relayed musician
        // callback, NOT a user message — attribute it to that musician.
        if (!source) {
          const rm = CALLBACK_RELAY_RE.exec(txt);
          if (rm) source = rm[1].trim();
        }
        // A "@musician" shortcut carries source="shortcut→X": it is the USER's
        // own message mirrored into the chef log for context — NOT a musician
        // callback (F5) and NOT a chef turn.
        const isShortcut = typeof source === "string" && source.startsWith("shortcut→");
        // source="wake" is the SERVER asking the chef to report on results the
        // user can already see as cards. Rendering it would duplicate the basket
        // and read like a message nobody sent. The chef's reply that follows
        // carries "prend en compte : A ✓ B ✕", which is the visible link.
        // v0.21.0 : on MÉMORISE l'origine (sans jamais l'afficher) pour que le
        // tour qui suit soit rendu comme un POINT SUR LES RÉSULTATS.
        if (source === "wake") { this._wakeObservedAt = Date.now(); return; }
        const last = this.chat[this.chat.length - 1];
        // 0.22.0 — un message mis en file part PLUS TARD : quand son écho
        // arrive, sa bulle locale n'est plus forcément la dernière (l'utilisateur
        // a pu en écrire d'autres entre-temps). Le ticket l'identifie sans
        // ambiguïté ; la comparaison de texte reste le repli pour l'historique
        // d'avant 0.22.0. Sans ça, deux messages d'affilée se dédoublaient.
        const byTicket = typeof raw.ticket === "string"
          ? this.chat.find(e => e.role === "user" && e.ticket === raw.ticket)
          : null;
        if (byTicket && Number.isFinite(raw.slot)) byTicket.slot = raw.slot;
        const isLocalEcho = !!byTicket || ((!source || isShortcut) && last && last.role === "user" && (
          last.text.trim() === txt ||
          (last._fullPrompt != null && last._fullPrompt.trim() === txt)
        ));
        if (!isLocalEcho) {
          const images = Array.isArray(raw.attachmentPaths) && raw.attachmentPaths.length
            ? raw.attachmentPaths.map(p => '/attachments/' + String(p).replace(/\\/g, '/').split('/').pop())
            : undefined;
          if (source && !isShortcut) {
            // Relayed musician callback — same routing as the notification:
            // into the results basket, never inline in an open chef turn.
            if (!this._callbackDup(txt)) {
              this._fileResult(this._makeResultItem(raw, txt, source));
              this.showCallbackToast(source, txt);
            }
          } else {
            // Real user message (or an @shortcut echo) — render as the user.
            this.chat.push({
              role: "user", text: txt, ts: Date.parse(raw.timestamp) || Date.now(),
              ...(images ? { images } : {}),
              ...(typeof raw.ticket === "string" ? { ticket: raw.ticket } : {}),
              ...(Number.isFinite(raw.slot) ? { slot: raw.slot } : {}),
            });
            if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
          }
        }
        // Arm "le chef répond…" ONLY on a real chef turn: a source-less
        // user_prompt. Callbacks and @shortcuts carry a source and never start a
        // chef turn; a real dispatch launched with --source arms via system/init.
        if (!source) this._armConductorWait();
      }
    } else if (raw?.type === "assistant") {
      // Mid-turn conductor activity. Feed the current reflection so the
      // user can watch what the chef is doing before the final reply.
      const blocks = raw.message?.content || [];
      const refl = this._ensureReflection();
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          // SIGNAL STRUCTURÉ : le chef dispatche ⇒ une ligne de mission naît
          // dans son tour. Le nom est validé contre la flotte, sinon rien.
          if (b.name === "Bash" && window.Salle) {
            for (const target of window.Salle.extractDispatches(b.input?.command)) {
              this._openMission(target);
            }
          }
          refl.events.push({
            kind: "tool",
            name: (b.name || "tool").toLowerCase(),
            preview: toolArgPreview(b),
            ts: Date.now(),
          });
        } else if (b?.type === "thinking") {
          const t = (b.thinking || "").trim();
          if (t) refl.events.push({ kind: "thinking", text: t.slice(0, 400), ts: Date.now() });
        } else if (b?.type === "text") {
          const t = (b.text || "").trim();
          if (t) refl.events.push({ kind: "text", text: t, ts: Date.now() });
        }
      }
    } else if (raw?.type === "user") {
      // Claude CLI emits tool_result blocks under type:"user" — surface a
      // condensed line so the user sees the tool's reply as well.
      const blocks = raw.message?.content || [];
      const refl = this._ensureReflection();
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const content = Array.isArray(b.content)
          ? b.content.map(c => c?.text ?? "").join("\n")
          : (b.content || "");
        const preview = String(content).trim().split("\n").slice(0, 4).join("\n").slice(0, 400);
        if (preview) refl.events.push({ kind: "result", text: preview, ts: Date.now() });
      }
    } else if (raw?.type === "system" && raw.subtype === "init") {
      // A real chef turn is starting. claude -p emits system/init even when the
      // dispatch was launched with --source (whose user_prompt carries a source
      // and therefore did NOT arm above) — so this is the reliable arm point.
      this._armConductorWait();
      // Everything that came back since the previous chef turn is what THIS turn
      // is answering about — show it as the turn's header.
      this._currentTurnTaking = this._resultsSinceChefTurn.splice(0);
      this._turnHadReflection = false;
      this._lastTurnStartTs = Date.now();
      // Un tour qui suit IMMÉDIATEMENT un réveil observé est un point sur les
      // résultats. Le drapeau est consommé ici, une seule fois (0.16.1 : le
      // wake sourcé n'arme rien, c'est system/init qui arme, comme avant).
      this._turnIsReport = !!this._wakeObservedAt && (Date.now() - this._wakeObservedAt) < 120000;
      this._wakeObservedAt = 0;
      this._currentMissions = null;      // nouveau tour ⇒ nouveau bloc MISSIONS
    } else if (raw?.type === "result") {
      // Chef finished — clear the waiting flag regardless of success/error.
      this._awaitingConductorResponse = false;
      this._awaitingSince = 0;
      const txt = (musician.lastAssistantText || "").trim();
      // Close the last still-open reflection (search BACKWARDS — a musician
      // callback may have been pushed after it, so it isn't always the tail) and
      // drop any reflection text event equal to the final answer. The chef's
      // reply is a consolidated assistant `text` block, which was recorded both
      // inside the reflection AND becomes the conductor bubble below → it showed
      // TWICE. The server history has no reflection, which is why a refresh
      // already looked correct; this makes the live view match it.
      for (let i = this.chat.length - 1; i >= 0; i--) {
        const e = this.chat[i];
        if (e.role !== "reflection") continue;
        if (!e.closed) { e.closed = true; e.endTs = Date.now(); }
        if (txt) e.events = e.events.filter(ev => !(ev.kind === "text" && (ev.text || "").trim() === txt));
        break;
      }
      if (!txt) { this._endChefTurn(); return this.renderChat(); }
      const last = this.chat[this.chat.length - 1];
      const usage = musician.lastTurnUsage;
      if (last && last.role === "conductor" && last.text.trim() === txt) {
        if (!last.usage && usage) last.usage = usage;
      } else {
        this.chat.push({
          role: "conductor", text: txt, ts: Date.now(), usage,
          // A chef reply ending on NEEDS_USER_INPUT is a QUESTION, not a report.
          ...(/^NEEDS_USER_INPUT:/m.test(txt) ? { question: true } : {}),
          // « ⚠ langue » : réponse reformulée dans la langue de discussion (0.51.0).
          ...(musician.lastLang ? { lang: musician.lastLang } : {}),
          // Réveil observé ⇒ « CHEF — POINT SUR LES RÉSULTATS ».
          ...(this._turnIsReport ? { report: true } : {}),
          // No reflection this turn → the "prend en compte" header belongs here.
          ...(!this._turnHadReflection && this._currentTurnTaking.length
            ? { taking: this._currentTurnTaking.slice() } : {}),
        });
        if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
        // Les lignes de mission de ce tour se lisent APRÈS la réponse du chef
        // (« je leur confie… » puis la liste), exactement comme la maquette.
        this._reorderMissionsAfterReply();
        // Réponse arrivée en direct (le SSE ne rejoue pas l'historique) :
        // lecture audio si l'utilisateur l'a demandée (0.35.0).
        const replyEntry = this.chat.findLast(e => e.role === "conductor" && e.text === txt);
        if (replyEntry) setTimeout(() => window.Tts?.onChefReply(this.chat.indexOf(replyEntry)), 0);
      }
      musician.markRead();
      this._endChefTurn();
    }
    this.renderChat();
  },

  /** Close a chef turn: the results that landed during it are released now, so
   *  they appear AFTER the reply instead of splitting it. */
  _endChefTurn() {
    this._currentTurnTaking = [];
    this._turnHadReflection = false;
    this._turnIsReport = false;
    this._flushPendingResults();
  },

  /** Replace le bloc MISSIONS du tour juste après la bulle du chef. */
  _reorderMissionsAfterReply() {
    const entry = this._currentMissions;
    if (!entry) return;
    const from = this.chat.indexOf(entry);
    if (from === -1) return;
    const last = this.chat.length - 1;
    if (from === last) return;
    this.chat.splice(from, 1);
    this.chat.push(entry);
  },

  showCallbackToast(source, text) {
    const toast = document.createElement("div");
    toast.className = "callback-toast";
    toast.innerHTML =
      `<span class="ct-source">${esc(source)}</span>` +
      `<span class="ct-text">${esc(text.length > 110 ? text.slice(0, 110) + "…" : text)}</span>`;
    toast.addEventListener("click", () => {
      toast.classList.remove("callback-toast--show");
      setTimeout(() => toast.remove(), 350);
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("callback-toast--show"));
    setTimeout(() => {
      toast.classList.remove("callback-toast--show");
      setTimeout(() => toast.remove(), 350);
    }, 7000);
  },

  // ---------- Refus d'autorisation traités (0.37.0) ----------
  /** Identifiants acquittés localement (serveur antérieur à 0.37.0). */
  localAckedDenials(name) {
    try { return (JSON.parse(localStorage.getItem("perm.acked") || "{}")[name] || []).map(String); } catch { return []; }
  },
  _storeLocalAck(name, ids) {
    try {
      const all = JSON.parse(localStorage.getItem("perm.acked") || "{}");
      all[name] = [...new Set([...(all[name] || []), ...ids])].slice(-300);
      localStorage.setItem("perm.acked", JSON.stringify(all));
    } catch { /* privé */ }
  },
  /** « Vu » ou outil accordé : le refus disparaît, ici et au rechargement. */
  async ackDenials(name, ids, { action = "seen", tool = null } = {}) {
    ids = (ids || []).filter(Boolean).map(String);
    if (!ids.length) return;
    const m = this.musicians.get(name);
    if (m) {
      ids.forEach(id => m.ackedDenials.add(id));
      m.pendingDenials = m.pendingDenials.filter(d => !m.ackedDenials.has(String(d.toolId)));
    }
    document.querySelectorAll(".perm-denial-toast").forEach(t => { if (ids.includes(t.dataset.toolId)) t.remove(); });
    window.Salle?.renderDive();
    try {
      const r = await fetch(`/api/project/${encodeURIComponent(name)}/denials/ack`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolIds: ids, action, tool, by: "utilisateur" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      // Serveur pas encore redémarré (route absente) : on garde la trace ici.
      this._storeLocalAck(name, ids);
    }
  },
  /** Outil accordé depuis un refus : settings.json + confiance (add-tool),
   *  puis le refus est acquitté — il ne revient pas. */
  async grantToolFromDenial(name, tool, toolIds) {
    const r = await fetch(`/api/project/${encodeURIComponent(name)}/add-tool`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const m = this.musicians.get(name);
    if (m && !window.PermissionDenial.toolAllowed(m.tools, tool)) m.tools = `${m.tools || ""},${tool}`.replace(/^,/, "");
    await this.ackDenials(name, toolIds, { action: "granted", tool });
  },

  /** Panneau de refus : toujours QUI (musicien), QUEL outil, QUEL appel, et
   *  QUOI FAIRE. Un refus incomplet n'est jamais annoncé (permission-denial.js). */
  showPermDenialToast(m, d) {
    if (!window.PermissionDenial?.isComplete(d)) return;
    if (m.ackedDenials?.has(String(d.toolId))) return;
    const toast = document.createElement("div");
    toast.className = "callback-toast perm-denial-toast";
    toast.dataset.toolId = String(d.toolId || "");
    const tLabel = esc(d.toolName);
    // 0.37.0 : seul un outil NON ACCORDÉ se règle en l'ajoutant. Les refus de
    // l'analyse du CLI (commande complexe) ou de chemin ne proposent jamais
    // « Autoriser » : ça ne changerait rien et le panneau reviendrait.
    const kind = window.PermissionDenial.enrich(d, m._systemDenials).kind;
    const toolMissing = kind === "tool";
    const todo = esc(window.PermissionDenial.KIND_TEXT[kind] || "");
    toast.innerHTML =
      `<span class="ct-source">🚫 ${esc(m.name)} — autorisation refusée : ${tLabel}</span>` +
      `<span class="ct-text">Appel bloqué : <code>${esc(d.preview)}</code>` +
      (d.reason ? `<br><small>${esc(d.reason)}</small>` : "") +
      `<br>Le musicien continue sans cet appel. ${todo}</span>` +
      `<div class="ct-actions">` +
      `<button class="ct-open-btn">Ouvrir ${esc(m.name)} →</button>` +
      (toolMissing ? `<button class="ct-add-btn" data-project="${esc(m.name)}" data-tool="${esc(d.toolName)}">+ Autoriser ${tLabel}</button>` : "") +
      `<button class="ct-ack-btn" title="Ne plus afficher ce refus">✓ Vu</button>` +
      (window.Permissions ? `<button class="ct-forever-btn" title="Créer une règle permanente : la prochaine fois, l'appel passera sans demande">Toujours autoriser à l'avenir</button>` : "") +
      `</div>`;
    const dismiss = () => {
      toast.classList.remove("callback-toast--show");
      setTimeout(() => toast.remove(), 350);
    };
    toast.querySelector(".ct-open-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      App.openFocused(m);
      dismiss();
    });
    toast.querySelector(".ct-add-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const { project, tool } = btn.dataset;
      btn.disabled = true; btn.textContent = "Ajout…";
      App.grantToolFromDenial(project, tool, [d.toolId])
        .then(() => dismiss())
        .catch(err => { btn.disabled = false; btn.textContent = `Erreur : ${err.message || err}`; });
    });
    toast.querySelector(".ct-ack-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      App.ackDenials(m.name, [d.toolId]);
      dismiss();
    });
    toast.querySelector(".ct-forever-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      window.Permissions?.openRuleDialog({ project: m.name, tool: d.toolName, input: d.input, toolIds: d.toolId ? [String(d.toolId)] : [] });
      dismiss();
    });
    toast.addEventListener("click", dismiss);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("callback-toast--show"));
    setTimeout(dismiss, 15000);
  },

  // Replace the bubble at idx with an inline textarea; submit dispatches
  // the corrected text as a new turn without pushing a duplicate bubble.
  startInlineEdit(scroll, idx) {
    const bubble = scroll.querySelector(`.cv-bubble[data-idx="${idx}"]`);
    if (!bubble || bubble.classList.contains("is-editing")) return;
    const body = bubble.querySelector(".cv-body");
    const originalText = this.chat[idx]?.text;
    if (originalText == null) return;

    bubble.classList.add("is-editing");
    // The reconciler skips nodes whose sig is unchanged; this edit mutates the
    // node's DOM directly, so invalidate its sig or a later reconcile (e.g. on
    // cancel) would leave the textarea in place instead of restoring the bubble.
    bubble.dataset.sig = "editing";
    body.innerHTML = `<textarea class="cv-edit-ta" rows="1"></textarea>
      <div class="cv-edit-actions">
        <button class="cv-edit-cancel">✕ annuler</button>
        <button class="cv-edit-send">↩ renvoyer</button>
      </div>`;

    const ta = body.querySelector(".cv-edit-ta");
    ta.value = originalText;
    // Auto-size to content.
    const resize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.addEventListener("input", resize);
    requestAnimationFrame(() => { resize(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });

    const cancel = () => this.renderChat();
    const send = async () => {
      const newText = ta.value.trim();
      if (!newText) return;
      this.chat[idx].text = newText;
      this.chat[idx].ts   = Date.now();
      this.renderChat();
      await this._dispatchEdit(newText);
    };

    body.querySelector(".cv-edit-cancel").addEventListener("click", cancel);
    body.querySelector(".cv-edit-send").addEventListener("click", send);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
  },

  async _dispatchEdit(text) {
    try {
      const resp = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: this.composer.CONDUCTOR, prompt: text }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
    } catch (err) {
      alert("Renvoi échoué : " + (err.message || err));
    }
  },

  async sendMessage() {
    const input = $("#composer-input");
    const msg = input.value.trim();
    const pendingImages = [...this.composer.images];
    if (!msg && !pendingImages.length) return;
    // Tout part au chef : c'est lui qui route. Un préfixe `@X` reste un envoi
    // direct EXPLICITE, géré par le raccourci serveur existant (pas de
    // `--callback` : aucun réveil, aucun point — l'UI le dit).
    const target = this.composer.CONDUCTOR;
    const isConductorMsg = true;

    // If the user is replying to a chef bubble, prepend a quoted reference
    // to the prompt so the chef sees exactly which prior message this is
    // about and can reuse the target it already identified (project name,
    // session, etc.) without the user having to repeat it.
    const reply = this.composer.replyingTo;
    const pendingVideos = pendingImages.filter(i => i.isVideo);
    const pendingImagesOnly = pendingImages.filter(i => !i.isVideo);
    // Attachment-only messages need a minimal prompt (claude -p requires non-empty).
    let prompt = msg || (pendingImages.length ? (pendingVideos.length && !pendingImagesOnly.length ? "Une vidéo est jointe." : "Décris cette image.") : "");
    let displayText = msg;
    if (reply && isConductorMsg) {
      const quoted = reply.text.split("\n").map(l => `> ${l}`).join("\n");
      prompt = `Je réponds à ton message précédent :\n${quoted}\n\n${prompt}`;
      displayText = msg;
    }

    // Snapshot attachments and clear the strip immediately — optimistic UX.
    const imageObjectUrls = pendingImagesOnly.map(i => i.objectUrl);
    const videoObjectUrls = pendingVideos.map(v => v.objectUrl);
    this.composer.images = [];
    this.renderComposerImages();

    if (isConductorMsg) {
      this.chat.push({
        role: "user",
        text: displayText,
        images: imageObjectUrls.length ? imageObjectUrls : undefined,
        videos: videoObjectUrls.length ? videoObjectUrls : undefined,
        _fullPrompt: prompt !== displayText ? prompt : undefined,
        ts: Date.now(),
        replyingTo: reply ? reply.text : null,
      });
      if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    }
    this.cancelReply();
    this.composer.answerFor = null;
    this.renderComposerContext();
    this.renderChat();
    input.disabled = true;
    try {
      // Upload images and videos to /api/attach/image (accepts both MIME families).
      const attachmentPaths = [];
      for (const img of pendingImagesOnly) {
        const up = await fetch("/api/attach/image", {
          method: "POST",
          headers: { "Content-Type": img.mediaType },
          body: img.blob,
        });
        if (!up.ok) {
          const d = await up.json().catch(() => ({}));
          throw new Error(`Upload image échoué : ${d.error || `HTTP ${up.status}`}`);
        }
        const { path: p } = await up.json();
        attachmentPaths.push(p);
        // objectUrl NOT revoked — chat bubble <img> still references it.
      }
      const videoPaths = [];
      for (const vid of pendingVideos) {
        const up = await fetch("/api/attach/image", {
          method: "POST",
          headers: { "Content-Type": vid.mediaType },
          body: vid.blob,
        });
        if (!up.ok) {
          const d = await up.json().catch(() => ({}));
          throw new Error(`Upload vidéo échoué : ${d.error || `HTTP ${up.status}`}`);
        }
        const { path: p } = await up.json();
        videoPaths.push(p);
        // objectUrl NOT revoked — chat bubble <video> still references it.
      }

      const payload = { project: target, prompt };
      if (attachmentPaths.length) payload.attachmentPaths = attachmentPaths;
      if (videoPaths.length) payload.videoPaths = videoPaths;
      // Pipeline selector (0.52.0): an explicit choice wins over classification.
      // It applies to this message only, then goes back to "auto".
      const pipeSel = $("#composer-pipeline");
      if (pipeSel && pipeSel.value !== "auto") {
        const [pipe, mode] = pipeSel.value.split(":");
        payload.pipeline = pipe;
        if (mode) payload.pipelineMode = mode;
        pipeSel.value = "auto";
      }

      const resp = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // File de direction (0.22.0) : le message a un TICKET. On l'attache à la
      // bulle locale pour que sa ligne de statut le suive (en file → pris →
      // répondu) ; on ne dit PAS « pris » ici — c'est le log du slot qui le dit.
      if (data.ticket && isConductorMsg) {
        for (let i = this.chat.length - 1; i >= 0; i--) {
          const e = this.chat[i];
          if (e.role !== "user") continue;
          e.ticket = data.ticket;
          break;
        }
        this.schedulePupitreHint();
        this.renderChat();
      }
      // Server routed the message directly (queued or bypassed the conductor).
      if (data.queued) {
        this.chat.push({
          role: "callback", source: "queue",
          text: `⏸ ${data.project} est occupé — message en file (position ${data.queueLength}). Sera transmis automatiquement à la fin de son tour.`,
          ts: Date.now(),
        });
        this.renderChat();
      }
      input.value = "";
      input.style.height = "auto";
      this.composer.hasDraft = false;
      $("#composer-send").disabled = true;
      this._syncComposerTarget();
    } catch (err) {
      // Échec d'envoi : le brouillon est CONSERVÉ (rien n'est perdu).
      this.showComposerError("Envoi échoué : " + (err.message || err));
    } finally {
      input.disabled = false;
      input.focus();
    }
  },

  // ---------- File de direction (0.22.0) ----------
  //
  // Deux gestes, tous deux explicites et réversibles côté utilisateur :
  // retirer un message qui attend (le brouillon revient dans le composer), ou
  // interrompre franchement le tour en cours. Aucun des deux n'est automatique.

  async withdrawTicket(id) {
    try {
      const resp = await fetch(`/api/pool/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // La bulle reste dans le fil, grisée : on ne réécrit pas l'histoire.
      for (const e of this.chat) if (e.role === "user" && e.ticket === id) e.withdrawn = true;
      // Rien n'est perdu : le brouillon repart dans le composer s'il est vide.
      const input = $("#composer-input");
      if (data.draft && input && !input.value.trim()) {
        input.value = data.draft;
        this.composer.hasDraft = true;
        const send = $("#composer-send");
        if (send) send.disabled = false;
        input.focus();
      }
      this.pollPupitre();
      this.renderChat();
    } catch (err) {
      this.showComposerError("Retrait impossible : " + (err.message || err));
    }
  },

  /** Acquitter la question d'un musicien SANS le relancer (0.25.0) : réponse
   *  déjà donnée via le chef, ou question devenue sans objet. Le serveur écrit
   *  l'événement dans le log du musicien ; son écho SSE fait basculer la carte. */
  async resolveQuestion(name) {
    const note = prompt(`Marquer la question de ${name} comme répondue.\n\nNote (facultative, visible dans son panneau) :`, "répondu via le chef");
    if (note === null) return;                      // annulé
    try {
      const resp = await fetch(`/api/question/${encodeURIComponent(name)}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, by: "utilisateur" }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      this.pollPupitre();
    } catch (err) {
      alert("Acquittement impossible : " + (err.message || err));
    }
  },

  /** « Vu » (0.31.0) : acquitte un échec, un arrêt par le chef ou un résultat
   *  en attente, sans relancer de tour. `auto` = acquitté par l'ouverture du
   *  volet (silencieux en cas de refus : rien à acquitter n'est pas une erreur). */
  async ackMusician(name, { auto = false } = {}) {
    const m = this.musicians.get(name);
    try {
      const resp = await fetch(`/api/ack/${encodeURIComponent(name)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "utilisateur", auto }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // L'événement de log arrive aussi par le SSE ; on n'attend pas pour
      // retirer la ligne de « À examiner ».
      if (m) {
        if (data.kind === "unread" || data.kind === "awaiting_chef") m.markRead();
        else if (m.state === "error") {
          m.awaitingChef = false;
          m.setState("idle");
          m.lastLine = data.kind === "stopped" ? "✓ arrêt marqué vu" : "✓ échec marqué vu";
        }
      }
      this.pollPupitre();
      window.Salle?.renderRail();
      window.Salle?.renderAttention();
      if (window.Salle?.diveName === name) window.Salle.renderDive();
    } catch (err) {
      if (!auto) alert("Impossible de marquer vu : " + (err.message || err));
    }
  },

  async interruptChef(slot = 1) {
    if (!confirm(`Interrompre le tour en cours du chef ${slot} ?\n\nLe travail non terminé de ce tour sera perdu ; le message suivant de la file démarrera aussitôt.`)) return;
    try {
      const resp = await fetch(`/api/pool/interrupt/${slot}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      this._disarmConductorWait();
      this.pollPupitre();
      this.renderChat();
    } catch (err) {
      this.showComposerError("Interruption impossible : " + (err.message || err));
    }
  },

  // ---------- Keyboard ----------
  wireKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeAllOverlays();
    });
  },

  // ---------- Tweaks ----------
  wireTweaks() {
    $$(".tweaks-seg", $("#tweaks")).forEach(seg => {
      const key = seg.dataset.tweak;
      $$("button", seg).forEach(btn => {
        btn.addEventListener("click", () => {
          $$("button", seg).forEach(b => b.classList.toggle("on", b === btn));
          const v = btn.dataset.v;
          if (key === "theme") document.body.dataset.theme = v;
          else if (key === "halo") document.documentElement.style.setProperty("--halo-intensity", v);
          else if (key === "provider") {
            fetch("/api/config/provider", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: v }),
            }).catch(() => {});
          }
        });
      });
    });
  },

  // ---------- Overlays wiring ----------
  wireOverlays() {
    for (const id of ["overlay-briefing", "overlay-add", "overlay-session"]) {
      const ov = document.getElementById(id);
      if (!ov) continue;
      ov.addEventListener("click", (e) => {
        if (e.target.classList.contains("overlay-scrim")) this.closeOverlay(ov);
      });
      $$(".pb-close, .pa-close, .ps-close", ov).forEach(b => {
        b.addEventListener("click", () => this.closeOverlay(ov));
      });
    }

    // add-project manual row
    $(".pa-manual-add", $("#overlay-add")).addEventListener("click", () => this.submitManualAdd());

    // Delegated handler for "add tool" buttons rendered inside permission-denied events.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".ev-perm-add-btn");
      if (!btn) return;
      const project = btn.dataset.project;
      const tool    = btn.dataset.tool;
      if (!project || !tool) return;
      btn.disabled = true;
      btn.textContent = "Ajout…";
      const ids = String(btn.dataset.toolIds || btn.dataset.toolId || "").split(",").filter(Boolean);
      this.grantToolFromDenial(project, tool, ids)
        .then(() => { btn.textContent = `✓ ${tool} ajouté`; })
        .catch(err => { btn.disabled = false; btn.textContent = `Erreur : ${err.message || err}`; });
    });

    // briefing — re-render live by itself, no special button
  },

  closeOverlay(ov) {
    if (ov) ov.hidden = true;
  },

  closeAllOverlays() {
    ["overlay-search", "overlay-briefing", "overlay-add", "overlay-session"]
      .forEach(id => this.closeOverlay(document.getElementById(id)));
  },

  // ---------- Focused musician view ----------
  //
  // The opened card is EXACTLY a /pupitre opened row: the shared drawer chrome
  // (.d-head name + telemetry meta + close · .d-body event stream · .d-foot pin
  // + count) driven by the SAME PupitreDetail renderer /pupitre uses, plus the
  // composer below to talk to the musician. No pf-head / pf-main / pf-tech.
  /** v0.21.0 — ouvrir un musicien = NAVIGUER vers `#/m/<projet>`. Le volet
   *  remplace le rail, le fil ne défile pas, `Échap` / ‹ = history.back(), et
   *  le bouton Retour du navigateur fonctionne (pile d'historique réelle). */
  openFocused(m) {
    if (!m) return;
    this.openMusician(m.name);
  },

  openMusician(name) {
    if (!name || !this.musicians.has(name)) return;
    // L'élément d'origine reprend le focus à la fermeture du volet (§3.3).
    if (window.Salle && document.activeElement && document.activeElement !== document.body) {
      window.Salle.returnFocus = document.activeElement;
    }
    window.Salle?.markInAppNavigation();
    const target = "#/m/" + encodeURIComponent(name);
    if (location.hash === target) window.Salle?.router();
    else location.hash = target;
  },

  // Fill the drawer head's telemetry meta line — byte-for-byte the same compact
  // string /pupitre's render() writes into its own d-meta, from the shared
  // /api/pupitre snapshot + PupitreRow helpers.
  /** La ligne de télémétrie du niveau 2 est rendue par Salle.renderDive() à
   *  partir des MÊMES champs `/api/pupitre` que `renderCardMeta` historique. */
  renderCardMeta() {
    window.Salle?.renderDive();
  },

  // ---------- Pupitre-parity live strip (focused card) ----------
  //
  // Reuses /api/pupitre (the same snapshot endpoint /pupitre polls) and
  // PupitreRow.rowHtml (the same renderer /pupitre uses) so the focused
  // card's telemetry — state, current activity, turn/silence timers, stall,
  // PID liveness, model/provider — can never diverge from a /pupitre row.
  // Cadence mirrors /pupitre exactly: 2.5s authoritative poll + an SSE hint
  // for a quick re-poll on new events, with the existing 1s heartbeat ticker
  // (updateHeartbeat) driving the smooth between-poll counter interpolation.
  startPupitrePoll() {
    if (this._pupitrePollTimer) return;
    this._pupitrePollTimer = setInterval(() => this.pollPupitre(), 2500);
    this.pollPupitre();
  },

  stopPupitrePoll() {
    if (this._pupitrePollTimer) { clearInterval(this._pupitrePollTimer); this._pupitrePollTimer = null; }
    if (this._pupitreHintTimer) { clearTimeout(this._pupitreHintTimer); this._pupitreHintTimer = null; }
  },

  // Debounced quick re-poll triggered by a live SSE event for the focused
  // musician — same 400ms debounce /pupitre uses for its own SSE hint.
  schedulePupitreHint() {
    if (this._pupitreHintTimer) return;
    this._pupitreHintTimer = setTimeout(() => { this._pupitreHintTimer = null; this.pollPupitre(); }, 400);
  },

  async pollPupitre() {
    try {
      const resp = await fetch("/api/pupitre", { headers: { Accept: "application/json" } });
      if (!resp.ok) { this._pollFailing = true; this.setConnState(); return; }
      this.pupitreSnapshot = await resp.json();
      this.pupitreRecvPerf = performance.now();
      this._pollOkAt = Date.now();
      this._pollFailing = false;
      this.setConnState();
      this.renderPupitreStrip();
      this.applyPupitreToCards();
    } catch {
      // Non-fatal — strip holds its last snapshot, but flag it as stale so the
      // UI stops implying the data is fresh (A5).
      this._pollFailing = true;
      this.setConnState();
    }
  },

  // Drive the topbar connection pill. Priority: SSE down (live feed lost) >
  // pupitre poll failing (telemetry stale) > ok. Called on SSE open/error and
  // on every poll outcome; `up` updates the cached SSE flag when provided.
  setConnState(up) {
    if (up !== undefined) this._sseUp = up;
    const el = document.getElementById("conn-status");
    if (!el) return;
    const dot = el.querySelector(".conn-dot");
    const txt = el.querySelector(".conn-text");
    // Quatre notions DISTINCTES (§6) : synchronisé · flux interrompu ·
    // données anciennes · sans progrès. Un SSE coupé avec un instantané frais
    // ne veut PAS dire que tout est mort : les états restent actualisés.
    let cls, label, title;
    if (this._sseUp === false && !this._pollFailing) {
      cls = "conn-stale"; label = "direct interrompu";
      title = "Flux temps réel perdu — les états restent actualisés par instantané ; reconnexion automatique";
    } else if (this._sseUp === false) {
      cls = "conn-lost"; label = "hors ligne";
      title = "Flux temps réel perdu ET télémétrie muette — dernières valeurs connues affichées";
    } else if (this._pollFailing) {
      cls = "conn-stale"; label = "données anciennes";
      title = "La télémétrie /api/pupitre ne répond pas — dernières valeurs connues affichées";
    } else {
      cls = "conn-ok"; label = "synchronisé"; title = "Flux temps réel connecté";
    }
    el.classList.remove("conn-ok", "conn-lost", "conn-stale");
    el.classList.add(cls);
    if (txt) txt.textContent = label;
    el.title = title;
    if (dot) { /* colour is CSS-driven via the class */ }
    window.Salle?.renderSysBanner();
  },

  // P0-b safety net: if "le chef répond…" has been armed for a while but the
  // chef has no live producer process, no `result` will ever arrive (missed
  // over an SSE gap, dispatch killed/crashed, spawn failed, no-failover exit) —
  // so drop the stale indicator. Fetches an authoritative /api/pupitre row for
  // the chef; the ordinary 2.5s pupitre poll does NOT run on the conductor pane,
  // which is exactly where this symptom shows. Fail-safe: only disarms on
  // POSITIVE evidence (pidAlive !== true); a live PID keeps waiting even if the
  // tool is silent, and a transient null just waits for the next tick.
  async _conductorLivenessCheck() {
    if (!this._awaitingConductorResponse) return;
    if (Date.now() - this._awaitingSince < 20000) return;
    let row;
    try {
      const resp = await fetch("/api/pupitre", { headers: { Accept: "application/json" } });
      if (!resp.ok) return;
      const snap = await resp.json();
      if (!snap || !Array.isArray(snap.fleet)) return;
      row = snap.fleet.find(r => r.name === this.composer.CONDUCTOR);
    } catch { return; /* transient — retry next tick */ }
    if (!row || row.pidAlive === true) return;
    // Re-check after the await: a result may have landed meanwhile.
    if (!this._awaitingConductorResponse || Date.now() - this._awaitingSince < 20000) return;
    this._disarmConductorWait();
    this.renderChat();
  },

  // Second card line from the authoritative /api/pupitre snapshot: PID liveness
  // and turn duration — signals the event-only reducer cannot derive. Values are
  // as-of the last poll (refreshed every 5s); no per-frame ticker.
  /** Le snapshot autoritaire alimente désormais le rail, la bande d'attention,
   *  le bandeau système et l'en-tête du volet — mêmes champs, mêmes cadences
   *  (5 s flotte / 2,5 s ciblé), aucun poll par ligne. */
  applyPupitreToCards() {
    const snap = this.pupitreSnapshot;
    if (!snap || !Array.isArray(snap.fleet)) return;
    const S = window.Salle;
    window.Projets?.applyUi(snap.ui); window.Activite?.applyUi(snap.ui); window.Tts?.applyUi(snap.ui); window.Models?.applyUi(snap.ui);
    window.Projets?.render();
    S?.renderRail();
    S?.renderAttention();
    S?.renderPoolBand();
    S?.renderSysBanner();
    this.syncChefCard(this.musicians.get(this.composer.CONDUCTOR) || null);
    if (S?.diveName) S.renderDive();
    // Le fil porte des lignes de mission vivantes : elles suivent le snapshot.
    this.renderMainPane();
  },

  // Quel musicien la télémétrie ciblée doit-elle suivre ? Le volet ouvert.
  pupitreTargetName() {
    return window.Salle?.diveName || null;
  },

  // Build the shared /pupitre row markup for one musician from the last
  // snapshot. Empty string when the snapshot lacks that musician.
  _pupitreRowHtml(name) {
    if (!this.pupitreSnapshot || !window.PupitreRow) return "";
    const row = this.pupitreSnapshot.fleet.find(r => r.name === name);
    if (!row) return "";
    const elapsed = performance.now() - this.pupitreRecvPerf;
    return window.PupitreRow.rowHtml(row, elapsed, { clickable: false });
  },

  // Start the /api/pupitre poll iff a single-musician view is open; stop it
  // otherwise. Idempotent — safe to call on every open/close/tab switch.
  ensurePupitrePoll() {
    if (this.pupitreTargetName()) this.startPupitrePoll();
    else this.stopPupitrePoll();
    this.renderPupitreStrip();
  },

  /** Le « strip » de télémétrie est devenu l'en-tête du volet musicien :
   *  mêmes champs, même instantané, une seule surface. */
  renderPupitreStrip() {
    if (window.Salle?.diveName) window.Salle.renderDive();
  },

  async hydrateMusicianRing(m) {
    try {
      const resp = await fetch(`/api/project/${encodeURIComponent(m.name)}/events?n=120`);
      if (!resp.ok) return;
      const events = await resp.json();
      if (!Array.isArray(events) || !events.length) return;
      // Replace the ring wholesale — the fetched list is authoritative and
      // already includes anything we streamed so far (same log file).
      m.ring = events;
      m.recomputeFromRing?.();
      if (window.Salle?.diveName === m.name) window.Salle.renderDive();
    } catch { /* non-fatal */ }
  },

  updateFocusedSessionChip() { /* le chip de session vit dans « Actions avancées » */ },

  /** v0.21.0 — le corps du musicien est rendu par le volet routé
   *  (`Salle.renderDive`), qui réutilise le MÊME PupitreDetail. Conservé en
   *  no-op gardé : des appelants historiques le visent encore (P2). */
  renderFocusedBody() {
    window.Salle?.renderDive();
  },

  /** Battement de coeur : le volet affiche l'activité et le tour depuis
   *  `/api/pupitre` (en-tête du volet), plus fiable que l'anneau local. */
  updateHeartbeat() { /* remplacé par l'en-tête du volet musicien */ },

  startHeartbeatTicker() {
    if (this._hbTimer) return;
    this._hbTimer = setInterval(() => {
      if (document.hidden) return;   // no counter repaint while the tab is hidden
      // Interpolation des compteurs tour/silence entre deux polls — même
      // cadence que /pupitre (setInterval(render, 1000)).
      this.renderPupitreStrip();
      window.Salle?.renderChefStatus(this.musicians.get(this.composer.CONDUCTOR) || null);
      window.Projets?.tick();
    }, 1000);
  },

  /** Envoi DIRECT à un musicien — action explicite, jamais implicite : elle
   *  n'est atteignable que par « Actions avancées » du volet ou par `@X`.
   *  Un envoi direct n'a PAS de `--callback` : aucun réveil, aucun point. */
  async sendDirectTo(name) {
    const m = this.musicians.get(name);
    if (!m) return;
    const busy = this.pupitreSnapshot?.fleet?.find(r => r.name === name)?.pidAlive === true;
    const txt = prompt(
      `Envoyer directement à ${name}` +
      (busy ? " (occupé — le message sera mis en file)" : "") +
      " — aucun retour au chef ne sera déclenché.",
      "");
    if (!txt || !txt.trim()) return;
    try {
      const resp = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: name, prompt: txt.trim() }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (data.queued) this.showCallbackToast("file", `${name} est occupé — message en file (position ${data.queueLength}).`);
    } catch (err) {
      this.showComposerError("Envoi direct échoué : " + (err.message || err));
    }
  },

  // ---------- Briefing ----------
  openBriefing() {
    const ov = $("#overlay-briefing");
    const body = $(".pb-body", ov);
    const musicians = [...this.musicians.values()];
    $(".pb-count", ov).textContent = musicians.length;
    // "À vérifier" = questions, results not yet read, failures, AND silently
    // stuck turns — an error must never be hidden behind a "new messages" count.
    const needsAttn = (m) => {
      if (m.state === "input" || m.state === "unread" || m.state === "error") return true;
      const inFlight = m.state === "live" || m.state === "think";
      const silentMs = m.lastActivityMs ? (Date.now() - m.lastActivityMs) : 0;
      return inFlight && silentMs > 30_000;   // sans progrès observé
    };
    const attn = musicians.filter(needsAttn).length;
    $(".pb-attn", ov).textContent = attn;

    body.innerHTML = musicians.map(m => `
      <div class="pb-row" data-name="${esc(m.name)}" style="--state-color: ${varByState(m.state)};">
        <span class="pb-dot"></span>
        <div class="pb-row-body">
          <div class="pb-row-head">
            <span class="pb-row-name">${esc(m.name)}</span>
            <span class="pb-row-state">${STATE_LABELS[m.state].label}</span>
          </div>
          <div class="pb-row-text">${esc(m.lastLine || "(rien de récent)")}</div>
        </div>
      </div>
    `).join("");
    $$(".pb-row", body).forEach(el => {
      el.addEventListener("click", () => {
        const m = this.musicians.get(el.dataset.name);
        this.closeOverlay(ov);
        if (m) this.openFocused(m);
      });
    });
    ov.hidden = false;
  },

  // ---------- Add project ----------
  async openAdd() {
    const ov = $("#overlay-add");
    const cands = $(".pa-candidates", ov);
    cands.innerHTML = `<div class="pa-cand-path">scan en cours…</div>`;
    ov.hidden = false;
    try {
      const resp = await fetch("/api/projects/candidates");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.candidates.length) {
        cands.innerHTML = `<div class="pa-cand-path">Aucun nouveau dossier sous ${esc(data.root)}.</div>`;
      } else {
        cands.innerHTML = data.candidates.map(c => `
          <button class="pa-cand" data-name="${esc(c.name)}" data-path="${esc(c.path)}">
            <span class="pa-cand-name">${esc(c.name)}</span>
            <span class="pa-cand-marks">${
              [c.hasGit && "git", c.hasClaudeMd && "CLAUDE.md", c.hasClaude && ".claude"]
                .filter(Boolean).join(" · ") || "—"
            }</span>
            <span class="pa-cand-path">${esc(c.path)}</span>
          </button>
        `).join("");
        $$(".pa-cand", cands).forEach(btn => {
          btn.addEventListener("click", () => this.submitAdd({
            name: btn.dataset.name, path: btn.dataset.path,
          }));
        });
      }
    } catch (err) {
      cands.innerHTML = `<div class="pa-cand-path" style="color: var(--st-input);">scan échoué : ${esc(err.message)}</div>`;
    }
  },

  async submitAdd(entry) {
    const isConductorBox = $(".pa-is-conductor", $("#overlay-add"));
    const isConductor = !!isConductorBox?.checked;
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, isConductor }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // If this project was promoted to conductor, the whole UI must rewire
      // around the new CONDUCTOR — simplest/safest: full reload.
      if (isConductor) {
        this.closeOverlay($("#overlay-add"));
        location.reload();
        return;
      }
      const m = new Musician(data.project);
      this.musicians.set(m.name, m);
      this.relayout();
      this.toggleEmptyHint();
      this.closeOverlay($("#overlay-add"));
      if (isConductorBox) isConductorBox.checked = false;
    } catch (err) {
      alert("Ajout échoué : " + (err.message || err));
    }
  },

  async submitManualAdd() {
    const ov = $("#overlay-add");
    const name = $(".pa-manual-name", ov).value.trim();
    const p    = $(".pa-manual-path", ov).value.trim();
    const err  = $(".pa-manual-err",  ov);
    if (!name || !p) {
      err.textContent = "nom et chemin requis";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    try {
      await this.submitAdd({ name, path: p });
      $(".pa-manual-name", ov).value = "";
      $(".pa-manual-path", ov).value = "";
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  },

  async removeProject(m) {
    if (!confirm(`Retirer "${m.name}" de l'orchestre ? (les logs sont gardés sur disque, l'entrée de config est supprimée.)`)) return;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(m.name)}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      m.el?.remove();
      this.musicians.delete(m.name);
      this.relayout();
      this.toggleEmptyHint();
    } catch (err) {
      alert("Suppression échouée : " + (err.message || err));
    }
  },

  // ---------- Session picker ----------
  async openSession(m) {
    const ov = $("#overlay-session");
    $(".ps-project", ov).textContent = m.name;
    $(".ps-path",    ov).textContent = "scan en cours…";
    $(".ps-attached", ov).textContent = m.attachedSession || "aucune";
    $(".ps-detach",  ov).hidden = !m.attachedSession;
    $(".ps-list",    ov).innerHTML = "";
    ov.hidden = false;
    ov.dataset.project = m.name;

    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(m.name)}/sessions`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      $(".ps-path", ov).textContent = `${data.projectPath}  ·  ${data.encodedDir}`;
      $(".ps-attached", ov).textContent = data.attached || "aucune";
      $(".ps-detach",   ov).hidden = !data.attached;

      const list = $(".ps-list", ov);
      if (!data.sessions.length) {
        list.innerHTML = `<div class="ps-row"><span class="ps-c-preview">Aucune session Claude pour ce cwd.</span></div>`;
      } else {
        list.innerHTML = data.sessions.map(s => `
          <button class="ps-row ${s.id === data.attached ? "current" : ""}" data-sid="${esc(s.id)}">
            <span class="ps-c-sid">${esc(s.id.slice(0, 8))}${s.live ? `<span class="ps-live-badge">● LIVE</span>` : ""}</span>
            <span class="ps-c-when">${esc(fmtRel(s.mtime))} ago</span>
            <span class="ps-c-branch">${esc(s.gitBranch || "—")} · ${esc(s.sizeHuman || "?")} · ${s.approxTurns || 0} turns</span>
            <span class="ps-c-preview">
              <span class="ps-c-first">start · ${esc(s.preview || "(vide)")}</span>
              ${s.lastMessage ? `<span class="ps-c-last">latest · ${esc(s.lastMessage)}</span>` : ""}
            </span>
          </button>
        `).join("");
        $$(".ps-row", list).forEach(row => {
          row.addEventListener("click", () => this.attachSession(m.name, row.dataset.sid));
        });
      }

      $(".ps-detach", ov).onclick = () => this.detachSession(m.name);
    } catch (err) {
      $(".ps-path", ov).textContent = "échec : " + err.message;
    }
  },

  async attachSession(project, sid) {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const m = this.musicians.get(project);
      if (m) { m.attachedSession = sid; this.updateFocusedSessionChip(m); }
      this.closeOverlay($("#overlay-session"));
    } catch (err) {
      alert("Attach échoué : " + (err.message || err));
    }
  },

  async detachSession(project) {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/attach`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const m = this.musicians.get(project);
      if (m) { m.attachedSession = null; this.updateFocusedSessionChip(m); }
      this.closeOverlay($("#overlay-session"));
    } catch (err) {
      alert("Detach échoué : " + (err.message || err));
    }
  },
};

// --------------------------------------------------------------------------
// Event renderers (inside focused musician view)
// --------------------------------------------------------------------------

// Main zone: user-facing content — prompts, assistant prose, turn summaries.
// Build a map of tool_use_id → tool_name from the assistant events in a ring.
/** tool_use_id → {name, input} sur l'anneau : l'aperçu d'un refus en a besoin. */
function buildToolUseMap(ring) {
  const map = {};
  for (const ev of ring || []) {
    if (ev?.type !== "assistant") continue;
    for (const b of ev.message?.content || []) {
      if (b?.type === "tool_use" && b.id && b.name) map[b.id] = { name: b.name, input: b.input };
    }
  }
  return map;
}

function buildToolNameMap(ring) {
  const m = {};
  for (const ev of ring) {
    if (ev.type !== "assistant") continue;
    for (const b of ev.message?.content || []) {
      if (b?.type === "tool_use" && b.id && b.name) m[b.id] = b.name;
    }
  }
  return m;
}

function renderFocusedEventMain(raw, projectName, toolNames) {
  const ts = fmtTs(raw.timestamp);
  switch (raw.type) {
    case "user_prompt": {
      const badge = raw.source ? esc(raw.source) : "TOI";
      const callbackCls = raw.source ? " ev-prompt-callback" : "";
      return `<div class="ev ev-prompt${callbackCls}"><span class="ev-ts">${ts}</span><span class="ev-prompt-badge">${badge}</span><div class="ev-text md">${mdToHtml(raw.text || "")}</div></div>`;
    }
    case "assistant":
      return renderAssistantMain(raw, ts);
    case "result":
      return renderResult(raw, ts);
    case "user": {
      // Refus d'autorisation : vrai refus du CLI seulement (permission-denial.js).
      // `toolNames` : id → {name, input} (buildToolUseMap).
      const uses = toolNames && typeof toolNames === "object" ? toolNames : {};
      const d = (window.PermissionDenial?.denialsFromUserEvent(raw, uses) || [])[0];
      if (!d) return "";
      const btn = projectName && window.PermissionDenial.classify(d) === "tool"
        ? `<br><button class="ev-perm-add-btn" data-project="${esc(projectName)}" data-tool="${esc(d.toolName)}" data-tool-id="${esc(d.toolId || "")}">+ Ajouter ${esc(d.toolName)} aux outils</button>`
        : "";
      return `<div class="ev ev-perm-denied"><span class="ev-ts">${ts}</span>🚫 <strong>Autorisation refusée</strong> — <code>${esc(d.toolName)}</code> : <code>${esc(d.preview)}</code>${btn}</div>`;
    }
    default:
      return "";
  }
}
// Tech zone: tool calls and results — secondary, collapsible at bottom.
function renderFocusedEventTech(raw) {
  const ts = fmtTs(raw.timestamp);
  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") return `<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text">— nouveau tour (session ${esc((raw.session_id||"").slice(0,8))}) —</span></div>`;
      return "";
    case "assistant":
      return renderAssistantTech(raw, ts);
    case "user":
      return renderUser(raw, ts);
    default:
      return "";
  }
}
function renderAssistantMain(raw, ts) {
  const parts = [];
  for (const b of raw.message?.content || []) {
    if (b?.type === "text") {
      const text = (b.text || "").trim();
      if (text) parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><div class="ev-text md">${mdToHtml(text)}</div></div>`);
    } else if (b?.type === "thinking") {
      const t = (b.thinking || "").trim();
      if (t) parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><div class="ev-think">◌ ${esc(t)}</div></div>`);
    } else if (b?.type === "tool_use") {
      // Show tool-use prominently in the main zone so the user sees what Claude is doing.
      const preview = toolArgPreview(b);
      parts.push(`<div class="ev ev-tool-action"><span class="ev-ts">${ts}</span><span class="ev-tool-badge">⚙ ${esc((b.name||"outil").toLowerCase())}</span>${preview ? `<span class="ev-tool-preview">${esc(preview)}</span>` : ""}</div>`);
    }
  }
  return parts.join("");
}
function renderAssistantTech(raw, ts) {
  const parts = [];
  for (const b of raw.message?.content || []) {
    if (b?.type === "tool_use") {
      parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-tool">▸ ${esc((b.name||"TOOL").toLowerCase())}</span> <span class="ev-text">${esc(toolArgPreview(b))}</span></div>`);
    }
  }
  return parts.join("");
}
function renderUser(raw, ts) {
  const parts = [];
  for (const b of raw.message?.content || []) {
    if (b?.type === "tool_result") {
      const content = Array.isArray(b.content)
        ? b.content.map(c => c.text ?? "").join("\n")
        : (b.content || "");
      const trimmed = String(content).trim().split("\n").slice(0, 8).join("\n");
      parts.push(`<div class="ev-res">${esc(trimmed || "(vide)")}</div>`);
    }
  }
  return parts.join("");
}
function renderResult(raw, ts) {
  const isErr = !!raw.is_error || (typeof raw.subtype === "string" && raw.subtype.startsWith("error"));
  if (isErr) return `<div class="ev-err">FAIL · ${esc(raw.subtype || "erreur")}</div>`;
  const dur = raw.duration_ms ? `${(raw.duration_ms/1000).toFixed(1)}s` : "";
  const u = raw.usage || {};
  const mu = raw.modelUsage ? Object.values(raw.modelUsage)[0] : null;
  const chip = fmtTurnUsage({
    inTok: +u.input_tokens || 0,
    outTok: +u.output_tokens || 0,
    cacheRead: +u.cache_read_input_tokens || 0,
    cacheCreate: +u.cache_creation_input_tokens || 0,
    cost: +raw.total_cost_usd || 0,
    ctxUsed: (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0) + (+u.cache_creation_input_tokens || 0),
    ctxMax: mu?.contextWindow || 0,
  });
  const parts = ["— tour terminé", dur];
  if (chip) parts.push(chip);
  return `<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text" style="color: var(--fg-1);">${parts.filter(Boolean).join(" · ")} —</span></div>`;
}
// --------------------------------------------------------------------------
// Minimal, safe Markdown → HTML converter. We escape HTML first, then only
// inject tags we produce ourselves (no raw HTML from the model). Covers the
// constructs Claude emits most often: headings, bold/italic, inline code,
// fenced blocks, lists, blockquotes, paragraphs, links (rendered but not
// clickable — href sanitised). Intentionally does NOT handle tables or
// reference-style links (rare in Claude's prose).
// --------------------------------------------------------------------------
function mdToHtml(src) {
  if (!src) return "";
  // 1. Extract fenced code blocks into placeholders, then escape everything
  //    else. This protects code-block contents from further regex passes.
  const fences = [];
  let s = String(src).replace(/```([a-zA-Z0-9+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `\u0000F${fences.length}\u0000`;
    fences.push({ lang: (lang || "").toLowerCase(), code });
    return token;
  });
  s = esc(s);

  // 2. Inline code — single backticks. Use a non-greedy match.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);

  // 3. Bold / italic. Bold-underscore first, then bold-star, then italics.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");

  // 4. Links — [text](url). We only allow http(s) and relative; render
  //    as plain <a> with target=_blank rel=noopener to keep the dashboard
  //    stable if the user ever clicks.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const safe = /^(https?:\/\/|\/|#)/.test(url) ? url : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 4b. Autolink BARE http(s) URLs the chef writes in plain text. Guard the
  //     spans we must not touch — the <a>…</a> just produced above and any
  //     <code>…</code> (inline code) — with placeholders so we never double-link
  //     or linkify inside code, then restore them. Scheme is required (we do NOT
  //     autolink host:port like "myhost:7777" — too many false positives).
  const linkGuards = [];
  const guard = (html) => { const t = `@@LNK${linkGuards.length}@@`; linkGuards.push(html); return t; };
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, guard);
  s = s.replace(/<code>[\s\S]*?<\/code>/g, guard);
  s = s.replace(/https?:\/\/[^\s<]+/g, (url) => {
    // Keep trailing punctuation (.,;:!?)]) out of the link.
    const mt = url.match(/^([\s\S]*?)([.,;:!?)\]]*)$/);
    const link = mt[1], trail = mt[2] || "";
    if (!link) return url;
    const safe = link.replace(/"/g, "%22");
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${link}</a>${trail}`;
  });
  s = s.replace(/@@LNK(\d+)@@/g, (_, i) => linkGuards[+i]);

  // 5. Block-level pass line by line: headings, lists, blockquotes,
  //    paragraphs, horizontal rules. Code-fence placeholders are kept
  //    outside paragraphs.
  const lines = s.split("\n");
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join(" ")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw;
    if (!line.trim()) { flushPara(); closeList(); continue; }

    // Fenced code placeholder — emit as <pre><code> with language class.
    const fenceMatch = line.match(/^\u0000F(\d+)\u0000$/);
    if (fenceMatch) {
      flushPara(); closeList();
      const f = fences[+fenceMatch[1]];
      const cls = f.lang ? ` class="lang-${esc(f.lang)}"` : "";
      out.push(`<pre><code${cls}>${esc(f.code)}</code></pre>`);
      continue;
    }

    // Heading #..######
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara(); closeList();
      out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`);
      continue;
    }

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(); closeList();
      out.push(`<hr>`);
      continue;
    }

    // Blockquote
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      flushPara(); closeList();
      out.push(`<blockquote>${bq[1] || ""}</blockquote>`);
      continue;
    }

    // GFM table — header row + separator row + zero or more body rows.
    if (/^\s*\|.*\|?\s*$/.test(line) && li + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[li + 1])) {
      flushPara(); closeList();
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const header = splitRow(lines[li]);
      let end = li + 1;
      while (end + 1 < lines.length && /^\s*\|.*\|?\s*$/.test(lines[end + 1])) end++;
      const bodyRows = [];
      for (let k = li + 2; k <= end; k++) bodyRows.push(splitRow(lines[k]));
      let html = `<table><thead><tr>${header.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>`;
      for (const row of bodyRows) html += `<tr>${row.map(c => `<td>${c}</td>`).join("")}</tr>`;
      html += `</tbody></table>`;
      out.push(html);
      li = end;
      continue;
    }

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") { closeList(); out.push(`<ul>`); listType = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") { closeList(); out.push(`<ol>`); listType = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }

    // Paragraph accumulation
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = String(s % 60).padStart(2, "0");
  if (m < 60) return `${m}m${rs}`;
  const h = Math.floor(m / 60);
  const rm = String(m % 60).padStart(2, "0");
  return `${h}h${rm}`;
}

function fmtTok(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n/1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
function fmtCost(usd) {
  if (!usd) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
/** Per-turn token/cost chip used in "— tour terminé —" and the conductor bubble.
 *  Format: ↓{input+cache} ↑{out} · $cost  (omits the $ if 0) */
function fmtTurnUsage(u) {
  if (!u) return "";
  const inSum = (u.inTok || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
  const parts = [];
  if (inSum)   parts.push(`↓${fmtTok(inSum)}`);
  if (u.outTok) parts.push(`↑${fmtTok(u.outTok)}`);
  if (u.cost)  parts.push(fmtCost(u.cost));
  if (u.ctxMax) {
    const pct = Math.round((u.ctxUsed / u.ctxMax) * 100);
    if (pct > 0) parts.push(`${pct}% ctx`);
  }
  return parts.join(" · ");
}

function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

function fmtChatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  if (isToday) return hm;
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${hm}`;
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => App.init());
window.App = App;
