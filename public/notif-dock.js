// public/notif-dock.js — zone compacte des notifications et demandes (0.123.0)
//
// Demande utilisateur (2026-10-20) : les notifications de demande « prennent toute
// la page, et ne donnent pas la possibilite de voir quoique ce soit d'autre ».
//   - #notif-dock regroupe les bandeaux de demandes (autorisations #perm-band,
//     réponses automatiques #auto-band) sous une ligne « 🔔 N demandes en attente » ;
//   - hauteur bornée (CSS), défilement interne : le reste du dashboard reste visible
//     et cliquable, aucun overlay, aucun focus piégé ;
//   - repli / dépli par la ligne de tête, « Tout réduire » ; l'état replié est
//     mémorisé (localStorage notif.collapsed).
// Chaque bandeau publie son nombre d'éléments visibles dans data-nd-count.
// Sans import ni export : pose globalThis.NotifDock.
(function (global) {
  "use strict";
  const KEY = "notif.collapsed";
  const st = { dock: null, observer: null };

  const readCollapsed = () => { try { return global.localStorage?.getItem(KEY) === "1"; } catch { return false; } };
  const writeCollapsed = (v) => { try { global.localStorage?.setItem(KEY, v ? "1" : "0"); } catch { /* */ } };

  function count() {
    if (!st.dock) return 0;
    let n = 0;
    for (const b of st.dock.querySelectorAll(".nd-body > [data-nd-count]")) if (!b.hidden) n += Number(b.dataset.ndCount) || 0;
    return n;
  }

  function sync() {
    const d = st.dock;
    if (!d) return;
    const n = count();
    const collapsed = readCollapsed();
    // Only real changes are written: the observer watches .nd-body, and even an
    // identical `hidden` write queues a mutation record (endless loop, frozen page).
    const set = (el, prop, v) => { if (el && el[prop] !== v) el[prop] = v; };
    // Visible while any band shows something (masked permissions keep a « Réafficher » line).
    set(d, "hidden", ![...d.querySelectorAll(".nd-body > [data-nd-count]")].some(b => !b.hidden));
    if (d.dataset.collapsed !== (collapsed ? "1" : "0")) d.dataset.collapsed = collapsed ? "1" : "0";
    set(d.querySelector(".nd-body"), "hidden", collapsed);
    const t = d.querySelector(".nd-toggle");
    if (t) {
      if (t.getAttribute("aria-expanded") !== (collapsed ? "false" : "true")) t.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const label = `${n} demande${n > 1 ? "s" : ""} en attente`;
      const c = t.querySelector(".nd-count");
      if (c && c.textContent !== label) c.textContent = label;
      t.title = collapsed ? "Déplier les demandes" : "Replier les demandes";
    }
    const all = d.querySelector(".nd-collapse-all");
    if (all) all.disabled = collapsed;
  }

  function setCollapsed(v) { writeCollapsed(v); sync(); }
  function collapseAll() {
    writeCollapsed(true);
    document.dispatchEvent(new CustomEvent("notif-dock:collapse-all"));
    sync();
  }

  function init() {
    st.dock = document.getElementById("notif-dock");
    if (!st.dock) return;
    st.dock.addEventListener("click", (e) => {
      if (e.target.closest(".nd-toggle")) { setCollapsed(!readCollapsed()); return; }
      if (e.target.closest(".nd-collapse-all")) collapseAll();
    });
    st.observer = new MutationObserver(() => sync());
    st.observer.observe(st.dock.querySelector(".nd-body"), { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "data-nd-count"] });
    global.addEventListener?.("storage", (e) => { if (e.key === KEY) sync(); });
    sync();
  }

  global.NotifDock = { sync, setCollapsed, collapseAll, count, isCollapsed: readCollapsed };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  }
})(typeof window !== "undefined" ? window : globalThis);
