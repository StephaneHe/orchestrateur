// ============================================================================
// public/turn-core.js — v0.31.0 : vu/acquitté, arrêt par le chef, journal
// ============================================================================
//
// UN SEUL fichier pour le navigateur (chargé en <script>) et Node (importé pour
// ses effets par fleet-status-core.mjs et server.js) : aucun import/export, il
// pose `globalThis.TurnCore`. Un script classique sans `this` de premier niveau
// est aussi un module ES valide.
//
// Trois règles partagées par tous les réducteurs d'état :
//
// 1. ACQUITTEMENT (« vu ») : un événement `notification/acknowledged` ajouté au
//    log fait passer `error` (échec ou arrêt) à `idle`. Comme la question
//    acquittée de 0.25.0, c'est un événement de log et pas un sidecar : tous
//    les réducteurs lisent déjà le log dans l'ordre, l'acquittement survit au
//    redémarrage, part par le SSE, et un nouveau tour reprend naturellement la
//    main. `unread` passe par le marqueur de lecture existant (/api/mark-read),
//    `input` par « Marquer comme répondue ».
//
// 2. ARRÊT PAR LE CHEF : `kill-stalled.mjs` clôt le tour par un result
//    `error_killed_by_conductor`. L'état reste `error` (vocabulaire verrouillé),
//    avec l'attribut additif `stopped` ({by, reason}) pour l'afficher « Arrêté
//    par le chef » et non « Échec ». Avant 0.31.0, dispatch.mjs écrivait ensuite
//    un second result (« model indisponible… le CLI a échoué ») qui masquait
//    l'arrêt : tout result qui suit un arrêt dans le même tour est ignoré.
//
// 3. JOURNAL : `createJournal()` réduit les événements, dans l'ordre, en une
//    liste de tours (demande, ce qui a été fait, issue, durée, coût, model).
//    Déterministe, aucun appel LLM. Le serveur l'utilise sur la fin du log, le
//    client y pousse ensuite les événements du SSE.
// ============================================================================
(function (g) {
  "use strict";

  function isAcknowledged(ev) {
    return !!ev && ev.type === "notification" && ev.subtype === "acknowledged";
  }
  function isQuestionResolved(ev) {
    return !!ev && ev.type === "notification" && ev.subtype === "question_resolved";
  }
  function isConductorStop(ev) {
    return !!ev && ev.type === "result" && ev.subtype === "error_killed_by_conductor";
  }
  /** Même définition que fleet-status-core.isPhantomResult (copie : le client
   *  ne peut pas importer ce module Node). */
  function isPhantomResult(ev) {
    return !!ev && ev.type === "result" && !ev.synthetic &&
      ev.num_turns === 0 && ev.duration_api_ms === 0;
  }
  function isResultError(ev) {
    return !!ev && (!!ev.is_error || (typeof ev.subtype === "string" && ev.subtype.startsWith("error")));
  }
  /** Ouverture de tour (même règle que les réducteurs d'état). */
  function isTurnStart(ev) {
    if (!ev) return false;
    return (ev.type === "user_prompt" && !ev.source) || (ev.type === "system" && ev.subtype === "init");
  }
  function stopInfo(ev) {
    const reason = typeof ev.reason === "string" && ev.reason.trim() ? ev.reason.trim() : "";
    return { by: ev.stopped_by || "chef", reason, ts: ev.timestamp || null };
  }
  // 0.47.2 — demande utilisateur : « Si il n'y a pas eu de probleme, ca n'aurait
  // pas du etre affiche en rouge ». Un arrêt VOLONTAIRE (chef, supervision,
  // essai, utilisateur) s'affiche neutre, avec son auteur et son motif.
  const STOP_BY = { chef: "par le chef", supervision: "par la supervision", test: "(essai)", utilisateur: "par l'utilisateur" };
  function stopWord(stop) {
    return `Arrêté ${STOP_BY[stop && stop.by] || (stop && stop.by ? `par ${stop.by}` : "par le chef")}`;
  }
  /** « ■ Arrêté par le chef — motif ». */
  function stopText(stop) {
    return `■ ${stopWord(stop)}${stop && stop.reason ? ` — ${stop.reason}` : ""}`;
  }
  /** Tour d'essai (dispatch.mjs --test "<libellé>") : jamais affiché en rouge. */
  function testInfo(ev) {
    const t = ev && ev.test;
    if (!t) return null;
    return { label: typeof t === "string" ? t : (t.label || "essai"), by: (t && t.by) || null };
  }

  // --------------------------------------------------------------------------
  // Résumés
  // --------------------------------------------------------------------------
  // Consignes ajoutées par le chef ou par dispatch.mjs : ce n'est pas la demande.
  const BOILERPLATE = [
    /\n\s*-{3,}\s*\n\s*Une fois ta tâche terminée[\s\S]*$/i,
    /\n\s*-{3,}\s*\n\s*RÈGLE DE FIN DE TOUR[\s\S]*$/i,
    /\n\s*RÈGLE DE FIN DE TOUR\s*:[\s\S]*$/i,
  ];
  const PREFIXES = /^\s*(\[(?:CHEF_ANSWER|ANSWER|CALLBACK_WAKE[^\]]*|NEEDS_CHEF_INPUT_FROM:[^\]]*|REPRISE)\]\s*)+/i;

  function oneLine(s, max) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  }
  function stripMd(s) {
    return String(s || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1");
  }

  /** Texte complet d'une demande, sans boilerplate ni préfixe de relais. */
  function cleanPrompt(text) {
    let t = String(text || "");
    for (const re of BOILERPLATE) t = t.replace(re, "");
    return t.replace(PREFIXES, "").trim();
  }

  // Texte complet gardé par tour (plié/déplié du journal, 0.33.0), borné : le
  // serveur garde jusqu'à 200 tours en mémoire par musicien.
  const FULL_MAX = 12000;
  function capped(text) {
    const t = String(text || "").trim();
    return t.length <= FULL_MAX ? { text: t, cut: false } : { text: t.slice(0, FULL_MAX), cut: true };
  }

  /** La demande d'un tour, sans le boilerplate, en une ligne courte. */
  function summarizePrompt(text, max = 160) {
    const t = cleanPrompt(text);
    const lines = stripMd(t).split("\n").map(s => s.trim()).filter(Boolean);
    return oneLine(lines.slice(0, 3).join(" — "), max);
  }

  /** 1 à 3 lignes de ce que le tour a produit, tirées du result. */
  function summarizeResult(text, maxLines = 3, max = 160) {
    const raw = String(text || "").replace(/^\s*NEEDS_(USER|CHEF)_INPUT\s*:.*$/gim, "");
    const lines = stripMd(raw).split("\n").map(s => s.trim())
      .filter(s => s && !/^[-=_*|:\s]+$/.test(s) && !/^\|.*\|$/.test(s));
    return lines.slice(0, maxLines).map(s => oneLine(s, max));
  }

  const URL_RE = /https?:\/\/[^\s)<>\]"'`]+/g;
  const VERSION_RE = /\b(?:v|version\s+|versionName\s*=?\s*"?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/gi;
  // Sortie de `git commit` : « [master 5bf1dde] docs: … ».
  const COMMIT_RE = /^\[([\w./-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;

  // « commit 5bf1dde », « committed it as 1f115b8 », « commité en local (e5b0408 ».
  const COMMIT_CITED_RE = /\bcommit(?:t?ed|t?é|s)?\b[^\n]{0,24}?\b(?=[0-9a-f]*\d)([0-9a-f]{7,40})\b/gi;

  function uniq(a) { return [...new Set(a)]; }
  function toolResultText(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(x => (x && typeof x.text === "string") ? x.text : "").join("\n");
    return "";
  }

  // --------------------------------------------------------------------------
  // Journal
  // --------------------------------------------------------------------------
  function createJournal(opts = {}) {
    const max = opts.max || 100;
    const turns = [];
    let cur = null;           // tour ouvert
    let pendingPrompt = null; // user_prompt sourcé en attente de son init
    let lastText = "";

    function open(ev, promptEv) {
      cur = {
        id: (promptEv && promptEv.timestamp) || ev.timestamp || null,
        start: (promptEv && promptEv.timestamp) || ev.timestamp || null,
        prompt: promptEv ? summarizePrompt(promptEv.text) : "",
        promptFull: promptEv ? capped(cleanPrompt(promptEv.text)) : null,
        resultFull: null,
        source: promptEv ? (promptEv.source || null) : null,
        model: (promptEv && promptEv.model) || null,
        provider: null,
        hasInit: ev.type === "system",
        end: null, outcome: "running", subtype: null,
        summary: [], question: "", durationMs: null, costUsd: null,
        commits: [], pushed: false, versions: [], urls: [],
        stop: null, ack: null, resolved: null, tools: 0,
        test: promptEv ? testInfo(promptEv) : null,
      };
      turns.push(cur);
      if (turns.length > max) turns.splice(0, turns.length - max);
      lastText = "";
      pendingPrompt = null;
    }

    function last() { return turns.length ? turns[turns.length - 1] : null; }

    function push(ev) {
      if (!ev || typeof ev !== "object" || ev.type === "stream_event") return;
      const t = ev.type;
      if (t === "user_prompt") {
        if (ev.source && !ev.dual) { pendingPrompt = ev; return; }
        if (cur && cur.outcome === "running") { cur.outcome = "interrupted"; cur.end = ev.timestamp || null; }
        open(ev, ev);
        // Mode double model (0.44.0) : deux branches puis la relecture, un seul tour.
        if (ev.dual) cur.dual = { run: ev.dual.run, mode: ev.dual.mode, principal: ev.dual.principal, second: ev.dual.second, sameModel: !!ev.dual.sameModel, branches: [], review: null };
        return;
      }
      if (t === "system" && typeof ev.subtype === "string" && ev.subtype.startsWith("dual_")) {
        const d = (cur && cur.dual) || (last() && last().dual);
        if (!d) return;
        if (ev.subtype === "dual_branch_done") {
          d.branches = d.branches.filter(b => b.role !== (ev.dual && ev.dual.role));
          d.branches.push({ role: ev.dual && ev.dual.role, model: ev.model, served: ev.served || null, provider: ev.provider, status: ev.status, error: ev.error || null, costUsd: ev.costUsd ?? null, durationMs: ev.durationMs ?? null, diffstat: ev.diffstat || null });
        } else if (ev.subtype === "dual_branch_failed") {
          d.secondFailed = ev.error || "échec";
        } else if (ev.subtype === "dual_review_start") {
          d.review = { model: ev.model, provider: ev.provider, status: "running" };
        } else if (ev.subtype === "dual_summary") {
          if (Array.isArray(ev.branches)) d.branches = ev.branches;
          if (ev.review) d.review = ev.review;
          if (ev.dual && ev.dual.paused) d.paused = true;
          d.archive = ev.dual && ev.dual.archive;
          d.totalMs = ev.totalMs ?? null;
        } else if (ev.subtype === "dual_interrupted") {
          d.interrupted = ev.text || "interrompue";
        }
        return;
      }
      // Demandes d'autorisation interactives (0.45.0) : chaque demande et sa
      // décision (une fois, toujours, règle, refus, expiré sans réponse).
      if ((t === "system" && ev.subtype === "permission_request") || (t === "notification" && ev.subtype === "permission_decision")) {
        const tr = cur || last();
        const p = ev.permission || {};
        if (!tr) return;
        if (!tr.permissions) tr.permissions = [];
        let e = p.id ? tr.permissions.find(x => x.id === p.id) : null;
        if (!e) { e = { id: p.id || null, tool: p.tool || "", preview: p.preview || "", decision: null }; tr.permissions.push(e); }
        if (t === "notification") Object.assign(e, { decision: p.decision || null, rule: p.rule || null, message: p.message || null, by: p.by || null });
        return;
      }
      if (t === "system" && ev.subtype === "init") {
        // Un second init dans un tour ouvert (bascule de provider) reste le même
        // tour, sauf si une nouvelle demande sourcée l'a précédé.
        if (!cur || cur.outcome !== "running" || (cur.hasInit && pendingPrompt)) {
          if (cur && cur.outcome === "running") { cur.outcome = "interrupted"; }
          open(ev, pendingPrompt);
        }
        cur.hasInit = true;
        if (ev.model) cur.model = ev.model;
        if (ev.provider) cur.provider = ev.provider;
        if (!cur.start && ev.timestamp) cur.start = ev.timestamp;
        return;
      }
      if (isAcknowledged(ev)) {
        const l = last();
        if (l) l.ack = { ts: ev.timestamp || null, by: ev.by || "", note: ev.note || "" };
        return;
      }
      if (isQuestionResolved(ev)) {
        const l = last();
        if (l) l.resolved = { ts: ev.timestamp || null, note: ev.note || "" };
        return;
      }
      if (t === "assistant") {
        if (!cur) open(ev, null);
        const m = ev.message || {};
        if (m.model && m.model !== "<synthetic>") cur.model = m.model;
        for (const b of m.content || []) {
          if (b && b.type === "text" && b.text) lastText = b.text;
          if (b && b.type === "tool_use") {
            cur.tools++;
            const cmd = b.input && typeof b.input.command === "string" ? b.input.command : "";
            if (/\bgit\b[^\n]*\bpush\b/.test(cmd)) cur.pushed = true;
          }
        }
        return;
      }
      if (t === "user" && cur) {
        for (const c of (ev.message && ev.message.content) || []) {
          if (!c || c.type !== "tool_result" || c.is_error) continue;
          const txt = toolResultText(c.content);
          if (!txt || txt.length > 200000) continue;
          let mm; COMMIT_RE.lastIndex = 0;
          while ((mm = COMMIT_RE.exec(txt)) !== null) {
            if (!cur.commits.some(x => x.sha === mm[2])) cur.commits.push({ sha: mm[2].slice(0, 7), branch: mm[1], msg: oneLine(mm[3], 90) });
          }
        }
        return;
      }
      if (t === "result") {
        if (isPhantomResult(ev)) return;
        // Un result qui suit un arrêt du chef dans le même tour (ancien
        // « model indisponible » de dispatch.mjs) ne change rien.
        const l = last();
        if ((!cur || cur.outcome !== "running") && l && l.outcome === "stopped") return;
        if (!cur || cur.outcome !== "running") open(ev, null);
        const text = typeof ev.result === "string" ? ev.result : "";
        const needs = /^NEEDS_USER_INPUT:\s*(.*)$/m.exec(lastText || text);
        const asksChef = /NEEDS_CHEF_INPUT:/i.test(lastText) || /NEEDS_CHEF_INPUT:/i.test(text);
        cur.subtype = typeof ev.subtype === "string" ? ev.subtype : null;
        if (isConductorStop(ev)) { cur.outcome = "stopped"; cur.stop = stopInfo(ev); }
        else if (isResultError(ev) && ev.synthetic) cur.outcome = "system";
        else if (isResultError(ev)) cur.outcome = "error";
        else if (needs) { cur.outcome = "question"; cur.question = oneLine(needs[1], 240); }
        else if (asksChef) cur.outcome = "ask_chef";
        else cur.outcome = "ok";
        cur.durationMs = Number.isFinite(ev.duration_ms) && ev.duration_ms > 0 ? ev.duration_ms : null;
        cur.costUsd = Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
        if (ev.model) cur.model = ev.model;
        if (ev.provider) cur.provider = ev.provider;
        cur.end = ev.timestamp || (cur.start && cur.durationMs ? new Date(Date.parse(cur.start) + cur.durationMs).toISOString() : null);
        if (!cur.durationMs && cur.start && ev.timestamp) {
          const d = Date.parse(ev.timestamp) - Date.parse(cur.start);
          if (Number.isFinite(d) && d >= 0) cur.durationMs = d;
        }
        // Un result vide ou laconique (« ok ») : le dernier texte en dit plus.
        const served = text.trim().length >= 20 || !lastText ? (text || lastText) : lastText;
        cur.summary = cur.outcome === "stopped"
          ? [cur.stop.reason || "arrêté par la supervision du chef"]
          : summarizeResult(served);
        cur.resultFull = served.trim() ? capped(served) : null;
        // Commits, versions et URL : dans le result ET dans le dernier texte de
        // l'assistant (le result du CLI ne le reprend pas toujours).
        const body = text === lastText ? text : `${text}\n${lastText}`;
        // `git commit -q` n'affiche rien : le musicien cite souvent le SHA.
        for (const mm of body.matchAll(COMMIT_CITED_RE)) {
          const sha = mm[1].slice(0, 7);
          if (!cur.commits.some(x => x.sha === sha)) cur.commits.push({ sha, branch: "", msg: "" });
        }
        cur.commits = cur.commits.slice(0, 5);
        cur.versions = uniq([...body.matchAll(VERSION_RE)].map(x => x[1])).slice(0, 4);
        cur.urls = uniq((body.match(URL_RE) || []).map(u => u.replace(/[.,;:!?]+$/, ""))).slice(0, 4);
        cur = null;
        lastText = "";
      }
    }

    return {
      push,
      /** Du plus récent au plus ancien. */
      list() { return turns.slice().reverse(); },
      get size() { return turns.length; },
    };
  }

  g.TurnCore = {
    isAcknowledged, isQuestionResolved, isConductorStop, isPhantomResult,
    isResultError, isTurnStart, stopInfo, stopWord, stopText, testInfo,
    summarizePrompt, summarizeResult, cleanPrompt, createJournal, FULL_MAX,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
