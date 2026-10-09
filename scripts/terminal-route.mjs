// ============================================================================
// scripts/terminal-route.mjs — routing of the interactive central terminal
// (/ws/pty) through the pipelines (phase 5, 0.52.0)
// ============================================================================
//
// User decision n° 1: "the interactive terminal can be a discussion as well as
// an instruction for a development. It must go through the router too. If no
// classification is possible, consider it a discussion."
//
// When `enforcement.terminal` is on:
//   - the central claude is started as a read-only Discussion (plan mode, no
//     write or shell tool) — see discussionArgs();
//   - every validated line is classified; a discussion line goes to the
//     terminal unchanged, an ACTION line is held (its Enter is not sent) until
//     the user confirms: run it as a pipeline execution, send it to the
//     terminal as a discussion anyway, or cancel;
//   - direct shell lines (`!…`) and memory writes (`#…`) would bypass the
//     read-only session: they are never sent, only run (as a pipeline) or
//     cancelled.
// Control frames to the client are OSC sequences (ESC ] 1337 ; OrchRoute=
// <base64 JSON> BEL): a terminal that does not know them ignores them.
// ============================================================================

export const ROUTE_OSC_PREFIX = '\x1b]1337;OrchRoute=';
export const HOLD_TIMEOUT_MS = 5 * 60_000;

/** Flags that make the central claude a read-only Discussion. */
export function discussionArgs() {
  return [
    '--permission-mode', 'plan',
    '--disallowed-tools', 'Edit,Write,NotebookEdit,Bash,PowerShell',
    '--append-system-prompt',
    'This terminal is routed through the orchestrator pipelines: this session is a read-only Discussion. ' +
      'Never modify files. When the user asks for a change, tell them the orchestrator will offer to run it as a pipeline execution.',
  ];
}

export function encodeFrame(obj) {
  return `${ROUTE_OSC_PREFIX}${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}\x07`;
}
export function decodeFrames(text) {
  const out = [];
  const re = /\x1b\]1337;OrchRoute=([A-Za-z0-9+/=]+)\x07/g;
  let m;
  while ((m = re.exec(String(text)))) { try { out.push(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))); } catch { /* skip */ } }
  return out;
}

/** Target of a terminal line: « @projet … » or « projet : … », else the chef. */
export function targetOf(line, projects, conductor) {
  const m = /^@(\S+)\s*/.exec(line) || /^([A-Za-z][\w.-]{1,30})\s*:\s+/.exec(line);
  const p = m && (projects || []).find(x => x.name.toLowerCase() === m[1].toLowerCase() && x.name !== conductor);
  return p ? { project: p.name, text: line.slice(m[0].length).trim() || line } : { project: conductor, text: line };
}

/**
 * Byte-level router for one websocket. feed() returns the bytes to write to
 * the pty now, and a held line (if any). While a line is held, later input is
 * queued; resolve() returns the decision byte and releases the queue.
 */
export class TerminalRouter {
  constructor({ classify, max = 4000 } = {}) {
    this.classify = classify;
    this.buf = '';
    this.max = max;
    this.inPaste = false;
    this.pending = null;   // { id, line, classification, shell }
    this.queued = '';
    this.seq = 0;
  }

  feed(data) {
    let s = String(data ?? '');
    if (this.pending) { this.queued += s; return { forward: '', hold: null }; }
    let forward = '';
    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      if (rest.startsWith('\x1b[200~')) { this.inPaste = true; forward += '\x1b[200~'; i += 6; continue; }
      if (rest.startsWith('\x1b[201~')) { this.inPaste = false; forward += '\x1b[201~'; i += 6; continue; }
      const esc = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O[A-Za-z]|.)/.exec(rest);
      if (esc) { forward += esc[0]; i += esc[0].length; continue; }
      const ch = s[i];
      if ((ch === '\r' || ch === '\n') && !this.inPaste) {
        const line = this.buf.trim();
        this.buf = '';
        const verdict = line ? this.judge(line) : null;
        if (verdict) {
          this.pending = { id: `t${Date.now().toString(36)}${(++this.seq).toString(36)}`, line, ...verdict };
          this.queued = s.slice(i + 1);
          return { forward, hold: this.pending };
        }
        forward += ch; i++; continue;
      }
      if (ch === '\x7f' || ch === '\b') this.buf = this.buf.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') this.buf = '';
      else if ((ch === '\r' || ch === '\n') && this.inPaste) this.buf += ' ';
      else if (ch >= ' ' || ch === '\t') { if (this.buf.length < this.max) this.buf += ch; }
      forward += ch; i++;
    }
    return { forward, hold: null };
  }

  /** null = a discussion line (send it); otherwise why it is held. */
  judge(line) {
    if (/^[!#]/.test(line)) return { shell: true, classification: { pipeline: 'dev', mode: 'leger', reasons: ['commande directe (shell ou mémoire) : interdite en Discussion'] } };
    const c = this.classify(line);
    if (!c || c.unclassifiable || c.pipeline === 'discussion') return null;
    return { shell: false, classification: c };
  }

  /** Decision on the held line: 'run' | 'discuss' | 'cancel'. */
  resolve(id, action) {
    if (!this.pending || this.pending.id !== id) return null;
    const held = this.pending;
    const act = held.shell && action === 'discuss' ? 'cancel' : action;
    this.pending = null;
    // Enter for a discussion; Ctrl+U clears the typed line otherwise.
    const decision = act === 'discuss' ? '\r' : '\x15';
    const queued = this.queued;
    this.queued = '';
    const next = this.feed(queued);
    return { held, action: act, forward: decision + next.forward, hold: next.hold };
  }
}
