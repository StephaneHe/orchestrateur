// ============================================================================
// public/pupitre-row.js — shared "one musician, right now" row renderer.
// ============================================================================
//
// SINGLE SOURCE OF TRUTH for turning one /api/pupitre fleet entry into markup.
// Used by BOTH:
//   - /pupitre, the live desk view (server.js pupitrePageHtml())
//   - the dashboard's focused-musician overlay (public/app.js)
// so a card's live strip and a /pupitre row can never show different data or
// different visuals for the same musician. Plain global script, no build
// step, no framework — matches the rest of the fleet's "no CDN" convention.
// ============================================================================
(function (global) {
  function esc(s) {
    s = (s == null ? '' : String(s));
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtAge(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0');
    var h = Math.floor(m / 60);
    return h + 'h' + String(m % 60).padStart(2, '0');
  }

  function stateInfo(r) {
    // A confirmed-dead producer is stronger evidence than mere silence, so it
    // must win over "sans progrès" (STALLED). The data-state key stays 'stalled'
    // for both — only the visible label changes (state vocabulary is locked).
    if (r.deadInFlight) return { k: 'stalled', label: 'PID MORT', cls: 'st-stalled' };
    if (r.stalled) return { k: 'stalled', label: 'SANS PROGRÈS', cls: 'st-stalled' };
    switch (r.state) {
      case 'live':   return { k: 'live',   label: 'EN COURS',        cls: 'st-live' };
      case 'think':  return { k: 'think',  label: 'RÉFLEXION',       cls: 'st-think' };
      case 'input':  return { k: 'input',  label: 'RÉPONSE REQUISE', cls: 'st-input' };
      case 'error':  return { k: 'error',  label: 'ÉCHEC',           cls: 'st-error' };
      case 'unread': return { k: 'unread', label: 'TERMINÉ · non lu', cls: 'st-unread' };
      default:       return { k: 'idle',   label: 'PRÊT',            cls: 'st-idle' };
    }
  }

  // Sort priority: stalled/dead first, then error, then needs-input, then
  // in-flight, then unread, idle last. Mirrors fleet-status-core's stall
  // signal — see scripts/fleet-status-core.mjs for the underlying derivation.
  function rank(r) {
    if (r.stalled || r.deadInFlight) return 0;
    if (r.state === 'error') return 1;
    if (r.state === 'input') return 2;
    if (r.state === 'live' || r.state === 'think') return 3;
    if (r.state === 'unread') return 4;
    return 5;
  }

  /**
   * Build the '.row' markup for one fleet entry (as returned by /api/pupitre).
   * `elapsedMs` extrapolates the turn/silence counters between snapshots —
   * pass `performance.now() - recvPerf` for a smooth per-second tick, or 0
   * right after a fresh fetch.
   * `opts.clickable` (default true) toggles the pointer cursor used by
   * /pupitre's detail drawer; the card-overlay strip passes false since it
   * already sits inside a focused panel.
   * `opts.selected` adds the 'sel' class /pupitre uses for the active row.
   */
  function rowHtml(r, elapsedMs, opts) {
    elapsedMs = elapsedMs || 0;
    opts = opts || {};
    var si = stateInfo(r);
    var dispTurn = (r.turnElapsedMs != null) ? fmtAge(r.turnElapsedMs + elapsedMs) : '—';
    var dispSilent = fmtAge(r.silentMs + elapsedMs);
    var pid = r.pid ? (r.pid + (r.pidAlive === false ? ' ✗' : (r.pidAlive ? ' ✓' : ''))) : '—';
    var mp = [(r.provider || r.configProvider || ''), (r.model || r.configModel || '')].filter(Boolean).join(' · ');
    var badges = '';
    if (r.isConductor) badges += '<span class="badge badge-chef">CHEF</span>';
    var note = r.needsInput ? ('<span class="note">↳ ' + esc(r.needsInput) + '</span>') : '';
    var cls = 'row ' + si.cls + (opts.selected ? ' sel' : '');
    var styleAttr = (opts.clickable === false) ? ' style="cursor:default"' : '';
    return '<div class="' + cls + '" data-state="' + si.k + '" data-name="' + esc(r.name) + '"' + styleAttr + '>'
      + '<div class="cell-state"><span class="dot"></span><span class="stlabel">' + si.label + '</span></div>'
      + '<div class="cell-name">' + esc(r.name) + badges + '</div>'
      + '<div class="cell-act"><span class="kind">' + esc(r.lastKind) + '</span> <span class="prev">' + esc(r.activity || '') + '</span>' + note + '</div>'
      + '<div class="cell-turn" title="temps sur le tour courant">' + dispTurn + '</div>'
      + '<div class="cell-silence" title="silence depuis le dernier progres reel">' + dispSilent + '</div>'
      + '<div class="cell-pid" title="PID vivant/mort">' + esc(pid) + '</div>'
      + '<div class="cell-mp">' + esc(mp) + '</div>'
      + '</div>';
  }

  global.PupitreRow = { esc: esc, fmtAge: fmtAge, stateInfo: stateInfo, rank: rank, rowHtml: rowHtml };
})(window);
