/* ==========================================================================
   public/release-panel.js — "📰 Release" tab of the side panel (0.97.0)
   --------------------------------------------------------------------------
   User request (2026-10-14): « Je dois voir comme TODO ou GIT, une liste qui
   augmente au fur et a mesure et qui conduira a la release note en fonction
   de ce qui est pret ». For the chosen musician: what is in progress
   ([Unreleased] of its CHANGELOG, TODO items being worked on) and what is
   ready (every CHANGELOG version newer than its last release, found by the
   server), then the release note built from the ready part only, in the
   CHANGELOG's own words. READ-ONLY: GET /api/release[/:project].
   ========================================================================== */
(function () {
  "use strict";
  if (!globalThis.SidePanel) return;
  const LS_PROJECT = "release.project";
  const st = { pane: null, projects: null, data: null, timer: null, error: null, loading: false, copied: 0 };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } };
  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  // Keeps the bold/code marks readable without rendering Markdown in the list.
  const plain = (s) => String(s || "").split("\n")[0].replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

  function current() {
    const ok = (st.projects || []).filter(p => p.changelog).map(p => p.name);
    const want = lsGet(LS_PROJECT);
    return ok.includes(want) ? want : (ok[0] || "");
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      if (!st.projects) {
        const r = await fetch("/api/release");
        if (!r.ok) throw httpError(r.status);
        st.projects = (await r.json()).projects || [];
      }
      const p = current();
      if (!p) st.data = { changelog: false, items: [], note: "" };
      else {
        const r = await fetch(`/api/release/${encodeURIComponent(p)}`);
        if (!r.ok) throw httpError(r.status);
        st.data = await r.json();
      }
      st.error = null;
    } catch (e) {
      st.error = e.status ? await SidePanel.explainFailure(e.status, "Release") : `Release indisponible : ${e.message}`;
    } finally {
      st.loading = false;
    }
    render();
  }

  function itemHtml(i) {
    const badge = i.state === "ready"
      ? `<span class="rl-state rl-ready" title="Prêt : dans une version plus récente que la dernière release">✓ prêt</span>`
      : `<span class="rl-state rl-progress" title="En cours : ${i.origin === "todo" ? "item de la TODO en cours" : "section [Unreleased] du CHANGELOG"}">⏳ en cours</span>`;
    const where = i.state === "ready" ? esc(i.section || "—") : i.origin === "todo" ? `TODO${i.id ? ` ${esc(i.id)}` : ""}` : `Unreleased${i.section ? ` · ${esc(i.section)}` : ""}`;
    return `<li class="rl-item" data-state="${esc(i.state)}"${i.version ? ` data-version="${esc(i.version)}"` : ""} title="${esc(i.text)}">${badge}<span class="rl-where">${where}</span><span class="rl-text">${esc(plain(i.text))}</span></li>`;
  }

  /* ---- Grouped by release, detail window (0.98.0) -------------------------
     User request (2026-10-14): « Dans RELEASE, les items doivent etre
     regroupes par release, et chaque release est clickable et ouvrir une
     fenetre qui montre les details de chaque items ». The server sends
     `groups` (scripts/release-notes.mjs, groupByRelease); an older server
     only sends `items`, grouped here the same way. */
  function groupsOf(d) {
    if (Array.isArray(d.groups)) return d.groups;
    const out = [], by = new Map();
    (d.items || []).forEach((it, index) => {
      const key = it.state === "ready" ? `v:${it.version}` : "progress";
      if (!by.has(key)) { const g = { key, state: it.state, version: it.version || null, date: it.date || null, items: [] }; by.set(key, g); out.push(g); }
      by.get(key).items.push({ ...it, index });
    });
    return out.sort((a, b) => (a.key === "progress" ? -1 : b.key === "progress" ? 1 : 0));
  }
  const groupTitle = (g) => g.state === "progress" ? "⏳ En cours — pas encore dans une version" : `✓ ${g.version}${g.date ? ` · ${g.date}` : ""}`;

  function groupHtml(g) {
    const n = g.items.length;
    return `<section class="rl-group" data-state="${esc(g.state)}" data-key="${esc(g.key)}">
      <button type="button" class="rl-group-head" data-rl-group="${esc(g.key)}" aria-haspopup="dialog"
        title="Voir le détail de chaque élément de ${g.state === "progress" ? "l’en-cours" : `la release ${esc(g.version)}`}">
        <span class="rl-group-title">${esc(groupTitle(g))}</span>
        <span class="rl-group-count">${n} élément${n > 1 ? "s" : ""}</span><span class="rl-group-open" aria-hidden="true">Détails ›</span></button>
      <ol class="rl-list">${g.items.map(itemHtml).join("")}</ol></section>`;
  }

  const md = (t) => typeof globalThis.mdToHtml === "function" ? globalThis.mdToHtml(t) : esc(t).replace(/\n/g, "<br>");
  function detailItemHtml(i) {
    const where = i.state === "ready" ? (i.section || "Autre")
      : i.origin === "todo" ? `TODO du musicien${i.id ? ` · ${i.id}` : ""}${i.since ? ` · depuis le ${String(i.since).slice(0, 10)}` : ""}`
      : `CHANGELOG [Unreleased]${i.section ? ` · ${i.section}` : ""}`;
    return `<li class="rlo-item" data-state="${esc(i.state)}"><div class="rlo-where">${esc(where)}</div><div class="rlo-text md">${md(i.text || "")}</div></li>`;
  }

  const ov = { el: null, key: null, opener: null };
  function overlayEl() {
    if (ov.el) return ov.el;
    const el = document.createElement("div");
    el.id = "release-overlay";
    el.hidden = true;
    el.innerHTML = `<div class="rlo-backdrop" data-rlo-close></div>
      <section class="rlo-box" role="dialog" aria-modal="true" aria-labelledby="rlo-title">
        <header class="rlo-head"><h3 id="rlo-title" class="rlo-title"></h3>
          <button type="button" class="rlo-close" data-rlo-close aria-label="Fermer">✕</button></header>
        <p class="rlo-meta"></p><ol class="rlo-items"></ol></section>`;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-rlo-close]")) closeDetail(true); });
    document.body.appendChild(el);
    // Capture: Escape closes the window, not the side panel behind it.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.el && !ov.el.hidden) { e.preventDefault(); e.stopPropagation(); closeDetail(true); } }, true);
    return (ov.el = el);
  }
  function fillDetail() {
    const g = st.data && groupsOf(st.data).find(x => x.key === ov.key);
    if (!g) { closeDetail(); return; }
    const el = overlayEl();
    el.querySelector(".rlo-title").textContent = g.state === "progress" ? `${st.data.project} — en cours` : `${st.data.project} — release ${g.version}`;
    const secs = [...new Set(g.items.map(i => i.section).filter(Boolean))];
    el.querySelector(".rlo-meta").textContent = `${g.state === "progress" ? "⏳ en cours, pas encore publié" : `✓ prêt${g.date ? ` · ${g.date}` : ""}`} · ${g.items.length} élément${g.items.length > 1 ? "s" : ""}${secs.length ? ` · ${secs.join(", ")}` : ""}`;
    el.querySelector(".rlo-items").innerHTML = g.items.map(detailItemHtml).join("");
  }
  function openDetail(key, opener) {
    ov.key = key; ov.opener = opener || null;
    overlayEl().hidden = false;
    fillDetail();
    ov.el.querySelector(".rlo-close").focus();
  }
  function closeDetail(refocus) {
    if (!ov.el || ov.el.hidden) return;
    ov.el.hidden = true;
    const k = ov.key; ov.key = null;
    if (refocus) (st.pane?.querySelector(`[data-rl-group="${CSS.escape(k || "")}"]`) || ov.opener)?.focus?.();
  }

  function render() {
    const pane = st.pane;
    if (!pane) return;
    const sel = pane.querySelector(".rl-project");
    const cur = current();
    if (st.projects) sel.innerHTML = st.projects.map(p => `<option value="${esc(p.name)}"${p.name === cur ? " selected" : ""}${p.changelog ? "" : " disabled"}>${esc(p.name)}${p.changelog ? "" : " (pas de CHANGELOG)"}</option>`).join("");
    else if (st.error) sel.innerHTML = `<option value="" disabled selected>— liste des musiciens indisponible —</option>`;
    const body = pane.querySelector(".rl-body");
    const d = st.data;
    if (st.error && !d) { body.innerHTML = `<p class="rl-empty rl-unavailable">${esc(st.error)}</p>`; return; }
    if (!d) { body.innerHTML = `<p class="rl-empty">Chargement…</p>`; return; }
    if (!d.changelog) { body.innerHTML = `<p class="rl-empty">${cur ? `${esc(cur)} n’a pas de CHANGELOG.md.` : "Aucun CHANGELOG.md dans la flotte."}</p>`; return; }
    if (d.error) { body.innerHTML = `<p class="rl-empty">Lecture impossible : ${esc(d.error)}</p>`; return; }
    const rel = d.release || {};
    const items = d.items || [];
    const groups = groupsOf(d);
    const list = groups.length
      ? `<div class="rl-groups">${groups.map(groupHtml).join("")}</div>`
      : `<p class="rl-empty">Rien en cours ni de prêt depuis la dernière release.</p>`;
    if (!items.length) closeDetail();
    const note = d.note
      ? `<div class="rl-note-bar"><b>Release note</b> <span class="rl-note-hint">(seulement ce qui est prêt, texte du CHANGELOG)</span>
           <button type="button" class="rl-btn rl-copy">${st.copied && Date.now() - st.copied < 2500 ? "✓ Copié" : "Copier"}</button>
           <button type="button" class="rl-btn rl-download">Télécharger .md</button></div>
         <pre class="rl-note">${esc(d.note)}</pre>`
      : `<p class="rl-empty rl-no-note">Pas encore de release note : rien n’est prêt depuis la dernière release.</p>`;
    body.innerHTML = `<div class="rl-summary">Dernière release : <b>${esc(rel.version || "—")}</b> <span class="rl-why">(${esc(rel.label || "")})</span>
        · <span class="rl-count-ready">${d.counts?.ready || 0} prêt${(d.counts?.ready || 0) > 1 ? "s" : ""}</span>
        · <span class="rl-count-progress">${d.counts?.progress || 0} en cours</span></div>${list}<div class="rl-note-box">${note}</div>`;
    // The 30 s refresh keeps an open window in step with the CHANGELOG.
    if (ov.key && ov.el && !ov.el.hidden) fillDetail();
  }

  async function copyNote() {
    const text = st.data?.note || "";
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* */ }
      ta.remove();
    }
    st.copied = Date.now();
    render();
  }

  function downloadNote() {
    const d = st.data;
    if (!d?.note) return;
    const last = (d.readyVersions || [])[0]?.version || "release";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([d.note], { type: "text/markdown;charset=utf-8" }));
    a.download = `${d.project}-release-${String(last).replace(/[^\w.-]+/g, "_")}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  SidePanel.register({
    id: "release", label: "Release", icon: "📰",
    mount(pane) {
      st.pane = pane;
      pane.innerHTML = `<div class="rl-filters"><label class="rl-f">Musicien <select class="rl-project"></select></label>
        <span class="rl-ro" title="Rien n’est modifié d’ici : la liste vient du CHANGELOG et de la TODO du musicien">lecture seule</span></div>
        <div class="rl-body"><p class="rl-empty">Chargement…</p></div>`;
      pane.querySelector(".rl-project").addEventListener("change", (e) => { lsSet(LS_PROJECT, e.target.value); st.data = null; render(); load(); });
      pane.addEventListener("click", (e) => {
        const head = e.target.closest("[data-rl-group]");
        if (head) openDetail(head.dataset.rlGroup, head);
        else if (e.target.closest(".rl-copy")) copyNote();
        else if (e.target.closest(".rl-download")) downloadNote();
      });
    },
    // The list grows as the musicians deliver: re-read every 30 s while open.
    onOpen() { st.projects = null; load(); clearInterval(st.timer); st.timer = setInterval(load, 30_000); },
    onClose() { clearInterval(st.timer); st.timer = null; closeDetail(); },
  });
  globalThis.ReleasePanel = { reload: load, state: () => st.data, openDetail, closeDetail, isDetailOpen: () => !!(ov.el && !ov.el.hidden) };
})();
