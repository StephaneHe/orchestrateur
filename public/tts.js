// ============================================================================
// public/tts.js — v0.35.0 : lecture audio des réponses du chef
// ============================================================================
//
// 100 % local et gratuit : la Web Speech API du navigateur (speechSynthesis).
// Aucun service cloud, aucune clé. Les voix sont celles du système ou du
// navigateur (Edge/Chrome desktop, Chrome Android).
//
// Deux parties :
//   1. PURE (testée sous Node par scripts/_test_tts_text.mjs) : du Markdown au
//      texte à dire (`toSpeech`), découpe en morceaux courts (`chunks`),
//      langue probable d'un morceau (`guessLang`). Comme turn-core.js : ni
//      import ni export, le fichier pose `globalThis.Tts`.
//   2. NAVIGATEUR : lecteur (écouter / pause / reprise / stop), lecture
//      automatique des nouvelles réponses (désactivée par défaut), réglages
//      (voix, vitesse, langue auto) mémorisés dans localStorage, raccourci
//      Ctrl+Alt+L, barre de lecture.
//
// Pourquoi lire morceau par morceau (un énoncé à la fois, le suivant sur
// `onend`) : les moteurs coupent les longs énoncés (Chrome s'arrête vers 15 s,
// Android tronque), et une pause portable n'existe pas — pause = arrêt en
// mémorisant le morceau courant, reprise = on repart de ce morceau.
//
// Désactivable sans redéploiement : config.json → "ui": {"tts": false} (à
// chaud) ou ?tts=0 pour un navigateur (=1 rétablit).
// ============================================================================
(function (g) {
  "use strict";

  // --------------------------------------------------------------------------
  // 1. Texte à dire
  // --------------------------------------------------------------------------
  const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi;
  const HEX_ONE = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}$/i;

  function domainOf(url) {
    const m = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url);
    return m ? m[1] : "";
  }

  function tableToSpeech(rows) {
    const cells = (r) => r.replace(/^\s*\||\|\s*$/g, "").split("|").map(c => c.trim());
    const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r));
    if (!body.length) return "";
    const head = cells(body[0]).filter(Boolean);
    const data = body.slice(1).map(cells);
    let out = `Tableau de ${data.length} ligne${data.length > 1 ? "s" : ""}`;
    if (head.length) out += `, colonnes : ${head.join(", ")}`;
    out += ".";
    // Au-delà de 8 lignes, on annonce seulement : la liste lue serait illisible.
    if (data.length && data.length <= 8) {
      for (const r of data) out += " " + r.filter(Boolean).join(", ") + ".";
    }
    return out;
  }

  /** Markdown d'une réponse → texte propre à lire à voix haute. */
  function toSpeech(md) {
    let s = String(md || "").replace(/\r\n?/g, "\n");
    // Blocs de code : jamais lus.
    s = s.replace(/```[\s\S]*?(```|$)/g, "\n(bloc de code)\n");
    // Tableaux : annoncés (et lus s'ils sont courts).
    s = s.replace(/(^\s*\|.*\|\s*$\n?)+/gm, (block) => "\n" + tableToSpeech(block.trim().split("\n")) + "\n");
    // Sentinelles du protocole.
    s = s.replace(/^\s*NEEDS_USER_INPUT\s*:\s*/gm, "Question : ");
    s = s.replace(/^\s*NEEDS_CHEF_INPUT\s*:\s*/gm, "Question pour le chef : ");
    s = s.replace(/\[(?:CHEF_ANSWER|ANSWER|CALLBACK_WAKE[^\]]*|NEEDS_CHEF_INPUT_FROM:[^\]]*)\]\s*/g, "");
    // Liens : le texte du lien ; URL nue : « lien vers domaine ».
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => alt ? `image : ${alt}` : "image");
    s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
    s = s.replace(/<?(https?:\/\/[^\s<>)\]]+)>?/g, (m, url) => {
      const d = domainOf(url);
      return d ? `lien vers ${d}` : "lien";
    });
    // Code en ligne : un mot court se lit, le reste devient « code ».
    s = s.replace(/`([^`\n]+)`/g, (m, c) => (/^[\p{L}\p{N}._-]{1,24}$/u.test(c) && !HEX_ONE.test(c) ? c : "code"));
    // Chemins (Windows ou POSIX) : le dernier segment seulement.
    s = s.replace(/(?:\b[A-Za-z]:|(?<![\w.]))(?:[\\/]:?[\w.\-]+){2,}[\\/]?/g, (p) => {
      const seg = (p.split(/[\\/]/).filter(Boolean).pop() || "").replace(/^:/, "");
      return seg ? `chemin ${seg}` : "chemin";
    });
    // Empreintes, SHA, longs identifiants.
    s = s.replace(HEX_ID, "identifiant");
    s = s.replace(/\S{36,}/g, "identifiant");
    // Titres, citations, puces, règles horizontales.
    s = s.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (m, t) => `${t.replace(/[.:!?]\s*$/, "")}.`);
    s = s.replace(/^\s*>\s?/gm, "");
    s = s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/gm, (m, t) => /[.!?;:…]$/.test(t.trim()) ? t : `${t}.`);
    s = s.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");
    // Emphase et symboles décoratifs.
    s = s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,;:!?])/g, "$1$2");
    s = s.replace(/\s*(?:→|⇒|->)\s*/g, " vers ").replace(/\s*(?:←|<-)\s*/g, " depuis ");
    s = s.replace(/[✓✔✕✗✘⇄▸▾▴■●○◐⏳⚠ⓘ↩⚙★☆]/g, " ");
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
    s = s.replace(/[*_~`#|]/g, " ");
    // Une ligne sans ponctuation finale reste une phrase.
    s = s.split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => /[.!?;:…]$/.test(l) ? l : `${l}.`).join(" ");
    return s.replace(/\s+([.,;:!?])/g, "$1").replace(/\.{2,}/g, ".").replace(/\s{2,}/g, " ").trim();
  }

  /** Coupe en morceaux d'au plus `max` caractères, aux fins de phrase d'abord,
   *  puis aux virgules, puis aux espaces. */
  function chunks(text, max = 220) {
    const out = [];
    const sentences = String(text || "").split(/(?<=[.!?…])\s+/);
    let cur = "";
    const push = (t) => { t = t.trim(); if (t) out.push(t); };
    for (let sen of sentences) {
      sen = sen.trim();
      if (!sen) continue;
      while (sen.length > max) {
        let cut = sen.lastIndexOf(", ", max);
        if (cut < max * 0.4) cut = sen.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        if (cur) { push(cur); cur = ""; }
        push(sen.slice(0, cut + 1));
        sen = sen.slice(cut + 1).trim();
      }
      if ((cur + " " + sen).trim().length > max) { push(cur); cur = sen; }
      else cur = (cur ? cur + " " : "") + sen;
    }
    push(cur);
    return out;
  }

  const EN_WORDS = /\b(the|and|is|are|was|with|this|that|for|of|to|in|on|it|be|not|you|we|have|has|will|can|should|which|from)\b/gi;
  const FR_WORDS = /\b(le|la|les|des|du|un|une|et|est|sont|pour|dans|sur|avec|pas|que|qui|ce|cette|nous|vous|il|elle|à|au|aux|en)\b/gi;
  /** Langue probable d'un morceau : "en" seulement si l'anglais domine nettement. */
  function guessLang(text) {
    const en = (String(text).match(EN_WORDS) || []).length;
    const fr = (String(text).match(FR_WORDS) || []).length;
    return en >= 3 && en > fr * 2 ? "en" : "fr";
  }

  const pure = { toSpeech, chunks, guessLang, tableToSpeech };
  if (typeof document === "undefined") { g.Tts = pure; return; }

  // --------------------------------------------------------------------------
  // 2. Navigateur
  // --------------------------------------------------------------------------
  const LS = { voice: "tts.voice", rate: "tts.rate", auto: "tts.auto", autoLang: "tts.autoLang", off: "tts.off" };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v)); } catch { /* privé */ } };

  {
    const m = /[?&]tts=([^&#]*)/.exec(location.search);
    if (m) {
      const v = decodeURIComponent(m[1]).toLowerCase();
      if (v === "0" || v === "off" || v === "non") lsSet(LS.off, "1");
      if (v === "1" || v === "on" || v === "oui") lsSet(LS.off, null);
    }
  }

  const synth = () => (typeof g.speechSynthesis !== "undefined" ? g.speechSynthesis : null);
  const st = {
    serverOn: true,
    playing: null,        // { key, parts:[{text,lang}], i, paused }
    voices: [],
  };

  function supported() { return !!synth() && typeof g.SpeechSynthesisUtterance === "function"; }
  function enabled() { return st.serverOn && lsGet(LS.off) !== "1" && supported(); }
  function rate() { const r = Number(lsGet(LS.rate)); return r >= 0.5 && r <= 2 ? r : 1; }
  function autoRead() { return lsGet(LS.auto) === "1"; }
  function autoLang() { return lsGet(LS.autoLang) !== "0"; }

  function loadVoices() {
    const s = synth();
    st.voices = s ? (s.getVoices() || []) : [];
    renderSettings();
  }
  /** Voix choisie, sinon la meilleure voix française (les voix « Natural » /
   *  « Online » / Google sont nettement plus naturelles que les voix SAPI). */
  function pickVoice(lang = "fr") {
    const vs = st.voices;
    if (lang === "fr") {
      const want = lsGet(LS.voice);
      const chosen = want && vs.find(v => v.name === want);
      if (chosen) return chosen;
    }
    const pool = vs.filter(v => String(v.lang || "").toLowerCase().startsWith(lang));
    const rank = (v) => (/natural|online|neural/i.test(v.name) ? 0 : /google/i.test(v.name) ? 1 : 2) +
      (lang === "fr" && !/fr[-_]fr/i.test(v.lang) ? 0.5 : 0);
    return pool.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  function sayPart() {
    const p = st.playing;
    const s = synth();
    if (!p || !s) return;
    if (p.i >= p.parts.length) { stop(); return; }
    const part = p.parts[p.i];
    const u = new g.SpeechSynthesisUtterance(part.text);
    const v = pickVoice(part.lang);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = part.lang === "en" ? "en-US" : "fr-FR";
    u.rate = rate();
    const token = p.token;
    u.onend = () => {
      if (st.playing !== p || p.paused || p.token !== token) return;
      p.i++;
      sayPart();
    };
    u.onerror = (e) => {
      if (st.playing !== p || p.token !== token) return;
      // « interrupted » / « canceled » : c'est nous (pause, stop, nouvelle lecture).
      if (e && /interrupt|cancel/i.test(e.error || "")) return;
      p.i++;
      sayPart();
    };
    s.speak(u);
    sync();
  }

  /** Lit `text` (Markdown) ; `key` identifie la source (bulle du chef). */
  function speak(text, key = "") {
    const s = synth();
    if (!enabled() || !s) return false;
    s.cancel();
    const clean = toSpeech(text);
    const parts = chunks(clean).map(t => ({ text: t, lang: autoLang() ? guessLang(t) : "fr" }));
    if (!parts.length) return false;
    st.playing = { key: String(key), parts, i: 0, paused: false, token: 0 };
    sayPart();
    return true;
  }
  function pause() {
    const p = st.playing, s = synth();
    if (!p || p.paused || !s) return;
    p.paused = true;
    p.token++;
    s.cancel();
    sync();
  }
  function resume() {
    const p = st.playing;
    if (!p || !p.paused) return;
    p.paused = false;
    p.token++;
    sayPart();
  }
  function stop() {
    const s = synth();
    st.playing = null;
    if (s) s.cancel();
    sync();
  }
  function toggle(text, key) {
    if (st.playing && st.playing.key === String(key)) { stop(); return; }
    speak(text, key);
  }

  // ---------- Bulles du chef ----------
  /** Bouton d'une bulle du chef (sans état : `sync()` le met à jour). */
  function buttonHtml(idx) {
    if (!enabled()) return "";
    return `<button class="cv-tts-btn" type="button" data-tts-idx="${idx}" aria-label="Écouter ce message du chef" title="Écouter (Ctrl+Alt+L : dernière réponse)">🔊 écouter</button>`;
  }
  function chefText(idx) {
    const b = g.App?.chat?.[idx];
    return b && b.role === "conductor" ? b.text || "" : "";
  }
  function lastChefIdx() {
    const chat = g.App?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].role === "conductor" && chat[i].text) return i;
    return -1;
  }
  /** Nouvelle réponse du chef arrivée en direct (pas l'historique). */
  function onChefReply(idx) {
    if (enabled() && autoRead() && idx >= 0) speak(chefText(idx), `chef:${idx}`);
  }

  // ---------- Barre de lecture + état des boutons ----------
  function sync() {
    const p = st.playing;
    document.querySelectorAll("[data-tts-idx]").forEach(b => {
      const on = !!p && p.key === `chef:${b.dataset.ttsIdx}`;
      b.classList.toggle("is-playing", on);
      b.textContent = on ? "⏹ arrêter" : "🔊 écouter";
      b.setAttribute("aria-label", on ? "Arrêter la lecture de ce message" : "Écouter ce message du chef");
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.hidden = !enabled();
    });
    const bar = document.getElementById("tts-bar");
    if (!bar) return;
    if (!p || !enabled()) { bar.hidden = true; return; }
    bar.hidden = false;
    const pb = bar.querySelector('[data-tts-act="pause"]');
    pb.textContent = p.paused ? "▶" : "⏸";
    pb.setAttribute("aria-label", p.paused ? "Reprendre la lecture" : "Mettre la lecture en pause");
    bar.querySelector(".tts-prog").textContent = `${p.paused ? "En pause" : "Lecture"} · ${Math.min(p.i + 1, p.parts.length)}/${p.parts.length}`;
  }

  // ---------- Réglages (panneau ⚙) ----------
  function renderSettings() {
    const box = document.getElementById("tts-settings");
    if (!box) return;
    box.hidden = !st.serverOn || lsGet(LS.off) === "1";
    if (!supported()) {
      box.querySelector(".tts-unsupported").hidden = false;
      return;
    }
    const sel = box.querySelector("#tts-voice");
    const want = lsGet(LS.voice) || "";
    const fr = st.voices.filter(v => /^fr/i.test(v.lang));
    const others = st.voices.filter(v => !/^fr/i.test(v.lang));
    const opt = (v) => `<option value="${v.name.replace(/"/g, "&quot;")}"${v.name === want ? " selected" : ""}>${v.name.replace(/</g, "&lt;")} (${v.lang})</option>`;
    const html = `<option value=""${want ? "" : " selected"}>Automatique (meilleure voix française)</option>` +
      (fr.length ? `<optgroup label="Français">${fr.map(opt).join("")}</optgroup>` : "") +
      (others.length ? `<optgroup label="Autres langues">${others.map(opt).join("")}</optgroup>` : "");
    if (sel._html !== html) { sel.innerHTML = html; sel._html = html; }
    const r = box.querySelector("#tts-rate");
    r.value = String(rate());
    box.querySelector(".tts-rate-val").textContent = `×${rate().toFixed(1)}`;
    box.querySelector("#tts-auto").checked = autoRead();
    box.querySelector("#tts-autolang").checked = autoLang();
  }

  function wire() {
    const box = document.getElementById("tts-settings");
    if (box && !box._wired) {
      box._wired = true;
      box.addEventListener("change", (e) => {
        const t = e.target;
        if (t.id === "tts-voice") lsSet(LS.voice, t.value || null);
        if (t.id === "tts-auto") lsSet(LS.auto, t.checked ? "1" : null);
        if (t.id === "tts-autolang") lsSet(LS.autoLang, t.checked ? null : "0");
        renderSettings();
      });
      box.addEventListener("input", (e) => {
        if (e.target.id === "tts-rate") { lsSet(LS.rate, Number(e.target.value) === 1 ? null : e.target.value); renderSettings(); }
      });
      box.addEventListener("click", (e) => {
        if (e.target.closest("[data-tts-test]")) speak("Bonjour. Voici la voix qui lira les réponses du chef.", "test");
      });
    }
    const bar = document.getElementById("tts-bar");
    if (bar && !bar._wired) {
      bar._wired = true;
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tts-act]");
        if (!b) return;
        if (b.dataset.ttsAct === "pause") (st.playing?.paused ? resume() : pause());
        if (b.dataset.ttsAct === "stop") stop();
      });
    }
    // Clic sur « écouter » dans le fil (délégation : le fil est re-rendu).
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tts-idx]");
      if (!b) return;
      e.stopPropagation();
      const idx = Number(b.dataset.ttsIdx);
      toggle(chefText(idx), `chef:${idx}`);
    }, true);
    const s = synth();
    if (s) {
      loadVoices();
      if (typeof s.addEventListener === "function") s.addEventListener("voiceschanged", loadVoices);
      else s.onvoiceschanged = loadVoices;
    }
    renderSettings();
    sync();
  }

  // Ctrl+Alt+L : écouter la dernière réponse du chef, ou arrêter. Comme pour la
  // taille du texte : jamais dans un champ, jamais avec AltGr.
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
    if (e.getModifierState && e.getModifierState("AltGraph")) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.code !== "KeyL" && String(e.key).toLowerCase() !== "l") return;
    if (!enabled()) return;
    e.preventDefault();
    if (st.playing) { stop(); return; }
    const i = lastChefIdx();
    if (i >= 0) speak(chefText(i), `chef:${i}`);
  });

  /** Drapeaux `ui` de /api/config et /api/pupitre (absent = activé). */
  function applyUi(ui) {
    const on = !(ui && ui.tts === false);
    if (on === st.serverOn) return;
    st.serverOn = on;
    if (!on) stop();
    renderSettings();
    g.App?.renderChat?.();
    sync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
  // Quitter la page coupe la voix (certains navigateurs continuent sinon).
  g.addEventListener("pagehide", () => { const s = synth(); if (s) s.cancel(); });

  // Pas d'Object.assign pour `playing` : il lirait le getter une seule fois.
  g.Tts = Object.assign({}, pure, {
    speak, pause, resume, stop, toggle, buttonHtml, onChefReply, sync, applyUi,
    enabled, supported, pickVoice,
  });
  Object.defineProperty(g.Tts, "playing", { get: () => st.playing, enumerable: true });
})(typeof globalThis !== "undefined" ? globalThis : window);
