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
const ROW_GAP    = 28;            // vertical gap between arc rows
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

function computeLayout(musicians, viewport) {
  // 1. Sort musicians by freq desc — more active sits nearer the apex.
  const sorted = [...musicians].sort((a, b) => b.freq - a.freq);

  // 2. Decide card width.
  const usable = viewport.w - 2 * SIDE_PAD;
  // How many fit in ONE row at max width?
  let cardW = CARD_MAX_W;
  let perRow = Math.max(1, Math.floor((usable + GAP_MIN) / (cardW + GAP_MIN)));
  if (perRow >= sorted.length) {
    perRow = sorted.length;
  } else {
    // Try to shrink cards so more fit, up to CARD_MIN_W.
    const tryRows = Math.ceil(sorted.length / perRow);
    // If shrinking to CARD_MIN_W fits everything in fewer rows, do it.
    for (let w = CARD_MAX_W; w >= CARD_MIN_W; w -= 10) {
      const pr = Math.max(1, Math.floor((usable + GAP_MIN) / (w + GAP_MIN)));
      const rows = Math.ceil(sorted.length / pr);
      if (rows < tryRows || (rows === tryRows && pr > perRow)) {
        cardW = w;
        perRow = pr;
      }
    }
  }

  const rows = Math.ceil(sorted.length / perRow);

  // 3. Arc geometry: the innermost arc sits closer to the bottom (near the
  //    conductor). Outer arcs step up in Y. Apex is the middle slot of each arc.
  //    Center X fixed.
  const cx = viewport.w / 2;
  const baseBottom = viewport.h - BOTTOM_PAD;           // inner arc center-Y baseline
  const outerTop   = TOP_PAD + CARD_H / 2;              // outermost arc cannot push past this
  const availableV = Math.max(160, baseBottom - outerTop);
  const ryPerArc   = availableV / Math.max(1, rows);    // vertical slot per row
  const maxRy      = clamp(ryPerArc * 0.75, 80, 180);   // how tall each arc peaks
  const rowStep    = ryPerArc * 0.55;                   // how much rows are vertically offset

  // 4. Assign each musician to a row + slot in their row.
  //    Row 0 (innermost) holds the N highest-freq. For each row, the slot
  //    assignment is apex-first (center), alternating right/left outward.
  let assigned = 0;
  for (let row = 0; row < rows; row++) {
    const countThisRow = Math.min(perRow, sorted.length - assigned);
    const slotIndices  = apexFirstIndices(countThisRow);

    // Horizontal layout of the row: N cards spread symmetrically across the arc.
    const rowRx = Math.min((usable - cardW) / 2, viewport.w * 0.45);
    const cyRow = baseBottom - row * rowStep;
    const ryRow = Math.max(60, maxRy - row * 14);       // outer rows flatter

    for (let k = 0; k < countThisRow; k++) {
      const m = sorted[assigned + k];
      const slot = slotIndices[k];                     // 0..countThisRow-1 from left to right is slot
      const theta = countThisRow === 1
        ? Math.PI / 2
        : Math.PI - (slot * Math.PI) / (countThisRow - 1);
      const x = cx + rowRx * Math.cos(theta);
      const y = cyRow - ryRow * Math.sin(theta);
      m.pos = { x, y, w: cardW, row };
    }
    assigned += countThisRow;
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
    target: null,                 // musician name OR null = "tout l'orchestre"
    hasDraft: false,
  },
  _reorderTimer: null,

  async init() {
    this.wireTopbar();
    this.wireComposer();
    this.wireKeyboard();
    this.wireTweaks();
    this.wireOverlays();
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
    input.addEventListener("input", () => {
      setDraft();
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 180) + "px";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
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

    this.setTarget(null);
  },

  setTarget(name) {
    this.composer.target = name;
    const chip = $("#target-chip");
    const lbl  = $(".tc-label", chip);
    const dot  = $(".tc-dot",   chip);
    if (name) {
      lbl.textContent = `à ${name}`;
      const m = this.musicians.get(name);
      chip.style.setProperty("--tc-color", varByState(m?.state || "idle"));
    } else {
      lbl.textContent = "à tout l'orchestre";
      chip.style.setProperty("--tc-color", "var(--fg-2)");
    }
    $("#composer-input").placeholder = name
      ? `Parle à ${name}…`
      : "Parle à tout l'orchestre — ou @ pour choisir un musicien";
    redrawThreads();
  },

  updateTargetMenu() {
    const menu = $("#target-menu");
    const rows = [
      { name: null, label: "à tout l'orchestre", sub: "diffusion" },
      ...[...this.musicians.values()].map(m => ({
        name: m.name,
        label: m.name,
        sub: STATE_LABELS[m.state].label,
        state: m.state,
      })),
    ];
    menu.innerHTML = rows.map((r, i) => `
      <button class="tm-item ${r.name === this.composer.target ? "is-selected" : ""}" data-name="${esc(r.name || "")}">
        <span class="tm-dot" style="background: ${r.state ? varByState(r.state) : "var(--fg-3)"};"></span>
        <span class="tm-name">${esc(r.label)}</span>
        <span class="tm-sub">${esc(r.sub)}</span>
      </button>
    `).join("");
    $$(".tm-item", menu).forEach(el => {
      el.addEventListener("click", () => {
        this.setTarget(el.dataset.name || null);
        menu.hidden = true;
        $("#target-chip").classList.remove("is-open");
      });
    });
  },

  async sendMessage() {
    const input = $("#composer-input");
    const msg = input.value.trim();
    if (!msg) return;
    const target = this.composer.target;
    if (!target) {
      alert("Dispatching ‘à tout l'orchestre’ n'est pas encore implémenté — choisis un musicien dans le chip.");
      return;
    }
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
      if (text) parts.push(`<div class="ev"><span class="ev-ts">${ts}</span><span class="ev-text">${esc(text)}</span></div>`);
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
