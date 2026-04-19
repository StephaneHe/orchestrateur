/* ============================================================
   ORCHESTRE — client runtime
   Vanilla JS, single aggregate SSE, ring buffer per musician.
   ============================================================ */

"use strict";

// --------------------------------------------------------------------------
// Constants & small helpers
// --------------------------------------------------------------------------

const RING_MAX = 30;              // per-musician event buffer
const CARD_MIN_W = 150;
const CARD_MAX_W = 220;
const CARD_H     = 120;
const GAP_MIN    = 28;            // minimum horizontal gap between card centers
const ROW_GAP    = 30;            // min vertical breathing room between rows
const ARC_AMP    = 15;            // how far a card's Y is perturbed by the arc shape
const ROW_STEP   = CARD_H + ROW_GAP + 2 * ARC_AMP;  // guaranteed non-overlap
const TOP_PAD    = 96;            // room for topbar
const BOTTOM_PAD = 220;           // room for composer
const SIDE_PAD   = 40;

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
    this.lastActivityMs = 0;
    this.turnCount = 0;
    this.freq = 0;                       // communication frequency score

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
    if (t === "system") {
      if (raw.subtype === "init") {
        this.turnCount++;
        this.setState(this.state === "idle" || this.state === "unread" ? "live" : this.state);
      }
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
      const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(this.lastAssistantText || "");
      if (isErr) {
        this.lastLine = raw.subtype || "échec du tour";
        this.setState("input");              // treat errors as needing attention too
      } else if (needs) {
        this.lastLine = needs[1].trim().slice(0, 140);
        this.setState("input");
      } else {
        this.setState("unread");
        this.unreadCount++;
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
  }

  buildCard() {
    if (this.el) return this.el;
    const el = document.createElement("article");
    el.className = "musician";
    el.dataset.name = this.name;
    el.dataset.state = this.state;
    el.innerHTML = `
      <div class="m-halo"></div>
      <div class="m-body">
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
    $(".m-state-icon",  this.el).textContent = label.icon;
    $(".m-state-label", this.el).textContent = this.unreadCount > 1 && this.state === "unread"
      ? `${this.unreadCount} ${label.label}`
      : label.label;

    const lastEl = $(".m-last-line", this.el);
    if (this.lastLine) {
      lastEl.classList.remove("m-last-empty");
      lastEl.textContent = this.lastLine;
    } else {
      lastEl.classList.add("m-last-empty");
      lastEl.textContent = "en attente…";
    }

    const badge = $(".m-badge", this.el);
    if (this.unreadCount > 0 && this.state === "unread") {
      badge.hidden = false;
      badge.textContent = String(this.unreadCount);
    } else {
      badge.hidden = true;
    }

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

  const topPad    = 72;
  const bottomPad = 150;                // composer + chip
  const usableH   = h - topPad - bottomPad;

  // Hand baseline Y — where the CENTER card's bottom lives. Primary hand
  // sits near the composer; subsequent hands climb by handStepY so they
  // spread out using as much of the viewport as possible.
  const handStepY = handCount <= 1
    ? 0
    : Math.max(220, (usableH - 120) / (handCount - 1));

  for (let hi = 0; hi < handCount; hi++) {
    const hand     = hands[hi];
    const size     = hand.length;
    const scale    = Math.max(0.85, 1 - hi * 0.09);
    // Primary hand can grow to ~85% viewport width; back hands shrink
    // proportionally but stay large and legible.
    const cardW    = Math.round(Math.min(340, w * 0.84) * scale);

    // Fan geometry: pivot BELOW this hand's baseline by R. Card bottoms
    // trace an arc of radius R. A larger R flattens the arc (cards stand
    // more upright) — we want that so wide cards don't clip off-screen.
    const R        = 560 * scale;
    const baseY    = h - bottomPad - hi * handStepY;     // centre-card bottom
    const pivotY   = baseY + R;

    // Angular spread kept modest so the horizontal footprint of the fan
    // fits the viewport even with large cards.
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
  const usableW = viewport.w - 2 * SIDE_PAD;
  const usableH = viewport.h - TOP_PAD - BOTTOM_PAD;
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
  const composerCenter = {
    x: window.innerWidth / 2,
    y: window.innerHeight - 55, // roughly the top of the composer
  };
  // Clear
  svg.innerHTML = "";
  // Active threads: every musician in live/think/input state
  for (const m of App.musicians.values()) {
    if (!m.el) continue;
    if (!["live", "think", "input"].includes(m.state)) continue;
    const cx = m.pos.x;
    const cy = m.pos.y;
    const mid = { x: (composerCenter.x + cx) / 2, y: (composerCenter.y + cy) / 2 - 80 };
    const d = `M ${composerCenter.x} ${composerCenter.y} Q ${mid.x} ${mid.y} ${cx} ${cy + CARD_H / 2}`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "active");
    path.style.color = varByState(m.state);
    path.style.stroke = "currentColor";
    svg.appendChild(path);
  }
  // Pending thread (when a target is selected and input is non-empty)
  const target = App.composer.target;
  if (target && App.composer.hasDraft && App.musicians.has(target)) {
    const m = App.musicians.get(target);
    const cx = m.pos.x;
    const cy = m.pos.y;
    const mid = { x: (composerCenter.x + cx) / 2, y: (composerCenter.y + cy) / 2 - 120 };
    const d = `M ${composerCenter.x} ${composerCenter.y} Q ${mid.x} ${mid.y} ${cx} ${cy + CARD_H / 2}`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "pending");
    path.style.color = "var(--st-live)";
    path.style.stroke = "currentColor";
    svg.appendChild(path);
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
      if (App.focused === m) App.renderFocusedBody();
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
    target: "orchestrateur",      // the conductor: default recipient — it delegates to the others
    CONDUCTOR: "orchestrateur",   // name of the conductor project (special routing)
    hasDraft: false,
  },
  _reorderTimer: null,
  deckOffset: 0,                  // mobile: how many times the user swiped

  async init() {
    this.wireTopbar();
    this.wireComposer();
    this.wireKeyboard();
    this.wireTweaks();
    this.wireOverlays();
    this.wireFanSwipe();
    window.addEventListener("resize", () => this.relayout());

    await this.loadConfig();
    this.stream = new FleetStream();

    // Periodic freq decay + layout re-sort to surface recently-active musicians.
    setInterval(() => {
      for (const m of this.musicians.values()) m.freq *= 0.98;
      this.reorderSoon();
    }, 5000);

    // Periodic thread refresh (handles idle timers)
    setInterval(() => redrawThreads(), 1000);
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
    this.updateTargetMenu();
    this.toggleEmptyHint();
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
    const chip = $("#target-chip");
    const menu = $("#target-menu");

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

    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = !menu.hidden;
      menu.hidden = isOpen;
      chip.classList.toggle("is-open", !isOpen);
      if (!isOpen) this.updateTargetMenu();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#target-chip") && !e.target.closest("#target-menu")) {
        menu.hidden = true;
        chip.classList.remove("is-open");
      }
    });

    this.setTarget(this.composer.CONDUCTOR);
  },

  setTarget(name) {
    // Empty / null falls back to the conductor — the user is never in
    // "broadcast" mode; the conductor (orchestrateur) fans out itself.
    if (!name) name = this.composer.CONDUCTOR;
    this.composer.target = name;
    const chip = $("#target-chip");
    const lbl  = $(".tc-label", chip);
    const isConductor = name === this.composer.CONDUCTOR;
    if (isConductor) {
      lbl.textContent = "au chef d'orchestre";
      chip.classList.add("is-conductor");
      chip.style.setProperty("--tc-color", "var(--accent)");
    } else {
      lbl.textContent = `à ${name}`;
      chip.classList.remove("is-conductor");
      const m = this.musicians.get(name);
      chip.style.setProperty("--tc-color", varByState(m?.state || "idle"));
    }
    $("#composer-input").placeholder = isConductor
      ? "Parle au chef d'orchestre — il déléguera aux musiciens"
      : `Parle à ${name}… (contournement : d'habitude le chef délègue)`;
    redrawThreads();
  },

  updateTargetMenu() {
    const menu = $("#target-menu");
    const CONDUCTOR = this.composer.CONDUCTOR;
    const conductorM = this.musicians.get(CONDUCTOR);
    const rows = [
      {
        name: CONDUCTOR,
        label: "au chef d'orchestre",
        sub: "délègue aux musiciens (défaut)",
        state: conductorM?.state || "idle",
        conductor: true,
      },
      ...[...this.musicians.values()]
        .filter(m => m.name !== CONDUCTOR)
        .map(m => ({
          name: m.name,
          label: m.name,
          sub: `direct · ${STATE_LABELS[m.state].label}`,
          state: m.state,
        })),
    ];
    menu.innerHTML = rows.map((r) => `
      <button class="tm-item ${r.conductor ? "is-conductor" : ""} ${r.name === this.composer.target ? "is-selected" : ""}" data-name="${esc(r.name || "")}">
        <span class="tm-dot" style="background: ${r.state ? varByState(r.state) : "var(--fg-3)"};"></span>
        <span class="tm-name">${esc(r.label)}</span>
        <span class="tm-sub">${esc(r.sub)}</span>
      </button>
    `).join("");
    $$(".tm-item", menu).forEach(el => {
      // mousedown fires before the input loses focus; we close immediately
      // and rely on click for the actual action — this closes the menu
      // visually even if some event order quirk swallows the later click.
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTarget(el.dataset.name || null);
        menu.hidden = true;
        $("#target-chip").classList.remove("is-open");
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        // Safety net — mousedown should have already closed us.
        menu.hidden = true;
        $("#target-chip").classList.remove("is-open");
      });
    });
  },

  async sendMessage() {
    const input = $("#composer-input");
    const msg = input.value.trim();
    if (!msg) return;
    const target = this.composer.target || this.composer.CONDUCTOR;
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
    this.renderFocusedBody();
    ov.hidden = false;
    setTimeout(() => $(".pf-input", ov).focus(), 100);
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
      return;
    }
    const parts = [];
    for (const raw of m.ring) {
      parts.push(renderFocusedEvent(raw));
    }
    body.innerHTML = parts.join("");
    body.scrollTop = body.scrollHeight;
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
      this.updateTargetMenu();
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
      this.updateTargetMenu();
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
  // NEEDS_USER_INPUT is surfaced via lastAssistantText; just show a tour-done marker
  const dur = raw.duration_ms ? `${(raw.duration_ms/1000).toFixed(1)}s` : "";
  return `<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text" style="color: var(--fg-3);">— tour terminé · ${dur} —</span></div>`;
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
