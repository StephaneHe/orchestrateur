/* ==========================================================================
   public/todo-panel.js — "☑ TODO" tab of the side panel (0.75.0)
   --------------------------------------------------------------------------
   User request (2026-10-13): each musician's TODO list, as checkboxes, OPEN
   items on top then DONE ones below (0.76.2, replaces "done first"), each part
   newest first by entry date; read-only
   for the user (the musician of the item ticks it, with scripts/todo.mjs);
   the musician's name next to each done item. Each item opens an overlay
   with the whole item (0.77.0). Items are reordered by drag and drop, the
   order kept by the server in todo-order.json (0.83.0).
   Reads GET /api/todo (no write route on the lists themselves). Refreshed every 15 s while the
   tab is open; the open-items count of the pill every 60 s.
   ========================================================================== */
(function () {
  "use strict";
  if (!globalThis.SidePanel) return;
  const LS_PROJECT = "todo.filter.project";
  const st = { data: null, pane: null, timer: null, loading: false, error: null };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } };
  const TYPE = { fonctionnalite: "Fonctionnalité", correction: "Correction", projet: "Projet" };

  /** "2026-10-13T09:12" → "13/10/26 09:12" (dates are local in the files). */
  function fmt(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}:${m[5]}` : "—";
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const r = await fetch("/api/todo");
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      st.data = await r.json();
      st.error = null;
    } catch (e) {
      st.error = e.status ? await SidePanel.explainFailure(e.status, "Liste") : `Liste indisponible : ${e.message}`;
    } finally {
      st.loading = false;
    }
    SidePanel.setBadge("todo", st.data ? st.data.counts.open : "");
    render();
  }

  function itemHtml(i) {
    const done = i.status === "done";
    const added = `<span class="ti-added" title="${i.addedEstimated ? "Date d’entrée estimée (date du fichier)" : "Date d’entrée dans la liste"}">${i.addedEstimated ? "≈ " : ""}${esc(fmt(i.addedAt))}</span>`;
    const type = TYPE[i.type] ? `<span class="ti-type ti-type-${esc(i.type)}">${TYPE[i.type]}</span>` : "";
    const prog = i.status === "progress" ? `<span class="ti-prog" title="En cours">◐ en cours</span>` : "";
    const nNotes = Array.isArray(i.notes) ? i.notes.length : 0;
    const notes = nNotes ? `<span class="ti-notes" title="${nNotes} note${nNotes > 1 ? "s" : ""} — ouvrir l’item pour les lire">✎ ${nNotes}</span>` : "";
    const by = !done ? "" : i.rejected
      ? `<span class="ti-rejected" title="Rejeté par l’utilisateur le ${esc(fmt(i.rejected.at))}">✕ rejeté (${esc(fmt(i.rejected.at))}) par l’utilisateur</span>`
      : i.doneBy
      ? `<span class="ti-by" title="Coché par ${esc(i.doneBy)}${i.doneAt ? ` le ${esc(fmt(i.doneAt))}` : ""}">✓ ${esc(i.doneBy)}</span>`
      : `<span class="ti-by is-unknown" title="Nom non enregistré : item coché à la main, hors de todo.mjs">✓ —</span>`;
    return `<li class="todo-item${done ? " is-done" : ""}${i.rejected ? " is-rejected" : ""}" data-key="${esc(i.project + "/" + i.id)}" data-id="${esc(i.id)}" data-status="${esc(i.status)}" data-project="${esc(i.project)}" data-added="${esc(i.addedAt || "")}" tabindex="0" role="button" aria-haspopup="dialog" title="Voir l’item complet">
      <span class="ti-grip" aria-hidden="true" title="Glisser pour déplacer (clavier : Alt+↑ / Alt+↓)">⋮⋮</span>
      <input type="checkbox" class="ti-box" disabled ${done ? "checked" : ""} aria-label="${i.rejected ? "Rejeté" : done ? "Fait" : "Non fait"} (lecture seule : seul le musicien coche)" title="Lecture seule : c’est le musicien qui coche">
      <div class="ti-main"><div class="ti-title">${esc(i.title)}</div>
        ${i.detail ? `<div class="ti-detail">${esc(i.detail)}</div>` : ""}
        <div class="ti-meta">${by}<span class="ti-proj">${esc(i.project)}</span>${added}${type}${prog}${notes}</div></div></li>`;
  }

  /* ---- Item overlay (0.77.0): the whole item, on click / Enter / Space ----
     User request (2026-10-13): « chaque item doit être clickable et afficher
     une overlay qui présente l'item complet ». Later parts (notes, reject,
     send to the chef) plug in through TodoPanel.registerAction(); none is
     registered yet, so the action bar stays hidden. */
  const actions = [];
  const ov = { el: null, id: null, returnFocus: null, drafts: {}, filledId: null, busy: false };
  const NOTE_MAX = 4000;   // = scripts/todo-notes.mjs
  const STATUS = { todo: "○ Non fait", progress: "◐ En cours", done: "✓ Fait" };

  function overlayEl() {
    if (ov.el) return ov.el;
    const el = document.createElement("div");
    el.id = "todo-overlay";
    el.className = "tov";
    el.hidden = true;
    el.innerHTML = `<div class="tov-backdrop" data-tov-close></div>
      <section class="tov-dialog" role="dialog" aria-modal="true" aria-labelledby="tov-title">
        <header class="tov-head"><h2 id="tov-title" class="tov-title"></h2>
          <button type="button" class="tov-close" data-tov-close aria-label="Fermer" title="Fermer (Échap)">✕</button></header>
        <div class="tov-scroll"><div class="tov-body"></div>
          <section class="tov-notes" aria-labelledby="tov-notes-h">
            <h3 id="tov-notes-h" class="tov-notes-h">Notes <span class="tov-notes-n"></span></h3>
            <ol class="tov-notes-list"></ol>
            <form class="tov-note-form">
              <label class="tov-note-label" for="tov-note-text">Ajouter une note</label>
              <textarea id="tov-note-text" class="tov-note-text" rows="3" maxlength="${NOTE_MAX}" placeholder="Votre note sur cet item (Ctrl+Entrée pour enregistrer)"></textarea>
              <div class="tov-note-bar"><span class="tov-note-msg" role="status" aria-live="polite"></span>
                <button type="submit" class="tov-note-add">Ajouter la note</button></div>
            </form>
          </section></div>
        <section class="tov-confirm" hidden aria-labelledby="tov-confirm-h">
          <h3 id="tov-confirm-h" class="tov-confirm-h">Envoyer cet item au chef ?</h3>
          <p class="tov-hint tov-confirm-hint">Ce message sera placé dans votre saisie au chef. Il partira quand vous l’enverrez (Entrée ou ➤), comme tout message au chef, qui en lancera l’exécution.</p>
          <pre class="tov-confirm-msg"></pre>
          <p class="tov-confirm-draft" hidden></p>
          <div class="tov-confirm-bar">
            <button type="button" class="tov-btn tov-confirm-ok">Placer dans le message au chef</button>
            <button type="button" class="tov-btn tov-confirm-cancel">Annuler</button>
          </div>
        </section>
        <section class="tov-reject" hidden aria-labelledby="tov-reject-h">
          <h3 id="tov-reject-h" class="tov-confirm-h">Rejeter cet item ?</h3>
          <p class="tov-hint">Il sera marqué « rejeté (date) par l’utilisateur » dans le TODO_LIST.md de <b class="tov-reject-proj"></b>, que le musicien lit, et passera dans les faits, barré.</p>
          <p class="tov-reject-msg" role="status" aria-live="polite"></p>
          <div class="tov-confirm-bar">
            <button type="button" class="tov-btn tov-reject-ok">Rejeter l’item</button>
            <button type="button" class="tov-btn tov-reject-cancel">Annuler</button>
          </div>
        </section>
        <footer class="tov-actions" hidden></footer>
      </section>`;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-tov-close]")) closeItem(); });
    el.querySelector(".tov-confirm-cancel").addEventListener("click", () => hideConfirm(true));
    el.querySelector(".tov-confirm-ok").addEventListener("click", () => confirmSend());
    el.querySelector(".tov-reject-cancel").addEventListener("click", () => hideReject(true));
    el.querySelector(".tov-reject-ok").addEventListener("click", () => confirmReject());
    const form = el.querySelector(".tov-note-form"), area = el.querySelector(".tov-note-text");
    form.addEventListener("submit", (e) => { e.preventDefault(); addNote(); });
    area.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); } });
    area.addEventListener("input", () => { if (ov.id) ov.drafts[ov.id] = area.value; });
    el.querySelector(".tov-actions").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tov-action]");
      const a = b && actions.find(x => x.id === b.dataset.tovAction);
      const item = currentItem();
      if (a && item) a.run(item, { close: closeItem, reload: load });
    });
    document.body.appendChild(el);
    ov.el = el;
    return el;
  }

  function findItem(id) { return (st.data && st.data.items.find(i => i.id === id)) || null; }
  function currentItem() { return findItem(ov.id) || ov.last || null; }

  function fillOverlay(i) {
    const el = overlayEl();
    ov.last = i;
    const dialog = el.querySelector(".tov-dialog");
    dialog.dataset.id = i.id;
    dialog.dataset.status = i.status;
    el.querySelector(".tov-title").textContent = i.title;
    const full = i.detailFull || i.detail || "";
    const done = i.status === "done";
    const doneLine = !done ? "" : i.rejected
      ? `<div class="tov-row"><span class="tov-k">Rejeté</span><span class="tov-rejected">rejeté (${esc(fmt(i.rejected.at))}) par l’utilisateur</span></div>`
      : i.doneBy
      ? `<div class="tov-row"><span class="tov-k">Fait</span><span class="tov-done-at">${esc(fmt(i.doneAt))}</span> par <b class="tov-by">${esc(i.doneBy)}</b></div>`
      : `<div class="tov-row"><span class="tov-k">Fait</span><span class="tov-by is-unknown">coché à la main (nom non enregistré)</span></div>`;
    el.querySelector(".tov-body").innerHTML = `
      <div class="tov-row tov-tags"><span class="tov-status tov-status-${esc(i.rejected ? "rejected" : i.status)}">${i.rejected ? "✕ Rejeté" : STATUS[i.status] || esc(i.status)}</span>
        <span class="tov-proj">${esc(i.project)}</span>${TYPE[i.type] ? `<span class="ti-type ti-type-${esc(i.type)}">${TYPE[i.type]}</span>` : ""}</div>
      <div class="tov-row"><span class="tov-k">Entrée</span><span class="tov-added">${i.addedEstimated ? "≈ " : ""}${esc(fmt(i.addedAt))}</span>${i.addedEstimated ? `<span class="tov-hint">(date estimée : date du fichier)</span>` : ""}</div>
      ${doneLine}
      ${full ? `<div class="tov-text tov-detail">${esc(full)}</div>` : ""}
      ${i.more ? `<div class="tov-text tov-more">${esc(i.more)}</div>` : ""}
      ${!full && !i.more ? `<p class="tov-hint">Aucun détail : l’item tient en son titre.</p>` : ""}
      <div class="tov-src">${esc(i.project)}/TODO_LIST.md, ligne ${esc(i.line)} · <code>${esc(i.id)}</code></div>`;
    renderNotes(i);
    const bar = el.querySelector(".tov-actions");
    const usable = actions.filter(a => !a.when || a.when(i));
    bar.innerHTML = usable.map(a => `<button type="button" class="tov-action" data-tov-action="${esc(a.id)}"${a.title ? ` title="${esc(a.title)}"` : ""}>${esc(a.label)}</button>`).join("");
    bar.hidden = !usable.length || !el.querySelector(".tov-confirm").hidden || !el.querySelector(".tov-reject").hidden;
  }

  /* ---- « Envoyer au chef » (0.79.0, part 4/5) ----------------------------
     User request: « Possilité aussi de lancer le contenu de l'item au chef,
     pour lancer l'execution ». After a confirmation showing the exact
     message, the message goes into the chef's composer
     and leaves through it when the user sends it — the same channel as any
     message to the chef. */
  function chefMessage(i) {
    const full = i.detailFull || i.detail || "";
    const notes = Array.isArray(i.notes) ? i.notes : [];
    return [
      `Item de la TODO de ${i.project} à exécuter : ${i.title}`,
      full,
      i.more || "",
      notes.length ? "Notes de l’utilisateur :\n" + notes.map(n => `- ${n.at ? `(${fmt(n.at)}) ` : ""}${n.text}`).join("\n") : "",
      `(Item ${i.id}, ${i.project}/TODO_LIST.md ligne ${i.line}, ${(STATUS[i.status] || i.status).replace(/^\S+\s/, "").toLowerCase()}.)`,
    ].filter(Boolean).join("\n\n");
  }

  /* ---- « Discuter avec le chef » (0.96.0) --------------------------------
     User request: « liste des todo, on devrait pouvoir envoyer au chef, pas
     pour lancer mais en discuter, si j'ai besoin de reponse. » The message
     starts with the explicit prefix /chef-discussion: dispatch.mjs then runs
     the chef's Routage in its discussion mode, which has no dispatch step —
     nothing is launched; the chef's answer comes back in the usual thread. */
  const DISCUSS_PREFIX = "/chef-discussion";
  function discussMessage(i) {
    const full = i.detailFull || i.detail || "";
    const notes = Array.isArray(i.notes) ? i.notes : [];
    return [
      DISCUSS_PREFIX,
      `Item de la TODO de ${i.project} à DISCUTER (ne pas le lancer) : ${i.title}`,
      full,
      i.more || "",
      notes.length ? "Notes de l’utilisateur :\n" + notes.map(n => `- ${n.at ? `(${fmt(n.at)}) ` : ""}${n.text}`).join("\n") : "",
      `(Item ${i.id}, ${i.project}/TODO_LIST.md ligne ${i.line}, ${(STATUS[i.status] || i.status).replace(/^\S+\s/, "").toLowerCase()}.)`,
      "Ma question / ce dont je veux discuter : ",
    ].filter(Boolean).join("\n\n");
  }
  const CONFIRM = {
    run: { h: "Envoyer cet item au chef ?", ok: "Placer dans le message au chef", msg: (i) => chefMessage(i), action: "send-chef",
      hint: "Ce message sera placé dans votre saisie au chef. Il partira quand vous l’enverrez (Entrée ou ➤), comme tout message au chef, qui en lancera l’exécution." },
    discuss: { h: "Discuter de cet item avec le chef ?", ok: "Placer dans le message au chef (discussion)", msg: (i) => discussMessage(i), action: "discuss-chef",
      hint: "Ce message sera placé dans votre saisie au chef, pour en DISCUTER : ajoutez votre question à la fin, puis envoyez-le (Entrée ou ➤). Le chef répond dans le fil ; rien n’est lancé (aucune tâche, aucun musicien)." },
  };
  function askSendToChef(i, kind = "run") {
    const el = overlayEl();
    const box = el.querySelector(".tov-confirm");
    const k = CONFIRM[kind] ? kind : "run";
    box.dataset.kind = k;
    box.querySelector(".tov-confirm-h").textContent = CONFIRM[k].h;
    box.querySelector(".tov-confirm-hint").textContent = CONFIRM[k].hint;
    box.querySelector(".tov-confirm-ok").textContent = CONFIRM[k].ok;
    box.querySelector(".tov-confirm-msg").textContent = CONFIRM[k].msg(i);
    const draft = (document.getElementById("composer-input")?.value || "").trim();
    const warn = box.querySelector(".tov-confirm-draft");
    warn.textContent = draft ? `⚠ Votre brouillon actuel au chef (${draft.length} caractères) sera remplacé.` : "";
    warn.hidden = !draft;
    box.dataset.id = i.id;
    box.hidden = false;
    el.querySelector(".tov-actions").hidden = true;
    box.querySelector(".tov-confirm-ok").focus();
  }

  function hideConfirm(refocus) {
    if (!ov.el) return;
    const box = ov.el.querySelector(".tov-confirm");
    if (box.hidden) return;
    box.hidden = true;
    const i = currentItem();
    if (i) fillOverlay(i);
    if (refocus) ov.el.querySelector(`[data-tov-action="${(CONFIRM[box.dataset.kind] || CONFIRM.run).action}"]`)?.focus();
  }

  function confirmSend() {
    const i = currentItem();
    if (!i || !globalThis.App?.prepareChefMessage) return;
    const kind = ov.el?.querySelector(".tov-confirm")?.dataset.kind === "discuss" ? "discuss" : "run";
    const text = CONFIRM[kind].msg(i);
    closeItem();
    globalThis.SidePanel?.close();
    globalThis.App.prepareChefMessage(text, { project: i.project, title: i.title, id: i.id, ...(kind === "discuss" ? { discuss: true } : {}) });
  }

  /* ---- Reject (0.85.0, part 3/5): « Possibilité […] de rejetter l'item ».
     User choice (2026-10-13): the rejection is written in the musician's
     TODO_LIST.md; the item goes to the done ones, struck, « rejeté (date) par
     l'utilisateur ». A confirmation first; POST /api/reject/todo/:p/:id. */
  function askReject(i) {
    const el = overlayEl();
    const box = el.querySelector(".tov-reject");
    box.querySelector(".tov-reject-proj").textContent = i.project;
    box.querySelector(".tov-reject-msg").textContent = "";
    box.querySelector(".tov-reject-msg").classList.remove("is-error");
    box.hidden = false;
    el.querySelector(".tov-actions").hidden = true;
    box.querySelector(".tov-reject-ok").focus();
  }

  function hideReject(refocus) {
    if (!ov.el) return;
    const box = ov.el.querySelector(".tov-reject");
    if (box.hidden) return;
    box.hidden = true;
    const i = currentItem();
    if (i) fillOverlay(i);
    if (refocus) ov.el.querySelector('[data-tov-action="reject"]')?.focus();
  }

  async function confirmReject() {
    const i = currentItem();
    if (!i || ov.busy) return;
    const box = ov.el.querySelector(".tov-reject");
    const msg = box.querySelector(".tov-reject-msg"), btn = box.querySelector(".tov-reject-ok");
    ov.busy = true; btn.disabled = true;
    msg.classList.remove("is-error");
    msg.textContent = "Rejet en cours…";
    try {
      const r = await fetch(`/api/reject/todo/${encodeURIComponent(i.project)}/${encodeURIComponent(i.id)}`, { method: "POST" });
      const isJson = (r.headers.get("content-type") || "").includes("json");
      const j = isJson ? await r.json() : null;
      if (!r.ok || !j || !j.ok) {
        msg.textContent = j && j.error ? `Item non rejeté : ${j.error}` : await SidePanel.explainFailure(r.status, "Rejet");
        msg.classList.add("is-error");
        return;
      }
      box.hidden = true;
      await load();
      const now = findItem(i.id) || { ...i, ...j.item };
      if (ov.el && !ov.el.hidden) { fillOverlay(now); ov.el.querySelector(".tov-close").focus(); }
    } catch (e) {
      msg.textContent = `Item non rejeté : ${e.message}`;
      msg.classList.add("is-error");
    } finally {
      ov.busy = false; btn.disabled = false;
    }
  }

  /* ---- Notes (0.78.0): « Possibilité d'y ajouter des notes ». Stored by the
     server in todo-notes.json, never in the musician's TODO_LIST.md. The form
     is built once: the 15 s refresh only redraws the list, never the draft. */
  function renderNotes(i) {
    const el = ov.el;
    const notes = Array.isArray(i.notes) ? i.notes : [];
    el.querySelector(".tov-notes-n").textContent = notes.length ? `(${notes.length})` : "";
    el.querySelector(".tov-notes-list").innerHTML = notes.length
      ? notes.map(n => `<li class="tov-note" data-note="${esc(n.id)}"><div class="tov-note-meta">${esc(fmt(n.at))}${n.by ? ` · ${esc(n.by)}` : ""}</div><div class="tov-note-body">${esc(n.text)}</div></li>`).join("")
      : `<li class="tov-notes-empty">Aucune note pour l’instant.</li>`;
    if (ov.filledId !== i.id) {
      ov.filledId = i.id;
      el.querySelector(".tov-note-text").value = ov.drafts[i.id] || "";
      noteMsg("");
    }
  }

  function noteMsg(text, bad) {
    const m = ov.el.querySelector(".tov-note-msg");
    m.textContent = text;
    m.classList.toggle("is-error", !!bad);
  }

  async function addNote() {
    const item = currentItem();
    const area = ov.el.querySelector(".tov-note-text");
    const text = area.value.trim();
    if (!item || ov.busy) return;
    if (!text) { noteMsg("La note est vide.", true); area.focus(); return; }
    if (text.length > NOTE_MAX) { noteMsg(`Note trop longue (${text.length} caractères, ${NOTE_MAX} au plus).`, true); return; }
    ov.busy = true;
    const btn = ov.el.querySelector(".tov-note-add");
    btn.disabled = true;
    noteMsg("Enregistrement…");
    try {
      const r = await fetch(`/api/notes/todo/${encodeURIComponent(item.project)}/${encodeURIComponent(item.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      const isJson = (r.headers.get("content-type") || "").includes("json");
      const j = isJson ? await r.json() : null;
      if (!r.ok || !j || !j.ok) {
        noteMsg(j && j.error ? `Note non enregistrée : ${j.error}` : await SidePanel.explainFailure(r.status, "Notes"), true);
        return;
      }
      item.notes = j.notes;
      const live = findItem(item.id);
      if (live) live.notes = j.notes;
      delete ov.drafts[item.id];
      area.value = "";
      renderNotes(item);
      noteMsg("Note enregistrée.");
      if (st.pane) render();
      area.focus();
    } catch (e) {
      noteMsg(`Note non enregistrée : ${e.message}`, true);
    } finally {
      ov.busy = false;
      btn.disabled = false;
    }
  }

  function openItem(id) {
    const i = findItem(id);
    if (!i) return false;
    ov.id = id;
    ov.returnFocus = document.activeElement;
    fillOverlay(i);
    ov.el.hidden = false;
    document.body.classList.add("tov-open");
    ov.el.querySelector(".tov-close").focus();
    return true;
  }

  function closeItem() {
    if (!ov.el || ov.el.hidden) return;
    ov.el.hidden = true;
    ov.id = null;
    ov.el.querySelector(".tov-confirm").hidden = true;
    ov.el.querySelector(".tov-reject").hidden = true;
    ov.filledId = null;
    document.body.classList.remove("tov-open");
    const back = ov.returnFocus;
    ov.returnFocus = null;
    if (back && back.isConnected) back.focus();
    else if (st.pane) st.pane.querySelector(".todo-project")?.focus();
  }

  // Capture phase: Escape closes the overlay only, not the side panel behind it.
  document.addEventListener("keydown", (e) => {
    if (!ov.el || ov.el.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      // Escape first cancels a pending confirmation, then closes the overlay.
      if (!ov.el.querySelector(".tov-confirm").hidden) hideConfirm(true);
      else if (!ov.el.querySelector(".tov-reject").hidden) hideReject(true);
      else closeItem();
      return;
    }
    if (e.key === "Tab") {
      const f = [...ov.el.querySelectorAll("button:not([hidden]), textarea, [href], [tabindex]:not([tabindex='-1'])")].filter(x => x.offsetParent !== null && !x.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    // Keys meant for the dashboard behind (t, g m…) are not passed on.
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) e.stopImmediatePropagation();
  }, true);

  function render() {
    const pane = st.pane;
    if (!pane) return;
    if (drag.on) { drag.pendingRender = true; return; }
    const d = st.data;
    const sel = pane.querySelector(".todo-project");
    if (!d) {
      // Never an empty musician list: say why there is none (user report, 0.76.5).
      sel.innerHTML = `<option value="" disabled selected>${st.error ? "— liste des musiciens indisponible —" : "Chargement…"}</option>`;
      pane.querySelector(".todo-body").innerHTML = `<p class="todo-empty${st.error ? " todo-unavailable" : ""}">${esc(st.error || "Chargement…")}</p>`;
      return;
    }
    const project = lsGet(LS_PROJECT);
    const names = d.lists.map(l => l.project);
    sel.innerHTML = `<option value="">Tous les projets (${d.lists.length})</option>` +
      names.map(n => `<option value="${esc(n)}"${n === project ? " selected" : ""}>${esc(n)}</option>`).join("");
    const items = d.items.filter(i => !project || i.project === project);
    const orderMsg = d.orderError ? `<p class="todo-order-msg is-error" role="status">Ordre personnalisé illisible : ${esc(d.orderError)}</p>` : (st.orderMsg ? `<p class="todo-order-msg${st.orderBad ? " is-error" : ""}" role="status">${esc(st.orderMsg)}</p>` : "");
    const done = items.filter(i => i.status === "done"), open = items.filter(i => i.status !== "done");
    // Rebuilding the list would drop the keyboard focus on every refresh
    // (15 s timer, save of the order): give it back to the same item.
    const focused = document.activeElement;
    const focusKey = focused && pane.contains(focused) && focused.classList.contains("todo-item") ? focused.dataset.key : null;
    pane.querySelector(".todo-body").innerHTML = orderMsg + (!items.length
      ? `<p class="todo-empty">Aucun item${project ? ` pour ${esc(project)}` : ""}.</p>`
      : `<section class="todo-sec" data-sec="open"><h3 class="todo-sec-h">Non faits <span class="todo-n">${open.length}</span></h3><ul class="todo-list">${open.map(itemHtml).join("")}</ul></section>
         <section class="todo-sec" data-sec="done"><h3 class="todo-sec-h">Faits <span class="todo-n">${done.length}</span></h3><ul class="todo-list">${done.map(itemHtml).join("")}</ul></section>`);
    if (focusKey) pane.querySelector(`.todo-item[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    // Keep an open overlay in step with the 15 s refresh (an item that left
    // the list stays shown as it was).
    if (ov.el && !ov.el.hidden) { const i = findItem(ov.id); if (i) fillOverlay(i); }
  }

  /* ---- Drag and drop (0.83.0, part 5/5): « Chaque item est drag & dropable,
     et les positions doivent persister. » Pointer events, so mouse, pen and
     touch share one path: a mouse drags from anywhere on the item past a
     6 px threshold (below it, the click opens the overlay as before); a
     finger drags from the ⋮⋮ grip only, so the list still scrolls. An item
     moves inside its own part: open items stay on top, done ones below
     (0.76.2). The new order is saved by POST /api/order/todo. */
  const drag = { on: false, li: null, pointer: null, before: null, x: 0, y: 0, suppressClickUntil: 0, pendingRender: false };
  const DRAG_THRESHOLD = 6;
  const listKeys = (ul) => [...ul.querySelectorAll(":scope > .todo-item")].map(x => x.dataset.key);

  function onPointerDown(e) {
    if (e.button !== 0 || drag.li) return;
    const li = e.target.closest(".todo-item");
    if (!li) return;
    if (e.pointerType !== "mouse" && !e.target.closest(".ti-grip")) return;
    Object.assign(drag, { li, x: e.clientX, y: e.clientY, pointer: e.pointerId, on: false, before: listKeys(li.parentElement) });
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  }

  function onPointerMove(e) {
    if (e.pointerId !== drag.pointer || !drag.li) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.on = true;
      drag.li.classList.add("is-dragging");
      st.pane.classList.add("todo-dragging");
    }
    e.preventDefault();
    const list = drag.li.parentElement;
    // Only the items of the same part are targets.
    const others = [...list.children].filter(x => x !== drag.li);
    const next = others.find(x => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (next) { if (drag.li.nextElementSibling !== next) list.insertBefore(drag.li, next); }
    else if (list.lastElementChild !== drag.li && e.clientY <= list.getBoundingClientRect().bottom + 24) list.appendChild(drag.li);
  }

  function endDrag() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
    if (drag.li) drag.li.classList.remove("is-dragging");
    if (st.pane) st.pane.classList.remove("todo-dragging");
    const out = { was: drag.on, li: drag.li, before: drag.before };
    Object.assign(drag, { on: false, li: null, pointer: null, before: null });
    return out;
  }

  function onPointerUp(e) {
    if (e.pointerId !== drag.pointer) return;
    const { was, li, before } = endDrag();
    if (!was) return;
    drag.suppressClickUntil = Date.now() + 400;
    if (listKeys(li.parentElement).join("|") !== before.join("|")) saveOrder(li.parentElement);
    else if (drag.pendingRender) { drag.pendingRender = false; render(); }
  }

  function onPointerCancel(e) {
    if (e.pointerId !== drag.pointer) return;
    if (endDrag().was) { drag.pendingRender = false; render(); }   // back to the saved order
  }

  function moveByKey(li, dir) {
    const sib = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    li.parentElement.insertBefore(li, dir < 0 ? sib : sib.nextElementSibling);
    li.focus();
    saveOrder(li.parentElement, li.dataset.key);
  }

  /** The visible part (maybe filtered on one project) gives its new order,
   *  merged into the whole list: the slots of the visible items, in the
   *  global order, are refilled in the new order. */
  async function saveOrder(ul, focusKey) {
    const d = st.data;
    if (!d) return;
    const visible = listKeys(ul);
    const shown = new Set(visible);
    const keyOf = (i) => i.project + "/" + i.id;
    let k = 0;
    const keys = d.items.map(i => (shown.has(keyOf(i)) ? visible[k++] : keyOf(i)));
    const byKey = new Map(d.items.map(i => [keyOf(i), i]));
    d.items = keys.map(x => byKey.get(x)).filter(Boolean);
    st.orderMsg = "Enregistrement de l’ordre…"; st.orderBad = false;
    try {
      const r = await fetch("/api/order/todo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
      const isJson = (r.headers.get("content-type") || "").includes("json");
      const j = isJson ? await r.json() : null;
      if (!r.ok || !j || !j.ok) {
        st.orderMsg = j && j.error ? `Ordre non enregistré : ${j.error}` : await SidePanel.explainFailure(r.status, "Ordre");
        st.orderBad = true;
        drag.pendingRender = false;
        await load();
        return;
      }
      st.orderMsg = "Ordre enregistré."; st.orderBad = false;
      clearTimeout(st.orderMsgTimer);
      st.orderMsgTimer = setTimeout(() => { st.orderMsg = null; render(); }, 4000);
    } catch (e) {
      st.orderMsg = `Ordre non enregistré : ${e.message}`; st.orderBad = true;
    }
    drag.pendingRender = false;
    render();
    if (focusKey && st.pane) st.pane.querySelector(`.todo-item[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  SidePanel.register({
    id: "todo", label: "TODO", icon: "☑", key: "t",
    mount(pane) {
      st.pane = pane;
      pane.innerHTML = `<div class="todo-filters"><label class="todo-f">Projet <select class="todo-project"></select></label>
        <span class="todo-ro" title="Seuls les musiciens cochent leurs items (scripts/todo.mjs)">lecture seule</span></div>
        <div class="todo-body"><p class="todo-empty">Chargement…</p></div>`;
      pane.querySelector(".todo-project").addEventListener("change", (e) => { lsSet(LS_PROJECT, e.target.value); render(); });
      const body = pane.querySelector(".todo-body");
      body.addEventListener("click", (e) => {
        // A drag ends with a click on the item: it must not open the overlay.
        if (Date.now() < drag.suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
        const li = e.target.closest(".todo-item");
        if (li) openItem(li.dataset.id);
      });
      body.addEventListener("keydown", (e) => {
        const li = e.target.closest(".todo-item");
        if (!li) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveByKey(li, e.key === "ArrowUp" ? -1 : 1); return; }
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openItem(li.dataset.id); }
      });
      body.addEventListener("pointerdown", onPointerDown);
    },
    onOpen() { load(); clearInterval(st.timer); st.timer = setInterval(load, 15_000); },
    onClose() { clearInterval(st.timer); st.timer = null; closeItem(); },
  });

  // Count of open items on the pill, even with the panel closed.
  load();
  setInterval(() => { if (!SidePanel.isOpen() && SidePanel.enabled()) load(); }, 60_000);

  /**
   * Adds a button to the item overlay: {id, label, title?, when?(item),
   * run(item, {close, reload})}. Re-registering an id replaces it.
   */
  function registerAction(def) {
    if (!def || !def.id || typeof def.run !== "function") return;
    const k = actions.findIndex(a => a.id === def.id);
    if (k >= 0) actions.splice(k, 1, def); else actions.push(def);
    if (ov.el && !ov.el.hidden) { const i = currentItem(); if (i) fillOverlay(i); }
  }
  registerAction({
    id: "send-chef", label: "Envoyer au chef…",
    title: "Prépare un message au chef avec le contenu complet de l’item, pour qu’il en lance l’exécution (confirmation d’abord)",
    run: (i) => askSendToChef(i),
  });
  registerAction({
    id: "discuss-chef", label: "💬 Discuter avec le chef…",
    title: "Prépare un message au chef pour DISCUTER de l’item (questions, avis), sans rien lancer : le chef répond dans le fil (confirmation d’abord)",
    run: (i) => askSendToChef(i, "discuss"),
  });
  registerAction({
    id: "reject", label: "Rejeter l’item…",
    title: "Marque l’item « rejeté par l’utilisateur » dans le TODO_LIST.md du musicien ; il passe dans les faits, barré (confirmation d’abord)",
    when: (i) => i.status !== "done",
    run: (i) => askReject(i),
  });
  globalThis.TodoPanel = { reload: load, openItem, closeItem, registerAction, chefMessage, discussMessage, DISCUSS_PREFIX, isItemOpen: () => !!(ov.el && !ov.el.hidden), isDragging: () => drag.on };
})();
