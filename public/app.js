/* ============================================================
   PHOSPHOR/03 — orchestrator client (real wiring)
   ============================================================

   Loaded after vendor/xterm.js + vendor/addon-fit.js.
   Pulls its token from the URL (?token=<hex>), opens a WebSocket to
   /ws/pty for the central, and one EventSource per configured project
   to /sse/logs/<name>.

   MVP renders complete stream-json events (assistant, user, result).
   Partial streaming (stream_event / text_delta) is received over SSE
   but skipped in rendering — a future enhancement will accumulate
   text_deltas into a live text block.  Search for TODO(partial).
   ============================================================ */

const TWEAK_DEFAULTS = {
  palette: "matrix",
  density: "normal",
  scanlines: "off",
};

const STATE_LABELS = {
  idle:  "IDLE",
  live:  "LIVE",
  input: "NEEDS INPUT",
  done:  "DONE",
  error: "ERROR",
};

// ------------------------------------------------------------------
// Util
// ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function nowHHMMSS(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtDur(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(ss)}`;
}

function getToken() {
  return new URLSearchParams(location.search).get("token") || "";
}

// Truncate preview string for tool args display.
function truncate(s, n = 80) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function renderArgs(input) {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input).slice(0, 4);
  return entries.map(([k, v]) => {
    const vStr = typeof v === "string" ? v : JSON.stringify(v);
    const cls = (k === "file_path" || k === "path" || k === "file" || k === "command") ? "path" : "v";
    return `<span class="k">${escapeHtml(k)}=</span><span class="${cls}">${escapeHtml(truncate(vStr, 60))}</span>`;
  }).join(" ");
}

// ------------------------------------------------------------------
// Panel data model
// ------------------------------------------------------------------
//
// Each project has one Panel instance. It owns its DOM, its SSE source,
// its aggregated event counters, and a small running state machine.

class Panel {
  constructor(projectInfo) {
    this.name = projectInfo.name;
    this.model = projectInfo.model;
    this.tools = projectInfo.tools;
    this.state = "idle";
    this.originalIndex = projectInfo.originalIndex ?? 0;
    this.sessionId = null;
    this.attachedSession = projectInfo.attachedSession || null;
    this.lastActivityMs = 0;
    this.eventCount = 0;
    this.turnCount = 0;
    this.lastAssistantText = "";
    this.lastAssistantVerb = "IDLE";
    this.lastActivityNote = "awaiting dispatch";

    this.stickToBottom = true;
    this.el = this.buildDom();
    this.setAttachedSession(this.attachedSession);

    // Track user scroll intent so new events don't hijack the viewport.
    this.el.querySelector(".panel-body").addEventListener("scroll", () => {
      const b = this.el.querySelector(".panel-body");
      this.stickToBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 50;
    }, { passive: true });
  }

  buildDom() {
    const root = document.createElement("section");
    root.className = "panel";
    root.dataset.state = this.state;
    root.dataset.name = this.name;
    root.innerHTML = `
      <div class="disc-overlay">⚠ LINK TO AGENT LOST</div>
      <header class="panel-head">
        <span class="status-dot"></span>
        <div class="meta-col">
          <div class="title-row">
            <span class="title">${escapeHtml(this.name)}</span>
            <span class="mid">${escapeHtml(this.model || "")}</span>
            <span class="state-lbl">${STATE_LABELS.idle}</span>
          </div>
          <div class="activity">
            <span class="verb">IDLE</span>
            <span class="rest"> · awaiting dispatch</span>
          </div>
        </div>
        <div class="head-right">
          <button class="session-chip" data-act="session" title="Attach / detach Claude session">
            <span class="sc-label">SID</span>
            <span class="sc-id">—</span>
          </button>
          <div class="head-tools">
            <button title="Pause stream"      data-act="pause">⏸</button>
            <button title="Fullscreen"        data-act="fs">⛶</button>
            <button title="Clear rendered"    data-act="clear">⌦</button>
            <button title="Remove from fleet" data-act="remove">✕</button>
          </div>
        </div>
      </header>
      <div class="panel-body">
        <div class="empty-hint">awaiting events · dispatch the central agent to start</div>
      </div>
    `;

    // Header click toggles compact (except on buttons)
    const head = root.querySelector(".panel-head");
    head.addEventListener("click", (e) => {
      if (e.target.closest(".head-right")) return;
      root.classList.toggle("compact");
    });

    // Head tool buttons
    head.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "pause") this.togglePause(btn);
        else if (act === "fs") root.classList.toggle("fs");
        else if (act === "clear") this.clear(btn);
        else if (act === "session") SessionPicker.openFor(this);
        else if (act === "remove") App.removeProject(this);
      });
    });

    root.addEventListener("pointerdown", () => Attention.ack(this.name), { passive: true });

    return root;
  }

  setAttachedSession(sid) {
    this.attachedSession = sid || null;
    const chip = this.el.querySelector(".session-chip");
    const idEl = chip.querySelector(".sc-id");
    const lblEl = chip.querySelector(".sc-label");
    if (sid) {
      chip.classList.add("attached");
      lblEl.textContent = "SID";
      idEl.textContent = sid.slice(0, 8);
      chip.title = `Attached session ${sid}\nClick to change or detach`;
    } else {
      chip.classList.remove("attached");
      lblEl.textContent = "+";
      idEl.textContent = "attach";
      chip.title = "No session attached — click to pick an existing Claude session";
    }
  }

  get body() { return this.el.querySelector(".panel-body"); }

  setState(state) {
    if (!STATE_LABELS[state]) return;
    const prev = this.state;
    this.state = state;
    this.el.dataset.state = state;
    this.el.querySelector(".state-lbl").textContent = STATE_LABELS[state];
    // Bubble panels needing input to the top; restore order when they leave.
    if (prev !== state && (state === "input" || prev === "input")) App.reorderFleet();
    if (prev !== state) {
      if (state === "done" || state === "input") {
        Attention.notify(this, prev, state);
      } else {
        Attention.ack(this.name);
      }
    }
  }

  setActivity(verb, note) {
    this.lastAssistantVerb = verb;
    this.lastActivityNote = note;
    this.el.querySelector(".activity .verb").textContent = verb;
    this.el.querySelector(".activity .rest").textContent = " · " + note;
  }

  removeEmptyHint() {
    const hint = this.body.querySelector(".empty-hint");
    if (hint) hint.remove();
  }

  appendEvent(el) {
    this.removeEmptyHint();
    const body = this.body;
    body.appendChild(el);
    if (this.stickToBottom) body.scrollTop = body.scrollHeight;
    this.eventCount++;
    this.lastActivityMs = Date.now();
  }

  togglePause(btn) {
    this.paused = !this.paused;
    btn.classList.toggle("active", this.paused);
    btn.textContent = this.paused ? "▶" : "⏸";
    btn.title = this.paused ? "Resume stream" : "Pause stream";
  }

  clear(btn) {
    if (!confirm(`Clear rendered events for ${this.name}? (the agent keeps running)`)) return;
    const body = this.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "cleared · events keep arriving";
    body.appendChild(hint);
    this.eventCount = 0;
    this.stickToBottom = true;
    Attention.ack(this.name);
  }

  // ---- Event type factories (return a DOM element) ---------------

  renderTextEv(text, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev text";
    el.dataset.f = "text";
    el.innerHTML = `<span class="gutter">${ts}</span><div class="content"></div>`;
    el.querySelector(".content").textContent = text;
    return el;
  }

  renderThinkingEv(text, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev thinking collapsed";
    el.dataset.f = "thinking";
    el.innerHTML = `
      <span class="gutter">${ts}</span>
      <div class="content">
        <span class="think-tag">THINKING</span><span class="txt"></span>
      </div>`;
    el.querySelector(".txt").textContent = text;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".content")) el.classList.toggle("collapsed");
    });
    return el;
  }

  renderToolUseEv(block, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev tool_use";
    el.dataset.f = "tool_use";
    const name = (block.name || "TOOL").toUpperCase();
    const preview = renderArgs(block.input);
    const full = JSON.stringify(block.input ?? {}, null, 2);
    el.innerHTML = `
      <span class="gutter">${ts}</span>
      <div class="content">
        <span class="tool-glyph">${escapeHtml(name)}</span>
        <span class="tool-args">${preview}</span>
        <span class="chev">▸</span>
      </div>
      <div class="tool-full"></div>
    `;
    el.querySelector(".tool-full").textContent = full;
    el.querySelector(".content").addEventListener("click", () => el.classList.toggle("open"));
    return el;
  }

  renderToolResultEv(block, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev tool_result collapsed";
    el.dataset.f = "tool_result";
    const isErr = !!block.is_error;
    const raw = Array.isArray(block.content)
      ? block.content.map(c => c.text ?? JSON.stringify(c)).join("\n")
      : typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
    const lines = raw.split("\n");
    const meta = `${lines.length} lines · ${raw.length} chars${isErr ? " · ERR" : ""}`;
    el.innerHTML = `
      <span class="gutter">${ts}</span>
      <div class="content">
        <div class="tr-head">
          <span class="rtag">${isErr ? "ERR" : "RESULT"}</span>
          <span class="rmeta"></span>
          <span class="spacer"></span>
          <button class="tr-copy" type="button">COPY</button>
        </div>
        <div class="tr-body"></div>
      </div>
    `;
    el.querySelector(".rmeta").textContent = meta;
    el.querySelector(".tr-body").textContent = raw;
    const head = el.querySelector(".tr-head");
    head.addEventListener("click", (e) => {
      if (e.target.closest(".tr-copy")) return;
      el.classList.toggle("collapsed");
    });
    el.querySelector(".tr-copy").addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(raw).then(() => {
        const b = e.currentTarget;
        b.classList.add("copied"); b.textContent = "COPIED";
        setTimeout(() => { b.classList.remove("copied"); b.textContent = "COPY"; }, 1200);
      }).catch(() => {});
    });
    return el;
  }

  renderErrorEv(title, detail, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev error";
    el.dataset.f = "error";
    el.innerHTML = `
      <span class="gutter">${ts}</span>
      <div class="content">
        <span class="err-tag">FAIL</span><span class="ttl"></span>
        <button class="err-ack" type="button">ACK</button>
        <pre></pre>
      </div>
    `;
    el.querySelector(".ttl").textContent = title || "error";
    el.querySelector("pre").textContent = detail || "";
    el.querySelector(".err-ack").addEventListener("click", () => el.remove());
    return el;
  }

  renderQuestionEv(question, ts = nowHHMMSS()) {
    const el = document.createElement("div");
    el.className = "ev question";
    el.dataset.f = "text";
    el.innerHTML = `
      <span class="gutter">${ts}</span>
      <div class="content">
        <span class="q-tag">ASK</span><span class="q-text"></span>
      </div>
    `;
    el.querySelector(".q-text").textContent = question;
    return el;
  }

  // ---- stream-json event router ----------------------------------

  handleStreamEvent(ev) {
    if (!ev || typeof ev !== "object") return;

    switch (ev.type) {
      case "system":
        this.onSystem(ev); break;
      case "assistant":
        this.onAssistant(ev); break;
      case "user":
        this.onUser(ev); break;
      case "result":
        this.onResult(ev); break;
      case "stream_event":
        // TODO(partial): accumulate text_delta for live token streaming.
        // For now the complete assistant event arrives at turn end.
        break;
      default:
        // Unknown event — ignore. Brief says "never truncate" so we still
        // receive them via SSE but don't clutter the UI.
        break;
    }
  }

  onSystem(ev) {
    if (ev.subtype === "init") {
      if (typeof ev.session_id === "string") this.sessionId = ev.session_id;
      if (this.state === "idle" || this.state === "done") this.setState("live");
      this.setActivity("START", `session ${(ev.session_id || "").slice(0, 8)}`);
      this.turnCount++;
    }
  }

  onAssistant(ev) {
    const content = ev.message?.content || [];
    const textParts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          textParts.push(block.text || "");
          this.appendEvent(this.renderTextEv(block.text || ""));
          break;
        case "thinking":
          this.appendEvent(this.renderThinkingEv(block.thinking || block.text || ""));
          break;
        case "tool_use":
          this.appendEvent(this.renderToolUseEv(block));
          this.setActivity(
            (block.name || "TOOL").toUpperCase(),
            toolUsePreview(block),
          );
          this.setState("live");
          break;
      }
    }
    if (textParts.length) this.lastAssistantText = textParts.join("\n");
  }

  onUser(ev) {
    const content = ev.message?.content || [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        this.appendEvent(this.renderToolResultEv(block));
      }
    }
  }

  onResult(ev) {
    const isErr = !!ev.is_error || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"));
    const needsInput = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(this.lastAssistantText || ev.result || "");

    if (isErr) {
      this.appendEvent(this.renderErrorEv(
        ev.subtype || "error",
        typeof ev.result === "string" ? ev.result : JSON.stringify(ev, null, 2),
      ));
      this.setState("error");
      this.setActivity("FAIL", ev.subtype || "turn failed");
    } else if (needsInput) {
      this.appendEvent(this.renderQuestionEv(needsInput[1].trim()));
      this.setState("input");
      this.setActivity("ASKS", truncate(needsInput[1].trim(), 60));
    } else {
      this.setState("done");
      this.setActivity("DONE", `turn ${ev.num_turns ?? "—"} · ${ev.duration_ms ? (ev.duration_ms/1000).toFixed(1)+"s" : ""}`.trim());
    }
  }
}

function toolUsePreview(block) {
  const input = block.input || {};
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") return truncate(input.command, 80);
  if (typeof input.pattern === "string") return `/${input.pattern}/`;
  const keys = Object.keys(input);
  return keys.slice(0, 3).join(", ") || "—";
}

// ------------------------------------------------------------------
// Central terminal (xterm.js + /ws/pty)
// ------------------------------------------------------------------

function themeFromCss() {
  const cs = getComputedStyle(document.body);
  const pick = (v, fb) => cs.getPropertyValue(v).trim() || fb;
  return {
    background: pick("--bg-0", "#0a0b0c"),
    foreground: pick("--fg-0", "#e6dcc8"),
    cursor:     pick("--accent-primary", "#ffb347"),
    cursorAccent: pick("--bg-0", "#0a0b0c"),
    selectionBackground: pick("--rule-strong", "#3a4147"),
    black:    "#0a0b0c", red:     "#ff5b3e", green:   "#7fd98f", yellow:  "#ffc857",
    blue:     "#5fd4ff", magenta: "#ff2d8b", cyan:    "#5fd4ff", white:   "#e6dcc8",
    brightBlack:   "#5f5c55", brightRed:     "#ff7a5f", brightGreen:   "#9fffaf",
    brightYellow:  "#ffe080", brightBlue:    "#8fe8ff", brightMagenta: "#ff5fad",
    brightCyan:    "#8fe8ff", brightWhite:   "#ffffff",
  };
}

class CentralTerminal {
  constructor() {
    // xterm.js UMD exports to window.Terminal, fit addon to window.FitAddon.
    // eslint-disable-next-line no-undef
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      theme: themeFromCss(),
      scrollback: 10000,
      convertEol: false,
    });
    // eslint-disable-next-line no-undef
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.host = document.getElementById("term-host");
    this.term.open(this.host);
    this.fitNow();

    window.addEventListener("resize", () => this.fitNow());
    new ResizeObserver(() => this.fitNow()).observe(this.host);

    this.socket = null;
    this.rxBytes = 0;

    // Shadow buffer: approximate mirror of what the user has typed on the
    // current PTY line.  Used to inject the "@project " prefix on submit when
    // a target project is selected.  Drifts if the user moves the cursor
    // mid-line with arrow keys — acceptable for typical single-line dispatch.
    this.lineBuffer = "";

    // Stick-to-bottom: true until the user scrolls up; resumes when they
    // return to the bottom.  onScroll fires with the new viewportY (lines).
    this.stickToBottom = true;
    this.term.onScroll((newViewportY) => {
      const buf = this.term.buffer.active;
      this.stickToBottom = newViewportY + this.term.rows >= buf.length - 1;
    });

    this.wireImageAttach();
    this.connect();

    // Enter submits; Shift+Enter inserts a newline.
    // Claude Code's TTY treats a single `\r` as "newline in draft" and only
    // submits on `\r\r` (Enter on an empty line). We want plain Enter to feel
    // like "send" on every surface — desktop and phone — so we translate
    // `\r` → `\r\r` before it reaches the pty, except when the user held Shift.
    //
    // Two layers because mobile IMEs often skip keydown for Enter and emit the
    // character straight into the hidden textarea xterm reads from:
    //   1. attachCustomKeyEventHandler catches desktop Shift+Enter and marks a
    //      one-shot flag so the following onData `\r` is forwarded untouched.
    //   2. onData converts any other bare `\r` to `\r\r` — the path mobile
    //      Enter takes, and also where the mirrored remote-input lands.
    let shiftEnterPending = false;
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.key !== "Enter") return true;
      if (e.shiftKey) {
        shiftEnterPending = true;
        return true;
      }
      e.preventDefault();
      this.submitLine();
      return false;
    });
    this.term.onData((d) => {
      if (d === "\x7f") {
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        shiftEnterPending = false;
      } else if (d === "\r") {
        if (shiftEnterPending) {
          shiftEnterPending = false;
          // Shift+Enter: single \r = newline-in-draft, no prefix injection.
          this.send({ type: "input", data: d });
        } else {
          // Mobile Enter path.
          this.submitLine();
        }
        return;
      } else {
        shiftEnterPending = false;
        if (!d.startsWith("\x1b")) this.lineBuffer += d;
      }
      this.send({ type: "input", data: d });
    });
    this.term.onResize(({ cols, rows }) => this.send({ type: "resize", cols, rows }));
  }

  fitNow() {
    try { this.fitAddon.fit(); } catch {}
  }

  // ---- Image attach --------------------------------------------------

  wireImageAttach() {
    // Paste: only intercept when xterm has focus AND clipboard has image items.
    document.addEventListener("paste", (e) => {
      if (document.activeElement !== this.term.textarea) return;
      const images = [];
      for (const item of e.clipboardData?.items ?? []) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) images.push(f);
        }
      }
      if (images.length) { e.preventDefault(); this.uploadImages(images); }
    });

    // Drag-and-drop onto the terminal area.
    this.host.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        this.host.classList.add("drag-over");
      }
    });
    this.host.addEventListener("dragleave", (e) => {
      if (!this.host.contains(e.relatedTarget)) this.host.classList.remove("drag-over");
    });
    this.host.addEventListener("drop", (e) => {
      e.preventDefault();
      this.host.classList.remove("drag-over");
      const images = [...(e.dataTransfer?.files ?? [])].filter(f => f.type.startsWith("image/"));
      if (images.length) this.uploadImages(images);
    });

    // File picker button.
    const btn   = document.getElementById("term-attach");
    const input = document.getElementById("term-attach-input");
    if (btn && input) {
      btn.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        if (input.files?.length) {
          this.uploadImages([...input.files]);
          input.value = "";
        }
      });
    }
  }

  async uploadImages(files) {
    if (!files.length) return;
    this.showAttachStatus("UPLOADING\u2026");
    const paths = [];
    for (const file of files) {
      try {
        const resp = await fetch("/api/attach/image", {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        paths.push(data.path);
      } catch (err) {
        this.showAttachStatus("ERR: " + (err.message || "upload failed"), true);
        setTimeout(() => this.hideAttachStatus(), 4000);
        return;
      }
    }
    this.hideAttachStatus();
    if (paths.length) {
      // Insert space-separated paths into the pty draft; the trailing space
      // lets Claude Code recognise each path as a complete token.
      this.send({ type: "input", data: paths.join(" ") + " " });
      this.term.focus();
    }
  }

  showAttachStatus(msg, isErr = false) {
    const el = document.getElementById("attach-badge");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("err", isErr);
    el.hidden = false;
  }

  hideAttachStatus() {
    const el = document.getElementById("attach-badge");
    if (el) el.hidden = true;
  }

  applyTheme() {
    this.term.options.theme = themeFromCss();
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
    }
  }

  // Submits the current line, prepending "@<project> " if a target is selected.
  // Erases the typed line in the PTY via backspaces, then retypes with prefix.
  submitLine() {
    const target = TargetSelect.get();
    const buf = this.lineBuffer;
    if (target && buf.trim()) {
      const backspaces = "\x7f".repeat(buf.length);
      this.send({ type: "input", data: backspaces + `@${target} ` + buf + "\r\r" });
    } else {
      this.send({ type: "input", data: "\r\r" });
    }
    this.lineBuffer = "";
  }

  connect() {
    const token = getToken();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/pty?token=${encodeURIComponent(token)}`;
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    this.socket = sock;

    sock.addEventListener("open", () => {
      App.setConn("alive", "WSS · LINK OK");
      document.getElementById("term-title-sub").textContent = "· pty attached";
      document.getElementById("term-state").textContent = "live";
      // Nudge the server with current size.
      this.send({ type: "resize", cols: this.term.cols, rows: this.term.rows });
    });

    // Keyboard-less submit fallback (touch UI, accessibility).
    document.getElementById("term-send")?.addEventListener("click", () => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.submitLine();
        this.term.focus();
      }
    });

    sock.addEventListener("message", (ev) => {
      let data;
      if (typeof ev.data === "string") data = ev.data;
      else if (ev.data instanceof ArrayBuffer) data = new TextDecoder().decode(new Uint8Array(ev.data));
      else data = String(ev.data);
      this.rxBytes += data.length;
      document.getElementById("term-rx").textContent = fmtBytes(this.rxBytes);
      this.term.write(data, () => {
        if (this.stickToBottom) this.term.scrollToBottom();
      });
    });

    sock.addEventListener("close", () => {
      App.setConn("dead", "WSS · LINK DOWN");
      document.getElementById("term-state").textContent = "closed";
      document.body.classList.add("app-disconnected");
      // Retry after a delay.
      setTimeout(() => {
        App.setConn("reconn", "WSS · RECONNECT");
        this.connect();
      }, 3000);
    });

    sock.addEventListener("error", () => {
      App.setConn("dead", "WSS · ERR");
    });
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)}k`;
  return `${(n/1024/1024).toFixed(2)}M`;
}

// ------------------------------------------------------------------
// Per-project SSE stream
// ------------------------------------------------------------------

/**
 * Single-connection fleet stream. Replaces the per-panel EventSource.
 * The server emits `data: {"project":"<name>","line":"<raw-jsonl>"}` over
 * /api/sse/fleet, one connection regardless of fleet size. The viewer
 * routes each envelope to its panel. Essential because Chrome only
 * allows 6 concurrent HTTP/1.1 connections per origin, which a
 * per-panel approach exhausts instantly.
 */
class FleetStream {
  constructor() {
    this.source = null;
    this.open();
  }

  open() {
    const src = new EventSource("/api/sse/fleet");
    this.source = src;

    src.addEventListener("message", (ev) => {
      let envelope;
      try { envelope = JSON.parse(ev.data); } catch { return; }
      const panel = App.panels.get(envelope.project);
      if (!panel || panel.paused) return;
      let parsed;
      try { parsed = JSON.parse(envelope.line); } catch { return; }
      App.globalEventCount++;
      panel.handleStreamEvent(parsed);
    });

    src.addEventListener("error", () => {
      App.flashHeartbeat();
    });
  }

  close() {
    if (this.source) this.source.close();
    this.source = null;
  }
}

// ------------------------------------------------------------------
// TargetSelect — sticky project selector in the terminal chrome bar.
// Selected project name is persisted in localStorage. On submit,
// CentralTerminal.submitLine() prepends "@<name> " to the typed text
// so the central Claude knows which sub-agent to route the message to.
// ------------------------------------------------------------------

const TargetSelect = {
  STORAGE_KEY: "phosphor.target",
  el: null,

  init() {
    this.el = document.getElementById("target-select");
    if (!this.el) return;
    const saved = localStorage.getItem(this.STORAGE_KEY) || "";
    // Value will be reconciled after sync() populates options.
    this._pendingSaved = saved;
    this.el.addEventListener("change", () => {
      const v = this.el.value;
      this.el.classList.toggle("has-target", Boolean(v));
      if (v) localStorage.setItem(this.STORAGE_KEY, v);
      else localStorage.removeItem(this.STORAGE_KEY);
    });
  },

  // Rebuilds the option list from the current fleet. Preserves selection
  // if the project is still present; resets to "central" otherwise.
  sync(names) {
    if (!this.el) return;
    const current = this.el.value || this._pendingSaved || "";
    this._pendingSaved = null;
    this.el.innerHTML = `<option value="">— central —</option>`;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      this.el.appendChild(opt);
    }
    if (current && names.includes(current)) {
      this.el.value = current;
    } else if (current) {
      // Previously selected project no longer in fleet → fall back to central.
      this.el.value = "";
      localStorage.removeItem(this.STORAGE_KEY);
    }
    this.el.classList.toggle("has-target", Boolean(this.el.value));
  },

  // Returns the selected project name, or null when "— central —" is active.
  get() {
    return this.el?.value || null;
  },
};

// ------------------------------------------------------------------
// Attention — notifications, favicon badge, sound, unread tracking
// ------------------------------------------------------------------

const Attention = {
  pending: new Set(),   // noms de panneaux avec attention non acquittée
  soundEnabled: false,
  _audioCtx: null,
  _faviconEl: null,
  _origFavicon: null,

  init() {
    this.soundEnabled = localStorage.getItem("phosphor.sound") === "1";
    this._faviconEl = document.querySelector("link[rel~='icon']");
    this._origFavicon = this._faviconEl?.href || null;
    this._wireSoundToggle();
    this._requestNotifPermission();
  },

  // Appelé depuis Panel.setState quand prev=live → state=done/input
  notify(panel, prevState, newState) {
    if (newState !== "done" && newState !== "input") return;
    if (prevState !== "live") return;
    this.pending.add(panel.name);
    panel.el.dataset.attn = newState;
    this._updateTitle();
    this._updateFavicon();
    if (this.soundEnabled) this._playSound(newState);
    if (!document.hasFocus()) this._sendNotif(panel, newState);
  },

  // Acquitter un panneau (supprime badge, met à jour titre/favicon)
  ack(name) {
    if (!this.pending.has(name)) return;
    this.pending.delete(name);
    const panel = App.panels.get(name);
    if (panel) delete panel.el.dataset.attn;
    this._updateTitle();
    this._updateFavicon();
  },

  _updateTitle() {
    const n = this.pending.size;
    const base = "PHOSPHOR/03 — AGENT ORCHESTRATION COCKPIT";
    document.title = n > 0 ? `(${n}) ${base}` : base;
  },

  // Dessine le favicon en canvas : design original + point rouge si pending > 0
  _updateFavicon() {
    if (!this._faviconEl) return;
    const n = this.pending.size;
    if (n === 0) {
      this._faviconEl.href = this._origFavicon;
      return;
    }
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d");
    // Reproduire le design SVG original
    ctx.fillStyle = "#0a0b0c";
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = "#ffb347";
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, 24, 24);
    ctx.beginPath();
    ctx.moveTo(10, 10); ctx.lineTo(22, 10); ctx.lineTo(22, 16);
    ctx.lineTo(16, 16); ctx.lineTo(16, 22);
    ctx.stroke();
    // Point rouge en haut à droite
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(25, 7, 6, 0, Math.PI * 2);
    ctx.fill();
    this._faviconEl.href = c.toDataURL();
  },

  _sendNotif(panel, state) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = state === "input"
      ? `⚡ ${panel.name} — needs your input`
      : `✓ ${panel.name} — done`;
    const body = panel.lastActivityNote || "";
    const notif = new Notification(title, { body, tag: panel.name, silent: true });
    notif.addEventListener("click", () => {
      window.focus();
      panel.el.scrollIntoView({ behavior: "smooth", block: "center" });
      Attention.ack(panel.name);
      notif.close();
    });
    setTimeout(() => notif.close(), 8000);
  },

  _playSound(state) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!this._audioCtx) this._audioCtx = new AudioCtx();
    const ctx = this._audioCtx;
    const now = ctx.currentTime;
    const tones = state === "done"
      ? [{ f: 784, t: 0, d: 0.35 }, { f: 1047, t: 0.18, d: 0.35 }]
      : [{ f: 440, t: 0, d: 0.2 }, { f: 494, t: 0.25, d: 0.2 }];
    for (const { f, t, d } of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = state === "done" ? "sine" : "triangle";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.2, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + d);
      osc.start(now + t);
      osc.stop(now + t + d + 0.05);
    }
  },

  _wireSoundToggle() {
    const btn = document.getElementById("sound-toggle");
    if (!btn) return;
    this._updateSoundBtn(btn);
    btn.addEventListener("click", () => {
      this.soundEnabled = !this.soundEnabled;
      localStorage.setItem("phosphor.sound", this.soundEnabled ? "1" : "0");
      this._updateSoundBtn(btn);
      if (this.soundEnabled) this._playSound("done");
    });
  },

  _updateSoundBtn(btn) {
    btn.textContent = this.soundEnabled ? "🔔" : "🔕";
    btn.title = this.soundEnabled ? "Sound ON — click to mute" : "Sound OFF — click to enable";
    btn.classList.toggle("on", this.soundEnabled);
  },

  _requestNotifPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      document.addEventListener("click", () => {
        if (Notification.permission === "default") Notification.requestPermission();
      }, { once: true });
    }
  },
};

// ------------------------------------------------------------------
// Root app
// ------------------------------------------------------------------

const App = {
  tweaks: loadTweaks(),
  panels: new Map(),     // name -> Panel
  fleetStream: null,     // single aggregate SSE for all panels
  central: null,
  bootTime: Date.now(),
  globalEventCount: 0,

  async init() {
    this.applyTweaks();
    this.wireTweaks();
    this.wireKeyboard();
    this.startClocks();
    this.wireSearch();
    TargetSelect.init();
    Attention.init();

    // Populate HOST / LOCAL strip from what the browser knows.
    document.getElementById("strip-host").textContent = location.host;
    document.getElementById("strip-local").textContent = "127.0.0.1:" + (location.port || "7777");

    // Central terminal
    this.central = new CentralTerminal();

    // Fleet
    try {
      const resp = await fetch("/api/config?token=" + encodeURIComponent(getToken()));
      if (!resp.ok) throw new Error(`config ${resp.status}`);
      const cfg = await resp.json();
      this.renderFleet(cfg.projects || []);
    } catch (err) {
      console.error("[app] fetch /api/config failed", err);
      this.renderFleet([]);
      this.showFleetError(err.message);
    }

    // Healthz — populate TAILSCALE strip.
    try {
      const hz = await (await fetch("/healthz?token=" + encodeURIComponent(getToken()))).json();
      document.getElementById("strip-tailscale").textContent = hz.tailscale || "not detected";
    } catch { /* already token-gated; ignore */ }
  },

  renderFleet(projects) {
    const host = document.getElementById("panel-host");
    host.innerHTML = "";
    this.panels.clear();

    for (let i = 0; i < projects.length; i++) {
      const panel = new Panel({ ...projects[i], originalIndex: i });
      this.panels.set(projects[i].name, panel);
      host.appendChild(panel.el);
    }
    // One SSE connection for the whole fleet (not one per panel — Chrome's
    // 6-connection-per-origin limit would otherwise starve ad-hoc fetches).
    if (!this.fleetStream) this.fleetStream = new FleetStream();
    TargetSelect.sync([...this.panels.keys()]);
    this.updateFleetCounts();
  },

  showFleetError(msg) {
    const host = document.getElementById("panel-host");
    const el = document.createElement("div");
    el.style.padding = "24px";
    el.style.color = "var(--alert-error)";
    el.style.fontFamily = "var(--font-ui)";
    el.textContent = `FLEET ERROR: ${msg}`;
    host.appendChild(el);
  },

  updateFleetCounts() {
    const total = this.panels.size;
    let active = 0;
    for (const p of this.panels.values()) {
      if (p.state === "live" || p.state === "input") active++;
    }
    document.getElementById("fleet-count").textContent = total;
    document.getElementById("stat-agents").textContent = `${active}/${total}`;
    document.getElementById("stat-events").textContent = this.globalEventCount.toLocaleString();
  },

  applyTweaks() {
    document.body.dataset.palette = this.tweaks.palette;
    document.body.dataset.density = this.tweaks.density;
    document.body.dataset.scanlines = this.tweaks.scanlines;
    if (this.tweaks.scanlines === "faint") {
      document.body.style.backgroundImage =
        "repeating-linear-gradient(to bottom, transparent 0, transparent 2px, rgba(255,255,255,0.015) 2px, rgba(255,255,255,0.015) 3px)";
    } else {
      document.body.style.removeProperty("background-image");
    }
    // Propagate palette to xterm.js
    if (this.central) this.central.applyTheme();
    saveTweaks(this.tweaks);
  },

  wireTweaks() {
    document.querySelectorAll(".tweaks .row[data-tweak]").forEach(row => {
      const key = row.dataset.tweak;
      row.querySelectorAll("button").forEach(btn => {
        btn.classList.toggle("on", btn.dataset.v === this.tweaks[key]);
        btn.addEventListener("click", () => {
          this.tweaks[key] = btn.dataset.v;
          row.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
          this.applyTweaks();
        });
      });
    });
  },

  toggleTweaks(force) {
    const el = document.getElementById("tweaks");
    const open = typeof force === "boolean" ? force : !el.classList.contains("open");
    el.classList.toggle("open", open);
  },

  wireKeyboard() {
    document.addEventListener("keydown", (e) => {
      // Ignore keys while typing into inputs or xterm.
      const tag = (e.target && e.target.tagName) || "";
      const isInput = tag === "INPUT" || tag === "TEXTAREA" ||
                      (e.target && e.target.closest && e.target.closest(".xterm"));
      if (e.key === "Escape") { this.toggleTweaks(false); return; }
      if (isInput) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        this.toggleTweaks();
      }
    });
  },

  wireSearch() {
    const input = document.getElementById("fleet-search");
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase().trim();
      for (const panel of this.panels.values()) {
        const hit = !q || panel.name.toLowerCase().includes(q);
        panel.el.classList.toggle("hidden", !hit);
      }
    });
    document.getElementById("fleet-add").addEventListener("click", () => ProjectPicker.open());
  },

  async addProject(entry) {
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const panel = new Panel(data.project);
      panel.originalIndex = this.panels.size;
      this.panels.set(panel.name, panel);
      document.getElementById("panel-host").appendChild(panel.el);
      panel.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      // The aggregate FleetStream picks up new projects on its next poll.
      TargetSelect.sync([...this.panels.keys()]);
      this.updateFleetCounts();
      return data.project;
    } catch (err) {
      alert("Add failed: " + (err.message || err));
      throw err;
    }
  },

  reorderFleet() {
    const host = document.getElementById("panel-host");
    // Panels awaiting user input bubble to the top (preserve their relative
    // DOM order so multiple blocked panels stay stable). All others follow,
    // sorted by the index they had when they were first registered.
    const inDom = [...host.querySelectorAll(".panel")];
    const inputEls = inDom.filter(el => el.dataset.state === "input");
    const otherEls = [...this.panels.values()]
      .filter(p => p.state !== "input")
      .sort((a, b) => a.originalIndex - b.originalIndex)
      .map(p => p.el);
    for (const el of [...inputEls, ...otherEls]) host.appendChild(el);
  },

  async removeProject(panel) {
    if (!confirm(`Remove "${panel.name}" from the fleet? (logs are kept on disk; the config entry is deleted)`)) return;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(panel.name)}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      panel.el.remove();
      this.panels.delete(panel.name);
      TargetSelect.sync([...this.panels.keys()]);
      this.updateFleetCounts();
    } catch (err) {
      alert("Remove failed: " + (err.message || err));
    }
  },

  setConn(cls, label) {
    const el = document.getElementById("conn");
    el.className = "conn " + cls;
    el.querySelector(".lbl").textContent = label;
  },

  reconnect() {
    document.body.classList.remove("app-disconnected");
    if (this.central?.socket?.readyState === WebSocket.CLOSED) this.central.connect();
  },

  startClocks() {
    const upd = () => {
      const s = Math.floor((Date.now() - this.bootTime) / 1000);
      document.getElementById("stat-uptime").textContent = fmtDur(s);
      document.getElementById("stat-turns").textContent =
        [...this.panels.values()].reduce((acc, p) => acc + p.turnCount, 0).toLocaleString();

      const d = new Date();
      document.getElementById("strip-clock").textContent =
        `${d.getFullYear()}·${pad2(d.getMonth()+1)}·${pad2(d.getDate())} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      this.updateFleetCounts();
    };
    upd();
    setInterval(upd, 1000);

    // Heartbeat icon
    let hb = 0;
    setInterval(() => {
      hb++;
      const bars = "▮▯".repeat(3).split("");
      for (let i = 0; i < 5; i++) bars[i] = (i + hb) % 2 ? "▮" : "▯";
      document.getElementById("heartbeat").textContent =
        `${bars.slice(0,5).join("")} ${this.globalEventCount} events`;
    }, 500);
  },

  flashHeartbeat() {
    const el = document.getElementById("heartbeat");
    if (!el) return;
    el.style.color = "var(--alert-warn)";
    setTimeout(() => el.style.removeProperty("color"), 600);
  },

  flashAttach(name, kind) {
    const panel = this.panels.get(name);
    if (!panel) return;
    const chip = panel.el.querySelector(".session-chip");
    chip.classList.add("flash-" + (kind === "attached" ? "ok" : "warn"));
    setTimeout(() => {
      chip.classList.remove("flash-ok", "flash-warn");
    }, 900);
  },
};

function loadTweaks() {
  try {
    const raw = localStorage.getItem("phosphor.tweaks");
    if (raw) return { ...TWEAK_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...TWEAK_DEFAULTS };
}
function saveTweaks(t) {
  try { localStorage.setItem("phosphor.tweaks", JSON.stringify(t)); } catch {}
}

// ------------------------------------------------------------------
// SessionPicker — modal overlay for attaching a Claude session to a
// panel. Shows available sessions from ~/.claude/projects/<encoded>/,
// sorted by mtime. Click to attach, detach button if already attached,
// Esc to close.
// ------------------------------------------------------------------

const SessionPicker = {
  el: null,
  panel: null,

  ensureDom() {
    if (this.el) return;
    const root = document.createElement("div");
    root.className = "sp-overlay";
    root.innerHTML = `
      <div class="sp-modal" role="dialog">
        <div class="sp-head">
          <span class="sp-title">SESSION · <span class="sp-project">—</span></span>
          <span class="sp-spacer"></span>
          <button class="sp-close" title="Close (Esc)">✕</button>
        </div>
        <div class="sp-meta">
          <div><span class="sp-k">path</span> <span class="sp-v sp-path">—</span></div>
          <div><span class="sp-k">attached</span> <span class="sp-v sp-attached">none</span>
            <button class="sp-detach" hidden>DETACH</button>
          </div>
          <div><span class="sp-k">claude dir</span> <span class="sp-v sp-dir">—</span></div>
        </div>
        <div class="sp-new">
          <div class="sp-new-label">NEW SESSION — run a first Claude turn in this project</div>
          <div class="sp-new-row">
            <textarea class="sp-new-prompt" rows="3" placeholder="first prompt for this project…"></textarea>
            <div class="sp-new-actions">
              <button class="sp-new-start">START ↵</button>
              <span class="sp-new-err" hidden></span>
            </div>
          </div>
        </div>
        <div class="sp-list-wrap">
          <div class="sp-list-head">
            <span>SID</span><span>When</span><span>Branch</span><span>First message</span>
          </div>
          <div class="sp-list"></div>
        </div>
        <div class="sp-footer">
          <span class="sp-hint">Click a row to attach · DETACH clears the sidecar (next dispatch starts fresh).</span>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.el = root;

    root.addEventListener("click", (e) => {
      if (e.target === root) this.close();
    });
    root.querySelector(".sp-close").addEventListener("click", () => this.close());
    root.querySelector(".sp-detach").addEventListener("click", () => this.detach());
    root.querySelector(".sp-new-start").addEventListener("click", () => this.startNew());
  },

  async openFor(panel) {
    this.ensureDom();
    this.panel = panel;
    this.el.classList.add("open");
    this.el.querySelector(".sp-project").textContent = panel.name;
    const listEl = this.el.querySelector(".sp-list");
    listEl.innerHTML = `<div class="sp-loading">loading sessions…</div>`;
    this.el.querySelector(".sp-path").textContent = "—";
    this.el.querySelector(".sp-attached").textContent = "loading…";
    this.el.querySelector(".sp-detach").hidden = true;
    this.el.querySelector(".sp-dir").textContent = "—";
    // Reset new-session form.
    this.el.querySelector(".sp-new-prompt").value = "";
    this.el.querySelector(".sp-new-err").hidden = true;
    this.el.querySelector(".sp-new-start").disabled = false;
    this.el.querySelector(".sp-new-start").textContent = "START ↵";

    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(panel.name)}/sessions`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this.render(data);
    } catch (err) {
      listEl.innerHTML = `<div class="sp-err">failed to load: ${escapeHtml(String(err.message || err))}</div>`;
    }
  },

  render(data) {
    this.el.querySelector(".sp-path").textContent = data.projectPath;
    this.el.querySelector(".sp-dir").textContent = data.encodedDir;
    const attachedEl = this.el.querySelector(".sp-attached");
    const detachBtn = this.el.querySelector(".sp-detach");
    if (data.attached) {
      attachedEl.textContent = data.attached;
      attachedEl.classList.add("mono");
      detachBtn.hidden = false;
    } else {
      attachedEl.textContent = "none · next dispatch creates a new session";
      attachedEl.classList.remove("mono");
      detachBtn.hidden = true;
    }

    const listEl = this.el.querySelector(".sp-list");
    if (!data.sessions.length) {
      listEl.innerHTML = `<div class="sp-empty">no sessions found under ${escapeHtml(data.encodedDir)}/</div>`;
      return;
    }
    listEl.innerHTML = "";
    for (const s of data.sessions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sp-row";
      row.dataset.sid = s.id;
      if (s.id === data.attached) row.classList.add("current");
      if (s.live) row.classList.add("live");

      const when = fmtRelTime(new Date(s.mtime).toISOString());
      const turns = s.approxTurns ? `${s.approxTurns}+ turns` : "new";
      const sizeHuman = s.sizeHuman || "";
      const badge = s.live ? `<span class="sp-live-badge">● LIVE</span>` : "";

      row.innerHTML = `
        <span class="sp-c-sid mono">${escapeHtml(s.id.slice(0, 8))}${badge}</span>
        <span class="sp-c-when">${escapeHtml(when)}</span>
        <span class="sp-c-branch">${escapeHtml((s.gitBranch || "—") + " · " + turns + " · " + sizeHuman)}</span>
        <span class="sp-c-preview"></span>
      `;
      // Build a two-line content cell: first user msg + (optionally) last msg.
      const prev = row.querySelector(".sp-c-preview");
      const first = s.preview || "(no user message yet)";
      prev.innerHTML = `
        <span class="sp-c-first"></span>
        ${s.lastMessage ? `<span class="sp-c-last"></span>` : ""}
      `;
      prev.querySelector(".sp-c-first").textContent = "start · " + first;
      if (s.lastMessage) prev.querySelector(".sp-c-last").textContent = "latest · " + s.lastMessage;

      row.addEventListener("click", () => this.attach(s.id));
      listEl.appendChild(row);
    }
  },

  async attach(sid) {
    // Capture the target panel synchronously — close() below nulls it, and a
    // duplicate click (or MCP retry) would otherwise NPE on this.panel.name.
    const panel = this.panel;
    if (!panel || this.busy) return;
    this.busy = true;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(panel.name)}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      panel.setAttachedSession(data.attached);
      this.close();
      App.flashAttach(panel.name, "attached");
    } catch (err) {
      alert("Attach failed: " + (err.message || err));
    } finally {
      this.busy = false;
    }
  },

  async detach() {
    const panel = this.panel;
    if (!panel || this.busy) return;
    this.busy = true;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(panel.name)}/attach`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      panel.setAttachedSession(null);
      this.close();
      App.flashAttach(panel.name, "detached");
    } catch (err) {
      alert("Detach failed: " + (err.message || err));
    } finally {
      this.busy = false;
    }
  },

  async startNew() {
    const panel = this.panel;
    if (!panel || this.busy) return;
    const promptEl = this.el.querySelector(".sp-new-prompt");
    const errEl    = this.el.querySelector(".sp-new-err");
    const btn      = this.el.querySelector(".sp-new-start");
    const prompt   = promptEl.value.trim();
    if (!prompt) {
      errEl.textContent = "prompt is required";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    if (panel.attachedSession) {
      const ok = confirm(
        `This will start a new session and detach the current one (${panel.attachedSession.slice(0, 8)}…).\n` +
        `The existing session history is kept on disk.\n\nContinue?`
      );
      if (!ok) return;
    }
    this.busy = true;
    btn.disabled = true;
    btn.textContent = "STARTING…";
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(panel.name)}/sessions/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      panel.setAttachedSession(data.session_id);
      this.close();
      App.flashAttach(panel.name, "attached");
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.hidden = false;
    } finally {
      this.busy = false;
      btn.disabled = false;
      btn.textContent = "START ↵";
    }
  },

  close() {
    if (this.el) this.el.classList.remove("open");
    this.panel = null;
  },
};

function fmtRelTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = Date.now() - t;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// ProjectPicker — pick a directory under I:\Dev to add to the fleet.
// ------------------------------------------------------------------

const ProjectPicker = {
  el: null,
  busy: false,

  ensureDom() {
    if (this.el) return;
    const root = document.createElement("div");
    root.className = "sp-overlay pp-overlay";
    root.innerHTML = `
      <div class="sp-modal">
        <div class="sp-head">
          <span class="sp-title">ADD PROJECT · <span class="sp-project">I:\\Dev</span></span>
          <span class="sp-spacer"></span>
          <button class="sp-close" title="Close (Esc)">✕</button>
        </div>
        <div class="sp-meta">
          <div><span class="sp-k">root</span> <span class="sp-v pp-root">I:\\Dev</span></div>
          <div><span class="sp-k">found</span> <span class="sp-v pp-count">—</span> directories not yet in the fleet</div>
        </div>

        <div class="pp-manual">
          <span class="pp-manual-lbl">or register a path outside I:\\Dev</span>
          <div class="pp-manual-row">
            <input class="pp-manual-name"  placeholder="name (letters/digits/_.-)" />
            <input class="pp-manual-path"  placeholder="absolute path — must exist" />
            <button class="pp-manual-add">ADD</button>
          </div>
          <span class="pp-manual-err" hidden></span>
        </div>

        <div class="sp-list-wrap">
          <div class="sp-list-head pp-list-head">
            <span>NAME</span><span>MARKERS</span><span>PATH</span>
          </div>
          <div class="sp-list pp-list"></div>
        </div>
        <div class="sp-footer">
          <span class="sp-hint">Click a directory to register it as a fleet project. Existing tools/model will use defaults; change later in config.json.</span>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.el = root;
    root.addEventListener("click", (e) => { if (e.target === root) this.close(); });
    root.querySelector(".sp-close").addEventListener("click", () => this.close());
    root.querySelector(".pp-manual-add").addEventListener("click", () => this.submitManual());
  },

  async submitManual() {
    const nameEl = this.el.querySelector(".pp-manual-name");
    const pathEl = this.el.querySelector(".pp-manual-path");
    const errEl  = this.el.querySelector(".pp-manual-err");
    const name = nameEl.value.trim();
    const path = pathEl.value.trim();
    if (!name || !path) {
      errEl.textContent = "both name and path are required";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    try {
      await App.addProject({ name, path });
      this.close();
      nameEl.value = "";
      pathEl.value = "";
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.hidden = false;
    }
  },

  async open() {
    this.ensureDom();
    this.el.classList.add("open");
    const listEl = this.el.querySelector(".pp-list");
    listEl.innerHTML = `<div class="sp-loading">scanning I:\\Dev …</div>`;
    this.el.querySelector(".pp-count").textContent = "…";
    try {
      const resp = await fetch("/api/projects/candidates");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this.render(data);
    } catch (err) {
      listEl.innerHTML = `<div class="sp-err">scan failed: ${escapeHtml(String(err.message || err))}</div>`;
    }
  },

  render(data) {
    this.el.querySelector(".pp-root").textContent = data.root;
    this.el.querySelector(".pp-count").textContent = String(data.candidates.length);
    const listEl = this.el.querySelector(".pp-list");
    if (!data.candidates.length) {
      listEl.innerHTML = `<div class="sp-empty">every directory under ${escapeHtml(data.root)} is already in the fleet.</div>`;
      return;
    }
    listEl.innerHTML = "";
    for (const c of data.candidates) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sp-row pp-row";
      const markers = [
        c.hasGit ? "git" : "",
        c.hasClaudeMd ? "CLAUDE.md" : "",
        c.hasClaude ? ".claude" : "",
      ].filter(Boolean).join(" · ") || "—";
      row.innerHTML = `
        <span class="sp-c-sid mono">${escapeHtml(c.name)}</span>
        <span class="sp-c-branch">${escapeHtml(markers)}</span>
        <span class="sp-c-preview">${escapeHtml(c.path)}</span>
      `;
      row.addEventListener("click", () => this.pick(c));
      listEl.appendChild(row);
    }
  },

  async pick(candidate) {
    if (this.busy) return;
    this.busy = true;
    try {
      await App.addProject({ name: candidate.name, path: candidate.path });
      this.close();
    } catch {
      // App.addProject already surfaced the error
    } finally {
      this.busy = false;
    }
  },

  close() {
    if (this.el) this.el.classList.remove("open");
  },
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (SessionPicker.el?.classList.contains("open")) SessionPicker.close();
    if (ProjectPicker.el?.classList.contains("open")) ProjectPicker.close();
  }
});

window.App = App;
window.SessionPicker = SessionPicker;
window.ProjectPicker = ProjectPicker;
document.addEventListener("DOMContentLoaded", () => App.init());
