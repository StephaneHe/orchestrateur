// ============================================================================
// public/pupitre-detail.js — shared "open row" event-stream renderer.
// ============================================================================
//
// SINGLE SOURCE OF TRUTH for the /pupitre detail-drawer body: the labelled
// event blocks (prompt · texte · réflexion · outil · résultat outil · tour
// terminé · échec · système) with token-level streaming, clamp-to-fold, and
// pin-to-bottom. Used by BOTH:
//   - /pupitre  (server.js pupitrePageHtml() → #d-body)
//   - the dashboard focused card (public/app.js → .pf-main-stream)
// so an "opened /pupitre row" and a focused card's pf-main render identically.
//
// create(container, opts) → instance
//   container   : element the .e-* blocks are appended to
//   opts.scrollEl : element to scroll / pin (defaults to container). Lets the
//                   append-target be nested inside a different scroll parent
//                   (pf-main appends into .pf-main-stream but scrolls .pf-main).
//   opts.maxNodes : ring cap before oldest blocks are trimmed (default 600)
//   opts.onCount  : callback(n) whenever the visible block count changes
//   opts.pinned   : start pinned to bottom (default true)
//
// instance API: addEvent(raw) · onLive(raw) · endAllBlocks() · reset() ·
//               setPinned(b) · getPinned() · atBottom() · stick()
// ============================================================================
(function (global) {
  function create(container, opts) {
    opts = opts || {};
    var scrollEl = opts.scrollEl || container;
    var maxNodes = opts.maxNodes || 600;
    var onCount = typeof opts.onCount === 'function' ? opts.onCount : null;
    var pinned = (opts.pinned !== false);
    var blocks = {};   // stream content-block index → { wrap, body }
    var count = 0;

    // Real event timestamps, not a render clock. Several raw Claude CLI event
    // types (system/init, result, stream_event, rate_limit_event, tool_progress)
    // never carry a top-level `timestamp` field — verified against live logs:
    // user_prompt/assistant/user(tool_result)/notification always have one,
    // the rest never do. For those we carry forward the most recent REAL
    // timestamp seen in this same stream (they land within the same turn,
    // usually the same second) rather than fabricate `new Date()` at render
    // time. `tsOf` both resolves and updates that carried-forward value.
    var lastTs = null;
    function tsOf(raw) {
      var t = raw && raw.timestamp;
      if (typeof t === 'string' && t) { lastTs = t; return t; }
      return lastTs;
    }
    function fmtTs(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      function p2(n) { return String(n).padStart(2, '0'); }
      return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' +
             p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    }

    function atBottom() { return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 48; }
    function stick() { if (pinned) scrollEl.scrollTop = scrollEl.scrollHeight; }
    // stick() reads scrollHeight → forced synchronous reflow. During token-level
    // streaming that ran once PER delta (hundreds/sec). Coalesce to 1×/frame.
    var stickScheduled = false;
    var raf = global.requestAnimationFrame ? global.requestAnimationFrame.bind(global) : function (f) { return setTimeout(f, 16); };
    function scheduleStick() {
      if (stickScheduled) return;
      stickScheduled = true;
      raf(function () { stickScheduled = false; stick(); });
    }
    function bump() {
      count++;
      if (onCount) onCount(count);
      while (container.childNodes.length > maxNodes) container.removeChild(container.firstChild);
      scheduleStick();
    }

    function mkEvent(cls, label, text, clamp, ts) {
      var wrap = document.createElement('div');
      wrap.className = 'e ' + cls + (clamp ? ' clamp' : '');
      var tsText = fmtTs(ts);
      if (label || tsText) {
        var lab = document.createElement('span');
        lab.className = 'e-label';
        if (tsText) {
          var tsSpan = document.createElement('span');
          tsSpan.className = 'e-ts';
          tsSpan.textContent = tsText;
          lab.appendChild(tsSpan);
          if (label) lab.appendChild(document.createTextNode('  ' + label));
        } else {
          lab.textContent = label;
        }
        wrap.appendChild(lab);
      }
      var body = document.createElement('span');
      body.textContent = text || '';
      wrap.appendChild(body);
      if (clamp) wrap.addEventListener('click', function () { wrap.classList.toggle('open'); });
      container.appendChild(wrap);
      bump();
      return { wrap: wrap, body: body };
    }

    function preview(v, max) {
      var t = (typeof v === 'string') ? v : JSON.stringify(v);
      t = (t == null) ? '' : String(t);
      return t.length > max ? t.slice(0, max) + ' …' : t;
    }

    // --- token-level streaming (stream_event lines) ---
    function startBlock(idx, kind, prefix, ts) {
      var cls = (kind === 'thinking') ? 'e-think' : (kind === 'tool' ? 'e-tool' : 'e-text');
      var lab = (kind === 'thinking') ? 'reflexion' : (kind === 'tool' ? 'outil' : 'texte');
      var n = mkEvent(cls, lab, prefix || '', false, ts);
      n.wrap.classList.add('streaming');
      blocks[idx] = n;
    }
    function pushDelta(idx, txt) {
      if (!blocks[idx]) startBlock(idx, 'text', '');
      blocks[idx].body.textContent += txt;
      scheduleStick();
    }
    function endBlock(idx) {
      if (blocks[idx]) {
        blocks[idx].wrap.classList.remove('streaming');
        if (blocks[idx].body.textContent.length > 700) {
          var w = blocks[idx].wrap;
          w.classList.add('clamp');
          w.addEventListener('click', function () { w.classList.toggle('open'); });
        }
        delete blocks[idx];
      }
    }
    function endAllBlocks() { for (var k in blocks) endBlock(k); blocks = {}; }

    // --- consolidated events (everything that is not a stream_event) ---
    function addEvent(raw) {
      var t = raw && raw.type;
      var ts = tsOf(raw);
      if (t === 'user_prompt') { mkEvent('e-prompt', 'prompt', raw.text || '', true, ts); return; }
      if (t === 'assistant') {
        var cb = (raw.message && raw.message.content) || [];
        for (var i = 0; i < cb.length; i++) {
          var b = cb[i];
          if (!b) continue;
          if (b.type === 'text' && b.text) mkEvent('e-text', 'texte', b.text, true, ts);
          else if (b.type === 'thinking' && b.thinking) mkEvent('e-think', 'reflexion', b.thinking, true, ts);
          else if (b.type === 'tool_use') mkEvent('e-tool', 'outil', '⚙ ' + (b.name || '?') + '  ' + preview(b.input, 1500), true, ts);
        }
        return;
      }
      if (t === 'user') {
        var c = (raw.message && raw.message.content) || [];
        for (var j = 0; j < c.length; j++) {
          var tr = c[j];
          if (!tr || tr.type !== 'tool_result') continue;
          var payload = tr.content;
          if (Object.prototype.toString.call(payload) === '[object Array]') {
            var parts = [];
            for (var k2 = 0; k2 < payload.length; k2++) parts.push((payload[k2] && payload[k2].text) || '');
            payload = parts.join('\n');
          }
          mkEvent('e-result', 'resultat outil', preview(payload, 6000), true, ts);
        }
        return;
      }
      if (t === 'result') {
        var err = !!raw.is_error;
        var meta = [];
        if (raw.num_turns != null) meta.push(raw.num_turns + ' tours');
        if (raw.duration_ms != null) meta.push(Math.round(raw.duration_ms / 1000) + 's');
        mkEvent(err ? 'e-error' : 'e-done',
          (err ? 'echec' : 'tour termine') + (meta.length ? ' · ' + meta.join(' · ') : ''),
          raw.result || raw.error || raw.subtype || '', true, ts);
        return;
      }
      if (t === 'system') {
        var st = raw.subtype || '';
        if (st === 'init') mkEvent('e-sys', 'init', (raw.model || '') + (raw.provider ? ' · ' + raw.provider : ''), false, ts);
        else if (st === 'task_started') mkEvent('e-sys', 'tache lancee', raw.description || '', false, ts);
        else if (st === 'task_notification') mkEvent('e-sys', 'tache ' + (raw.status || ''), raw.summary || raw.description || '', false, ts);
        return;   // status / thinking_tokens: pure noise, dropped
      }
      if (t === 'notification') { mkEvent('e-sys', raw.source || 'notification', raw.text || '', true, ts); return; }
    }

    // Live line: for Claude, text/thinking/tool args arrive as stream_event
    // deltas AND again in the consolidated 'assistant' event — render the deltas
    // (the whole point of a live view) and drop the duplicate assistant. BUT the
    // Codex adapter (and Claude after an SSE gap) can emit an 'assistant' with NO
    // preceding deltas: dropping it unconditionally lost that content. So we only
    // drop the assistant when at least one streaming block was actually rendered
    // for the current message; otherwise we render the consolidated event.
    var streamedThisMsg = false;
    function onLive(raw) {
      if (raw.type === 'stream_event') {
        var ev = raw.event || {}, k = ev.type;
        var ts = tsOf(raw);   // stream_event itself has no timestamp; carries the last real one forward
        if (k === 'content_block_start') {
          var b = ev.content_block || {};
          if (b.type === 'thinking') { startBlock(ev.index, 'thinking', '', ts); streamedThisMsg = true; }
          else if (b.type === 'text') { startBlock(ev.index, 'text', '', ts); streamedThisMsg = true; }
          else if (b.type === 'tool_use') { startBlock(ev.index, 'tool', '⚙ ' + (b.name || '?') + '  ', ts); streamedThisMsg = true; }
        } else if (k === 'content_block_delta') {
          var d = ev.delta || {};
          var txt = d.text || d.thinking || d.partial_json || '';
          if (txt) { pushDelta(ev.index, txt); streamedThisMsg = true; }
        } else if (k === 'content_block_stop') { endBlock(ev.index); }
        else if (k === 'message_stop') { endAllBlocks(); }
        return;
      }
      if (raw.type === 'assistant') {
        // Only a duplicate if its blocks were already streamed live.
        if (!streamedThisMsg) addEvent(raw);
        streamedThisMsg = false;   // one assistant closes one message
        return;
      }
      if (raw.type === 'result') streamedThisMsg = false;   // turn boundary
      addEvent(raw);
    }

    function reset() { container.innerHTML = ''; blocks = {}; count = 0; if (onCount) onCount(0); }

    return {
      addEvent: addEvent,
      onLive: onLive,
      endAllBlocks: endAllBlocks,
      reset: reset,
      setPinned: function (v) { pinned = !!v; },
      getPinned: function () { return pinned; },
      atBottom: atBottom,
      stick: stick,
    };
  }

  global.PupitreDetail = { create: create };
})(window);
