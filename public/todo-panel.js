/* ==========================================================================
   public/todo-panel.js — "☑ TODO" tab of the side panel (0.75.0)
   --------------------------------------------------------------------------
   User request (2026-10-13): each musician's TODO list, as checkboxes, OPEN
   items on top then DONE ones below (0.76.2, replaces "done first"), each part
   newest first by entry date; read-only
   for the user (the musician of the item ticks it, with scripts/todo.mjs);
   the musician's name next to each done item. Each item opens an overlay
   with the whole item (0.77.0).
   Reads GET /api/todo (no write route exists). Refreshed every 15 s while the
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
    const by = !done ? "" : i.doneBy
      ? `<span class="ti-by" title="Coché par ${esc(i.doneBy)}${i.doneAt ? ` le ${esc(fmt(i.doneAt))}` : ""}">✓ ${esc(i.doneBy)}</span>`
      : `<span class="ti-by is-unknown" title="Nom non enregistré : item coché à la main, hors de todo.mjs">✓ —</span>`;
    return `<li class="todo-item${done ? " is-done" : ""}" data-id="${esc(i.id)}" data-status="${esc(i.status)}" data-project="${esc(i.project)}" data-added="${esc(i.addedAt || "")}" tabindex="0" role="button" aria-haspopup="dialog" title="Voir l’item complet">
      <input type="checkbox" class="ti-box" disabled ${done ? "checked" : ""} aria-label="${done ? "Fait" : "Non fait"} (lecture seule : seul le musicien coche)" title="Lecture seule : c’est le musicien qui coche">
      <div class="ti-main"><div class="ti-title">${esc(i.title)}</div>
        ${i.detail ? `<div class="ti-detail">${esc(i.detail)}</div>` : ""}
        <div class="ti-meta">${by}<span class="ti-proj">${esc(i.project)}</span>${added}${type}${prog}</div></div></li>`;
  }

  /* ---- Item overlay (0.77.0): the whole item, on click / Enter / Space ----
     User request (2026-10-13): « chaque item doit être clickable et afficher
     une overlay qui présente l'item complet ». Later parts (notes, reject,
     send to the chef) plug in through TodoPanel.registerAction(); none is
     registered yet, so the action bar stays hidden. */
  const actions = [];
  const ov = { el: null, id: null, returnFocus: null };
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
        <div class="tov-body"></div>
        <footer class="tov-actions" hidden></footer>
      </section>`;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-tov-close]")) closeItem(); });
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
    const doneLine = !done ? "" : i.doneBy
      ? `<div class="tov-row"><span class="tov-k">Fait</span><span class="tov-done-at">${esc(fmt(i.doneAt))}</span> par <b class="tov-by">${esc(i.doneBy)}</b></div>`
      : `<div class="tov-row"><span class="tov-k">Fait</span><span class="tov-by is-unknown">coché à la main (nom non enregistré)</span></div>`;
    el.querySelector(".tov-body").innerHTML = `
      <div class="tov-row tov-tags"><span class="tov-status tov-status-${esc(i.status)}">${STATUS[i.status] || esc(i.status)}</span>
        <span class="tov-proj">${esc(i.project)}</span>${TYPE[i.type] ? `<span class="ti-type ti-type-${esc(i.type)}">${TYPE[i.type]}</span>` : ""}</div>
      <div class="tov-row"><span class="tov-k">Entrée</span><span class="tov-added">${i.addedEstimated ? "≈ " : ""}${esc(fmt(i.addedAt))}</span>${i.addedEstimated ? `<span class="tov-hint">(date estimée : date du fichier)</span>` : ""}</div>
      ${doneLine}
      ${full ? `<div class="tov-text tov-detail">${esc(full)}</div>` : ""}
      ${i.more ? `<div class="tov-text tov-more">${esc(i.more)}</div>` : ""}
      ${!full && !i.more ? `<p class="tov-hint">Aucun détail : l’item tient en son titre.</p>` : ""}
      <div class="tov-src">${esc(i.project)}/TODO_LIST.md, ligne ${esc(i.line)} · <code>${esc(i.id)}</code></div>`;
    const bar = el.querySelector(".tov-actions");
    const usable = actions.filter(a => !a.when || a.when(i));
    bar.innerHTML = usable.map(a => `<button type="button" class="tov-action" data-tov-action="${esc(a.id)}"${a.title ? ` title="${esc(a.title)}"` : ""}>${esc(a.label)}</button>`).join("");
    bar.hidden = !usable.length;
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
    document.body.classList.remove("tov-open");
    const back = ov.returnFocus;
    ov.returnFocus = null;
    if (back && back.isConnected) back.focus();
    else if (st.pane) st.pane.querySelector(".todo-project")?.focus();
  }

  // Capture phase: Escape closes the overlay only, not the side panel behind it.
  document.addEventListener("keydown", (e) => {
    if (!ov.el || ov.el.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeItem(); return; }
    if (e.key === "Tab") {
      const f = [...ov.el.querySelectorAll("button:not([hidden]), [href], [tabindex]:not([tabindex='-1'])")].filter(x => x.offsetParent !== null);
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
    const done = items.filter(i => i.status === "done"), open = items.filter(i => i.status !== "done");
    pane.querySelector(".todo-body").innerHTML = !items.length
      ? `<p class="todo-empty">Aucun item${project ? ` pour ${esc(project)}` : ""}.</p>`
      : `<section class="todo-sec" data-sec="open"><h3 class="todo-sec-h">Non faits <span class="todo-n">${open.length}</span></h3><ul class="todo-list">${open.map(itemHtml).join("")}</ul></section>
         <section class="todo-sec" data-sec="done"><h3 class="todo-sec-h">Faits <span class="todo-n">${done.length}</span></h3><ul class="todo-list">${done.map(itemHtml).join("")}</ul></section>`;
    // Keep an open overlay in step with the 15 s refresh (an item that left
    // the list stays shown as it was).
    if (ov.el && !ov.el.hidden) { const i = findItem(ov.id); if (i) fillOverlay(i); }
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
        const li = e.target.closest(".todo-item");
        if (li) openItem(li.dataset.id);
      });
      body.addEventListener("keydown", (e) => {
        const li = e.target.closest(".todo-item");
        if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(li.dataset.id); }
      });
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
  globalThis.TodoPanel = { reload: load, openItem, closeItem, registerAction, isItemOpen: () => !!(ov.el && !ov.el.hidden) };
})();
