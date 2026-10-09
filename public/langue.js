// ============================================================================
// public/langue.js — language of discussion (0.51.0)
// ============================================================================
//
// User request: « La langue de la discussion doit pouvoir etre fixee et tu dois
// t'y tenir. » Two screens:
//   · ⚙ panel: global language + per-project override (#lang-settings);
//   · Models page, « 🌐 Langues des models »: the editable models × reliable
//     languages table, with « Tester la langue ».
// The server writes language-settings.json; dispatch.mjs reads it on every turn.
// User-facing strings stay in French (the dashboard's UI language).
// ============================================================================
(function (global) {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const st = { view: null, models: null, open: false, busy: {} };

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch { /* corps vide */ }
    if (!r.ok && !(j && "detected" in j)) { const e = new Error(j?.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  const put = (url, body) => api(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // --- ⚙ panel ---------------------------------------------------------------
  function note(msg) { const n = document.querySelector("#lang-settings .lang-note"); if (n) n.textContent = msg || ""; }

  function renderSettings() {
    const box = document.getElementById("lang-settings");
    if (!box) return;
    const v = st.view;
    const sel = box.querySelector("#lang-default");
    if (!v) { if (sel) sel.disabled = true; return; }
    const opts = Object.entries(v.langs).map(([k, l]) => `<option value="${k}"${k === v.default ? " selected" : ""}>${esc(l.label)}</option>`).join("");
    sel.innerHTML = opts;
    sel.disabled = false;
    const rows = Object.entries(v.projects).map(([p, l]) =>
      `<li data-lang-project="${esc(p)}"><span>${esc(p)}</span> → ${esc(v.langs[l]?.label || l)} <button type="button" class="lang-del" data-lang-del="${esc(p)}" aria-label="Retirer l’exception de ${esc(p)}">✕</button></li>`).join("");
    const projOpts = v.projectNames.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    box.querySelector(".lang-projects").innerHTML =
      `<div class="lang-sub">Exception pour un projet</div>
       <ul class="lang-list">${rows || '<li class="lang-empty">aucune — tous les projets suivent la langue ci-dessus</li>'}</ul>
       <div class="lang-add">
         <select class="lang-add-project" aria-label="Projet">${projOpts}</select>
         <select class="lang-add-lang" aria-label="Langue du projet">${Object.entries(v.langs).map(([k, l]) => `<option value="${k}">${esc(l.label)}</option>`).join("")}</select>
         <button type="button" class="lang-add-btn">Appliquer</button>
       </div>`;
  }

  async function loadSettings() {
    try { st.view = await api("/api/language"); note(""); }
    catch (e) { st.view = null; note(e.status === 404 ? "Réglage disponible après le redémarrage du serveur (0.51.0)." : `Réglage illisible : ${e.message}`); }
    renderSettings();
  }

  // --- Models page: models × reliable languages -----------------------------
  function modelsHtml() {
    const m = st.models;
    if (!m) return '<p class="mr-empty">Chargement…</p>';
    const langs = Object.keys(m.langs);
    const SRC = { override: "réglé ici", rule: "règle par défaut", default: "inconnu : anglais seulement" };
    const rows = m.models.map(x => {
      const checks = langs.map(l => `<label class="ml-lang"><input type="checkbox" data-ml-model="${esc(x.model)}" data-ml-lang="${l}"${x.langs.includes(l) ? " checked" : ""}> ${l}</label>`).join("");
      const t = x.test ? ` · essai ${esc(x.test.lang)} : ${x.test.ok ? "✓" : `✕ (réponse en ${esc(x.test.detected || "?")})`}` : "";
      return `<tr data-ml-row="${esc(x.model)}">
        <td><code>${esc(x.model)}</code>${x.provider ? ` <span class="mr-dim">${esc(x.provider)}</span>` : ""}</td>
        <td class="ml-langs">${checks}</td>
        <td class="mr-dim">${esc(SRC[x.source] || x.source)}${x.note ? ` — ${esc(x.note)}` : ""}${t}</td>
        <td><button type="button" class="ml-test" data-ml-test="${esc(x.model)}" data-ml-provider="${esc(x.provider || "")}"${st.busy[x.model] ? " disabled" : ""}>${st.busy[x.model] ? "essai en cours…" : "Tester la langue"}</button></td>
      </tr>`;
    }).join("");
    return `<p class="mr-hint">Un model qui écrit mal la langue de discussion travaille en anglais ; sa réponse destinée à l’utilisateur est reformulée automatiquement (⚠ langue). Valeurs par défaut prudentes : Claude, GPT et les grands models multilingues = toutes les langues ; inconnu = anglais seulement, jusqu’à vérification.</p>
      <table class="ml-table"><thead><tr><th>Model</th><th>Langues fiables</th><th>Origine</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="mr-empty">aucun model affecté dans les cases</td></tr>'}</tbody></table>`;
  }
  function renderModels(rootEl) {
    const box = rootEl?.querySelector(".mr-langs");
    if (!box) return;
    box.hidden = !st.open;
    if (st.open) box.innerHTML = '<h2 class="mr-h2">Langues des models</h2>' + modelsHtml();
    const b = rootEl.querySelector(".mr-langs-btn") || document.querySelector(".mr-langs-btn");
    if (b) b.setAttribute("aria-expanded", st.open ? "true" : "false");
  }
  async function loadModels(rootEl) {
    try { st.models = await api("/api/model-languages"); }
    catch (e) { st.models = { langs: {}, models: [] }; }
    renderModels(rootEl);
  }
  function toggleModels(rootEl) {
    st.open = !st.open;
    renderModels(rootEl);
    if (st.open) loadModels(rootEl);
  }

  // --- Events -----------------------------------------------------------------
  document.addEventListener("change", async (e) => {
    if (e.target.id === "lang-default") {
      try { st.view = await put("/api/language", { default: e.target.value }); note(`✓ Langue de discussion : ${st.view.langs[st.view.default].label} — appliquée au prochain tour de chaque musicien.`); }
      catch (err) { note(`Échec : ${err.message}`); }
      renderSettings();
      return;
    }
    const cb = e.target.closest("[data-ml-model]");
    if (cb) {
      const model = cb.dataset.mlModel;
      const langs = [...document.querySelectorAll(`[data-ml-model="${CSS.escape(model)}"]`)].filter(x => x.checked).map(x => x.dataset.mlLang);
      try { st.models = await put(`/api/model-languages/${encodeURIComponent(model)}`, { langs }); }
      catch (err) { alert(`Langues de ${model} : ${err.message}`); }
      renderModels(document.getElementById("models"));
    }
  });
  document.addEventListener("click", async (e) => {
    if (e.target.closest(".lang-add-btn")) {
      const box = document.getElementById("lang-settings");
      const p = box.querySelector(".lang-add-project").value, l = box.querySelector(".lang-add-lang").value;
      try { st.view = await put(`/api/language/project/${encodeURIComponent(p)}`, { lang: l }); note(`✓ ${p} → ${st.view.langs[l].label}`); }
      catch (err) { note(`Échec : ${err.message}`); }
      renderSettings();
      return;
    }
    const del = e.target.closest("[data-lang-del]");
    if (del) {
      try { st.view = await put(`/api/language/project/${encodeURIComponent(del.dataset.langDel)}`, { lang: null }); note(`✓ ${del.dataset.langDel} suit la langue globale`); }
      catch (err) { note(`Échec : ${err.message}`); }
      renderSettings();
      return;
    }
    const test = e.target.closest("[data-ml-test]");
    if (test) {
      const model = test.dataset.mlTest;
      st.busy[model] = true; renderModels(document.getElementById("models"));
      try {
        const lang = st.view?.default || "fr";
        const r = await api("/api/model-languages/test", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: test.dataset.mlProvider, model, lang }) });
        if (r.models) st.models = r;
        if (r.why && !("detected" in r)) alert(`Essai de ${model} : ${r.why}`);
      } catch (err) { alert(`Essai de ${model} : ${err.message}`); }
      delete st.busy[model];
      renderModels(document.getElementById("models"));
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadSettings); else loadSettings();
  global.Langue = { loadSettings, toggleModels, loadModels, get view() { return st.view; } };
})(window);
