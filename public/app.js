/* ============================================================
   ORCHESTRE — client runtime
   Vanilla JS, single aggregate SSE, ring buffer per musician.
   ============================================================ */

"use strict";

// --------------------------------------------------------------------------
// Constants & small helpers
// --------------------------------------------------------------------------

const RING_MAX = 30;              // per-musician event buffer
const CARD_MIN_W = 110;
const CARD_MAX_W = 150;
const CARD_H     = 76;
const GAP_MIN    = 18;            // minimum horizontal gap between card centers
const ROW_GAP    = 14;            // min vertical breathing room between rows
const ARC_AMP    = 10;            // how far a card's Y is perturbed by the arc shape
const ROW_STEP   = CARD_H + ROW_GAP + 2 * ARC_AMP;  // guaranteed non-overlap
const TOP_PAD    = 96;            // room for topbar
const BOTTOM_PAD = 240;           // room for composer
const SIDE_PAD   = 40;
const STRIP_H    = 220;           // fan strip band height on desktop (below conductor view)

const STATE_LABELS = {
  idle:   { label: "AU REPOS",              icon: "○" },
  live:   { label: "EN COMMUNICATION",      icon: "●" },
  think:  { label: "RÉFLEXION",             icon: "◌" },
  input:  { label: "ATTEND TA RÉPONSE",     icon: "!" },
  unread: { label: "NOUVEAUX MESSAGES",     icon: "✉" },
};

// Claude Code's interactive UI draws lots of noise via box-drawing + cursor
// jumps. We filter lines that are pure decoration when displayed in focus
// view.
const DECOR_RE = /^[\s_\-=·›»▶▸…\u2010-\u2027\u2030-\u205F\u2190-\u21FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2800-\u28FF]*$/;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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
    this.model = project.model;
    this.tools = project.tools;
    this.attachedSession = project.attachedSession || null;

    this.state = "idle";                 // idle | live | think | input | unread
    this.lastLine = "";                  // cached preview for the arc card
    this.lastAssistantText = "";         // last assistant text (for NEEDS_USER_INPUT detection)
    this.unreadCount = 0;                // events since last focused-view open
    // Last-read marker (ISO timestamp). Comes from the server at
    // /api/config (logs/<name>.read) and is updated by markRead() via
    // POST /api/mark-read so unread state survives reloads.
    this.readAt = project.readAt || null;
    this.lastActivityMs = 0;
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
  }

  push(ev) {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this.lastActivityMs = Date.now();
    this.freq = Math.min(100, this.freq * 0.98 + 1); // decays + adds
  }

  transition(raw) {
    // Reducer: one stream-json event → possible state change + lastLine update.
    this.push(raw);

    const t = raw.type;
    if (t === "user_prompt") {
      // The orchestrator's prompt, injected synthetically by dispatch.mjs.
      this.turnStartMs = Date.parse(raw.timestamp) || Date.now();
      this.setState(this.state === "idle" || this.state === "unread" ? "live" : this.state);
      this.lastLine = String(raw.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
    } else if (t === "system") {
      if (raw.subtype === "init") {
        this.turnCount++;
        this.turnStartMs = Date.parse(raw.timestamp) || Date.now();
        this.setState(this.state === "idle" || this.state === "unread" ? "live" : this.state);
      }
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
        if (b?.type === "tool_use") { hasTool = true; this.lastLine = `${(b.name || "TOOL").toLowerCase()} · ${toolArgPreview(b)}`; }
      }
      if (gotText) {
        this.lastAssistantText = gotText;
        this.lastLine = gotText.replace(/\s+/g, " ").trim().slice(0, 140);
      }
      this.setState(hasTool ? "live" : (hasThink ? "think" : "live"));
    } else if (t === "user") {
      // Tool result comes back — keep current state
    } else if (t === "result") {
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
      if (isErr && raw.synthetic) {
        // Synthetic interrupts (orchestrator restart / child crash) — no question was asked.
        this.lastLine = raw.subtype || "interrompu";
        this.setState("idle");
      } else if (isErr) {
        this.lastLine = raw.subtype || "échec du tour";
        this.setState("input");              // real error — needs attention
      } else if (needs) {
        this.lastLine = needs[1].trim().slice(0, 140);
        this.setState("input");
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
        <div class="m-last-line m-last-empty">en attente…</div>
        <div class="m-state-row">
          <span class="m-state-icon">○</span>
          <span class="m-state-label">AU REPOS</span>
        </div>
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
    $(".m-state-icon",  this.el).textContent = label.icon;
    const baseLabel = this.unreadCount > 1 && this.state === "unread"
      ? `${this.unreadCount} ${label.label}`
      : label.label;
    $(".m-state-label", this.el).textContent = stale
      ? `${baseLabel} · silence ${formatElapsed(silentMs)}`
      : baseLabel;

    const lastEl = $(".m-last-line", this.el);
    if (this.lastLine) {
      lastEl.classList.remove("m-last-empty");
      lastEl.textContent = this.lastLine;
    } else {
      lastEl.classList.add("m-last-empty");
      lastEl.textContent = "en attente…";
    }

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

// --------------------------------------------------------------------------
// Arc layout — multi-row, non-overlapping, apex = highest-freq
// --------------------------------------------------------------------------

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = () => window.innerWidth < MOBILE_BREAKPOINT;

function computeLayout(musicians, viewport) {
  if (viewport.w < MOBILE_BREAKPOINT) return computeFanLayout(musicians, viewport);
  return computeDesktopArc(musicians, viewport);
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

  const sorted = [...musicians].sort((a, b) => b.freq - a.freq);
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

  // Sort by frequency so the apex gets the most-active musician.
  const sorted = [...musicians].sort((a, b) => b.freq - a.freq);

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
  const svg = $("#threads");
  svg.innerHTML = "";
  // Threads only make sense on desktop — the mobile view has no fan.
  if (isMobileViewport()) return;

  const composerCenter = {
    x: window.innerWidth / 2,
    y: window.innerHeight - 55, // roughly the top of the composer
  };
  const CONDUCTOR = App.composer.CONDUCTOR;
  const conductor = App.musicians.get(CONDUCTOR);
  // Anchor for chef↔musicien threads — the conductor card's top. Falls back
  // to the composer when the conductor card isn't laid out yet.
  const conductorAnchor = (conductor && conductor.pos)
    ? { x: conductor.pos.x, y: conductor.pos.y - CARD_H / 2 }
    : composerCenter;

  const addPath = (from, to, className, color) => {
    const mid = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - 80,
    };
    const d = `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", className);
    path.style.color = color;
    path.style.stroke = "currentColor";
    svg.appendChild(path);
  };

  // Chef ↔ musicien — drawn from the conductor card down/out to each active
  // musician. This visually mirrors the fact that the conductor delegates
  // work; the user's own line goes to the conductor, not the musicians.
  for (const m of App.musicians.values()) {
    if (!m.el || !m.pos) continue;
    if (m.name === CONDUCTOR) continue;
    if (!["live", "think", "input"].includes(m.state)) continue;
    const to = { x: m.pos.x, y: m.pos.y + CARD_H / 2 };
    addPath(conductorAnchor, to, "active", varByState(m.state));
  }

  // Utilisateur ↔ chef d'orchestre. Active whenever the conductor is busy;
  // pending (dashed, pulsing faster) whenever the user has a draft in flight.
  if (conductor && conductor.pos) {
    const to = { x: conductor.pos.x, y: conductor.pos.y + CARD_H / 2 };
    if (["live", "think", "input"].includes(conductor.state)) {
      addPath(composerCenter, to, "active", varByState(conductor.state));
    }
    if (App.composer.hasDraft) {
      addPath(composerCenter, to, "pending", "var(--accent)");
    }
  }
}

function varByState(state) {
  return {
    idle: "var(--st-idle)", live: "var(--st-live)", think: "var(--st-think)",
    input: "var(--st-input)", unread: "var(--st-unread)",
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
    this.source.onmessage = (ev) => {
      let env; try { env = JSON.parse(ev.data); } catch { return; }
      const m = App.musicians.get(env.project);
      if (!m) return;
      let raw; try { raw = JSON.parse(env.line); } catch { return; }
      m.transition(raw);
      m.updateCard();
      if (App.focused === m) { App.renderFocusedBody(); App.updateFocusedUsage(m); }
      if (m.name === App.composer.CONDUCTOR) App.onConductorEvent(m, raw);
      // Mobile tabs + session body need to re-render on every event so
      // priority order and live streams stay in sync.
      App.renderTabs();
      if (isMobileViewport() && App.activeTab === m.name && m.name !== App.composer.CONDUCTOR) {
        App.renderMainPane();
      }
    };
    this.source.onerror = () => { /* browser auto-reconnects */ };
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
  composer: {
    target: "orchestrateur",      // the conductor — every typed message goes here
    CONDUCTOR: "orchestrateur",   // name of the conductor project (special routing)
    hasDraft: false,
  },
  _reorderTimer: null,
  deckOffset: 0,                  // mobile: how many times the user swiped
  // Conductor transcript — user's messages + conductor's synthesised replies.
  // Each entry: { role: "user"|"conductor", text, ts }.
  chat: [],
  // Mobile only: which project the user is currently viewing in the main
  // pane. Defaults to the conductor. When != conductor, the body shows the
  // project's event stream and the composer dispatches there.
  activeTab: "orchestrateur",

  async init() {
    this.wireTopbar();
    this.wireComposer();
    this.wireKeyboard();
    this.wireTweaks();
    this.wireOverlays();
    this.wireFanSwipe();
    window.addEventListener("resize", () => { this.relayout(); this.renderChat(); });

    await this.loadConfig();
    this.stream = new FleetStream();

    // Periodic freq decay + layout re-sort to surface recently-active musicians.
    setInterval(() => {
      for (const m of this.musicians.values()) m.freq *= 0.98;
      this.reorderSoon();
    }, 5000);

    // Periodic thread refresh (handles idle timers)
    setInterval(() => redrawThreads(), 1000);

    // 1s heartbeat ticker — updates the "in-flight" banner in the focused
    // panel so the user sees elapsed time and a sign of life even when the
    // sub-agent's stream is quiet between tool calls.
    this.startHeartbeatTicker();

    // 5s staleness ticker — refreshes each musician card so the
    // "silence Xs" indicator updates without waiting for new events.
    setInterval(() => {
      for (const m of this.musicians.values()) m.updateCard();
      this.renderTabs();
    }, 5000);
  },

  async loadConfig() {
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) throw new Error(`config ${resp.status}`);
      const cfg = await resp.json();
      this.renderFleet(cfg.projects || []);
    } catch (err) {
      console.error("[app] config fetch failed", err);
      $("#empty-hint").hidden = false;
      $(".empty-title", $("#empty-hint")).textContent = "Erreur de chargement";
      $(".empty-sub",   $("#empty-hint")).textContent = err.message;
    }
  },

  renderFleet(projects) {
    const arc = $("#arc");
    arc.innerHTML = "";
    this.musicians.clear();
    for (const p of projects) {
      const m = new Musician(p);
      this.musicians.set(p.name, m);
      arc.appendChild(m.buildCard());
    }
    this.relayout();
    this.toggleEmptyHint();
    this.renderChat();
  },

  toggleEmptyHint() {
    $("#empty-hint").hidden = this.musicians.size > 0;
  },

  relayout() {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const list = [...this.musicians.values()];
    if (!list.length) return redrawThreads();
    computeLayout(list, viewport);
    for (const m of list) m.updateCard();
    redrawThreads();
  },

  reorderSoon() {
    clearTimeout(this._reorderTimer);
    this._reorderTimer = setTimeout(() => this.relayout(), 250);
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
    $("#btn-add").addEventListener("click", () => this.openAdd());
    $("#btn-briefing").addEventListener("click", () => this.openBriefing());
    $("#btn-tweaks").addEventListener("click", () => $("#tweaks").hidden = !$("#tweaks").hidden);
  },

  // ---------- Composer wiring ----------
  wireComposer() {
    const input = $("#composer-input");
    const send = $("#composer-send");

    const setDraft = () => {
      const has = input.value.trim().length > 0;
      send.disabled = !has;
      this.composer.hasDraft = has;
      redrawThreads();
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
      const needsSpace = !(after.startsWith(" ") || after.startsWith("\n") || after === "");
      const insertion = `@${pick.n}${needsSpace ? " " : ""}`;
      input.value = before + insertion + after;
      const newCaret = (before + insertion).length;
      input.setSelectionRange(newCaret, newCaret);
      closeMention();
      setDraft();
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
  },

  // ---------- Conductor transcript ----------
  renderChat() {
    // Always refresh the tab bar + main pane in tandem; both depend on
    // activeTab + musician states.
    this.renderTabs();
    this.renderMainPane();
  },

  renderMainPane() {
    const scroll = $("#cv-scroll");
    if (!scroll) return;
    const activeIsConductor = this.activeTab === this.composer.CONDUCTOR;
    scroll.classList.toggle("cv-session", !activeIsConductor);

    if (!activeIsConductor) {
      const m = this.musicians.get(this.activeTab);
      if (!m || !m.ring.length) {
        scroll.innerHTML = `<div class="cv-empty">
          <div class="cv-empty-title">${esc(this.activeTab)}</div>
          <div class="cv-empty-sub">Aucun événement. Écris un message pour démarrer un tour direct.</div>
        </div>`;
        return;
      }
      scroll.innerHTML = m.ring.map(raw => renderFocusedEvent(raw)).join("");
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
      return;
    }

    if (!this.chat.length) {
      scroll.innerHTML = `
        <div class="cv-empty">
          <div class="cv-empty-title">Salle de direction</div>
          <div class="cv-empty-sub">Parle au chef. Il délègue aux musiciens et te rapporte la synthèse.</div>
        </div>`;
      return;
    }
    const conductor = this.musicians.get(this.composer.CONDUCTOR);
    const isWaitingConductor = conductor &&
      (conductor.state === "live" || conductor.state === "think") &&
      this.chat.length > 0 &&
      this.chat[this.chat.length - 1].role === "user";

    scroll.innerHTML = this.chat.map(b => {
      if (b.role === "user") {
        return `<div class="cv-bubble is-user">
          <div class="cv-byline">toi</div>
          <div class="cv-body">${esc(b.text)}</div>
        </div>`;
      }
      const usageChip = b.usage ? `<span class="cv-usage">${esc(fmtTurnUsage(b.usage))}</span>` : "";
      return `<div class="cv-bubble is-conductor">
          <div class="cv-byline">chef d'orchestre${usageChip}</div>
          <div class="cv-body md">${mdToHtml(b.text || "")}</div>
        </div>`;
    }).join("") + (isWaitingConductor
      ? `<div class="cv-thinking">le chef ${conductor.state === "think" ? "réfléchit" : "répond"}<span class="cv-dots"></span></div>`
      : "");
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  },

  // Priority order: 'input' (needs attention) > 'unread' > 'live' / 'think'
  // (active) > 'idle'. Ties broken by recent-freq then alpha.
  _tabPriority(m) {
    const P = { input: 0, unread: 1, live: 2, think: 2, idle: 3 };
    return (P[m.state] ?? 3);
  },

  renderTabs() {
    const bar = $("#tab-bar");
    if (!bar) return;
    if (!isMobileViewport()) { bar.hidden = true; return; }
    bar.hidden = false;

    const CONDUCTOR = this.composer.CONDUCTOR;
    const conductorM = this.musicians.get(CONDUCTOR);
    const others = [...this.musicians.values()].filter(m => m.name !== CONDUCTOR);
    others.sort((a, b) => {
      const pa = this._tabPriority(a), pb = this._tabPriority(b);
      if (pa !== pb) return pa - pb;
      if (b.freq !== a.freq) return b.freq - a.freq;
      return a.name.localeCompare(b.name);
    });

    const tabs = [conductorM ? {
      name: CONDUCTOR, state: conductorM.state, unread: conductorM.unreadCount, conductor: true,
    } : null].filter(Boolean).concat(
      others.map(m => ({ name: m.name, state: m.state, unread: m.unreadCount }))
    );

    bar.innerHTML = tabs.map(t => {
      const isActive = t.name === this.activeTab;
      const showBadge = t.unread > 0 && t.state === "unread";
      return `
        <button class="tab ${t.conductor ? "is-conductor" : ""} ${isActive ? "is-active" : ""}"
                data-tab="${esc(t.name)}" data-state="${t.state}"
                style="--state-color: ${varByState(t.state)};">
          <span class="tab-dot"></span>
          <span class="tab-name">${esc(t.conductor ? "Chef" : t.name)}</span>
          <span class="tab-badge" ${showBadge ? "" : "hidden"}>${t.unread || ""}</span>
          ${!t.conductor && isActive ? `<span class="tab-close" data-act="close" title="Revenir au chef">×</span>` : ""}
        </button>`;
    }).join("");

    $$(".tab", bar).forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-act='close']")) {
          this.setActiveTab(CONDUCTOR);
          return;
        }
        this.setActiveTab(el.dataset.tab);
      });
    });
  },

  setActiveTab(name) {
    this.activeTab = name || this.composer.CONDUCTOR;
    // When the user opens a project session, mark their unread as read.
    const m = this.musicians.get(this.activeTab);
    if (m && this.activeTab !== this.composer.CONDUCTOR) m.markRead();
    // Update composer placeholder to reflect the target.
    const input = $("#composer-input");
    if (input) {
      input.placeholder = this.activeTab === this.composer.CONDUCTOR
        ? "Parle au chef — tape @ pour citer un musicien"
        : `Parle directement à ${this.activeTab}…`;
    }
    this.composer.target = this.activeTab;
    this.renderChat();
    redrawThreads();
  },

  /**
   * Called from Musician.transition() whenever the conductor project sees a
   * new event. We harvest its final assistant text on `result` turns and
   * append it as a conductor bubble.
   */
  onConductorEvent(musician, raw) {
    if (raw?.type === "user_prompt") {
      // Prompt sent to the conductor by any client (this tab, another tab,
      // mobile web, Android app). Mirror it as a user bubble unless this
      // same tab already pushed it locally in sendMessage().
      const txt = String(raw.text || "").trim();
      if (txt) {
        const last = this.chat[this.chat.length - 1];
        const isLocalEcho = last && last.role === "user" && last.text.trim() === txt;
        if (!isLocalEcho) {
          this.chat.push({ role: "user", text: txt, ts: Date.parse(raw.timestamp) || Date.now() });
        }
      }
    } else if (raw?.type === "result") {
      const txt = (musician.lastAssistantText || "").trim();
      if (!txt) return this.renderChat();
      const last = this.chat[this.chat.length - 1];
      const usage = musician.lastTurnUsage;
      if (last && last.role === "conductor" && last.text.trim() === txt) {
        if (!last.usage && usage) last.usage = usage;
        return this.renderChat();
      }
      this.chat.push({ role: "conductor", text: txt, ts: Date.now(), usage });
    }
    this.renderChat();
  },

  async sendMessage() {
    const input = $("#composer-input");
    const msg = input.value.trim();
    if (!msg) return;
    // Mobile: composer routes to the active tab (conductor by default).
    // Desktop: always the conductor (fan stays visible; direct-to-musician
    // is via the focused overlay).
    const target = isMobileViewport() ? this.activeTab : this.composer.CONDUCTOR;
    if (target === this.composer.CONDUCTOR) {
      this.chat.push({ role: "user", text: msg, ts: Date.now() });
    } else {
      // Mobile direct-to-musician: show the sent message in the musician's ring immediately.
      const m = this.musicians.get(target);
      if (m) m.push({ type: "user_prompt", text: msg, timestamp: new Date().toISOString() });
    }
    this.renderChat();
    input.disabled = true;
    try {
      const resp = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: target, prompt: msg }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      input.value = "";
      input.style.height = "auto";
      this.composer.hasDraft = false;
      $("#composer-send").disabled = true;
      redrawThreads();
    } catch (err) {
      alert("Envoi échoué : " + (err.message || err));
    } finally {
      input.disabled = false;
      input.focus();
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
        });
      });
    });
  },

  // ---------- Overlays wiring ----------
  wireOverlays() {
    for (const id of ["overlay-focused", "overlay-briefing", "overlay-add", "overlay-session"]) {
      const ov = document.getElementById(id);
      ov.addEventListener("click", (e) => {
        if (e.target.classList.contains("overlay-scrim")) this.closeOverlay(ov);
      });
      $$(".pf-close, .pb-close, .pa-close, .ps-close", ov).forEach(b => {
        b.addEventListener("click", () => this.closeOverlay(ov));
      });
    }
    // pf-compose
    const pfInput = $(".pf-input", $("#overlay-focused"));
    const pfSend  = $(".pf-send",  $("#overlay-focused"));
    pfInput.addEventListener("input", () => {
      pfSend.disabled = pfInput.value.trim().length === 0;
      pfInput.style.height = "auto";
      pfInput.style.height = Math.min(pfInput.scrollHeight, 180) + "px";
    });
    pfInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendFocusedMessage(); }
    });
    pfSend.addEventListener("click", () => this.sendFocusedMessage());

    // session-chip in focused view
    $(".pf-session-chip", $("#overlay-focused")).addEventListener("click", () => {
      if (this.focused) this.openSession(this.focused);
    });

    // add-project manual row
    $(".pa-manual-add", $("#overlay-add")).addEventListener("click", () => this.submitManualAdd());

    // briefing — re-render live by itself, no special button
  },

  closeOverlay(ov) {
    ov.hidden = true;
    if (ov.id === "overlay-focused") this.focused = null;
  },

  closeAllOverlays() {
    ["overlay-focused", "overlay-briefing", "overlay-add", "overlay-session"]
      .forEach(id => this.closeOverlay(document.getElementById(id)));
  },

  // ---------- Focused musician view ----------
  openFocused(m) {
    this.focused = m;
    m.markRead();
    m.updateCard();
    const ov = $("#overlay-focused");
    const root = $(".panel-focused", ov);
    root.style.setProperty("--state-color", varByState(m.state));
    $(".pf-name", ov).textContent = m.name;
    $(".pf-sub",  ov).textContent = `modèle ${m.model || "—"} · outils ${m.tools || "—"}`;
    const stateTag = $(".pf-state-tag", ov);
    stateTag.textContent = STATE_LABELS[m.state].label;
    stateTag.style.setProperty("--state-color", varByState(m.state));
    this.updateFocusedSessionChip(m);
    this.updateFocusedUsage(m);
    this.renderFocusedBody();
    ov.hidden = false;
    setTimeout(() => $(".pf-input", ov).focus(), 100);
  },

  updateFocusedUsage(m) {
    const el = $(".pf-usage", $("#overlay-focused"));
    if (!el) return;
    if (!m.turnCount && !m.totalCostUsd) { el.hidden = true; el.textContent = ""; return; }
    const inTot = m.totalInputTokens + m.totalCacheReadTokens + m.totalCacheCreateTokens;
    const parts = [];
    if (m.totalCostUsd) parts.push(fmtCost(m.totalCostUsd));
    if (inTot)          parts.push(`↓${fmtTok(inTot)}`);
    if (m.totalOutputTokens) parts.push(`↑${fmtTok(m.totalOutputTokens)}`);
    if (m.lastTurnUsage?.ctxMax && m.lastTurnUsage.ctxUsed) {
      const pct = Math.round((m.lastTurnUsage.ctxUsed / m.lastTurnUsage.ctxMax) * 100);
      if (pct > 0) parts.push(`${pct}% ctx`);
    }
    el.textContent = parts.join(" · ");
    el.hidden = parts.length === 0;
  },

  updateFocusedSessionChip(m) {
    const chip = $(".pf-session-chip", $("#overlay-focused"));
    const label = $(".psc-label", chip);
    const id    = $(".psc-id",    chip);
    if (m.attachedSession) {
      chip.classList.add("attached");
      label.textContent = "SID";
      id.textContent = m.attachedSession.slice(0, 8);
    } else {
      chip.classList.remove("attached");
      label.textContent = "+";
      id.textContent = "attacher";
    }
  },

  renderFocusedBody() {
    const m = this.focused;
    if (!m) return;
    const body = $(".pf-body", $("#overlay-focused"));
    if (!m.ring.length) {
      body.innerHTML = `<div class="pf-empty">En attente d'événements. Envoie un message à <strong>${esc(m.name)}</strong> pour commencer.</div>`;
      this.updateHeartbeat();
      return;
    }
    const parts = [];
    for (const raw of m.ring) {
      parts.push(renderFocusedEvent(raw));
    }
    // In-flight heartbeat: shown while the turn hasn't emitted a `result` yet.
    // Gives the user a visible proof-of-life with elapsed time + last activity.
    parts.push(`<div class="ev-heartbeat" hidden><span class="hb-dot"></span><span class="hb-label"></span><span class="hb-elapsed"></span></div>`);
    body.innerHTML = parts.join("");
    body.scrollTop = body.scrollHeight;
    this.updateHeartbeat();
  },

  /** Compute and paint the heartbeat banner for the currently-focused panel.
   *  Called by renderFocusedBody and by the 1s ticker (startHeartbeatTicker). */
  updateHeartbeat() {
    const m = this.focused;
    const ov = $("#overlay-focused");
    if (!ov || ov.hidden) return;
    const el = $(".ev-heartbeat", ov);
    if (!el || !m) return;
    const inFlight = (m.state === "live" || m.state === "think") &&
      (m.ring.length === 0 || m.ring[m.ring.length - 1].type !== "result");
    if (!inFlight) { el.hidden = true; return; }
    el.hidden = false;
    // Derive a short activity label from the last meaningful event.
    let label = "démarrage…";
    for (let i = m.ring.length - 1; i >= 0; i--) {
      const r = m.ring[i];
      if (r.type === "assistant") {
        const blocks = r.message?.content || [];
        const last = blocks[blocks.length - 1];
        if (last?.type === "tool_use") {
          label = `⚙ ${(last.name || "tool").toLowerCase()} — ${toolArgPreview(last)}`;
        } else if (last?.type === "thinking") {
          label = "◌ réflexion";
        } else if (last?.type === "text") {
          label = "… rédige";
        }
        break;
      }
      if (r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some(b => b?.type === "tool_result")) {
        label = "↳ tool result reçu";
        break;
      }
      if (r.type === "system" && r.subtype === "init") { label = "session ouverte…"; break; }
      if (r.type === "user_prompt") { label = "envoi au musicien…"; break; }
    }
    const startMs = m.turnStartMs || (m.ring[0] && Date.parse(m.ring[0].timestamp)) || Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, "0");
    $(".hb-label", el).textContent = label;
    $(".hb-elapsed", el).textContent = mm > 0 ? `${mm}m${ss}` : `${elapsed}s`;
  },

  startHeartbeatTicker() {
    if (this._hbTimer) return;
    this._hbTimer = setInterval(() => this.updateHeartbeat(), 1000);
  },

  async sendFocusedMessage() {
    const m = this.focused;
    if (!m) return;
    const ov = $("#overlay-focused");
    const input = $(".pf-input", ov);
    const msg = input.value.trim();
    if (!msg) return;
    input.disabled = true;
    try {
      const resp = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: m.name, prompt: msg }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      // Show the sent message immediately in the focused body before SSE arrives.
      m.push({ type: "user_prompt", text: msg, timestamp: new Date().toISOString() });
      this.renderFocusedBody();
      input.value = "";
      input.style.height = "auto";
      $(".pf-send", ov).disabled = true;
    } catch (err) {
      alert("Envoi échoué : " + (err.message || err));
    } finally {
      input.disabled = false;
      input.focus();
    }
  },

  // ---------- Briefing ----------
  openBriefing() {
    const ov = $("#overlay-briefing");
    const body = $(".pb-body", ov);
    const musicians = [...this.musicians.values()];
    $(".pb-count", ov).textContent = musicians.length;
    const attn = musicians.filter(m => m.state === "input" || m.state === "unread").length;
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
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const m = new Musician(data.project);
      this.musicians.set(m.name, m);
      $("#arc").appendChild(m.buildCard());
      this.relayout();
      this.toggleEmptyHint();
      this.closeOverlay($("#overlay-add"));
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

function renderFocusedEvent(raw) {
  const ts = fmtTs(raw.timestamp);
  switch (raw.type) {
    case "user_prompt":
      return `<div class="ev ev-prompt"><span class="ev-ts">${ts}</span><span class="ev-prompt-badge">TOI</span><div class="ev-text md">${mdToHtml(raw.text || "")}</div></div>`;
    case "system":
      if (raw.subtype === "init") return `<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text">— nouveau tour (session ${esc((raw.session_id||"").slice(0,8))}) —</span></div>`;
      return "";
    case "assistant":
      return renderAssistant(raw, ts);
    case "user":
      return renderUser(raw, ts);
    case "result":
      return renderResult(raw, ts);
    default:
      return "";
  }
}
function renderAssistant(raw, ts) {
  const parts = [];
  for (const b of raw.message?.content || []) {
    if (b?.type === "text") {
      const text = (b.text || "").trim();
      if (text) parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><div class="ev-text md">${mdToHtml(text)}</div></div>`);
    } else if (b?.type === "thinking") {
      const t = (b.thinking || "").trim();
      if (t) parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-think">◌ ${esc(t.slice(0, 300))}</span></div>`);
    } else if (b?.type === "tool_use") {
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
  return `<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text" style="color: var(--fg-3);">${parts.filter(Boolean).join(" · ")} —</span></div>`;
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

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => App.init());
window.App = App;
