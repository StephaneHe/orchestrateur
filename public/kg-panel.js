/* ==========================================================================
   public/kg-panel.js — « 🧠 Mémoire » tab of the side panel (0.131.0)
   --------------------------------------------------------------------------
   Knowledge graph phase 1, decision « vas y » (2026-10-22), KG-SYNTHESE §3.7:
     - Revue: facts proposed by a model, derived facts « à revoir », suspect
       pairs and contradictions, each with the four questions (what we know,
       why, since when, where it applies) and the buttons Valider, Corriger,
       Périmer à la date…, Rejeter (motif), Ouvrir la source, Corriger la
       source (a message to the chef for the owner: never a silent rewrite);
     - Règles en vigueur by project and by case, with the supersedes chain;
     - Statistiques de models by case (same data as `historique`);
     - banner « N contradictions entre règles » in the notification dock, each
       with its two sources and « celle-ci vaut ».
   Shown only while the server says ui.kgMemory (model-routing.json → kg.ui):
   off = no pill, no tab, no banner, no request. Every decision carries a
   commandId (idempotent) and the revision read (409 = it moved: reloaded).
   ========================================================================== */
(function () {
  "use strict";
  const st = { on: false, registered: false, pane: null, tab: "review", status: null, review: null, rules: null, stats: null,
    project: "", kase: "", statCase: "", error: null, busy: false, timer: null, bandTimer: null, form: null, notice: "" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const httpError = (status, body) => Object.assign(new Error(body?.error || `HTTP ${status}`), { status, body });
  const LS_TAB = "kg.tab";
  const ACTION_LABEL = { validate: "✓ Valider", correct: "✎ Corriger…", expire: "⏱ Périmer à la date…", reject: "✕ Rejeter…" };

  async function getJson(url) {
    const r = await fetch(url);
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw httpError(r.status, body);
    return body;
  }

  /* ---- loading ------------------------------------------------------------ */
  async function load(what = st.tab) {
    if (!st.on) return;
    st.busy = true;
    try {
      st.status = await getJson("/api/kg/status");
      if (what === "review") st.review = await getJson("/api/kg/review");
      else if (what === "rules") {
        const q = new URLSearchParams();
        if (st.project) q.set("projet", st.project);
        if (st.kase) q.set("case", st.kase);
        st.rules = await getJson(`/api/kg/rules${q.toString() ? `?${q}` : ""}`);
      } else if (what === "stats") st.stats = await getJson(`/api/kg/stats${st.statCase ? `?case=${encodeURIComponent(st.statCase)}` : ""}`);
      st.error = null;
    } catch (e) {
      st.error = e.status === 404 && e.body?.disabled ? "Onglet Mémoire désactivé (interrupteur kg.ui)." : e.status ? await globalThis.SidePanel.explainFailure(e.status, "Mémoire") : `Mémoire indisponible : ${e.message}`;
    } finally { st.busy = false; }
    render();
    renderBand();
  }

  /* ---- rendering helpers -------------------------------------------------- */
  const fmtO = (o) => Array.isArray(o) ? o.join(", ") : String(o ?? "");
  function cardHtml(c) {
    if (!c) return "";
    return `<dl class="kg-card">
      <dt>Ce que nous savons</dt><dd class="kg-what">${esc(c.what)}</dd>
      <dt>Pourquoi</dt><dd>${esc(c.why)}</dd>
      <dt>Depuis quand</dt><dd>${esc(c.since)}</dd>
      <dt>Où cela s’applique</dt><dd>${esc(c.where)}</dd></dl>`;
  }
  const sourceBtn = (src) => src && src.key ? `<button type="button" class="kg-btn kg-open-src" data-key="${esc(src.key)}" data-line="${esc(src.line || "")}">📄 Ouvrir la source</button>` : "";
  const fixBtn = (i, src, owner) => owner && owner !== "utilisateur" && src && (src.ref || src.key)
    ? `<button type="button" class="kg-btn kg-fix-src" data-id="${esc(i.id)}" data-owner="${esc(owner)}" data-ref="${esc(src.ref || src.key)}" title="Prépare un message au chef pour faire corriger la source par son projet (rien n’est réécrit d’ici)">🛠 Corriger la source</button>` : "";
  const statusBadge = (s) => `<span class="kg-status" data-status="${esc(s || "")}">${esc({ proposed: "proposé", to_review: "à revoir", validated: "validé", observed: "observé", disputed: "en conflit", superseded: "remplacé", retracted: "rejeté" }[s] || s || "")}</span>`;

  function formHtml(i) {
    const f = st.form;
    if (!f || f.id !== i.id) return "";
    const field = f.action === "correct" ? `<label>Nouvelle valeur <input class="kg-in" name="o" maxlength="200" placeholder="identifiant ou valeur (ex. shelfapp)" value="${esc(f.value || "")}"></label>`
      : f.action === "expire" ? `<label>Périmé au <input class="kg-in" type="date" name="valid_to" value="${esc(f.value || new Date().toISOString().slice(0, 10))}"></label>`
      : `<label>Motif <input class="kg-in" name="reason" maxlength="500" placeholder="pourquoi ce fait est faux" value="${esc(f.value || "")}"></label>`;
    return `<form class="kg-form" data-id="${esc(i.id)}" data-action="${esc(f.action)}">${field}
      <button type="submit" class="kg-btn kg-primary">Confirmer</button> <button type="button" class="kg-btn kg-cancel">Annuler</button></form>`;
  }

  function sideHtml(i, s) {
    return `<li class="kg-side"><div class="kg-side-head"><b>${esc(s.label || fmtO(s.o))}</b>${s.date ? ` <span class="kg-date">${esc(s.date)}</span>` : ""}</div>
      ${s.quote ? `<blockquote class="kg-quote">${esc(s.quote)}</blockquote>` : ""}
      <div class="kg-ref">${esc(s.ref || "")}</div>
      <div class="kg-actions"><button type="button" class="kg-btn kg-primary kg-keep" data-id="${esc(i.id)}" data-keep="${esc(s.fact)}" data-rev="${esc(i.rev)}">✓ Celle-ci vaut</button>
        ${sourceBtn(s)} ${fixBtn(i, s, s.owner)}</div></li>`;
  }

  function itemHtml(i) {
    if (i.kind === "conflict" || i.kind === "pair") {
      const pair = i.kind === "pair";
      return `<article class="kg-item" data-kind="${esc(i.kind)}" data-id="${esc(i.id)}">
        <header class="kg-item-head">${pair ? "🔎 Paire suspecte" : "⚠ Contradiction"} — <b>${esc(i.labels?.s || i.s)}</b> · ${esc(i.labels?.p || i.p)}</header>
        ${pair ? `<p class="kg-why">Avis du model : <b>${esc(i.verdict)}</b> — ${esc(i.why || "")}</p>` : i.hint ? `<p class="kg-why">${esc(i.hint)}</p>` : ""}
        ${pair ? `<ul class="kg-sides">${i.sides.map(s => `<li class="kg-side"><b>${esc(s.label)}</b>${s.quote ? `<blockquote class="kg-quote">${esc(s.quote)}</blockquote>` : ""}<div class="kg-ref">${esc(s.ref || "")}</div><div class="kg-actions">${sourceBtn(s)}</div></li>`).join("")}</ul>
          <div class="kg-actions"><button type="button" class="kg-btn kg-primary kg-act" data-id="${esc(i.id)}" data-action="validate" data-rev="${esc(i.rev)}">⚠ Confirmer la contradiction</button>
          <button type="button" class="kg-btn kg-act" data-id="${esc(i.id)}" data-action="reject" data-rev="${esc(i.rev)}">✕ Écarter</button></div>`
          : `<ul class="kg-sides">${(i.sides || []).map(s => sideHtml(i, s)).join("")}</ul>`}
      </article>`;
    }
    if (i.kind === "index") {
      return `<article class="kg-item" data-kind="index" data-id="${esc(i.id)}"><header class="kg-item-head">📇 Ligne d’index périmée — <b>${esc(i.labels?.s)}</b></header>
        <p class="kg-why">${esc(i.why)}</p>${i.source?.quote ? `<blockquote class="kg-quote">${esc(i.source.quote)}</blockquote>` : ""}
        <div class="kg-actions">${sourceBtn(i.source)} ${fixBtn(i, i.source, i.owner)}</div></article>`;
    }
    const acts = (i.actions || []).map(a => a === "validate"
      ? `<button type="button" class="kg-btn kg-primary kg-act" data-id="${esc(i.id)}" data-action="validate" data-rev="${esc(i.rev)}">${ACTION_LABEL.validate}</button>`
      : `<button type="button" class="kg-btn kg-ask" data-id="${esc(i.id)}" data-action="${esc(a)}">${ACTION_LABEL[a]}</button>`).join(" ");
    return `<article class="kg-item" data-kind="${esc(i.kind)}" data-id="${esc(i.id)}" data-rev="${esc(i.rev)}">
      <header class="kg-item-head">${i.kind === "stale" ? "⏳ À revoir" : "🤖 Proposé par un model"} ${statusBadge(i.status)}${i.why ? ` <span class="kg-why-inline">${esc(i.why)}</span>` : ""}</header>
      ${cardHtml(i.card)}
      <div class="kg-actions">${acts} ${sourceBtn(i.source)} ${fixBtn(i, i.source, i.owner)}</div>${formHtml(i)}</article>`;
  }

  function reviewHtml() {
    const r = st.review;
    if (!r) return `<p class="kg-empty">Chargement…</p>`;
    if (!r.items.length) return `<p class="kg-empty">Rien à revoir : aucune contradiction ouverte, aucun fait proposé en attente.</p>`;
    const groups = [["conflict", "Contradictions"], ["fact", "Faits proposés par un model"], ["pair", "Paires suspectes"], ["stale", "Faits à revoir"], ["index", "Index des mémoires"]];
    return groups.map(([k, title]) => {
      const list = r.items.filter(i => i.kind === k);
      return list.length ? `<section class="kg-group" data-group="${k}"><h4>${title} (${list.length})</h4>${list.map(itemHtml).join("")}</section>` : "";
    }).join("");
  }

  function chainHtml(chain) {
    if (!chain || !chain.length) return "";
    return `<details class="kg-chain"><summary>Chaîne des remplacements (${chain.length})</summary><ul>${chain.map(c => `<li>${c.newer ? "remplacée par" : "remplace"} <b>${esc(c.label)}</b> <span class="kg-ref">${esc(c.ref || "")}</span>${chainHtml(c.chain)}</li>`).join("")}</ul></details>`;
  }
  function rulesHtml() {
    const r = st.rules;
    const sel = `<div class="kg-filters"><label>Projet <select class="kg-project"><option value="">toute la flotte</option>${(r?.projects || []).map(p => `<option${p === st.project ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label>Case <select class="kg-case"><option value="">—</option>${(r?.cases || []).map(c => `<option${c === st.kase ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label></div>`;
    if (!r) return sel + `<p class="kg-empty">Chargement…</p>`;
    const line = (f) => `<li>${statusBadge(f.status)} <b>${esc(f.s)}</b> — ${esc(f.p)} — <b>${esc(fmtO(f.o))}</b>${f.date ? ` <span class="kg-date">${esc(f.date)}</span>` : ""}<div class="kg-ref">${esc(f.ref || "")}</div>${f.card ? cardHtml(f.card) : ""}</li>`;
    const rule = (x) => `<li>${statusBadge(x.status)} <b>${esc(x.label)}</b> <span class="kg-ref">${esc(x.id)}${x.modified ? ` · ${esc(x.modified)}` : ""}</span>${chainHtml(x.chain)}</li>`;
    return sel + `
      <section class="kg-group"><h4>Valeurs fixées (${r.fixed.length})</h4><ul class="kg-list">${r.fixed.map(line).join("") || "<li class='kg-empty'>—</li>"}</ul></section>
      <section class="kg-group"><h4>Règles en vigueur (${r.inForce.length})</h4><ul class="kg-list">${r.inForce.map(rule).join("") || "<li class='kg-empty'>—</li>"}</ul></section>
      <section class="kg-group"><h4>Liens validés par vous (${r.curated.length})</h4><ul class="kg-list">${r.curated.map(line).join("") || "<li class='kg-empty'>aucun</li>"}</ul></section>
      <section class="kg-group"><h4>Exceptions (${r.exceptions.length})</h4><ul class="kg-list">${r.exceptions.map(line).join("") || "<li class='kg-empty'>—</li>"}</ul></section>
      ${r.case ? `<section class="kg-group"><h4>Case ${esc(st.kase)} (${r.caseFacts.length})</h4><ul class="kg-list">${r.caseFacts.map(line).join("") || "<li class='kg-empty'>—</li>"}</ul></section>` : ""}
      <details class="kg-chain"><summary>Règles remplacées (${r.superseded.length})</summary><ul class="kg-list">${r.superseded.map(rule).join("")}</ul></details>`;
  }

  function statsHtml() {
    const s = st.stats;
    if (!s) return `<p class="kg-empty">Chargement…</p>`;
    if (!s.cases.length) return `<p class="kg-empty">Aucune exécution de pipeline dans l’index.</p>`;
    const d = s.detail;
    const detail = d ? `<section class="kg-group kg-stat-detail"><h4>${esc(d.case)} — ${d.n} cas${d.assigned ? ` · model de la case : ${esc(d.assigned)}` : ""}</h4>
      ${d.enough ? "" : `<p class="kg-why">${esc(d.message)}</p>`}
      <table class="kg-table"><thead><tr><th>Model servi</th><th>n</th><th>réussis</th><th>critère</th><th>infra</th><th>échec</th></tr></thead><tbody>
      ${Object.entries(d.byModel).map(([m, v]) => `<tr><td>${esc(m)}</td><td>${v.n}</td><td>${v.ok}</td><td>${v.critere}</td><td>${v.infrastructure}</td><td>${v.echec}</td></tr>`).join("")}</tbody></table>
      ${d.causes.length ? `<ul class="kg-list">${d.causes.map(c => `<li>${c.n} × ${esc(c.why)}</li>`).join("")}</ul>` : ""}</section>` : "";
    return `<ul class="kg-list kg-cases">${s.cases.map(c => `<li><button type="button" class="kg-btn kg-stat" data-case="${esc(c.case)}" aria-pressed="${c.case === st.statCase}">${esc(c.case)} <span class="kg-n">${c.n}</span></button></li>`).join("")}</ul>${detail}`;
  }

  function statusLine() {
    const s = st.status;
    if (!s) return "";
    const ex = s.extraction || {};
    const cut = s.cutoff ? ` · <b class="kg-cut">extraction coupée d’office : ${esc(s.cutoff.why)}</b>` : "";
    const susp = ex.suspended ? ` · <b class="kg-cut">extraction suspendue : ${esc(ex.suspended.why)}</b>` : "";
    const h = ex.health || {};
    return `<p class="kg-statusline">Mode <b>${esc(s.mode)}</b> · index ${s.index ? `du ${esc(String(s.index.builtAt || "").slice(0, 16).replace("T", " "))}` : "absent"}
      · extraction ${s.switches?.extract ? "allumée" : "coupée"}${h.judged ? ` · ${h.false} faux sur ${h.judged} jugés (plafond ${h.maxFalse}/${h.window})` : ""}${cut}${susp}</p>`;
  }

  function render() {
    const pane = st.pane;
    if (!pane) return;
    for (const b of pane.querySelectorAll("[data-kg-tab]")) b.setAttribute("aria-pressed", b.dataset.kgTab === st.tab ? "true" : "false");
    const n = st.review?.counts?.total;
    const rb = pane.querySelector('[data-kg-tab="review"] .kg-n');
    if (rb) rb.textContent = n ? String(n) : "";
    globalThis.SidePanel?.setBadge?.("kg", st.review?.counts?.conflicts || "");
    const body = pane.querySelector(".kg-body");
    if (!st.on) { body.innerHTML = `<p class="kg-empty">Onglet Mémoire désactivé (interrupteur kg.ui).</p>`; return; }
    if (st.error) { body.innerHTML = `<p class="kg-empty kg-unavailable">${esc(st.error)}</p>`; return; }
    body.innerHTML = (st.notice ? `<p class="kg-notice" role="status">${esc(st.notice)}</p>` : "") + statusLine()
      + (st.tab === "review" ? reviewHtml() : st.tab === "rules" ? rulesHtml() : statsHtml());
  }

  /* ---- decisions ------------------------------------------------------------ */
  const commandId = () => `kg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  async function decide(body) {
    try {
      const r = await fetch("/api/kg/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, commandId: commandId() }) });
      let j = null; try { j = await r.json(); } catch { /* */ }
      st.notice = r.ok ? (j?.cutoff ? `Enregistré. ${j.cutoff.why}` : "Enregistré.") : r.status === 409 ? `L’élément a changé depuis votre lecture : liste rechargée.${j?.error ? ` (${j.error})` : ""}` : `Refusé : ${j?.error || `HTTP ${r.status}`}`;
    } catch (e) { st.notice = `Envoi impossible : ${e.message}`; }
    st.form = null;
    await load(st.tab);
  }
  const itemById = (id) => (st.review?.items || []).find(i => i.id === id);

  function fixSource(btn) {
    const i = itemById(btn.dataset.id);
    const owner = btn.dataset.owner, ref = btn.dataset.ref;
    const what = i?.card?.what || `${i?.labels?.s || ""} — ${i?.labels?.p || ""}`;
    const text = `Corriger la source d’un fait de la mémoire (décision 15 : correction par le projet propriétaire, jamais réécrite en silence).\n\nSource : ${ref}\nPropriétaire : ${owner}\nFait : ${what}\n\nCe qui est faux / ce qu’il faut écrire : `;
    if (globalThis.App?.prepareChefMessage?.(text, { project: owner, title: ref, kg: true })) globalThis.SidePanel?.close?.();
  }

  /* ---- source overlay ------------------------------------------------------- */
  const ov = { el: null, opener: null };
  function overlayEl() {
    if (ov.el) return ov.el;
    const el = document.createElement("div");
    el.id = "kg-source-overlay";
    el.hidden = true;
    el.innerHTML = `<div class="kgo-backdrop" data-kgo-close></div>
      <section class="kgo-box" role="dialog" aria-modal="true" aria-labelledby="kgo-title">
        <header class="kgo-head"><h3 id="kgo-title" class="kgo-title"></h3><button type="button" class="kgo-close" data-kgo-close aria-label="Fermer">✕</button></header>
        <p class="kgo-meta"></p><pre class="kgo-lines"></pre></section>`;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-kgo-close]")) closeSource(); });
    document.body.appendChild(el);
    // Capture: Escape closes this window, not the side panel behind it.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.el && !ov.el.hidden) { e.preventDefault(); e.stopPropagation(); closeSource(); } }, true);
    return (ov.el = el);
  }
  async function openSource(key, line, opener) {
    ov.opener = opener || null;
    const el = overlayEl();
    el.hidden = false;
    el.querySelector(".kgo-title").textContent = key;
    el.querySelector(".kgo-meta").textContent = "Chargement…";
    el.querySelector(".kgo-lines").innerHTML = "";
    el.querySelector(".kgo-close").focus();
    try {
      const r = await getJson(`/api/kg/source?key=${encodeURIComponent(key)}${line ? `&line=${encodeURIComponent(line)}` : ""}`);
      el.querySelector(".kgo-meta").textContent = `${r.file} · lignes ${r.from} à ${r.to}${r.changed ? " · ⚠ la source a changé depuis la construction de l’index" : ""}`;
      el.querySelector(".kgo-lines").innerHTML = r.lines.map(l => `<span class="kgo-line${l.n === r.line ? " kgo-hit" : ""}"><span class="kgo-n">${l.n}</span>${esc(l.text)}</span>`).join("\n");
    } catch (e) { el.querySelector(".kgo-meta").textContent = `Source indisponible : ${e.body?.error || e.message}`; }
  }
  function closeSource() {
    if (!ov.el || ov.el.hidden) return;
    ov.el.hidden = true;
    ov.opener?.focus?.();
  }

  /* ---- banner (notification dock) -------------------------------------------- */
  function bandEl() { return document.getElementById("kg-band"); }
  function renderBand() {
    const band = bandEl();
    if (!band) return;
    const list = st.on ? (st.review?.items || []).filter(i => i.kind === "conflict") : [];
    const n = st.on ? (st.review ? list.length : (st.status?.contradictions || 0)) : 0;
    band.dataset.ndCount = String(n);
    band.hidden = !n;
    if (!n) { band.innerHTML = ""; return; }
    band.innerHTML = `<div class="kgb-head">🧠 <b>${n} contradiction${n > 1 ? "s" : ""} entre règles</b>
        <button type="button" class="kg-btn kgb-open" data-sp-open-kg>Voir dans Mémoire</button></div>
      ${list.slice(0, 5).map(i => `<div class="kgb-item" data-id="${esc(i.id)}"><span class="kgb-what">${esc(i.labels?.s || i.s)} · ${esc(i.labels?.p || i.p)}</span>
        ${(i.sides || []).map(s => `<span class="kgb-side">« ${esc(s.label || fmtO(s.o))} » <span class="kg-ref">${esc(s.ref || "")}</span>
          <button type="button" class="kg-btn kg-keep" data-id="${esc(i.id)}" data-keep="${esc(s.fact)}" data-rev="${esc(i.rev)}">✓ celle-ci vaut</button></span>`).join("")}</div>`).join("")}`;
  }
  async function refreshBand() {
    if (!st.on) return;
    try {
      st.review = await getJson("/api/kg/review");
      st.status = st.status || null;
    } catch { /* the tab shows the reason when opened */ }
    renderBand();
    if (st.pane && globalThis.SidePanel?.isOpen?.() && globalThis.SidePanel.current() === "kg" && st.tab === "review") render();
  }

  /* ---- events ----------------------------------------------------------------- */
  function onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-kg-tab]");
    if (tab) { st.tab = tab.dataset.kgTab; try { localStorage.setItem(LS_TAB, st.tab); } catch { /* */ } st.notice = ""; render(); load(st.tab); return; }
    const act = t.closest(".kg-act");
    if (act) { decide({ id: act.dataset.id, action: act.dataset.action, rev: Number(act.dataset.rev) }); return; }
    const keep = t.closest(".kg-keep");
    if (keep) { decide({ id: keep.dataset.id, action: "arbitrate", keep: keep.dataset.keep, rev: Number(keep.dataset.rev) }); return; }
    const ask = t.closest(".kg-ask");
    if (ask) { st.form = { id: ask.dataset.id, action: ask.dataset.action, value: "" }; render(); st.pane?.querySelector(`.kg-form[data-id="${CSS.escape(ask.dataset.id)}"] .kg-in`)?.focus(); return; }
    if (t.closest(".kg-cancel")) { st.form = null; render(); return; }
    const src = t.closest(".kg-open-src");
    if (src) { openSource(src.dataset.key, src.dataset.line, src); return; }
    const fix = t.closest(".kg-fix-src");
    if (fix) { fixSource(fix); return; }
    const sc = t.closest(".kg-stat");
    if (sc) { st.statCase = sc.dataset.case; load("stats"); return; }
    if (t.closest("[data-sp-open-kg]")) { globalThis.SidePanel?.open?.("kg"); st.tab = "review"; render(); load("review"); }
  }
  function onSubmit(e) {
    const form = e.target.closest(".kg-form");
    if (!form) return;
    e.preventDefault();
    const i = itemById(form.dataset.id);
    const action = form.dataset.action;
    const val = form.querySelector(".kg-in")?.value || "";
    const body = { id: form.dataset.id, action, rev: i ? i.rev : 0 };
    if (action === "correct") body.o = val; else if (action === "expire") body.valid_to = val; else body.reason = val;
    decide(body);
  }
  function onChange(e) {
    if (e.target.matches(".kg-project")) { st.project = e.target.value; load("rules"); }
    else if (e.target.matches(".kg-case")) { st.kase = e.target.value; load("rules"); }
  }

  /* ---- switch (ui.kgMemory) ------------------------------------------------------ */
  function ensurePill(on) {
    let pill = document.getElementById("btn-kg");
    if (!on) { pill?.remove(); return; }
    if (pill) return;
    pill = document.createElement("button");
    pill.id = "btn-kg";
    pill.type = "button";
    pill.className = "pill pill-sp";
    pill.dataset.spOpen = "kg";
    pill.setAttribute("aria-pressed", "false");
    pill.title = "Mémoire de l’orchestrateur : faits à valider, règles en vigueur, statistiques (k)";
    pill.innerHTML = `🧠 Mémoire<span class="sp-badge" data-sp-badge="kg"></span>`;
    const before = document.getElementById("btn-search");
    before?.parentNode?.insertBefore(pill, before);
  }
  function applyUi(ui) {
    const on = !!(ui && ui.kgMemory === true) && ui.sidePanel !== false;
    if (on === st.on) return;
    st.on = on;
    ensurePill(on);
    if (on && !st.registered && globalThis.SidePanel) {
      st.registered = true;
      try { st.tab = localStorage.getItem(LS_TAB) || "review"; } catch { /* */ }
      if (!["review", "rules", "stats"].includes(st.tab)) st.tab = "review";
      globalThis.SidePanel.register({
        id: "kg", label: "Mémoire", icon: "🧠", key: "k",
        mount(pane) {
          st.pane = pane;
          pane.innerHTML = `<div class="kg-tabs" role="group" aria-label="Mémoire">
              <button type="button" class="kg-tab" data-kg-tab="review" aria-pressed="false">Revue <span class="kg-n"></span></button>
              <button type="button" class="kg-tab" data-kg-tab="rules" aria-pressed="false">Règles en vigueur</button>
              <button type="button" class="kg-tab" data-kg-tab="stats" aria-pressed="false">Statistiques</button></div>
            <div class="kg-body"><p class="kg-empty">Chargement…</p></div>`;
          pane.addEventListener("click", onClick);
          pane.addEventListener("submit", onSubmit);
          pane.addEventListener("change", onChange);
          render();
        },
        onOpen() { load(st.tab); clearInterval(st.timer); st.timer = setInterval(() => load(st.tab), 30_000); },
        onClose() { clearInterval(st.timer); st.timer = null; closeSource(); },
      });
    }
    const band = bandEl();
    if (band && !band.dataset.kgWired) { band.dataset.kgWired = "1"; band.addEventListener("click", onClick); }
    clearInterval(st.bandTimer);
    if (on) { refreshBand(); st.bandTimer = setInterval(refreshBand, 60_000); }
    else { st.review = null; renderBand(); }
    render();
  }

  globalThis.KgPanel = { applyUi, reload: () => load(st.tab), state: () => ({ on: st.on, tab: st.tab, review: st.review, status: st.status, notice: st.notice }), openSource, closeSource };
})();
