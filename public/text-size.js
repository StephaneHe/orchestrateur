// ============================================================================
// public/text-size.js — v0.34.0 : taille du texte du dashboard (A− / A / A+)
// ============================================================================
//
// Toutes les polices du dashboard sont en rem ; la racine vaut 16px ×
// --text-scale. Ce script pose l'échelle mémorisée AVANT le premier rendu
// (chargé dans <head>, sans defer) puis câble les boutons de la barre du haut.
//
// Raccourcis : Ctrl+Alt+= (ou +) agrandit, Ctrl+Alt+- réduit, Ctrl+Alt+0
// rétablit. Ctrl+/- reste au zoom du navigateur. Sous Windows, AltGr EST
// Ctrl+Alt : sur AZERTY, AltGr+0 tape « @ » (mentions du composer). Les
// raccourcis sont donc ignorés dans un champ de saisie et quand AltGr est
// réellement enfoncé.
// ============================================================================
(function (global) {
  "use strict";

  const STEPS = [0.85, 0.9, 1, 1.1, 1.25, 1.5];
  const KEY = "ui.textScale";
  const root = document.documentElement;

  function stored() {
    try {
      const v = Number(localStorage.getItem(KEY));
      return STEPS.includes(v) ? v : 1;
    } catch { return 1; }
  }
  let scale = stored();

  function pct(s) { return Math.round(s * 100) + "\u00a0%"; }

  function render() {
    const box = document.getElementById("text-size");
    if (!box) return;
    const i = STEPS.indexOf(scale);
    const dec = box.querySelector('[data-ts="-1"]');
    const inc = box.querySelector('[data-ts="1"]');
    const mid = box.querySelector('[data-ts="0"]');
    dec.disabled = i <= 0;
    inc.disabled = i >= STEPS.length - 1;
    mid.textContent = pct(scale);
    mid.setAttribute("aria-label", `Taille du texte : ${pct(scale)} — rétablir 100 %`);
    mid.setAttribute("aria-pressed", scale === 1 ? "true" : "false");
  }

  function apply(next, persist = true) {
    scale = STEPS.includes(next) ? next : 1;
    if (scale === 1) root.style.removeProperty("--text-scale");
    else root.style.setProperty("--text-scale", String(scale));
    root.dataset.textScale = String(scale);
    if (persist) {
      try { scale === 1 ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(scale)); } catch { /* privé */ }
    }
    render();
    // Les rails et le volet mesurent des hauteurs : un resize leur suffit.
    global.dispatchEvent(new Event("resize"));
  }

  function step(dir) {
    if (dir === 0) return apply(1);
    const i = STEPS.indexOf(scale);
    const j = Math.max(0, Math.min(STEPS.length - 1, i + dir));
    if (j !== i) apply(STEPS[j]);
  }

  function editable(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function onKey(e) {
    if (!e.ctrlKey || !e.altKey || e.metaKey || (e.shiftKey && e.key !== "+")) return;
    if (e.getModifierState && e.getModifierState("AltGraph")) return;
    if (editable(e.target)) return;
    let dir = null;
    if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") dir = 1;
    else if (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") dir = -1;
    else if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") dir = 0;
    if (dir === null) return;
    e.preventDefault();
    step(dir);
  }

  // Avant le premier rendu : pas d'éclair à 100 % puis à la taille voulue.
  apply(scale, false);

  function wire() {
    const box = document.getElementById("text-size");
    if (box && !box._wired) {
      box._wired = true;
      box.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ts]");
        if (b && !b.disabled) step(Number(b.dataset.ts));
      });
    }
    render();
  }
  document.addEventListener("keydown", onKey);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  global.TextSize = { STEPS, apply, step, get scale() { return scale; } };
})(window);
