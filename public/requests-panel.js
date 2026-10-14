/* ==========================================================================
   public/requests-panel.js — "🧭 Requêtes" tab of the side panel (0.100.0)
   --------------------------------------------------------------------------
   User request (2026-10-14): « Je parle de voir comment une requete
   utilisateur a ete decoupee en taches atomiques, et voir le progres de ces
   taches, meme detachees. On avait fait le contstat qu'elles n'etaient pas
   visible actuellement ».
   One block per request to the chef (a Routage run): the request, then its
   atomic tasks as a map — one column per dependency level, a line from each
   task to the task it waits for (« après »), one colour per state — and the
   state of each task NOW, wherever it went (queue, waiting list, musician's
   turn, pipeline run, chef). Click a request or a task for its full detail.
   Design: the « carte du Routage » recommended by the web study of
   2026-10-14 (columns linked by dependencies, as GitHub Actions; stacked
   columns with « après n° k » on a phone). READ-ONLY: GET /api/requests.
   ========================================================================== */
(function () {
  "use strict";
  if (!globalThis.SidePanel) return;
  const LS_ALL = "requests.all";
  const st = { pane: null, data: null, timer: null, error: null, loading: false };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } };
  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  const md = (t) => typeof globalThis.mdToHtml === "function" ? globalThis.mdToHtml(t) : esc(t).replace(/\n/g, "<br>");

  const ICON = { attente: "⏳", bloquee: "⛔", file: "☰", lancee: "↗", en_cours: "▶", pause: "⏸", question: "?", terminee: "✓",
    echouee: "✕", arretee: "■", abandonnee: "⊘", renvoyee: "↩", action: "⚙", non_lancee: "–", doublon: "≡", a_dispatcher: "…", introuvable: "⚠" };
  const RUN_WORD = { running: "en cours", paused: "en pause", done: "terminée", failed: "en échec", interrupted: "interrompue", abandoned: "abandonnée" };
  const ROUTAGE = { running: "Routage en cours", paused: "Routage en pause", done: "découpée", failed: "Routage en échec", interrupted: "Routage interrompu", abandoned: "Routage abandonné" };
  const when = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const showAll = () => lsGet(LS_ALL) === "1";

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const r = await fetch("/api/requests?n=25");
      if (!r.ok) throw httpError(r.status);
      st.data = await r.json();
      st.error = null;
    } catch (e) {
      st.error = e.status ? await SidePanel.explainFailure(e.status, "Requêtes") : `Requêtes indisponibles : ${e.message}`;
    } finally { st.loading = false; }
    render();
  }

  function summary(q) {
    const by = {};
    for (const t of q.tasks) by[t.tone] = (by[t.tone] || 0) + 1;
    const words = { ok: ["terminée", "terminées"], live: ["en cours", "en cours"], input: ["attend une réponse", "attendent une réponse"], wait: ["en attente", "en attente"],
      chef: ["au chef", "au chef"], bad: ["en échec", "en échec"], neutral: ["sans suite", "sans suite"] };
    const parts = Object.keys(words).filter(k => by[k])
      .map(k => `<span class="rq-sum" data-tone="${k}">${by[k]} ${words[k][by[k] > 1 ? 1 : 0]}</span>`);
    return parts.join(" ");
  }

  function progressHtml(t) {
    const p = t.pipelineRun;
    if (!p || !p.steps) return "";
    const pct = Math.round((100 * p.done) / p.steps);
    return `<div class="rq-progress" title="${esc(`${p.pipeline} ${p.run} : ${p.done}/${p.steps} étapes${p.current ? `, étape « ${p.current} »` : ""}`)}">
      <span class="rq-bar"><span style="width:${pct}%"></span></span><span class="rq-steps">${p.done}/${p.steps}${p.current ? ` · ${esc(p.current)}` : ""}</span></div>`;
  }

  function taskHtml(q, t) {
    return `<button type="button" class="rq-task" data-run="${esc(q.run)}" data-n="${t.n}" data-state="${esc(t.state)}" data-tone="${esc(t.tone)}"${t.apres ? ` data-apres="${t.apres}"` : ""}
        aria-haspopup="dialog" title="${esc(`${t.n} « ${t.titre} » — ${t.stateLabel} : ${t.detail || ""}`)}">
      <span class="rq-task-head"><span class="rq-icon" aria-hidden="true">${ICON[t.state] || "·"}</span><span class="rq-n">${t.n}</span><span class="rq-title">${esc(t.titre)}</span></span>
      <span class="rq-task-meta"><span class="rq-project">${esc(t.projet || "—")}</span><span class="rq-state">${esc(t.stateLabel)}</span>${t.released ? `<span class="rq-detached" title="Lancée plus tard, à la fin de la tâche attendue">détachée</span>` : ""}</span>
      ${t.apres ? `<span class="rq-after">après n° ${t.apres}</span>` : ""}
      ${progressHtml(t)}
      <span class="rq-detail">${esc(t.detail || "")}</span></button>`;
  }

  function mapHtml(q) {
    if (!q.tasks.length) {
      const why = q.aucunDispatch || (q.questions[0] ? `question posée : ${q.questions[0]}` : q.nature === "reponse" ? "réponse du chef, sans tâche" : q.nature === "question" ? "le chef a posé une question" : q.routageStatus === "running" ? "découpage en cours…" : "aucune tâche");
      return `<p class="rq-none">${esc(why)}</p>`;
    }
    const cols = [];
    for (const t of q.tasks) (cols[t.level] ||= []).push(t);
    return `<div class="rq-map" data-run="${esc(q.run)}"><svg class="rq-links" aria-hidden="true"></svg>${cols.map((c, i) =>
      `<div class="rq-col" data-level="${i}">${(c || []).map(t => taskHtml(q, t)).join("")}</div>`).join("")}</div>`;
  }

  function requestHtml(q) {
    return `<section class="rq-request" data-run="${esc(q.run)}" data-origin="${esc(q.origin)}" data-open="${q.open}">
      <button type="button" class="rq-head" data-rq-request="${esc(q.run)}" aria-haspopup="dialog" title="Voir la requête complète et le détail de chaque tâche">
        <span class="rq-when">${esc(when(q.createdAt))}</span>
        <span class="rq-text">${q.origin === "relais" ? `<span class="rq-relay">relais</span> ` : ""}${esc(q.requestHead || "(requête vide)")}</span>
        <span class="rq-meta">${esc(ROUTAGE[q.routageStatus] || q.routageStatus || "")}${q.total ? ` · ${q.total} tâche${q.total > 1 ? "s" : ""}` : ""} ${summary(q)}</span>
      </button>${mapHtml(q)}</section>`;
  }

  function visible() {
    const all = st.data?.requests || [];
    return showAll() ? all : all.filter(q => q.tasks.length && q.origin === "utilisateur");
  }

  function render() {
    const pane = st.pane;
    if (!pane) return;
    pane.querySelector(".rq-all").checked = showAll();
    const body = pane.querySelector(".rq-body");
    if (st.error && !st.data) { body.innerHTML = `<p class="rq-empty rq-unavailable">${esc(st.error)}</p>`; return; }
    if (!st.data) { body.innerHTML = `<p class="rq-empty">Chargement…</p>`; return; }
    if (st.data.ok === false) { body.innerHTML = `<p class="rq-empty">Lecture impossible : ${esc(st.data.error || "?")}</p>`; return; }
    const list = visible();
    const hidden = (st.data.requests || []).length - list.length;
    body.innerHTML = (list.length ? list.map(requestHtml).join("") : `<p class="rq-empty">Aucune requête découpée en tâches parmi les ${(st.data.requests || []).length} dernières.</p>`)
      + (hidden > 0 ? `<p class="rq-hidden">${hidden} requête${hidden > 1 ? "s" : ""} sans tâche ou relayée${hidden > 1 ? "s" : ""} masquée${hidden > 1 ? "s" : ""} — cocher « tout afficher ».</p>` : "");
    requestAnimationFrame(drawLinks);
    if (ov.el && !ov.el.hidden) fillDetail();
  }

  /* Lines from each task to the one it waits for, drawn once laid out (the
     columns wrap on a phone: there the « après n° k » label says it). */
  function drawLinks() {
    for (const map of st.pane?.querySelectorAll(".rq-map") || []) {
      const svg = map.querySelector(".rq-links");
      if (!svg) continue;
      const box = map.getBoundingClientRect();
      svg.setAttribute("width", map.scrollWidth); svg.setAttribute("height", map.scrollHeight);
      const paths = [];
      for (const el of map.querySelectorAll(".rq-task[data-apres]")) {
        const dep = map.querySelector(`.rq-task[data-n="${CSS.escape(el.dataset.apres)}"]`);
        if (!dep) continue;
        const a = dep.getBoundingClientRect(), b = el.getBoundingClientRect();
        if (b.left < a.right) continue;
        const x1 = a.right - box.left + map.scrollLeft, y1 = a.top + a.height / 2 - box.top + map.scrollTop;
        const x2 = b.left - box.left + map.scrollLeft, y2 = b.top + b.height / 2 - box.top + map.scrollTop;
        const mx = (x1 + x2) / 2;
        paths.push(`<path class="rq-link" marker-end="url(#rq-arrow)" data-tone="${esc(el.dataset.tone)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`);
      }
      svg.innerHTML = `<defs><marker id="rq-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="rq-arrow"/></marker></defs>${paths.join("")}`;
    }
  }

  /* ---- detail window ------------------------------------------------------ */
  const ov = { el: null, run: null, n: null, opener: null };
  function overlayEl() {
    if (ov.el) return ov.el;
    const el = document.createElement("div");
    el.id = "requests-overlay";
    el.hidden = true;
    el.innerHTML = `<div class="rqo-backdrop" data-rqo-close></div>
      <section class="rqo-box" role="dialog" aria-modal="true" aria-labelledby="rqo-title">
        <header class="rqo-head"><h3 id="rqo-title" class="rqo-title"></h3>
          <button type="button" class="rqo-close" data-rqo-close aria-label="Fermer">✕</button></header>
        <div class="rqo-body"></div></section>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-rqo-close]")) { closeDetail(true); return; }
      const t = e.target.closest("[data-rqo-task]");
      if (t) { ov.n = Number(t.dataset.rqoTask); fillDetail(); }
    });
    document.body.appendChild(el);
    // Capture: Escape closes the window, not the side panel behind it.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.el && !ov.el.hidden) { e.preventDefault(); e.stopPropagation(); closeDetail(true); } }, true);
    return (ov.el = el);
  }
  const row = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : "");
  function taskDetail(q, t) {
    const p = t.pipelineRun;
    return `<article class="rqo-task" data-tone="${esc(t.tone)}" data-state="${esc(t.state)}">
      <h4>${ICON[t.state] || "·"} Tâche ${t.n} « ${esc(t.titre)} »</h4>
      <dl class="rqo-dl">
        ${row("État", `<b>${esc(t.stateLabel)}</b> — ${esc(t.detail || "")}`)}
        ${row("Musicien", esc(t.projet || "—"))}
        ${row("Après", t.apres ? `<button type="button" class="rqo-link" data-rqo-task="${t.apres}">tâche ${t.apres}</button>` : "")}
        ${row("Pipeline", t.pipeline ? esc(`${t.pipeline}${t.mode ? ` (${t.mode})` : ""}`) : "")}
        ${row("Exécution", p ? esc(`${p.run} — ${RUN_WORD[p.status] || p.status || "?"}, ${p.done}/${p.steps} étapes${p.current ? `, « ${p.current} »` : ""}`) : "")}
        ${row("Reprise de", t.reprise ? esc(t.reprise) : "")}
        ${row("Lancée", t.launchedAt ? esc(`${when(t.launchedAt)}${t.released ? " (libérée à la fin de la tâche attendue)" : ""}`) : "")}
        ${row("Commencée", t.since ? esc(when(t.since)) : "")}
        ${row("Finie", t.endedAt ? esc(when(t.endedAt)) : "")}
        ${row("En attente", t.pendingId ? esc(`entrée ${t.pendingId} de la liste des tâches en attente`) : "")}
        ${row("Classement", t.raison ? esc(t.raison) : "")}
        ${row("Rattachée à", t.rattache ? esc(t.rattache) : "")}
      </dl>
      ${t.excerpt ? `<div class="rqo-sub">Résultat</div><div class="rqo-text md">${md(t.excerpt)}</div>` : ""}
      <div class="rqo-sub">Demande confiée au musicien</div><div class="rqo-text md">${md(t.demande)}</div></article>`;
  }
  function fillDetail() {
    const q = (st.data?.requests || []).find(x => x.run === ov.run);
    if (!q) { closeDetail(); return; }
    const el = overlayEl();
    const t = ov.n != null ? q.tasks.find(x => x.n === ov.n) : null;
    el.querySelector(".rqo-title").textContent = t ? `Tâche ${t.n} — ${t.titre}` : `Requête du ${when(q.createdAt)}`;
    const nav = q.tasks.map(x => `<button type="button" class="rqo-chip${x.n === ov.n ? " rqo-cur" : ""}" data-rqo-task="${x.n}" data-tone="${esc(x.tone)}">${ICON[x.state] || "·"} ${x.n}</button>`).join("");
    el.querySelector(".rqo-body").innerHTML = `
      <p class="rqo-meta">${esc(ROUTAGE[q.routageStatus] || q.routageStatus || "")} · ${esc(q.run)} · ${q.total} tâche${q.total > 1 ? "s" : ""}${q.open ? ` dont ${q.open} pas encore finie${q.open > 1 ? "s" : ""}` : ""}</p>
      ${nav ? `<div class="rqo-nav">${nav}</div>` : ""}
      ${t ? taskDetail(q, t) : `
        <div class="rqo-sub">Requête</div><div class="rqo-text md">${md(q.request)}</div>
        ${q.sens ? `<div class="rqo-sub">Ce que le chef a compris</div><div class="rqo-text">${esc(q.sens)}</div>` : ""}
        ${q.questions.length ? `<div class="rqo-sub">Questions posées</div><ol class="rqo-q">${q.questions.map(x => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
        ${q.tasks.map(x => taskDetail(q, x)).join("")}`}`;
  }
  function openDetail(run, n, opener) {
    ov.run = run; ov.n = n ?? null; ov.opener = opener || null;
    overlayEl().hidden = false;
    fillDetail();
    ov.el.querySelector(".rqo-close").focus();
  }
  function closeDetail(refocus) {
    if (!ov.el || ov.el.hidden) return;
    ov.el.hidden = true;
    const o = ov.opener; ov.run = null; ov.n = null;
    if (refocus && o && o.isConnected) o.focus();
  }

  SidePanel.register({
    id: "requests", label: "Requêtes", icon: "🧭",
    mount(pane) {
      st.pane = pane;
      pane.innerHTML = `<div class="rq-filters"><label class="rq-f"><input type="checkbox" class="rq-all"> tout afficher (requêtes sans tâche, relais)</label>
        <span class="rq-ro" title="Rien n’est modifié d’ici : chaque requête du chef, son découpage en tâches, et l’état de chacune où qu’elle soit">lecture seule</span></div>
        <div class="rq-body"><p class="rq-empty">Chargement…</p></div>`;
      pane.querySelector(".rq-all").addEventListener("change", (e) => { lsSet(LS_ALL, e.target.checked ? "1" : ""); render(); });
      pane.addEventListener("click", (e) => {
        const task = e.target.closest(".rq-task");
        if (task) { openDetail(task.dataset.run, Number(task.dataset.n), task); return; }
        const head = e.target.closest("[data-rq-request]");
        if (head) openDetail(head.dataset.rqRequest, null, head);
      });
      addEventListener("resize", () => requestAnimationFrame(drawLinks));
    },
    // Tasks move on after the chef's turn: re-read every 10 s while open.
    onOpen() { load(); clearInterval(st.timer); st.timer = setInterval(load, 10_000); },
    onClose() { clearInterval(st.timer); st.timer = null; closeDetail(); },
  });
  globalThis.RequestsPanel = { reload: load, state: () => st.data, openDetail, closeDetail, isDetailOpen: () => !!(ov.el && !ov.el.hidden) };
})();
