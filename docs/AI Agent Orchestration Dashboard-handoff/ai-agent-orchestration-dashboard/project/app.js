/* ============================================================
   PHOSPHOR/03 — orchestrator client (mock)
   ============================================================ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "amber",
  "density": "normal",
  "scanlines": "off",
  "panels": "6"
}/*EDITMODE-END*/;

/* ---------- mock projects ---------------------------------- */

const PROJECTS = [
  {
    id: "BKHV-01", name: "BookHaven", state: "live",
    activity: { verb: "EDIT", path: "src/api/checkout.ts", note: "refactoring line 218 guard" },
    ago: "just now", tokens: "312.4k",
    events: [
      { t: "14:37:59", kind: "text", text: "Found the bug — `ctx.session` is accessed before middleware runs. I'll hoist the guard." },
      { kind: "thinking-group", n: 3, texts: [
        "Checkout route chain: auth → session → handler. If I move the nullcheck above session it fires too early.",
        "Better: keep session order, but wrap handler in a narrow try/catch that returns 428 on missing session.",
        "That keeps the 200-path zero-overhead and makes the contract explicit."
      ]},
      { t: "14:38:02", kind: "tool_use", tool: "READ", args: [["file","src/api/checkout.ts"],["range","210-240"]] },
      { t: "14:38:02", kind: "tool_result", tag: "READ", meta: "31 lines · 1.2 kB",
        body: [
          { c:"dim", s:"210 " }, { s:"export async function checkout(ctx: Ctx) {" },
          { c:"dim", s:"\n211 " }, { s:"  const { items, addr } = ctx.body;" },
          { c:"dim", s:"\n212 " }, { c:"red", s:"  if (ctx.session.userId == null) {      ← throws if session undefined" },
          { c:"dim", s:"\n213 " }, { s:"    return ctx.json({ error: 'UNAUTH' }, 401);" },
          { c:"dim", s:"\n214 " }, { s:"  }" },
          { c:"dim", s:"\n215 " }, { s:"  const cart = await loadCart(ctx.session.userId);" },
          { c:"dim", s:"\n216 " }, { s:"  …" }
        ]},
      { t: "14:38:04", kind: "tool_use", tool: "EDIT", args: [["file","src/api/checkout.ts"],["replace","+4/-1"]] },
      { t: "14:38:04", kind: "tool_result", tag: "EDIT", meta: "4 insertions, 1 deletion · ok",
        body: [ { c:"green", s:"✓ patch applied cleanly" }, { s:"\n  src/api/checkout.ts  |  +4  -1" } ] },
      { t: "14:38:06", kind: "text", text: "Running the checkout suite to confirm the guard is correct." },
      { t: "14:38:06", kind: "tool_use", tool: "BASH", args: [["cmd","pnpm test checkout.spec.ts"]] }
    ]
  },

  {
    id: "RMPD-02", name: "RemotePad", state: "input",
    activity: { verb: "BLOCKED", path: "db/migrations/0042_sessions.sql", note: "needs decision on migration strategy" },
    ago: "asks now", tokens: "88.1k",
    events: [
      { t: "14:36:12", kind: "text", text: "The `sessions` table is used by three services in prod. I need your call before I touch it." },
      { t: "14:36:14", kind: "tool_use", tool: "BASH", args: [["cmd","psql -c '\\d sessions'"]] },
      { t: "14:36:14", kind: "tool_result", tag: "BASH", meta: "9 rows · 0.3 kB",
        body: [
          { c:"dim", s:" Column       | Type        | Nullable\n" },
          { s:" id           | uuid        | not null\n" },
          { s:" user_id      | uuid        | not null\n" },
          { s:" expires_at   | timestamptz | not null\n" },
          { c:"amber", s:" device_hash  | text        | NULL       ← new, no backfill yet" }
        ]},
      { kind: "question", text: "How should I migrate live sessions? Two safe paths and one fast path:",
        choices: ["A · online backfill", "B · rolling drain", "C · truncate (unsafe)"]
      }
    ]
  },

  {
    id: "CRWG-03", name: "CryptoWing", state: "live",
    activity: { verb: "TEST", path: "cargo test --release", note: "312 of 488 tests passed" },
    ago: "2s ago", tokens: "541.0k",
    events: [
      { t: "14:35:02", kind: "tool_use", tool: "BASH", args: [["cmd","cargo test --release -- --test-threads=8"]] },
      { t: "14:35:42", kind: "tool_result", tag: "BASH", meta: "312/488 · running…", long: true,
        body: [
          { c:"green", s:"test orderbook::tests::insert_asc ... ok\n" },
          { c:"green", s:"test orderbook::tests::insert_desc ... ok\n" },
          { c:"green", s:"test matching::tests::fifo_partial_fill ... ok\n" },
          { c:"green", s:"test matching::tests::fifo_full_fill ... ok\n" },
          { c:"green", s:"test matching::tests::price_improve ... ok\n" },
          { c:"green", s:"test matching::tests::self_trade_prevent ... ok\n" },
          { c:"green", s:"test ringbuf::tests::overwrite_oldest ... ok\n" },
          { c:"green", s:"test ringbuf::tests::mpmc_stress ... ok\n" },
          { c:"green", s:"test risk::tests::margin_call_at_threshold ... ok\n" },
          { c:"amber", s:"test risk::tests::margin_call_flaky ... \n" },
          { c:"dim",   s:"  ↳ running 8s / timeout 15s\n" },
          { c:"green", s:"test wire::tests::fix44_roundtrip ... ok\n" },
          { c:"green", s:"test wire::tests::sbe_decode_depth ... ok\n" },
          { c:"green", s:"test settlement::tests::lockstep_two_ccp ... ok\n" },
          { c:"dim",   s:"(…172 more)\n" }
        ]},
      { kind: "thinking-group", n: 2, texts: [
        "`margin_call_flaky` has tripped twice in the last three runs. Probably a race on the position-cache lock.",
        "If it fails this pass I'll bisect against 2026.04.12; that's the last green SHA for this suite."
      ]},
      { t: "14:35:51", kind: "text", text: "Watching test 311. One flake to investigate after the pass completes." }
    ]
  },

  {
    id: "FLMN-04", name: "FlightMonitor", state: "error",
    activity: { verb: "FAIL", path: "scripts/sync_atc.mjs", note: "ECONNREFUSED 127.0.0.1:8088 · x4" },
    ago: "46s ago", tokens: "71.3k",
    events: [
      { t: "14:37:04", kind: "tool_use", tool: "BASH", args: [["cmd","node scripts/sync_atc.mjs --since=2026-04-19"]] },
      { t: "14:37:08", kind: "error", title: "ECONNREFUSED · atc-stub:8088",
        detail: "connect ECONNREFUSED 127.0.0.1:8088\n  at TCPConnectWrap.afterConnect [as oncomplete]\n  at async syncRegion (scripts/sync_atc.mjs:41:17)\n  at async main (scripts/sync_atc.mjs:108:3)\nretries: 4 · backoff: [200,800,3200,6400]ms" },
      { t: "14:37:15", kind: "text", text: "Upstream stub is down. I've stopped the sync loop to avoid hammering. Waiting for orchestrator guidance." },
      { t: "14:37:15", kind: "tool_use", tool: "READ", args: [["file","docker-compose.yml"]] }
    ]
  },

  {
    id: "LDGR-05", name: "LedgerLoom", state: "idle",
    activity: { verb: "IDLE", path: "— no task attached —", note: "slot reserved" },
    ago: "37m ago", tokens: "12.0k",
    events: [
      { t: "14:01:02", kind: "text", text: "Finished reconciliation pass on 2026-Q1. No discrepancies." },
      { t: "14:01:03", kind: "text", text: "Standing by for next task." }
    ]
  },

  {
    id: "NOIR-06", name: "Noir", state: "done",
    activity: { verb: "DONE", path: "12 files · 384/-128 lines", note: "awaiting your review" },
    ago: "4m ago", tokens: "457.6k",
    events: [
      { t: "14:34:00", kind: "text", text: "Finished the dark-theme contrast pass across 12 components. All AA-passing. Visual QA screenshots attached." },
      { t: "14:34:00", kind: "tool_use", tool: "WRITE", args: [["file","packages/ui/Button/styles.css"],["+24","-8"]] },
      { t: "14:34:01", kind: "tool_use", tool: "WRITE", args: [["file","packages/ui/Input/styles.css"],["+31","-14"]] },
      { t: "14:34:02", kind: "tool_use", tool: "BASH", args: [["cmd","pnpm -r typecheck"]] },
      { t: "14:34:17", kind: "tool_result", tag: "BASH", meta: "15.2s · ok",
        body: [ { c:"green", s:"✓ Tasks: 24 successful, 24 total" }, { s:"\n  Cached: 18, Ran: 6" } ]},
      { t: "14:34:18", kind: "text", text: "All checks green. Ready to merge when you give the word." }
    ]
  }
];

/* ---------- renderer --------------------------------------- */

const STATE_LABELS = {
  idle:  "IDLE",
  live:  "LIVE",
  input: "NEEDS INPUT",
  done:  "DONE",
  error: "ERROR"
};

function renderArgs(args) {
  return args.map(([k, v]) => {
    const vClass = (k === "file" || k === "path" || k === "cmd") ? "path" : "v";
    return `<span class="k">${k}=</span><span class="${vClass}">${escapeHtml(String(v))}</span>`;
  }).join(" ");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function renderPanel(p, idx) {
  const events = p.events.map(e => renderEvent(e, p.id)).join("");
  return `
    <section class="panel" data-state="${p.state}" data-id="${p.id}">
      <div class="disc-overlay">⚠ LINK TO AGENT LOST · last event +12s ago · <br>auto-reconnect 00:08</div>
      <header class="panel-head" onclick="App.toggleCompact(this)">
        <span class="status-dot"></span>
        <div class="meta-col">
          <div class="title-row">
            <span class="title">${p.name}</span>
            <span class="mid">${p.id}</span>
            <span class="state-lbl">${STATE_LABELS[p.state]}</span>
          </div>
          <div class="activity">
            <span class="verb">${p.activity.verb}</span>
            <span>· ${p.activity.path} · ${p.activity.note}</span>
          </div>
        </div>
        <div class="head-right" onclick="event.stopPropagation()">
          <span class="ago">${p.ago}</span>
          <span class="tok">${p.tokens} tok</span>
          <div class="head-tools">
            <button title="Pause stream" onclick="App.togglePause(this)">⏸</button>
            <button title="Filter" onclick="App.toggleFilters(this)">⏷</button>
            <button title="Fullscreen" onclick="App.toggleFs(this)">⛶</button>
            <button title="Clear (confirms)" onclick="App.clearPanel(event, this)">⌦</button>
          </div>
        </div>
      </header>
      <div class="panel-body">
        <div class="filters" style="display:none">
          <button class="on" data-f="text">TEXT</button>
          <button class="on" data-f="thinking">THINKING</button>
          <button class="on" data-f="tool_use">TOOL</button>
          <button class="on" data-f="tool_result">RESULT</button>
          <button class="on" data-f="error">ERROR</button>
          <span class="spacer"></span>
          <span class="count-tag">${p.events.length} events</span>
        </div>
        ${events}
      </div>
    </section>
  `;
}

function renderEvent(e, pid) {
  const t = e.t || "";
  switch (e.kind) {
    case "text":
      return `<div class="ev text" data-f="text"><span class="gutter">${t}</span><div class="content">${escapeHtml(e.text)}</div></div>`;

    case "thinking-group": {
      const inner = e.texts.map(t => `<div class="think-line">${escapeHtml(t)}</div>`).join("");
      return `
        <div class="thinking-group collapsed" data-f="thinking">
          <div class="group-head" onclick="App.toggleThink(this)">
            <span>THINKING</span><span class="n">${e.n} thoughts</span>
          </div>
          <div class="group-body">${inner}</div>
        </div>`;
    }

    case "tool_use":
      return `
        <div class="ev tool_use" data-f="tool_use" onclick="App.toggleTool(this)">
          <span class="gutter">${t}</span>
          <div class="content">
            <span class="tool-glyph">${e.tool}</span>
            <span class="tool-args">${renderArgs(e.args)}</span>
            <span class="chev">▸</span>
          </div>
          <div class="tool-full">${renderArgs(e.args)}</div>
        </div>`;

    case "tool_result": {
      const bodyHtml = e.body.map(seg =>
        seg.c ? `<span class="${seg.c}">${escapeHtml(seg.s)}</span>` : escapeHtml(seg.s)
      ).join("");
      const long = e.long ? ` data-long="1"` : "";
      const collapsed = e.long ? " collapsed" : "";
      return `
        <div class="ev tool_result${collapsed}" data-f="tool_result"${long}>
          <span class="gutter">${t}</span>
          <div class="content">
            <div class="tr-head" onclick="App.toggleResult(this.closest('.ev'))">
              <span class="rtag">${e.tag}</span>
              <span class="rmeta">${e.meta}</span>
              <span class="spacer"></span>
              <span class="tr-copy" onclick="event.stopPropagation(); App.copyResult(event, this)">COPY</span>
            </div>
            <div class="tr-body">${bodyHtml}</div>
            ${e.long ? `<button class="tr-expand" onclick="App.toggleResult(this.closest('.ev'))">EXPAND · 1,248 more lines</button>` : ""}
          </div>
        </div>`;
    }

    case "error":
      return `
        <div class="ev error" data-f="error">
          <span class="gutter">${t}</span>
          <div class="content">
            <span class="err-tag">FAIL</span><span>${escapeHtml(e.title)}</span>
            <button class="err-ack" onclick="this.closest('.ev').remove()">ACK</button>
            <pre>${escapeHtml(e.detail)}</pre>
          </div>
        </div>`;

    case "question":
      return `
        <div class="ev question" data-f="text">
          <span class="gutter"></span>
          <div class="content">
            <span class="q-tag">ASK</span><span class="q-text">${escapeHtml(e.text)}</span>
            <div class="q-choices">
              ${e.choices.map(c => `<button>${escapeHtml(c)}</button>`).join("")}
            </div>
          </div>
        </div>`;
  }
  return "";
}

/* ---------- App control ------------------------------------ */

const App = {
  tweaks: { ...TWEAK_DEFAULTS },
  disconnected: false,

  init() {
    this.applyTweaks();
    this.renderFleet();
    this.wireHeader();
    this.wireTweaks();
    this.wireTerminal();
    this.startClocks();
    this.wireEditMode();
  },

  renderFleet() {
    const host = document.getElementById("panel-host");
    const n = parseInt(this.tweaks.panels, 10);
    const projects = PROJECTS.slice(0, n);
    host.innerHTML = projects.map(renderPanel).join("");
    document.getElementById("fleet-count").textContent = projects.length;
    const active = projects.filter(p => p.state === "live" || p.state === "input").length;
    document.getElementById("stat-agents").textContent = `${active}/${projects.length}`;
  },

  applyTweaks() {
    document.body.dataset.palette = this.tweaks.palette;
    document.body.dataset.density = this.tweaks.density;
    document.body.dataset.scanlines = this.tweaks.scanlines;
    if (this.tweaks.scanlines === "faint") {
      document.body.style.setProperty("background-image",
        "repeating-linear-gradient(to bottom, transparent 0, transparent 2px, rgba(255,255,255,0.015) 2px, rgba(255,255,255,0.015) 3px)");
    } else {
      document.body.style.removeProperty("background-image");
    }
  },

  wireTweaks() {
    document.querySelectorAll(".tweaks .row[data-tweak]").forEach(row => {
      const key = row.dataset.tweak;
      row.querySelectorAll("button").forEach(btn => {
        btn.classList.toggle("on", btn.dataset.v === this.tweaks[key]);
        btn.onclick = () => {
          this.tweaks[key] = btn.dataset.v;
          row.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
          this.applyTweaks();
          if (key === "panels") this.renderFleet();
          this.pushEdit({ [key]: btn.dataset.v });
        };
      });
    });
  },

  wireHeader() {},

  wireTerminal() {
    const input = document.getElementById("term-input");
    const body = document.getElementById("term-body");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        const line = document.createElement("span");
        line.className = "term-line";
        line.innerHTML = `<span class="ts">${nowHHMMSS()}</span> <span class="lbl">▸ you</span> ${escapeHtml(input.value)}`;
        body.appendChild(line);
        const reply = document.createElement("span");
        reply.className = "term-line dim";
        reply.textContent = "// queued → dispatcher · thinking…";
        body.appendChild(reply);
        body.scrollTop = body.scrollHeight;
        input.value = "";
      }
    });
  },

  startClocks() {
    let uptime = 4*3600 + 17*60 + 32;
    let tokens = 1482309;
    setInterval(() => {
      uptime++;
      document.getElementById("stat-uptime").textContent = fmtDur(uptime);
      tokens += Math.floor(Math.random() * 180);
      document.getElementById("stat-tokens").textContent = tokens.toLocaleString();
      const cost = (tokens / 1_000_000 * 6.5).toFixed(2);
      document.getElementById("stat-cost").textContent = "$" + cost;
    }, 1000);
    setInterval(() => {
      const d = new Date();
      document.getElementById("strip-clock").textContent =
        `${d.getFullYear()}·${pad2(d.getMonth()+1)}·${pad2(d.getDate())} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }, 1000);
  },

  /* ---- interactions ---- */
  toggleThink(el) { el.parentElement.classList.toggle("collapsed"); },
  toggleTool(el) { el.classList.toggle("open"); },
  toggleResult(el) { el.classList.toggle("collapsed"); },
  copyResult(ev, el) {
    ev.stopPropagation();
    const body = el.closest(".ev").querySelector(".tr-body");
    navigator.clipboard?.writeText(body.innerText).catch(()=>{});
    el.classList.add("copied"); el.textContent = "COPIED";
    setTimeout(() => { el.classList.remove("copied"); el.textContent = "COPY"; }, 1200);
  },
  toggleCompact(head) {
    head.closest(".panel").classList.toggle("compact");
  },
  togglePause(btn) {
    event.stopPropagation();
    btn.classList.toggle("active");
    btn.textContent = btn.classList.contains("active") ? "▶" : "⏸";
    btn.title = btn.classList.contains("active") ? "Resume stream" : "Pause stream";
  },
  toggleFilters(btn) {
    event.stopPropagation();
    btn.classList.toggle("active");
    const f = btn.closest(".panel").querySelector(".filters");
    f.style.display = f.style.display === "none" ? "flex" : "none";
  },
  toggleFs(btn) {
    event.stopPropagation();
    btn.closest(".panel").classList.toggle("fs");
  },
  clearPanel(ev, btn) {
    ev.stopPropagation();
    if (!confirm("Clear rendered content for this panel? (agent keeps running)")) return;
    const body = btn.closest(".panel").querySelector(".panel-body");
    [...body.children].forEach(c => { if (!c.classList.contains("filters")) c.remove(); });
  },

  demoDisconnect() {
    this.disconnected = !this.disconnected;
    document.body.classList.toggle("app-disconnected", this.disconnected);
    const conn = document.getElementById("conn");
    conn.className = "conn " + (this.disconnected ? "dead" : "alive");
    conn.querySelector(".lbl").textContent = this.disconnected ? "WSS · LINK DOWN" : "WSS · LINK OK";
  },
  reconnect() { if (this.disconnected) this.demoDisconnect(); },

  /* ---- edit mode ---- */
  wireEditMode() {
    window.addEventListener("message", (ev) => {
      const d = ev.data || {};
      if (d.type === "__activate_edit_mode") {
        document.getElementById("tweaks").classList.add("open");
      } else if (d.type === "__deactivate_edit_mode") {
        document.getElementById("tweaks").classList.remove("open");
      }
    });
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
  },
  pushEdit(edits) {
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*");
  }
};

/* ---------- util ------------------------------------------- */
function pad2(n) { return String(n).padStart(2,"0"); }
function nowHHMMSS() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDur(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return `${pad2(h)}:${pad2(m)}:${pad2(ss)}`;
}

document.addEventListener("DOMContentLoaded", () => App.init());
