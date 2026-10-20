// public/auto-answer.js — réponse automatique quand l'utilisateur est inactif (0.121.0)
//
// Règle : « si aucune activite de ma part depuis plus de 15 minutes, et qu'un
// process attend quelque chose de moi, et que je ne reponds pas dans les 5
// minutes, opus 5.5 est charge et autorise a repondre a ma place. Un point de
// retours est cree si possible. Sinon il faut avancer »
//   - pill #btn-auto : l'interrupteur global, toujours visible (état dans le libellé) ;
//   - #auto-overlay : interrupteur, délais, garde-fous (lecture seule), toutes les décisions ;
//   - #auto-band : à votre retour, le résumé des décisions prises à votre place,
//     avec « Annuler » pour chacune quand c'est possible, et « ✓ Vu ».
// Les garde-fous sont obligatoires et toujours actifs : aucun contrôle ici ne les modifie.
// Sans import ni export : pose globalThis.AutoAnswer.
(function (global) {
  "use strict";
  const POLL_MS = 30_000;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const KIND = { question: "question", pause: "pause de pipeline", permission: "autorisation", gap: "lacune" };
  const st = { data: null, timer: null, busy: false };

  function when(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  async function call(url, body) {
    const r = await fetch(url, body === undefined ? { headers: { Accept: "application/json" }, credentials: "same-origin" }
      : { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function decisionHtml(d, withUndo) {
    const hits = d.guardrails?.hits?.length ? `<div class="aa-guard">⚠ garde-fou : ${esc(d.guardrails.hits.join(", "))}</div>` : "";
    const undo = withUndo && d.undoable
      ? `<button type="button" class="aa-undo" data-aa-undo="${esc(d.id)}">Annuler</button>`
      : d.undone ? `<span class="aa-undone">↩ annulée</span>` : "";
    return `<li class="aa-item" data-aa-id="${esc(d.id)}" data-aa-status="${esc(d.status)}">
      <div class="aa-line"><span class="aa-when">${esc(when(d.at))}</span>
        <span class="aa-proj">${esc(d.project || "—")}</span>
        <span class="aa-kind">${esc(KIND[d.kind] || d.kind)}</span>
        <span class="aa-status">${esc(d.statusText || d.status)}</span>${undo}</div>
      <div class="aa-q">Demande : ${esc(String(d.question || "").replace(/\s+/g, " ").slice(0, 300))}</div>
      ${d.answer ? `<div class="aa-a">Réponse : ${d.decision ? `[${esc(d.decision)}] ` : ""}${esc(String(d.answer).slice(0, 600))}</div>` : ""}
      ${d.reason ? `<div class="aa-r">Raison : ${esc(d.reason)}</div>` : ""}
      ${d.why && d.status !== "applied" ? `<div class="aa-r">${esc(d.why)}</div>` : ""}
      ${hits}
      ${d.recovery?.text ? `<div class="aa-rec">${esc(d.recovery.text)}</div>` : ""}
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

  function renderBand() {
    const band = document.getElementById("auto-band");
    if (!band || !st.data) return;
    const unseen = (st.data.decisions || []).filter(d => !d.seenAt && d.status !== "running");
    if (!unseen.length) { band.hidden = true; band.innerHTML = ""; return; }
    band.hidden = false;
    band.innerHTML = `<div class="aa-band-head"><strong>🤖 ${unseen.length} décision${unseen.length > 1 ? "s" : ""} prise${unseen.length > 1 ? "s" : ""} à votre place pendant votre absence</strong>
        <span class="aa-dim">${esc(st.data.mark || "")}</span>
        <button type="button" class="aa-seen" data-aa-seen="1">✓ Vu</button></div>
      <ul class="aa-list">${unseen.map(d => decisionHtml(d, true)).join("")}</ul>`;
  }

  function renderOverlay() {
    const ov = document.getElementById("auto-overlay");
    if (!ov || ov.hidden || !st.data) return;
    const s = st.data.settings || {};
    const g = (st.data.guardrails || []).map(x => `<li><strong>${esc(x.label)}</strong>${x.cases?.length ? `<ul>${x.cases.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</li>`).join("");
    const act = st.data.activity || {};
    ov.querySelector(".aa-ov-body").innerHTML = `
      <label class="aa-switch"><input type="checkbox" id="aa-enabled" ${s.enabled ? "checked" : ""}> Règle active : Opus 5.5 répond à ma place quand je suis inactif</label>
      <div class="aa-delays">
        <label>Inactivité (min) <input type="number" id="aa-idle" min="1" max="1440" step="1" value="${esc(s.idleMin)}"></label>
        <label>Sans réponse depuis (min) <input type="number" id="aa-wait" min="1" max="1440" step="1" value="${esc(s.waitMin)}"></label>
        <button type="button" id="aa-save">Enregistrer</button> <span class="aa-msg" role="status"></span>
      </div>
      <p class="aa-dim">Dernière activité : ${esc(act.lastAt ? when(act.lastAt) : "—")}${act.last?.kind ? ` (${esc(act.last.kind)})` : ""} · model ${esc(st.data.model || "")}, aucun repli.</p>
      <h3>Garde-fous — obligatoires, toujours actifs</h3>
      <p class="aa-dim">Indépendants de l’interrupteur. Dans ces cas, Opus choisit l’option qui avance sans engager, sinon le point vous est soumis. Les modifier demande une nouvelle décision de votre part (fichier data/auto-answer-guardrails.json) : aucun bouton ici.</p>
      <ul class="aa-guards">${g}</ul>
      <h3>Décisions automatiques</h3>
      <ul class="aa-list">${(st.data.decisions || []).map(d => decisionHtml(d, true)).join("") || "<li class=\"aa-dim\">Aucune.</li>"}</ul>`;
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

  async function onClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#btn-auto")) { openOverlay(); return; }
    if (t.closest(".aa-close") || t.id === "auto-overlay") { closeOverlay(); return; }
    const undo = t.closest("[data-aa-undo]");
    if (undo) {
      if (!global.confirm("Annuler cette décision automatique ?\nLe projet revient au point de retour (son état actuel est gardé dans un tag auto-answer-undo).")) return;
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
    load();
    st.timer = setInterval(load, POLL_MS);
  }

  global.AutoAnswer = { load, render, decisionHtml, state: st };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  }
})(typeof window !== "undefined" ? window : globalThis);
