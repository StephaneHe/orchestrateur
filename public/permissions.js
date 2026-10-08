// public/permissions.js — demandes d'autorisation interactives (0.45.0)
//
// Demande utilisateur : « Je n'ai pas vu de moyen d'autoriser (1 fois, pour
// toujours). Il faut d'ailleurs que je puisse avoir plus de détails sur
// l'opération en question. En cliquant dessus je dois voir un overlay avec tous
// les détails. »
//
// - Bandeau 🔐 (#perm-band) : une carte par demande en attente, compte à
//   rebours, « Autoriser une fois », « Toujours… », « Refuser… ».
// - Overlay (#perm-overlay) au clic sur la carte : projet, model, tour, étape,
//   outil, entrée COMPLÈTE (masquée), répertoire, dernier message du model,
//   pourquoi la demande, risque, horodatage et compte à rebours.
// - Règles permanentes : liste et révocation (menu ⋮ → « Autorisations
//   permanentes », ou lien de l'overlay).
// Source : GET /api/permissions, redemandé à chaque événement permission_* du
// SSE (et toutes les 15 s en filet). Décision : POST /api/permission/:id/decide.
(function (g) {
  "use strict";
  const PC = g.PermissionCore;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const RISK_CLS = { "faible": "low", "moyen": "mid", "élevé": "high" };

  const st = {
    pending: [], skew: 0, seen: new Set(), loaded: false, again: false,
    open: null,            // { id, data, focusBack, mode }
    tick: null, poll: null, inflight: null,
  };

  const serverNow = () => Date.now() - st.skew;
  const leftMs = (r) => (r?.deadline || 0) - serverNow();

  async function refresh() {
    // Une demande déjà partie peut rapporter un état d'AVANT une décision : on
    // en relance une derrière elle, sinon une carte décidée reviendrait 15 s.
    if (st.inflight) { st.again = true; return st.inflight; }
    st.again = false;
    st.inflight = (async () => {
      try {
        const r = await fetch("/api/permissions", { cache: "no-store" });
        if (!r.ok) return;                      // serveur d'avant 0.45.0
        const d = await r.json();
        if (Number.isFinite(d.now)) st.skew = Date.now() - d.now;
        const fresh = (d.pending || []).filter(p => !st.seen.has(p.id));
        st.pending = d.pending || [];
        fresh.forEach(p => st.seen.add(p.id));
        if (st.loaded) fresh.forEach(announce);
        st.loaded = true;
        render();
        if (st.open && !st.open.mode) syncOverlayState();
      } catch { /* hors ligne : on réessaiera */ }
      finally {
        st.inflight = null;
        if (st.again) refresh();
      }
    })();
    return st.inflight;
  }

  function onEvent(name, raw) {
    if (!raw) return;
    if ((raw.type === "system" && raw.subtype === "permission_request") ||
        (raw.type === "notification" && raw.subtype === "permission_decision")) refresh();
  }

  // ── Notifications : bureau et voix ─────────────────────────────────────────
  function announce(p) {
    const title = `🔐 ${p.project} attend une autorisation`;
    const body = `${p.tool} : ${p.preview}`;
    try {
      if (g.Notification && g.Notification.permission === "granted") {
        const n = new g.Notification(title, { body, tag: `perm-${p.id}`, requireInteraction: true });
        n.onclick = () => { try { g.focus(); } catch { /* */ } openDetails(p.id); n.close(); };
      }
    } catch { /* notifications indisponibles */ }
    try {
      const auto = g.localStorage && g.localStorage.getItem("tts.auto") === "1";
      if (auto && g.Tts && g.Tts.enabled()) g.Tts.speak(`${p.project} attend une autorisation pour ${p.tool}.`, `perm:${p.id}`);
    } catch { /* voix indisponible */ }
  }
  function askNotificationPermission() {
    try { if (g.Notification && g.Notification.permission === "default") g.Notification.requestPermission(); } catch { /* */ }
  }

  // ── Bandeau ────────────────────────────────────────────────────────────────
  function riskHtml(risk) {
    if (!risk) return "";
    return `<span class="pr-risk" data-level="${esc(RISK_CLS[risk.level] || "mid")}" title="Risque ${esc(risk.level)}">${risk.tags.map(t => `<span class="pr-tag">${esc(t)}</span>`).join("")}</span>`;
  }
  function cardHtml(p) {
    return `<div class="perm-card" data-perm-id="${esc(p.id)}" data-level="${esc(RISK_CLS[p.risk?.level] || "mid")}">
      <button class="pc-main" type="button" data-perm-open="${esc(p.id)}" title="Voir tous les détails de l'opération">
        <span class="pc-lock">🔐</span>
        <span class="pc-who"><b>${esc(p.project)}</b>${p.branch ? ` <span class="pc-branch">branche ${esc(p.branch)}</span>` : ""} attend votre autorisation</span>
        <span class="pc-what"><span class="pc-tool">${esc(p.tool)}</span> <code class="pc-preview">${esc(p.preview || "—")}</code></span>
        ${riskHtml(p.risk)}
        <span class="pc-left" data-left="${esc(p.id)}" title="Refus automatique « expiré sans réponse » à l'échéance">${esc(PC.fmtLeft(leftMs(p)))}</span>
      </button>
      <div class="pc-acts">
        <button class="pc-btn is-allow" type="button" data-perm-once="${esc(p.id)}">Autoriser une fois</button>
        <button class="pc-btn is-always" type="button" data-perm-always="${esc(p.id)}" title="Choisir la portée de la règle permanente">Toujours…</button>
        <button class="pc-btn is-deny" type="button" data-perm-deny="${esc(p.id)}" title="Refuser, avec un motif optionnel pour le model">Refuser…</button>
      </div>
    </div>`;
  }
  function render() {
    const el = document.getElementById("perm-band");
    if (!el) return;
    if (!st.pending.length) { el.hidden = true; el.innerHTML = ""; el._html = ""; return; }
    const html = `<div class="pb-head">🔐 ${st.pending.length === 1 ? "1 autorisation attend" : `${st.pending.length} autorisations attendent`} votre décision</div>` +
      st.pending.map(cardHtml).join("");
    // Le compte à rebours est mis à jour à part : on ne réécrit le bandeau que si
    // la liste change (sinon un clic en cours se perdrait).
    const key = st.pending.map(p => p.id).join(",");
    if (el._key !== key) { el.innerHTML = html; el._key = key; }
    el.hidden = false;
  }
  function tick() {
    document.querySelectorAll("[data-left]").forEach(n => {
      const p = st.pending.find(x => x.id === n.dataset.left) || (st.open?.data?.id === n.dataset.left ? st.open.data : null);
      if (!p) return;
      const ms = leftMs(p);
      n.textContent = ms > 0 ? PC.fmtLeft(ms) : "expiré";
      n.classList.toggle("is-urgent", ms < 60_000);
    });
  }

  // ── Décision ───────────────────────────────────────────────────────────────
  async function decide(id, decision, extra = {}) {
    const r = await fetch(`/api/permission/${encodeURIComponent(id)}/decide`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, by: "utilisateur", ...extra }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    st.pending = st.pending.filter(p => p.id !== id);
    render();
    refresh();
    return d;
  }

  // ── Overlay ────────────────────────────────────────────────────────────────
  function overlayEl() {
    let el = document.getElementById("perm-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "perm-overlay";
      el.className = "perm-overlay";
      el.hidden = true;
      document.body.appendChild(el);
    }
    if (!el._wired) {
      el._wired = true;
      el.addEventListener("click", onOverlayClick);
      el.addEventListener("keydown", (e) => { if (e.key === "Tab") trapFocus(e, el); });
      // Échap ferme l'overlay même si le focus en est sorti (clic à côté…).
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.hidden) { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
      }, true);
    }
    return el;
  }
  function trapFocus(e, root) {
    const f = [...root.querySelectorAll("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(n => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function showOverlay(html, focusSel) {
    const el = overlayEl();
    el.innerHTML = `<div class="po-backdrop" data-po-close></div><div class="po-dialog" role="dialog" aria-modal="true" aria-labelledby="po-title">${html}</div>`;
    el.hidden = false;
    document.body.classList.add("perm-overlay-open");
    const target = (focusSel && el.querySelector(focusSel)) || el.querySelector(".po-dialog button");
    if (target) target.focus();
  }
  function closeOverlay() {
    const el = document.getElementById("perm-overlay");
    if (!el || el.hidden) return;
    el.hidden = true;
    el.innerHTML = "";
    document.body.classList.remove("perm-overlay-open");
    const back = st.open?.focusBack;
    st.open = null;
    if (back && document.contains(back)) back.focus();
  }

  /** Coloration simple : diff ligne à ligne, commande avec opérateurs et
   *  options repérés. Le texte est déjà masqué par le serveur. */
  function codeHtml(b) {
    if (b.kind === "diff") {
      return b.text.split("\n").map(l => `<span class="pd-l ${l[0] === "+" ? "is-add" : l[0] === "-" ? "is-del" : ""}">${esc(l)}</span>`).join("\n");
    }
    if (b.kind === "code") {
      return esc(b.text)
        .replace(/(&amp;&amp;|\|\||;|\||&gt;&gt;?|\$\(|`)/g, '<span class="pd-op">$1</span>')
        .replace(/(^|\s)(--?[A-Za-z][\w-]*)/g, '$1<span class="pd-flag">$2</span>');
    }
    return esc(b.text);
  }

  function detailsHtml(r) {
    const decided = r.status === "decided";
    const ms = leftMs(r);
    const dt = (v) => v ? new Date(v).toLocaleString("fr-FR") : "—";
    const meta = [
      ["Projet", r.project + (r.branch ? ` (branche ${r.branch} du mode double)` : "")],
      ["Model", r.model || "—"],
      ["Tour", r.turnPrompt || "—"],
      ["Étape du pipeline", r.step || "inconnue"],
      ["Répertoire de travail", r.cwd || "—"],
      ["Demandée", dt(r.createdAt)],
      ["Échéance", dt(r.deadline)],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    const sugg = (r.suggestions || []);
    const def = sugg.find(s => s.scope === "pattern") || sugg.find(s => s.scope === "exact") || sugg[0];
    const radios = sugg.map((s, i) => `<label class="po-scope"><input type="radio" name="po-rule" value="${esc(s.rule)}"${s === def ? " checked" : ""}>
        <span><code>${esc(s.rule)}</code> — ${esc(s.label)}</span></label>`).join("");
    const blocks = (r.blocks || []).map(b => `<section class="po-block"><h4>${esc(b.label)}</h4><pre class="po-pre pd-${esc(b.kind)}">${codeHtml(b)}</pre></section>`).join("");
    const state = decided
      ? `<div class="po-decided">Déjà traitée : ${esc(PC.DECISION_TEXT[r.decision?.decision] || r.decision?.decision || "")}${r.decision?.rule ? ` (règle ${esc(r.decision.rule)})` : ""}${r.decision?.message ? ` — « ${esc(r.decision.message)} »` : ""}</div>` : "";
    return `
      <header class="po-head">
        <h3 id="po-title">🔐 ${esc(r.project)} demande l'autorisation d'utiliser <span class="po-tool">${esc(r.tool)}</span></h3>
        <span class="po-left${ms < 60_000 ? " is-urgent" : ""}" data-left="${esc(r.id)}" title="Refus automatique « expiré sans réponse » à l'échéance">${decided ? "—" : esc(PC.fmtLeft(ms))}</span>
        <button class="po-x" type="button" data-po-close aria-label="Fermer">✕</button>
      </header>
      <div class="po-body">
        <div class="po-why" data-kind="${esc(r.why?.kind || "")}"><b>Pourquoi cette demande :</b> ${esc(r.why?.text || "")}</div>
        <div class="po-riskline">Risque <b>${esc(r.risk?.level || "")}</b> ${riskHtml(r.risk)}</div>
        <dl class="po-meta">${meta}</dl>
        ${r.lastText ? `<section class="po-block"><h4>Dernier message du model avant la demande</h4><div class="po-last">${esc(r.lastText)}</div></section>` : ""}
        <h4 class="po-h">Entrée complète de l'appel</h4>
        ${blocks || '<p class="po-none">(aucun paramètre)</p>'}
        <p class="po-note">Les valeurs qui ressemblent à des clés ou à des secrets sont masquées (••••, 4 derniers caractères au plus).</p>
      </div>
      ${state}
      <footer class="po-acts"${decided ? " hidden" : ""}>
        <div class="po-act-row"><button class="pc-btn is-allow" type="button" data-po-once>Autoriser une fois</button></div>
        <fieldset class="po-always"><legend>Toujours autoriser — portée de la règle permanente de ${esc(r.project)}</legend>
          ${radios}
          <button class="pc-btn is-always" type="button" data-po-always>Toujours autoriser</button>
        </fieldset>
        <div class="po-deny">
          <label for="po-reason">Refuser — motif optionnel, transmis au model (pourquoi, ou quoi faire à la place)</label>
          <textarea id="po-reason" rows="2" maxlength="1000" placeholder="ex. : n'écris pas hors du projet, utilise plutôt Read"></textarea>
          <button class="pc-btn is-deny" type="button" data-po-deny>Refuser</button>
        </div>
        <div class="po-err" role="alert" hidden></div>
      </footer>
      <div class="po-foot"><button class="po-link" type="button" data-po-rules>Règles permanentes…</button></div>`;
  }

  async function openDetails(id, { focus = null } = {}) {
    const back = document.activeElement;
    st.open = { id, data: null, focusBack: back, mode: null };
    showOverlay(`<header class="po-head"><h3 id="po-title">🔐 Chargement de la demande…</h3><button class="po-x" type="button" data-po-close aria-label="Fermer">✕</button></header>`);
    try {
      const r = await fetch(`/api/permission/${encodeURIComponent(id)}/details`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!st.open || st.open.id !== id) return;
      st.open.data = d.request;
      showOverlay(detailsHtml(d.request), focus === "always" ? ".po-always input:checked" : focus === "deny" ? "#po-reason" : "[data-po-once]");
    } catch (e) {
      if (!st.open || st.open.id !== id) return;   // fermé pendant le chargement
      showOverlay(`<header class="po-head"><h3 id="po-title">🔐 Demande indisponible</h3><button class="po-x" type="button" data-po-close aria-label="Fermer">✕</button></header>
        <div class="po-body"><p>${esc(e.message)}</p></div>`);
    }
  }
  function syncOverlayState() {
    const o = st.open;
    if (!o?.data || o.data.status === "decided") return;
    if (!st.pending.some(p => p.id === o.id)) {
      // Traitée ailleurs (autre onglet, app) ou expirée : on le dit, sans fermer.
      const box = document.querySelector("#perm-overlay .po-acts");
      if (box) {
        box.hidden = true;
        const note = document.createElement("div");
        note.className = "po-decided";
        note.textContent = "Cette demande n'attend plus : décidée ailleurs ou expirée sans réponse.";
        box.after(note);
        o.data.status = "decided";
      }
    }
  }
  function overlayError(msg) {
    const e = document.querySelector("#perm-overlay .po-err");
    if (e) { e.textContent = msg; e.hidden = false; }
  }

  async function onOverlayClick(e) {
    if (e.target.closest("[data-po-close]")) { closeOverlay(); return; }
    if (e.target.closest("[data-po-rules]")) { openRules(); return; }
    const o = st.open;
    if (e.target.closest("[data-rule-revoke]")) {
      const b = e.target.closest("[data-rule-revoke]");
      b.disabled = true;
      try {
        const r = await fetch("/api/permission-rules", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: b.dataset.project, rule: b.dataset.ruleRevoke }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        openRules();
      } catch (err) { b.disabled = false; overlayError(err.message); }
      return;
    }
    if (e.target.closest("[data-rule-add]") && o?.mode === "add") {
      const rule = document.querySelector("#perm-overlay input[name='po-rule']:checked")?.value;
      if (!rule) return;
      try {
        const r = await fetch("/api/permission-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: o.add.project, rule, from: (o.add.toolIds || [])[0] || null }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (o.add.toolIds?.length && g.App?.ackDenials) g.App.ackDenials(o.add.project, o.add.toolIds, { action: "granted", tool: o.add.tool });
        closeOverlay();
      } catch (err) { overlayError(err.message); }
      return;
    }
    if (!o?.data) return;
    const btn = e.target.closest("[data-po-once], [data-po-always], [data-po-deny]");
    if (!btn) return;
    const all = [...document.querySelectorAll("#perm-overlay .po-acts button")];
    all.forEach(b => { b.disabled = true; });
    try {
      if (btn.hasAttribute("data-po-once")) await decide(o.id, "allow_once");
      else if (btn.hasAttribute("data-po-always")) {
        const rule = document.querySelector("#perm-overlay input[name='po-rule']:checked")?.value || o.data.tool;
        await decide(o.id, "allow_always", { rule });
      } else {
        const message = (document.getElementById("po-reason")?.value || "").trim();
        await decide(o.id, "deny", message ? { message } : {});
      }
      closeOverlay();
    } catch (err) {
      all.forEach(b => { b.disabled = false; });
      overlayError(err.message);
    }
  }

  // ── Règles permanentes ─────────────────────────────────────────────────────
  async function openRules() {
    const back = st.open?.focusBack || document.activeElement;
    const mine = { id: null, data: null, focusBack: back, mode: "rules" };
    st.open = mine;
    let rules = {};
    try {
      const r = await fetch("/api/permission-rules", { cache: "no-store" });
      const d = await r.json();
      rules = d.rules || {};
    } catch { /* serveur d'avant 0.45.0 */ }
    if (st.open !== mine) return;            // fermé ou remplacé pendant le chargement
    const projects = Object.keys(rules).sort();
    const body = projects.length ? projects.map(p => `<section class="po-block"><h4>${esc(p)}</h4><ul class="po-rules">` +
      rules[p].map(r => `<li><code>${esc(r.rule)}</code> <span class="po-soft">${esc(new Date(r.createdAt).toLocaleString("fr-FR"))} · ${esc(r.by || "")}</span>
        <button class="pc-btn is-deny" type="button" data-rule-revoke="${esc(r.rule)}" data-project="${esc(p)}">Révoquer</button></li>`).join("") +
      `</ul></section>`).join("") : `<p class="po-none">Aucune règle permanente. « Toujours autoriser » en crée une, par projet.</p>`;
    showOverlay(`<header class="po-head"><h3 id="po-title">🔐 Autorisations permanentes</h3><button class="po-x" type="button" data-po-close aria-label="Fermer">✕</button></header>
      <div class="po-body"><p class="po-note">Une règle laisse passer, sans vous déranger, les appels qu'elle couvre. Une règle de préfixe (<code>Bash(git status:*)</code>) ne couvre jamais une commande composite.</p>${body}<div class="po-err" role="alert" hidden></div></div>`);
  }

  /** « Toujours autoriser à l'avenir » depuis une ancienne carte de refus. */
  function openRuleDialog({ project, tool, input, toolIds } = {}) {
    const back = document.activeElement;
    const sugg = PC.suggestRules(tool, input || {}, {});
    const def = sugg.find(s => s.scope === "pattern") || sugg.find(s => s.scope === "exact") || sugg[0];
    st.open = { id: null, data: null, focusBack: back, mode: "add", add: { project, tool, toolIds } };
    showOverlay(`<header class="po-head"><h3 id="po-title">🔐 Toujours autoriser ${esc(tool)} pour ${esc(project)} ?</h3><button class="po-x" type="button" data-po-close aria-label="Fermer">✕</button></header>
      <div class="po-body">
        ${input ? `<section class="po-block"><h4>Appel refusé</h4>${PC.detailBlocks(tool, input).map(b => `<pre class="po-pre pd-${esc(b.kind)}">${codeHtml(b)}</pre>`).join("")}</section>` : ""}
        <fieldset class="po-always"><legend>Portée de la règle permanente</legend>
          ${sugg.map(s => `<label class="po-scope"><input type="radio" name="po-rule" value="${esc(s.rule)}"${s === def ? " checked" : ""}><span><code>${esc(s.rule)}</code> — ${esc(s.label)}</span></label>`).join("")}
          <button class="pc-btn is-always" type="button" data-rule-add>Toujours autoriser à l'avenir</button>
        </fieldset>
        <div class="po-err" role="alert" hidden></div>
      </div>`, ".po-always input:checked");
  }

  // ── Câblage ────────────────────────────────────────────────────────────────
  function wire() {
    const band = document.getElementById("perm-band");
    if (band && !band._wired) {
      band._wired = true;
      band.addEventListener("click", async (e) => {
        askNotificationPermission();
        const open = e.target.closest("[data-perm-open]");
        if (open) { openDetails(open.dataset.permOpen); return; }
        const always = e.target.closest("[data-perm-always]");
        if (always) { openDetails(always.dataset.permAlways, { focus: "always" }); return; }
        const deny = e.target.closest("[data-perm-deny]");
        if (deny) { openDetails(deny.dataset.permDeny, { focus: "deny" }); return; }
        const once = e.target.closest("[data-perm-once]");
        if (once) {
          once.disabled = true;
          try { await decide(once.dataset.permOnce, "allow_once"); }
          catch (err) { once.disabled = false; once.title = err.message; once.textContent = "Échec — réessayer"; }
        }
      });
    }
    document.addEventListener("click", (e) => {
      const r = e.target.closest("[data-perm-rules]");
      if (r) { e.preventDefault(); openRules(); }
      const p = e.target.closest("[data-perm-project]");
      if (p) {
        const req = st.pending.find(x => x.project === p.dataset.permProject);
        if (req) { e.stopPropagation(); openDetails(req.id); }
      }
    });
    // Onglet en arrière-plan : le navigateur ralentit les minuteries ; au retour,
    // compte à rebours et liste sont remis à jour tout de suite.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); refresh(); } });
    if (!st.tick) st.tick = setInterval(tick, 1000);
    if (!st.poll) st.poll = setInterval(refresh, 15_000);
    refresh();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
  }

  g.Permissions = {
    refresh, onEvent, openDetails, openRules, openRuleDialog, closeOverlay,
    pending: () => st.pending.slice(),
    pendingFor: (name) => st.pending.find(p => p.project === name) || null,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
