/* PHOSPHOR/03 Mobile — React app */
const { useState, useMemo } = React;

/* ---------- data ---------- */
const MPROJECTS = [
  { id: "RMPD-02", name: "RemotePad", state: "input",
    activity: { verb: "BLOCKED", note: "needs decision · migration strategy" },
    ago: "asks now", tokens: "88.1k",
    spark: [3,4,5,6,5,4,3,2,3,4,5,6,8,9,10,9,8,2,1,1],
    question: "How should I migrate live sessions on the users table? 1.4M rows, 3 consumers.",
    events: [
      { kind: "text", t: "14:36:12", text: "The sessions table is used by three services. I need your call before I touch it." },
      { kind: "thinking", t: "14:36:13", n: 3 },
      { kind: "tool_use", t: "14:36:14", tool: "BASH", args: "psql -c '\\d sessions'" },
      { kind: "tool_result", t: "14:36:14", tag: "BASH", meta: "9 rows",
        body: [
          { c:"pm-dim", s:" Column       | Type        | Nullable\n" },
          { s:" id           | uuid        | not null\n" },
          { s:" user_id      | uuid        | not null\n" },
          { c:"pm-amber", s:" device_hash  | text        | NULL   ← new column" },
        ]},
      { kind: "question", t: "14:36:15", text: "Pick a migration path — can only do this once cleanly.",
        choices: ["A · online backfill (safe, 6h)", "B · rolling drain (90m downtime)", "C · truncate (unsafe, 30s)"] },
    ]
  },
  { id: "FLMN-04", name: "FlightMonitor", state: "error",
    activity: { verb: "FAIL", note: "ECONNREFUSED 127.0.0.1:8088 · x4" },
    ago: "46s ago", tokens: "71.3k",
    spark: [4,5,6,7,8,7,6,5,4,3,2,1,1,1,1,0,0,0,0,0],
    events: [
      { kind: "tool_use", t: "14:37:04", tool: "BASH", args: "node scripts/sync_atc.mjs" },
      { kind: "error", t: "14:37:08", title: "ECONNREFUSED · atc-stub:8088",
        detail: "connect ECONNREFUSED 127.0.0.1:8088\n  at TCPConnectWrap.afterConnect\n  at async syncRegion (sync_atc.mjs:41)\nretries: 4 · backoff: [200,800,3200,6400]ms" },
    ]
  },
  { id: "BKHV-01", name: "BookHaven", state: "live",
    activity: { verb: "EDIT", note: "src/api/checkout.ts · line 218" },
    ago: "just now", tokens: "312.4k",
    spark: [5,6,7,8,9,8,7,9,10,11,10,9,10,11,12,11,10,11,12,13],
    events: [
      { kind: "text", t: "14:37:59", text: "Found the bug — ctx.session is accessed before middleware runs. Hoisting the guard." },
      { kind: "thinking", t: "14:38:00", n: 3 },
      { kind: "tool_use", t: "14:38:02", tool: "READ", args: "file=src/api/checkout.ts range=210-240" },
      { kind: "tool_use", t: "14:38:04", tool: "EDIT", args: "file=src/api/checkout.ts +4/-1" },
      { kind: "tool_result", t: "14:38:04", tag: "EDIT", meta: "ok",
        body: [ { c:"pm-green", s:"✓ patch applied cleanly" }, { s:"\n  checkout.ts  |  +4  -1" } ]},
      { kind: "text", t: "14:38:06", text: "Running the checkout suite to confirm." },
    ]
  },
  { id: "CRWG-03", name: "CryptoWing", state: "live",
    activity: { verb: "TEST", note: "cargo test · 312/488 pass" },
    ago: "2s ago", tokens: "541.0k",
    spark: [6,7,8,9,10,11,10,9,8,9,10,11,12,13,12,11,10,11,12,11],
    events: []
  },
  { id: "NOIR-06", name: "Noir", state: "done",
    activity: { verb: "DONE", note: "12 files · awaiting review" },
    ago: "4m ago", tokens: "457.6k",
    spark: [3,4,5,6,5,4,5,6,7,6,5,4,3,2,2,2,1,1,1,1],
    events: []
  },
  { id: "LDGR-05", name: "LedgerLoom", state: "idle",
    activity: { verb: "IDLE", note: "no task attached" },
    ago: "37m", tokens: "12.0k",
    spark: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    events: []
  },
];

const STATE_LABELS = { idle:"IDLE", live:"LIVE", input:"NEEDS INPUT", done:"DONE", error:"ERROR" };

/* ---------- shared header ---------- */
function TopHeader({ title, sub, liveTag }) {
  return (
    <div className="pm-top">
      <div className="pm-brand">
        <span className="pm-mark"></span>
        PHOSPHOR<span className="pm-slash">/</span>03
        <span className="pm-ellipsis">⋯</span>
      </div>
      <div className="pm-meta">
        <span className="pm-amber">●</span>
        <span>WSS OK</span>
        <span className="pm-sep">·</span>
        <span>04:17:32</span>
        <span className="pm-sep">·</span>
        <span className="pm-cyan">$9.62</span>
        <span className="pm-sep">·</span>
        <span className="pm-v">4/6 agents</span>
      </div>
      <div className="pm-title">{title}</div>
      {sub && <div className="pm-subtitle">{sub} {liveTag && <span className="pm-live">· {liveTag}</span>}</div>}
    </div>
  );
}

/* ---------- Fleet screen ---------- */
function FleetScreen({ onOpenCard }) {
  const alertProject = MPROJECTS.find(p => p.state === "input");
  const errorProject = MPROJECTS.find(p => p.state === "error");
  const sortedRest = MPROJECTS.filter(p => p !== alertProject && p !== errorProject);
  const order = [errorProject, ...sortedRest].filter(Boolean);

  return (
    <div className="pm-screen">
      <TopHeader title="FLEET" sub="6 AGENTS" liveTag="2 LIVE" />

      {alertProject && (
        <div className="pm-alert">
          <div className="pm-alert-head">
            <span className="pm-dot"></span>
            <span>{alertProject.name} · NEEDS INPUT</span>
            <span className="pm-ago">46s ago</span>
          </div>
          <div className="pm-alert-q">{alertProject.question}</div>
          <div className="pm-alert-actions">
            <button onClick={() => onOpenCard(alertProject)}>OPEN</button>
            <button className="pm-primary">RESPOND</button>
          </div>
        </div>
      )}

      <div className="pm-fleet-wrap">
        <div className="pm-fleet-head">
          <span>ACTIVE · <span className="pm-count">{order.length}</span></span>
          <span className="pm-ruler"></span>
          <span>LIVE</span>
        </div>
        {order.map(p => <FleetCard key={p.id} p={p} onClick={() => onOpenCard(p)} />)}
      </div>
    </div>
  );
}

function FleetCard({ p, onClick }) {
  return (
    <div className="pm-card" data-state={p.state} onClick={onClick}>
      <div className="pm-card-row1">
        <span className="pm-card-dot"></span>
        <span className="pm-card-name">{p.name}</span>
        <span className="pm-card-id">{p.id}</span>
        <span className="pm-card-state">{STATE_LABELS[p.state]}</span>
      </div>
      <div className="pm-card-activity">
        <span className="pm-verb">{p.activity.verb}</span> · {p.activity.note}
      </div>
      <div className="pm-card-foot">
        <span>{p.ago}</span>
        <span className="pm-tok">{p.tokens} tok</span>
      </div>
      <div className="pm-spark">
        {p.spark.map((v,i) => <span key={i} style={{ height: (v*1.2)+"px" }}></span>)}
      </div>
    </div>
  );
}

/* ---------- Detail screen ---------- */
function DetailScreen({ p, onBack }) {
  const [thinkOpen, setThinkOpen] = useState({});
  return (
    <div className="pm-screen">
      <div className="pm-detail-top">
        <button className="pm-detail-back" onClick={onBack}>
          <span className="pm-arrow">◂</span> FLEET
        </button>
        <div className="pm-detail-row">
          <span className="pm-d-name">{p.name}</span>
          <span className="pm-d-id">{p.id}</span>
        </div>
        <div className="pm-detail-state-row">
          <span className="pm-s-dot" style={stateDotStyle(p.state)}></span>
          <span className="pm-s-lbl" style={{ color: stateColor(p.state) }}>{STATE_LABELS[p.state]}</span>
          <span className="pm-s-meta">{p.ago} · {p.tokens} tok</span>
        </div>
        <div className="pm-detail-chips">
          <button className="pm-chip pm-chip-on">ALL</button>
          <button className="pm-chip">TEXT</button>
          <button className="pm-chip">THINKING</button>
          <button className="pm-chip">TOOLS</button>
          <button className="pm-chip pm-chip-hot">ERRORS</button>
          <button className="pm-chip">PAUSE</button>
          <button className="pm-chip">COPY</button>
        </div>
      </div>
      <div className="pm-stream">
        {p.events.map((e, i) => renderMobileEvent(e, i, thinkOpen, setThinkOpen))}
      </div>
    </div>
  );
}

function stateColor(s) {
  return { live:"#ffb347", input:"#ff2d8b", error:"#ff5b3e", done:"#7fd98f", idle:"#5f5c55" }[s];
}
function stateDotStyle(s) {
  const c = stateColor(s);
  return { background: c, boxShadow: `0 0 6px ${c}` };
}

function renderMobileEvent(e, i, thinkOpen, setThinkOpen) {
  switch (e.kind) {
    case "text":
      return <div key={i} className="pm-ev pm-text"><span className="pm-ev-ts">{e.t}</span><div className="pm-c">{e.text}</div></div>;
    case "thinking":
      return (
        <div key={i} className={`pm-ev pm-thinking ${thinkOpen[i] ? "" : "pm-collapsed"}`}
             onClick={() => setThinkOpen({...thinkOpen, [i]: !thinkOpen[i]})}>
          <div className="pm-think-head">
            {thinkOpen[i] ? "▾" : "▸"} THINKING · {e.n} thoughts
          </div>
          <div className="pm-c">
            Weighing the trade-off between guaranteed consistency and wall-clock cost.
            Option A is safest but costs six hours of background work. Option B needs a
            maintenance window I have to coordinate.
          </div>
        </div>
      );
    case "tool_use":
      return (
        <div key={i} className="pm-ev pm-tool">
          <span className="pm-ev-ts">{e.t}</span>
          <div className="pm-c">
            <span className="pm-glyph">{e.tool}</span>
            <span className="pm-args">{e.args}</span>
          </div>
        </div>
      );
    case "tool_result":
      return (
        <div key={i} className="pm-ev pm-result">
          <span className="pm-ev-ts">{e.t}</span>
          <div className="pm-c">
            <div className="pm-rhead">
              <span className="pm-rtag">{e.tag}</span>
              <span className="pm-rmeta">{e.meta}</span>
            </div>
            <div className="pm-rbody">
              {e.body.map((seg, j) => seg.c
                ? <span key={j} className={seg.c}>{seg.s}</span>
                : <span key={j}>{seg.s}</span>)}
            </div>
          </div>
        </div>
      );
    case "error":
      return (
        <div key={i} className="pm-ev pm-error">
          <span className="pm-ev-ts">{e.t}</span>
          <div className="pm-c">
            <span className="pm-etag">FAIL</span>{e.title}
            <pre>{e.detail}</pre>
          </div>
        </div>
      );
    case "question":
      return (
        <div key={i} className="pm-ev pm-question">
          <span className="pm-ev-ts">{e.t}</span>
          <div className="pm-c">
            <span className="pm-qtag">ASK</span>{e.text}
            <div className="pm-qchoices">
              {e.choices.map((c, j) => <button key={j}>{c}</button>)}
            </div>
          </div>
        </div>
      );
  }
}

/* ---------- Terminal screen ---------- */
function TerminalScreen() {
  return (
    <div className="pm-screen">
      <TopHeader title="COMMANDER" sub="CENTRAL SESSION" liveTag="CTX 82k/200k" />

      <div className="pm-term-top">
        <div className="pm-tt-title">CONSOLE · pid 48291</div>
        <div className="pm-tt-sub">SID 7F3A-9C2E-BB01 · claude-sonnet-4.5 · TURNS 147</div>
      </div>

      <div className="pm-term-body">
        <span className="pm-tl pm-tl-dim">// 4 sub-agents online · 2 slots free · fleet heartbeat OK</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl"><span className="pm-ts">14:36:41</span> <span className="pm-lbl">▸ you</span> status of FLMN-04</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl">Checking container state on host:</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl pm-tl-cyan">▸ Bash · docker ps --filter name=atc-stub</span>
        <span className="pm-tl"><span className="pm-tl-dim">&gt; </span><span style={{color:"#ff5b3e"}}>Exited (137) 4 minutes ago</span></span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl">Container was OOM-killed. Memory cap is 256MB — needs more for the full table.</span>
        <span className="pm-tl pm-tl-dim">// proposed remediation:</span>
        <span className="pm-tl">  1. <span className="pm-path">docker-compose.yml</span> — raise <span className="pm-tl-cyan">mem_limit</span> → <span className="pm-tl-amber">1g</span></span>
        <span className="pm-tl">  2. restart atc-stub</span>
        <span className="pm-tl">  3. nudge FLMN-04 to retry</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl pm-tl-dim">// shall I proceed? [y] / [n] / [d]iff-first</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl"><span className="pm-ts">14:37:22</span> <span className="pm-lbl">▸ you</span> d</span>
        <span className="pm-tl">&nbsp;</span>
        <span className="pm-tl pm-tl-dim">// awaiting confirmation…</span>
      </div>

      <div className="pm-quick">
        <button>/status</button>
        <button>/spawn</button>
        <button>/pause all</button>
        <button>/kill</button>
        <button>y</button>
        <button>n</button>
        <button>d</button>
      </div>
      <div className="pm-prompt">
        <span className="pm-lead">▸</span>
        <input type="text" placeholder="command or message…" />
        <button className="pm-send">SEND</button>
      </div>
    </div>
  );
}

/* ---------- Login screen ---------- */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9]{1,5}$/;

function LoginScreen() {
  const [servers, setServers] = useState([
    { addr: "orchestrator-01.fleet:7443", label: "kowloon-pc production", last: "+02:14",    status: "online",  agents: "4/6·1blk", proto: "WSS" },
    { addr: "10.0.14.22:7443",             label: "home lab",             last: "23:02 yd",  status: "online",  agents: "2/2",     proto: "WSS" },
    { addr: "staging.phosphor.int:7080",   label: "staging",              last: "3d ago",    status: "offline", agents: "unreach", proto: "WS"  },
    { addr: "192.0.2.10:7443",          label: "laptop local",         last: "7d ago",    status: "offline", agents: "last 7d", proto: "WSS" },
  ]);
  const [host, setHost] = useState("");
  const [step, setStep] = useState("host");
  const [current, setCurrent] = useState(null);

  const valid = HOST_RE.test(host.trim());
  const hint = host.length === 0 ? "" : (valid ? "valid · TLS handshake will follow" : "format: name:port or ip:port (1–65535)");

  const connect = (addr) => {
    setCurrent({ addr });
    setStep("connecting");
    setTimeout(() => {
      // add to list if new
      setServers(s => {
        const exists = s.find(x => x.addr === addr);
        if (exists) {
          return s.map(x => x.addr === addr ? { ...x, last: "just now", status: "online" } : x);
        }
        return [{ addr, label: "just added", last: "just now", status: "online", agents: "6 agents", proto: "WSS" }, ...s];
      });
      setStep("auth");
    }, 1800);
  };

  const remove = (addr, e) => {
    e.stopPropagation();
    setServers(s => s.filter(x => x.addr !== addr));
  };

  const [cmdHistory, setCmdHistory] = useState([]);
  const [cmdInput, setCmdInput] = useState("");

  const runCmd = (raw) => {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    let out;
    if (cmd === "?help" || cmd === "help" || cmd === "?") {
      out = { type: "help", lines: [
        "available commands:",
        "  ?help               this message",
        "  status              fleet snapshot",
        "  decode <attest-id>  ascii-render attestation bytes",
        "  whoami              operator identity",
        "  clear               clear buffer"
      ]};
    } else if (cmd === "status") {
      out = { type: "plain", lines: [
        "4 agents up · 1 blocked · 1 error · last beat 2s"
      ]};
    } else if (cmd === "whoami") {
      out = { type: "plain", lines: ["operator: k.ishikawa · clearance lvl-3 · biometric required"]};
    } else if (cmd === "clear") {
      setCmdHistory([]); setCmdInput(""); return;
    } else if (cmd.startsWith("decode")) {
      const arg = cmd.split(/\s+/)[1] || "";
      if (arg === "attest-b" || arg === "attest_b" || arg === "b") {
        out = { type: "decode", lines: [
          "reading bytes · 0x4E 45 4F 20 49 53 20 4F 4E 45",
          "ascii-render ↓"
        ]};
      } else if (arg === "attest-a" || arg === "a" || arg === "attest-c" || arg === "c") {
        out = { type: "plain", lines: ["decode: bytes are opaque hash (non-printable). try attest-b."]};
      } else {
        out = { type: "plain", lines: ["usage: decode <attest-a|attest-b|attest-c>"]};
      }
    } else {
      out = { type: "err", lines: [`shell: unknown command '${cmd}' · try ?help`]};
    }
    setCmdHistory(h => [...h, { cmd: raw, out }]);
    setCmdInput("");
  };

  const banner =
`  ██████ ██   ██ █████ ██████ ██████ ██  ██ █████ ██████
  ██  ██ ██   ██ ██  ██ ██    ██  ██ ██  ██ ██  ██ ██  ██
  ██████ █████ █ ██  ██ ██████ ██████ ██████ ██  ██ ██████
  ██     ██  ██ ██  ██     ██ ██     ██  ██ ██  ██ ██  ██
  ██     ██   █ █████  ██████ ██     ██  ██ █████  ██  ██`;

  const asciiNIO =
`  ███    ██ ███████  ██████    ██ ███████    ██████  ███    ██ ███████
  ████   ██ ██      ██    ██   ██ ██        ██    ██ ████   ██ ██
  ██ ██  ██ █████   ██    ██   ██ ███████   ██    ██ ██ ██  ██ █████
  ██  ██ ██ ██      ██    ██   ██      ██   ██    ██ ██  ██ ██ ██
  ██   ████ ███████  ██████    ██ ███████    ██████  ██   ████ ███████`;

  return (
    <div className="pm-login">
      <div className="pm-term-login">
        <span className="banner">{banner}</span>
        <span className="tl dim">  phosphor/03 · orchestrator shell · build 2026.04.19+a17c3</span>
        <span className="tl dim">  © nitro systems · not for flight</span>
        <hr className="hr"/>

        <span className="tl ok">tpm       <span className="dim">pcr#0 · 0x7F3A 9C2E BB01 4AF2 3D88</span></span>
        <span className="tl ok">attest-a  <span className="dim">0xA91B 2D44 8C71 60E3 FF02 11BD</span></span>
        <span className="tl ok">attest-b  <span className="dim">0x4E454F20 4953204F 4E45 3C9A 81DF</span></span>
        <span className="tl ok">attest-c  <span className="dim">0xD5CC 7712 9A04 E6B1 83FA 5742</span></span>
        <span className="tl ok">secure-el <span className="dim">nitro-v3 · sealed · nonce 0x7E12</span></span>
        <span className="tl ok">keyring   <span className="dim">4 endpoints · keys loaded</span></span>
        <span className="tl dim">  awaiting operator directive… <span className="amber">type ?help for shell commands</span></span>
        <hr className="hr"/>

        {step !== "auth" && <>
          <span className="tl"><span className="bright">$</span> phosphor connect &lt;host:port&gt;</span>

          <div className="prompt-line">
            <span className="lead">▸ wss://</span>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="orchestrator.fleet:7443_"
              spellCheck="false"
              autoCapitalize="none"
              autoCorrect="off"
              disabled={step === "connecting"}
            />
            {host.length === 0 && <span className="blk"></span>}
          </div>
          {host.length > 0 && (
            valid
              ? <span className="tl inline-ok">✓ {hint}</span>
              : <span className="tl inline-err">✗ {hint}</span>
          )}

          {step === "connecting" && current && <>
            <hr className="hr"/>
            <span className="tl"><span className="bright">$</span> phosphor connect <span className="cyan">{current.addr}</span></span>
            <span className="tl ok">resolve · <span className="dim">a 203.0.113.44</span></span>
            <span className="tl ok">tcp · <span className="dim">rtt 12ms</span></span>
            <span className="tl ok">tls · <span className="dim">TLS 1.3 · X25519 · ALPN=wss</span></span>
            <span className="tl"><span className="dim">  ▸ wss handshake</span> <span className="blk"></span></span>
          </>}

          <hr className="hr"/>
          <span className="tl srv-head">&nbsp;&nbsp;SAVED ENDPOINTS · <span className="amber">{servers.length}</span> · <span className="dim">tap idx to reconnect</span></span>

          {servers.map((s, i) => (
            <div key={s.addr} className="srv" onClick={() => connect(s.addr)}>
              <span className="idx">[{i+1}]</span>
              <span className="addr">
                {s.addr.split(":")[0]}<span className="port">:{s.addr.split(":")[1]}</span>
              </span>
              <span className="meta">
                {s.status === "online"
                  ? <><span className="up">● UP</span> · {s.proto} · {s.last}</>
                  : <><span className="dn">● DOWN</span> · {s.proto} · {s.last}</>}
              </span>
              <button className="del" onClick={(e) => remove(s.addr, e)} title="Remove">×</button>
              <span className="sub">  ↳ {s.label} · {s.agents}</span>
            </div>
          ))}
          <hr className="hr"/>
          <span className="tl dim">  fleet pulse → </span>
          <span className="tl" style={{marginTop:-8}}>
            <span style={{color:"#ffb347", textShadow:"0 0 6px #ffb347"}}>● </span>
            <span style={{color:"#ff2d8b", textShadow:"0 0 6px #ff2d8b"}}>● </span>
            <span style={{color:"#ffb347", textShadow:"0 0 6px #ffb347"}}>● </span>
            <span style={{color:"#ff5b3e", textShadow:"0 0 6px #ff5b3e"}}>● </span>
            <span style={{color:"#5f5c55"}}>○ </span>
            <span style={{color:"#7fd98f"}}>● </span>
            <span className="dim"> 4 up · 1 blk · 1 err</span>
          </span>
        </>}

        {step === "auth" && <>
          <span className="tl ok">connected · <span className="cyan">{current?.addr}</span></span>
          <span className="tl ok">session · <span className="dim">SID 7F3A-9C2E-BB01</span></span>
          <span className="tl ok">clearance · <span className="bright">LVL-3 FLEET COMMANDER</span></span>
          <hr className="hr"/>
          <span className="tl"><span className="bright">$</span> phosphor auth --biometric</span>
          <span className="tl dim">  awaiting fingerprint sensor…</span>

          <div style={{textAlign:"center", padding:"10px 0 4px"}}>
            <svg width="84" height="84" viewBox="0 0 64 64" fill="none" stroke="#ffb347"
                 strokeWidth="1.6" strokeLinecap="round"
                 style={{filter:"drop-shadow(0 0 8px rgba(255,179,71,0.6))"}}>
              <path d="M18 42c0-10 6-18 14-18s14 8 14 18" />
              <path d="M22 46c0-8 4-14 10-14s10 6 10 14" />
              <path d="M26 50c0-6 3-10 6-10s6 4 6 10" />
              <path d="M30 52c0-4 1-6 2-6s2 2 2 6" />
              <path d="M14 36c2-12 10-20 18-20s16 8 18 20" />
              <path d="M11 30c3-12 11-20 21-20s18 8 21 20" />
            </svg>
          </div>
          <span className="tl" style={{textAlign:"center"}}>
            <span className="bright">SCANNING</span><span className="dim">… hold steady</span>
          </span>
          <hr className="hr"/>
          <span className="tl dim">  [esc] <span className="amber" onClick={() => setStep("host")} style={{cursor:"pointer"}}>change host</span> · [p] use passphrase</span>
        </>}

        {cmdHistory.map((h, i) => (
          <div key={i}>
            <span className="tl"><span className="bright">$</span> {h.cmd}</span>
            {h.out.lines.map((l, j) => (
              <span key={j} className={`tl ${h.out.type === "err" ? "err" : h.out.type === "decode" ? "ok" : "dim"}`}>  {l}</span>
            ))}
            {h.out.type === "decode" && (
              <span className="banner" style={{color:"#baffc8", textShadow:"0 0 12px rgba(45,255,122,0.7)", margin:"4px 0 6px"}}>{asciiNIO}</span>
            )}
          </div>
        ))}

        {step !== "auth" && (
          <div className="prompt-line" style={{marginTop: 4}}>
            <span className="lead">$</span>
            <input
              type="text"
              value={cmdInput}
              onChange={e => setCmdInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") runCmd(cmdInput); }}
              placeholder="?help · status · decode attest-b"
              spellCheck="false"
              autoCapitalize="none"
              autoCorrect="off"
            />
            {cmdInput.length === 0 && <span className="blk"></span>}
          </div>
        )}

        <span className="tl">&nbsp;<span className="blk"></span></span>
      </div>
    </div>
  );
}

function LoginApp() {
  return (
    <div className="pm-root">
      <LoginScreen />
    </div>
  );
}

/* ---------- Tab bar ---------- */
function TabBar({ tab, onTab, alertCount }) {
  return (
    <div className="pm-tabs">
      <button className={"pm-tab " + (tab === "fleet" ? "pm-on" : "")} onClick={() => onTab("fleet")}>
        <span className="pm-glyph">▦</span>FLEET
        {alertCount > 0 && <span className="pm-badge">{alertCount}</span>}
      </button>
      <button className={"pm-tab " + (tab === "term" ? "pm-on" : "")} onClick={() => onTab("term")}>
        <span className="pm-glyph">▸_</span>TERMINAL
      </button>
      <button className={"pm-tab " + (tab === "activity" ? "pm-on" : "")} onClick={() => onTab("activity")}>
        <span className="pm-glyph">≡</span>ACTIVITY
      </button>
    </div>
  );
}

/* ---------- App (each screen is its own React tree inside its own device) ---------- */
function FleetApp() {
  const [opened, setOpened] = useState(null);
  return (
    <div className="pm-root">
      {opened
        ? <DetailScreen p={opened} onBack={() => setOpened(null)} />
        : <FleetScreen onOpenCard={setOpened} />}
      <TabBar tab="fleet" onTab={()=>{}} alertCount={1} />
    </div>
  );
}
function DetailApp() {
  return (
    <div className="pm-root">
      <DetailScreen p={MPROJECTS[0]} onBack={()=>{}} />
      <TabBar tab="fleet" onTab={()=>{}} alertCount={1} />
    </div>
  );
}
function TermApp() {
  return (
    <div className="pm-root">
      <TerminalScreen />
      <TabBar tab="term" onTab={()=>{}} alertCount={1} />
    </div>
  );
}

/* ---------- Mount three devices on the page ---------- */
function Canvas() {
  const wrap = (label, content, key) => (
    <div className="device-wrap" key={key}>
      <AndroidDevice width={380} height={820} dark={true}>
        {content}
      </AndroidDevice>
      <div className="label">{label}</div>
    </div>
  );
  return (
    <>
      {wrap(<><span className="amber">00</span> · LOCK · biometric gate</>, <LoginApp />, "0")}
      {wrap(<><span className="amber">01</span> · FLEET HOME · alert-first</>, <FleetApp />, "1")}
      {wrap(<><span className="amber">02</span> · AGENT DETAIL · RemotePad needs input</>, <DetailApp />, "2")}
      {wrap(<><span className="amber">03</span> · COMMANDER · central session</>, <TermApp />, "3")}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("canvas")).render(<Canvas />);
