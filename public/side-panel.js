/* ==========================================================================
   public/side-panel.js — full-height toggle drawer, shared by several tabs
   (0.75.0)
   --------------------------------------------------------------------------
   User request (2026-10-13): a full-height panel that opens and closes, used
   by the TODO list now and by the per-musician git graphs next. Generic: a tab
   registers itself with SidePanel.register({id, label, icon, key, mount,
   onOpen, onClose}); any element [data-sp-open="<id>"] opens it; the edge tab
   reopens the last tab. Open state and tab are remembered (localStorage).
   Off without redeploying: config.json "ui": {"sidePanel": false}, or
   ?todo=0 for one browser (?todo=1 restores).
   No import/export: sets globalThis.SidePanel (like turn-core.js).
   ========================================================================== */
(function () {
  "use strict";
  const LS = { open: "ui.sidePanel.open", tab: "ui.sidePanel.tab", off: "ui.sidePanel.disabled" };
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const tabs = new Map();
  const st = { open: false, tab: null, serverOn: true, el: null };

  // ?todo=0 / ?todo=1 — per-browser switch, like ?projets= and ?models=.
  (function readQuery() {
    const m = /[?&]todo=([^&#]*)/.exec(location.search);
    if (!m) return;
    const v = decodeURIComponent(m[1]).toLowerCase();
    if (v === "0" || v === "off" || v === "non") ls.set(LS.off, "1");
    if (v === "1" || v === "on" || v === "oui") ls.set(LS.off, null);
  })();

  const enabled = () => st.serverOn && ls.get(LS.off) !== "1";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function build() {
    if (st.el) return st.el;
    const aside = document.createElement("aside");
    aside.id = "side-panel";
    aside.className = "sp";
    aside.setAttribute("aria-label", "Panneau latéral");
    aside.setAttribute("aria-hidden", "true");
    aside.innerHTML = `<div class="sp-head"><div class="sp-tabs" role="tablist"></div>
      <button type="button" class="sp-close" aria-label="Fermer le panneau" title="Fermer (Échap)">✕</button></div>
      <div class="sp-body"></div>`;
    document.body.appendChild(aside);
    const edge = document.createElement("button");
    edge.id = "sp-edge";
    edge.type = "button";
    edge.className = "sp-edge";
    edge.setAttribute("aria-label", "Ouvrir le panneau latéral");
    document.body.appendChild(edge);
    aside.querySelector(".sp-close").addEventListener("click", () => close());
    edge.addEventListener("click", () => open(st.tab || first()));
    aside.querySelector(".sp-tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sp-tab]");
      if (b) show(b.dataset.spTab);
    });
    st.el = aside;
    for (const t of tabs.values()) addTab(t);
    return aside;
  }

  function addTab(t) {
    const aside = st.el;
    if (!aside || aside.querySelector(`[data-sp-tab="${t.id}"]`)) return;
    aside.querySelector(".sp-tabs").insertAdjacentHTML("beforeend",
      `<button type="button" role="tab" class="sp-tab" data-sp-tab="${esc(t.id)}" aria-selected="false">${esc(t.icon || "")} ${esc(t.label)}<span class="sp-badge" data-sp-badge="${esc(t.id)}"></span></button>`);
    const pane = document.createElement("section");
    pane.className = "sp-pane";
    pane.dataset.spPane = t.id;
    pane.setAttribute("role", "tabpanel");
    pane.hidden = true;
    aside.querySelector(".sp-body").appendChild(pane);
    try { t.mount?.(pane); } catch (e) { pane.textContent = `Erreur : ${e.message}`; }
  }

  const first = () => tabs.keys().next().value || null;

  /** Top of the drawer = bottom of the top bar (its height depends on the text size). */
  function place() {
    const bar = document.querySelector("header.topbar, .topbar");
    const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    document.documentElement.style.setProperty("--sp-top", `${top}px`);
  }

  function show(id) {
    if (!st.el || !tabs.has(id)) return;
    const prev = st.tab;
    st.tab = id;
    ls.set(LS.tab, id);
    for (const b of st.el.querySelectorAll("[data-sp-tab]")) b.setAttribute("aria-selected", b.dataset.spTab === id ? "true" : "false");
    for (const p of st.el.querySelectorAll("[data-sp-pane]")) p.hidden = p.dataset.spPane !== id;
    if (prev && prev !== id) tabs.get(prev)?.onClose?.();
    if (st.open) tabs.get(id)?.onOpen?.();
    sync();
  }

  function open(id) {
    if (!enabled()) return;
    build();
    place();
    const target = id && tabs.has(id) ? id : (st.tab || first());
    if (!target) return;
    const was = st.open;
    st.open = true;
    ls.set(LS.open, "1");
    st.el.classList.add("is-open");
    st.el.setAttribute("aria-hidden", "false");
    document.body.classList.add("sp-open");
    if (!was || target !== st.tab) { st.tab = null; show(target); } else tabs.get(target)?.onOpen?.();
    sync();
  }

  function close() {
    if (!st.el || !st.open) return;
    st.open = false;
    ls.set(LS.open, null);
    st.el.classList.remove("is-open");
    st.el.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sp-open");
    if (st.tab) tabs.get(st.tab)?.onClose?.();
    sync();
  }

  function toggle(id) {
    if (st.open && (!id || id === st.tab)) close(); else open(id);
  }

  /** Pills [data-sp-open], edge tab and badges follow the state. */
  function sync() {
    const on = enabled() && tabs.size > 0;
    for (const b of document.querySelectorAll("[data-sp-open]")) {
      b.hidden = !on;
      b.setAttribute("aria-pressed", st.open && st.tab === b.dataset.spOpen ? "true" : "false");
    }
    const edge = document.getElementById("sp-edge");
    if (edge) {
      const t = tabs.get(st.tab || first());
      edge.hidden = !on || st.open;
      if (t) {
        const n = t.badge ?? "";
        edge.innerHTML = `${esc(t.icon || "")} ${esc(t.label)}${n !== "" ? ` · <b class="sp-edge-n">${esc(n)}</b>` : ""}`;
      }
    }
    if (!on && st.open) close();
  }

  function register(def) {
    if (!def || !def.id || tabs.has(def.id)) return;
    tabs.set(def.id, { ...def, badge: "" });
    if (!st.tab && ls.get(LS.tab) === def.id) st.tab = def.id;
    build();
    addTab(tabs.get(def.id));
    sync();
    // Reopen as left (after a reload), once the tab exists.
    if (ls.get(LS.open) === "1" && enabled() && (ls.get(LS.tab) || first()) === def.id) open(def.id);
  }

  /** Count shown on the tab, its pill and the edge tab ("" hides it). */
  function setBadge(id, n) {
    const t = tabs.get(id);
    if (!t) return;
    t.badge = n == null ? "" : String(n);
    for (const el of document.querySelectorAll(`[data-sp-badge="${CSS.escape(id)}"]`)) el.textContent = t.badge;
    sync();
  }

  function applyUi(ui) {
    const on = !(ui && ui.sidePanel === false);
    if (on === st.serverOn) return;
    st.serverOn = on;
    sync();
  }

  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.open) { close(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey || typing(document.activeElement) || !enabled()) return;
    for (const t of tabs.values()) {
      if (t.key && e.key === t.key) { e.preventDefault(); toggle(t.id); return; }
    }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sp-open]");
    if (b) { e.preventDefault(); toggle(b.dataset.spOpen); }
  });
  window.addEventListener("resize", () => { if (st.open) place(); });

  /**
   * Plain-language reason for a failed read of a tab's API. The front is
   * served from disk, so a server started on an older version serves the new
   * tabs while their routes are still missing (404): say so, with both
   * versions, instead of an empty panel and a bare "HTTP 404".
   */
  async function explainFailure(status, what) {
    if (status !== 404) return `${what} indisponible : HTTP ${status}`;
    let v = null;
    try { const r = await fetch("/api/version"); if (r.ok) v = await r.json(); } catch { /* */ }
    if (v && v.restartRequired) {
      return `${what} indisponible : le serveur tourne encore en v${v.version}, alors que le code installé est en v${v.repoVersion}. Ce panneau fonctionnera après le redémarrage de l’orchestrateur (restart-orchestrateur.mjs, lancé par le chef).`;
    }
    return `${what} indisponible : le serveur${v ? ` (v${v.version})` : ""} ne connaît pas cette route (HTTP 404). L’orchestrateur doit sans doute être redémarré.`;
  }

  globalThis.SidePanel = { register, open, close, toggle, setBadge, applyUi, enabled, explainFailure,
    isOpen: () => st.open, current: () => st.tab };
})();
