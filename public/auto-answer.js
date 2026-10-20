// public/auto-answer.js — réponse automatique quand l'utilisateur est inactif (0.121.0, 0.123.0)
//
// Règle : « si aucune activite de ma part depuis plus de 15 minutes, et qu'un
// process attend quelque chose de moi, et que je ne reponds pas dans les 5
// minutes, opus 5.5 est charge et autorise a repondre a ma place. Un point de
// retours est cree si possible. Sinon il faut avancer »
//   - pill #btn-auto : l'interrupteur global, toujours visible (état dans le libellé) ;
//   - #auto-overlay : interrupteur, délais, garde-fous (une ligne repliée), arriéré,
//     décisions (Annuler, Écarter), historique des décisions écartées ;
//   - #auto-band (dans #notif-dock) : les décisions prises à votre place, une ligne
//     compacte chacune (Détail, Annuler, Reporter, Écarter), « ✓ Vu ».
//   - présence (0.123.0) : tant que l'onglet est visible, focalisé et utilisé
//     (souris, défilement, frappe, ouverture d'un panneau), un battement
//     POST /api/user-activity {kind:"présence"} : un utilisateur qui lit n'est
//     pas inactif.
// Les garde-fous sont obligatoires et toujours actifs : aucun contrôle ici ne les modifie.
// Sans import ni export : pose globalThis.AutoAnswer.
(function (global) {
  "use strict";
  const POLL_MS = 30_000;
  const HEARTBEAT_MS = 60_000;        // un battement par minute au plus
  const PRESENCE_WINDOW_MS = 10 * 60_000; // lecture : dernier geste il y a moins de 10 min
  const SNOOZE_MS = 60 * 60_000;      // « Reporter » : 1 h
  const SNOOZE_KEY = "aa.snoozed";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const KIND = { question: "question", pause: "pause de pipeline", permission: "autorisation", gap: "lacune" };
  const PHASE = { pending: "en attente de votre décision", handled: "traitée", obsolete: "obsolète" };
  const st = { data: null, timer: null, busy: false, open: new Set() };

  // ── Présence ────────────────────────────────────────────────────────────────
  const presence = { lastInteraction: 0, lastSent: 0, timer: null };
  function presenceDue(now = Date.now(), doc = global.document) {
    if (!doc || doc.visibilityState !== "visible") return false;
    if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
    if (now - presence.lastInteraction > PRESENCE_WINDOW_MS) return false;
    return now - presence.lastSent >= HEARTBEAT_MS;
  }
  function sendPresence(kind = "présence") {
    presence.lastSent = Date.now();
    try {
      fetch("/api/user-activity", { method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => {});
    } catch { /* serveur antérieur */ }
  }
  function onInteraction(e) {
    const first = Date.now() - presence.lastInteraction > HEARTBEAT_MS;
    presence.lastInteraction = Date.now();
    if (first && presenceDue()) sendPresence(e?.type === "keydown" ? "saisie" : "présence");
  }
  function presenceTick() { if (presenceDue()) sendPresence("lecture"); }

  // ── Données ─────────────────────────────────────────────────────────────────
  function when(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function day(iso) {
    const t = Date.parse(iso || "");
    return t ? new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " + when(iso) : "";
  }
  async function call(url, body) {
    const r = await fetch(url, body === undefined ? { headers: { Accept: "application/json" }, credentials: "same-origin" }
      : { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  function snoozed() {
    try { const j = JSON.parse(global.localStorage?.getItem(SNOOZE_KEY) || "{}"); return j && typeof j === "object" ? j : {}; } catch { return {}; }
  }
  function snooze(id, ms = SNOOZE_MS) {
    const s = snoozed();
    const now = Date.now();
    for (const k of Object.keys(s)) if (s[k] < now) delete s[k];
    s[id] = now + ms;
    try { global.localStorage?.setItem(SNOOZE_KEY, JSON.stringify(s)); } catch { /* */ }
  }

  // ── Rendu ───────────────────────────────────────────────────────────────────
  function targetHtml(t) {
    if (!t) return "";
    if (t.type === "gap") return `<a href="#/models" class="aa-target" data-aa-goto="gaps" title="Ouvrir les lacunes proposées (page Models)">${esc(t.label)}</a>`;
    if (t.type === "run") return `<a class="idref aa-target" href="#" role="button" data-idref="${esc(t.id)}" data-idref-kind="run" title="Qu’est-ce que c’est ? (cliquer)">${esc(t.label)}</a>`;
    if (t.project) return `<a class="idref aa-target" href="#" role="button" data-idref="${esc(t.project)}" data-idref-kind="projet" title="Ouvrir ${esc(t.project)}">${esc(t.label)}</a>`;
    return esc(t.label);
  }

  function decisionHtml(d, { compact = false, withUndo = true } = {}) {
    const open = !compact || st.open.has(d.id);
    const hits = d.guardrails?.hits?.length ? `<div class="aa-guard">⚠ garde-fou : ${esc(d.guardrails.hits.join(", "))}</div>` : "";
    const undo = withUndo && d.undoable
      ? `<button type="button" class="aa-undo" data-aa-undo="${esc(d.id)}" title="Revenir au point de retour">Annuler</button>`
      : d.undone ? `<span class="aa-undone">↩ annulée</span>` : "";
    const phase = d.phase ? `<span class="aa-phase" data-phase="${esc(d.phase)}"${d.obsolete ? ` title="${esc(d.obsolete)}"` : ""}>${esc(PHASE[d.phase] || d.phase)}</span>` : "";
    const acts = d.dismissed ? `<span class="aa-dim">écartée ${esc(day(d.dismissedAt))}</span>` : `
        ${compact ? `<button type="button" class="aa-det" data-aa-detail="${esc(d.id)}" aria-expanded="${open ? "true" : "false"}">${open ? "Masquer" : "Détail"}</button>` : ""}
        ${undo}
        ${compact ? `<button type="button" class="aa-snooze" data-aa-snooze="${esc(d.id)}" title="Masquer 1 h ici">Reporter</button>` : ""}
        <button type="button" class="aa-dismiss" data-aa-dismiss="${esc(d.id)}" data-phase="${esc(d.phase || "")}" title="Retirer de la vue (reste dans l’historique)">Écarter</button>`;
    return `<li class="aa-item" data-aa-id="${esc(d.id)}" data-aa-status="${esc(d.status)}" data-phase="${esc(d.phase || "")}">
      <div class="aa-line"><span class="aa-when">${esc(when(d.at))}</span>
        <span class="aa-what">🤖 ${esc(d.what || d.statusText || d.status)}</span>
        <span class="aa-on">sur ${targetHtml(d.target) || esc(d.project || "—")}</span>
        ${phase}<span class="aa-acts">${acts}</span></div>
      <div class="aa-more"${open ? "" : " hidden"}>
        <div class="aa-why"><strong>Pourquoi à votre place :</strong> ${esc(d.why_inactive || "")}</div>
        <div class="aa-q">Demande : ${esc(String(d.question || "").replace(/\s+/g, " ").slice(0, 300))}</div>
        ${d.answer ? `<div class="aa-a">Réponse : ${d.decision ? `[${esc(d.decision)}] ` : ""}${esc(String(d.answer).slice(0, 600))}</div>` : ""}
        ${d.reason ? `<div class="aa-r">Raison : ${esc(d.reason)}</div>` : ""}
        ${d.why && d.status !== "applied" ? `<div class="aa-r">${esc(d.why)}</div>` : ""}
        ${d.obsolete ? `<div class="aa-r">Obsolète : ${esc(d.obsolete)}</div>` : ""}
        ${hits}
        ${d.recovery?.text ? `<div class="aa-rec">${esc(d.recovery.text)}</div>` : ""}
      </div>
    </li>`;
  }

  function renderPill() {
    const b = document.getElementById("btn-auto");
    if (!b || !st.data) return;
    const on = !!st.data.settings?.enabled;
    b.hidden = false;
    b.dataset.on = on ? "1" : "0";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.dataset.unseen = String(st.data.unseen || 0);
    b.setAttribute("aria-label", `Réponse automatique ${on ? "ACTIVE" : "COUPÉE"}${st.data.unseen ? `, ${st.data.unseen} décision(s) à voir` : ""} — régler`);
    b.title = on
      ? `Réponse automatique ACTIVE : après ${st.data.settings.idleMin} min sans activité, Opus 5.5 répond à votre place aux attentes de plus de ${st.data.settings.waitMin} min. Cliquer pour régler.`
      : "Réponse automatique COUPÉE. Cliquer pour régler.";
  }

  function bandItems() {
    const s = snoozed();
    const now = Date.now();
    return (st.data?.decisions || []).filter(d => !d.seenAt && d.status !== "running" && !d.dismissed && !(s[d.id] > now));
  }

  function renderBand() {
    const band = document.getElementById("auto-band");
    if (!band || !st.data) return;
    const items = bandItems();
    band.dataset.ndCount = String(items.length);
    if (!items.length) { band.hidden = true; band.innerHTML = ""; return; }
    band.hidden = false;
    band.innerHTML = `<div class="aa-band-head"><strong>🤖 ${items.length} décision${items.length > 1 ? "s" : ""} prise${items.length > 1 ? "s" : ""} à votre place</strong>
        <button type="button" class="aa-seen" data-aa-seen="1" title="Retirer du bandeau ; elles restent dans le récapitulatif 🤖">✓ Vu</button>
        <button type="button" class="aa-recap" data-aa-recap="1">Récapitulatif…</button></div>
      <ul class="aa-list">${items.map(d => decisionHtml(d, { compact: true })).join("")}</ul>`;
  }

  function guardrailsHtml() {
    const list = st.data.guardrails || [];
    const g = list.map(x => `<li><strong>${esc(x.label)}</strong>${x.cases?.length ? `<ul>${x.cases.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</li>`).join("");
    return `<details class="aa-guards-d"><summary title="Obligatoires, toujours actifs, non modifiables ici">🔒 ${list.length} garde-fous actifs</summary>
      <p class="aa-dim">Obligatoires et toujours actifs, indépendants de l’interrupteur. Dans ces cas, Opus choisit l’option qui avance sans engager, sinon le point vous est soumis. Les modifier demande une nouvelle décision de votre part (fichier data/auto-answer-guardrails.json) : aucun bouton ici.</p>
      <ul class="aa-guards">${g}</ul></details>`;
  }

  function backlogHtml() {
    const b = st.data.backlog || [];
    if (!b.length) return "";
    return `<details class="aa-backlog"><summary>📥 Arriéré : ${b.length} attente${b.length > 1 ? "s" : ""} jamais traitée${b.length > 1 ? "s" : ""} automatiquement</summary>
      <ul class="aa-list">${b.map(w => `<li class="aa-item" data-aa-backlog="${esc(w.key)}"><div class="aa-line"><span class="aa-when">${esc(day(w.since))}</span>
        <span class="aa-kind">${esc(KIND[w.kind] || w.kind)}</span>
        <span class="aa-on">${w.kind === "gap" ? targetHtml({ type: "gap", label: `lacune « ${w.gapKey || w.key} »` }) : targetHtml({ type: w.run ? "run" : "project", id: w.run, project: w.project, label: w.run ? `exécution ${w.run}` : w.project || "—" })}</span></div>
        <div class="aa-q">${esc(w.question)}</div><div class="aa-r aa-dim">${esc(w.reasonText || w.reason)}</div></li>`).join("")}</ul></details>`;
  }

  function renderOverlay() {
    const ov = document.getElementById("auto-overlay");
    if (!ov || ov.hidden || !st.data) return;
    const s = st.data.settings || {};
    const act = st.data.activity || {};
    const decisions = st.data.decisions || [];
    const discardable = decisions.filter(d => d.phase !== "pending").length;
    const history = st.data.history || [];
    // Les <details> ouverts le restent après un rafraîchissement.
    const openD = new Set([...ov.querySelectorAll("details[open]")].map(d => d.className));
    ov.querySelector(".aa-ov-body").innerHTML = `
      <label class="aa-switch"><input type="checkbox" id="aa-enabled" ${s.enabled ? "checked" : ""}> Règle active : Opus 5.5 répond à ma place quand je suis inactif</label>
      <div class="aa-delays">
        <label>Inactivité (min) <input type="number" id="aa-idle" min="1" max="1440" step="1" value="${esc(s.idleMin)}"></label>
        <label>Sans réponse depuis (min) <input type="number" id="aa-wait" min="1" max="1440" step="1" value="${esc(s.waitMin)}"></label>
        <button type="button" id="aa-save">Enregistrer</button> <span class="aa-msg" role="status"></span>
      </div>
      <p class="aa-dim">Dernier signe de vous : ${esc(act.lastAt ? when(act.lastAt) : "—")}${act.last?.kind ? ` (${esc(act.last.kind)})` : ""} · lire le dashboard compte comme une activité · règle active depuis ${esc(s.activatedAt ? day(s.activatedAt) : "—")} · model ${esc(st.data.model || "")}, aucun repli.</p>
      ${guardrailsHtml()}
      ${backlogHtml()}
      <h3>Décisions automatiques</h3>
      <div class="aa-tools"><button type="button" id="aa-dismiss-handled" ${discardable ? "" : "disabled"}>Écarter tout ce qui est traité ou obsolète (${discardable})</button></div>
      <ul class="aa-list">${decisions.map(d => decisionHtml(d)).join("") || "<li class=\"aa-dim\">Aucune.</li>"}</ul>
      ${history.length ? `<details class="aa-history"><summary>Historique : ${history.length} décision${history.length > 1 ? "s" : ""} écartée${history.length > 1 ? "s" : ""}</summary>
        <ul class="aa-list">${history.map(d => decisionHtml(d, { withUndo: true })).join("")}</ul></details>` : ""}`;
    for (const c of openD) ov.querySelector(`details.${CSS.escape(c.split(" ")[0])}`)?.setAttribute("open", "");
  }

  function render() { renderPill(); renderBand(); renderOverlay(); }

  async function load() {
    if (st.busy) return;
    st.busy = true;
    try { st.data = await call("/api/auto-answer"); render(); }
    catch { /* serveur antérieur à 0.121.0 : la pill reste cachée */ }
    finally { st.busy = false; }
  }

  function openOverlay() {
    const ov = document.getElementById("auto-overlay");
    if (!ov) return;
    ov.hidden = false;
    renderOverlay();
    ov.querySelector(".aa-close")?.focus();
  }
  function closeOverlay() { const ov = document.getElementById("auto-overlay"); if (ov) ov.hidden = true; }

  async function dismiss(ids, phase) {
    let confirmIt = false;
    if (phase === "pending") {
      if (!global.confirm("Cette décision attend encore la vôtre.\nL’écarter la retire de la vue (elle reste dans l’historique) sans y répondre. Écarter quand même ?")) return;
      confirmIt = true;
    }
    try { await call("/api/auto-answer/dismiss", { ids, confirm: confirmIt }); }
    catch (err) {
      if (err.status === 409 && err.body?.needsConfirm?.length && global.confirm("Cette décision attend encore la vôtre. Écarter quand même ?")) {
        try { await call("/api/auto-answer/dismiss", { ids, confirm: true }); } catch (e2) { global.alert(`Écarter impossible : ${e2.message}`); }
      } else if (err.status !== 409) global.alert(`Écarter impossible : ${err.message}`);
    }
    await load();
  }

  function gotoGaps() {
    if (location.hash !== "#/models") location.hash = "#/models";
    setTimeout(() => { const box = document.querySelector(".mr-gaps"); if (box?.hidden) document.querySelector(".mr-gaps-btn")?.click(); }, 400);
  }

  async function onClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#btn-auto") || t.closest("[data-aa-recap]")) { openOverlay(); return; }
    if (t.closest(".aa-close") || t.id === "auto-overlay") { closeOverlay(); return; }
    if (t.closest("[data-aa-goto]")) { e.preventDefault(); closeOverlay(); gotoGaps(); return; }
    const det = t.closest("[data-aa-detail]");
    if (det) {
      const id = det.dataset.aaDetail;
      if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
      renderBand();
      return;
    }
    const sn = t.closest("[data-aa-snooze]");
    if (sn) { snooze(sn.dataset.aaSnooze); renderBand(); return; }
    const dis = t.closest("[data-aa-dismiss]");
    if (dis) { await dismiss([dis.dataset.aaDismiss], dis.dataset.phase); return; }
    if (t.id === "aa-dismiss-handled") {
      try { await call("/api/auto-answer/dismiss", { handled: true }); } catch (err) { global.alert(err.message); }
      await load();
      return;
    }
    const undo = t.closest("[data-aa-undo]");
    if (undo) {
      if (!global.confirm("Annuler cette décision automatique ?\nL’élément revient à son point de retour (son état actuel est gardé).")) return;
      undo.disabled = true;
      try { await call(`/api/auto-answer/${encodeURIComponent(undo.dataset.aaUndo)}/undo`, {}); }
      catch (err) { global.alert(`Annulation impossible : ${err.message}`); }
      await load();
      return;
    }
    if (t.closest("[data-aa-seen]")) { try { await call("/api/auto-answer/seen", {}); } catch { /* retry at next poll */ } await load(); return; }
    if (t.id === "aa-save") {
      const msg = document.querySelector("#auto-overlay .aa-msg");
      try {
        await call("/api/auto-answer/settings", { idleMin: Number(document.getElementById("aa-idle").value), waitMin: Number(document.getElementById("aa-wait").value) });
        if (msg) msg.textContent = "enregistré";
      } catch (err) { if (msg) msg.textContent = err.message; }
      await load();
    }
  }
  async function onChange(e) {
    if (e.target?.id !== "aa-enabled") return;
    try { await call("/api/auto-answer/settings", { enabled: !!e.target.checked }); } catch (err) { global.alert(err.message); }
    await load();
  }
  function onKey(e) {
    const ov = document.getElementById("auto-overlay");
    if (e.key === "Escape" && ov && !ov.hidden) { e.stopPropagation(); closeOverlay(); }
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("keydown", onKey, true);
    for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "scroll", "touchstart", "focusin"]) {
      document.addEventListener(ev, onInteraction, { passive: true, capture: true });
    }
    global.addEventListener?.("focus", onInteraction);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { onInteraction({ type: "retour" }); load(); } });
    document.addEventListener("notif-dock:collapse-all", () => { st.open.clear(); renderBand(); });
    presence.timer = setInterval(presenceTick, 15_000);
    load();
    st.timer = setInterval(load, POLL_MS);
  }

  global.AutoAnswer = { load, render, decisionHtml, state: st, presence, presenceDue, PRESENCE_WINDOW_MS, HEARTBEAT_MS };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  }
})(typeof window !== "undefined" ? window : globalThis);
