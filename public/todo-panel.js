/* ==========================================================================
   public/todo-panel.js — "☑ TODO" tab of the side panel (0.75.0)
   --------------------------------------------------------------------------
   User request (2026-10-13): each musician's TODO list, as checkboxes, OPEN
   items on top then DONE ones below (0.76.2, replaces "done first"), each part
   newest first by entry date; read-only
   for the user (the musician of the item ticks it, with scripts/todo.mjs);
   the musician's name next to each done item.
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
    return `<li class="todo-item${done ? " is-done" : ""}" data-id="${esc(i.id)}" data-status="${esc(i.status)}" data-project="${esc(i.project)}" data-added="${esc(i.addedAt || "")}">
      <input type="checkbox" class="ti-box" disabled ${done ? "checked" : ""} aria-label="${done ? "Fait" : "Non fait"} (lecture seule : seul le musicien coche)" title="Lecture seule : c’est le musicien qui coche">
      <div class="ti-main"><div class="ti-title">${esc(i.title)}</div>
        ${i.detail ? `<div class="ti-detail" title="${esc(i.detail)}">${esc(i.detail)}</div>` : ""}
        <div class="ti-meta">${by}<span class="ti-proj">${esc(i.project)}</span>${added}${type}${prog}</div></div></li>`;
  }

  function render() {
    const pane = st.pane;
    if (!pane) return;
    const d = st.data;
    if (!d) { pane.querySelector(".todo-body").innerHTML = `<p class="todo-empty${st.error ? " todo-unavailable" : ""}">${esc(st.error || "Chargement…")}</p>`; return; }
    const project = lsGet(LS_PROJECT);
    const sel = pane.querySelector(".todo-project");
    const names = d.lists.map(l => l.project);
    sel.innerHTML = `<option value="">Tous les projets (${d.lists.length})</option>` +
      names.map(n => `<option value="${esc(n)}"${n === project ? " selected" : ""}>${esc(n)}</option>`).join("");
    const items = d.items.filter(i => !project || i.project === project);
    const done = items.filter(i => i.status === "done"), open = items.filter(i => i.status !== "done");
    pane.querySelector(".todo-body").innerHTML = !items.length
      ? `<p class="todo-empty">Aucun item${project ? ` pour ${esc(project)}` : ""}.</p>`
      : `<section class="todo-sec" data-sec="open"><h3 class="todo-sec-h">Non faits <span class="todo-n">${open.length}</span></h3><ul class="todo-list">${open.map(itemHtml).join("")}</ul></section>
         <section class="todo-sec" data-sec="done"><h3 class="todo-sec-h">Faits <span class="todo-n">${done.length}</span></h3><ul class="todo-list">${done.map(itemHtml).join("")}</ul></section>`;
  }

  SidePanel.register({
    id: "todo", label: "TODO", icon: "☑", key: "t",
    mount(pane) {
      st.pane = pane;
      pane.innerHTML = `<div class="todo-filters"><label class="todo-f">Projet <select class="todo-project"></select></label>
        <span class="todo-ro" title="Seuls les musiciens cochent leurs items (scripts/todo.mjs)">lecture seule</span></div>
        <div class="todo-body"><p class="todo-empty">Chargement…</p></div>`;
      pane.querySelector(".todo-project").addEventListener("change", (e) => { lsSet(LS_PROJECT, e.target.value); render(); });
    },
    onOpen() { load(); clearInterval(st.timer); st.timer = setInterval(load, 15_000); },
    onClose() { clearInterval(st.timer); st.timer = null; },
  });

  // Count of open items on the pill, even with the panel closed.
  load();
  setInterval(() => { if (!SidePanel.isOpen() && SidePanel.enabled()) load(); }, 60_000);
  globalThis.TodoPanel = { reload: load };
})();
