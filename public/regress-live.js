// public/regress-live.js — non-régressions visibles pendant qu'elles tournent (0.119.0)
//
// Demande : « Je ne vois pas que le test de non regression est en cours sur
// orchestrateur-dev. C'est un probleme. » Toute exécution de
// scripts/regression.mjs (musicien, script du chef, prod-jump, console) est
// lue par le serveur (/api/regressions) et montrée ici :
//   - pastille sur le cadre du projet (Salle.cardHtml → RegressLive.chipHtml) ;
//   - bande #regress-band : étage, progression, KO, lanceur, lien vers le rapport ;
//   - entrée du journal d'activité (Activite → RegressLive.journalHtml) ;
//   - résultat final, gardé 10 min dans la bande et sur le cadre.
// Lecture seule. Sans import ni export (comme turn-core.js) : pose globalThis.RegressLive.
(function (global) {
  "use strict";
  const POLL_MS = 5000, POLL_HIDDEN_MS = 20000, RECENT_MS = 10 * 60_000;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const MODE = { full: "complète", targeted: "ciblée", perimeter: "par périmètre", partial: "partielle" };
  const STATUS = { running: "en cours", ok: "verte", ko: "rouge", stale: "périmée (contenu modifié)", error: "arrêtée sur une erreur", interrupted: "interrompue" };
  const MARK = { running: "🧪", ok: "✓", ko: "✕", stale: "⚠", error: "✕", interrupted: "■" };

  function koCount(r) { return (r.suites?.ko || 0) + (r.checks?.ko || 0) || (r.counts?.KO || 0); }
  function pct(r) {
    const s = r.suites || {}, c = r.checks || {};
    const total = (s.total || 0) + (c.expected || 0);
    if (!total) return null;
    return Math.max(0, Math.min(100, Math.round(100 * ((s.done || 0) + (c.done || 0)) / total)));
  }
  function when(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function title(r) {
    return `Non-régression ${MODE[r.mode] || r.mode || ""} ${STATUS[r.status] || r.status}`.replace(/\s+/g, " ").trim();
  }
  function summary(r) {
    if (r.status === "running") return `${r.stage ? `étage ${r.stage} · ` : ""}${r.progress || ""}`;
    const c = r.counts;
    return c ? `${c.OK} OK · ${c.KO} KO · ${c.NA} NA${r.durationS != null ? ` · ${Math.round(r.durationS / 60)} min` : ""}` : (r.why || r.progress || "");
  }
  function reportLink(r, cls) {
    if (!r.report) return "";
    if (r.status === "running") return `<span class="${cls} is-pending" title="${esc(r.reportFile || "")}">rapport à la fin</span>`;
    return `<a class="${cls}" href="${esc(r.report)}" target="_blank" rel="noopener" title="${esc(r.reportFile || "")}">rapport</a>`;
  }

  /** Pastille du cadre d'un projet (rien sans lancement récent). */
  function chipHtml(r) {
    if (!r) return "";
    const ko = koCount(r);
    const text = r.status === "running"
      ? `🧪 NR ${r.suites?.total != null ? `${r.suites.done}/${r.suites.total}` : "…"}${ko ? ` · ${ko} KO` : ""}`
      : `${MARK[r.status] || "·"} NR ${STATUS[r.status] || r.status}`;
    return `<span class="rc-chip rc-chip-regress" data-regress="${esc(r.status)}" title="${esc(`${title(r)} — ${summary(r)}`)}">${esc(text)}</span>`;
  }

  /** Entrée du journal d'activité. */
  function journalHtml(r) {
    const ko = (r.ko || []).length ? `<div class="jt-dim">KO : ${esc(r.ko.join(", "))}</div>` : "";
    const p = r.status === "running" ? pct(r) : null;
    return `<article class="jt jt-regress" data-outcome="regression" data-regress="${esc(r.status)}" data-regress-id="${esc(r.id)}">
        <header class="jt-head">
          <span class="jt-mark">${esc(MARK[r.status] || "·")}</span>
          <span class="jt-when">${esc(when(r.startedAt))}${r.endedAt ? ` → ${esc(when(r.endedAt))}` : ""}</span>
          <span class="jt-outcome">${esc(title(r))}</span>
          <span class="jt-meta">${esc(r.launcher?.by || "")}${r.lane ? ` · couloir #${esc(r.lane)}` : ""}</span>
        </header>
        <div class="jt-did">${esc(summary(r))}${p != null ? ` · ${p} %` : ""} ${reportLink(r, "jt-chip is-link")}</div>
        ${ko}
      </article>`;
  }

  // ------------------------------------------------------------------------
  // Bande
  // ------------------------------------------------------------------------
  const st = { data: null, timer: null, sig: "", journalSig: new Map() };
  function bandRows(data) {
    const rows = [];
    for (const p of data?.projects || []) {
      for (const r of p.running) rows.push({ project: p.project, r });
      const last = p.recent[0];
      if (!p.running.length && last && Date.now() - Date.parse(last.endedAt || 0) < RECENT_MS) rows.push({ project: p.project, r: last });
    }
    return rows;
  }
  function bandHtml(rows) {
    return rows.map(({ project, r }) => {
      const p = r.status === "running" ? pct(r) : null;
      return `<div class="rg-row" data-regress="${esc(r.status)}" data-project="${esc(project)}">
          <span class="rg-mark">${esc(MARK[r.status] || "·")}</span>
          <b class="rg-project">${esc(project)}</b>
          <span class="rg-title">${esc(title(r))}</span>
          <span class="rg-progress">${esc(summary(r))}</span>
          ${p != null ? `<span class="rg-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="avancement"><span style="width:${p}%"></span></span>` : ""}
          <span class="rg-by">${esc(r.launcher?.by || "")} · depuis ${esc(when(r.startedAt))}</span>
          ${reportLink(r, "rg-report")}
          ${(r.ko || []).length ? `<span class="rg-ko" title="${esc(r.ko.join("\n"))}">KO : ${esc(r.ko.slice(0, 3).join(", "))}${r.ko.length > 3 ? "…" : ""}</span>` : ""}
        </div>`;
    }).join("");
  }
  function paint() {
    const band = document.getElementById("regress-band");
    if (!band) return;
    const rows = bandRows(st.data);
    const html = bandHtml(rows);
    if (band._html !== html) { band.innerHTML = html; band._html = html; }
    band.hidden = !rows.length;
  }
  async function poll() {
    clearTimeout(st.timer);
    try {
      const r = await fetch("/api/regressions", { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (r.ok) {
        st.data = await r.json();
        paint();
        const sig = JSON.stringify(bandRows(st.data).map(x => [x.project, x.r.id, x.r.status, x.r.suites?.done, x.r.checks?.done]));
        if (sig !== st.sig) {
          st.sig = sig;
          // Cadres et journal du projet ouvert suivent sans attendre leur propre poll.
          global.Salle?.renderRail?.();
          const open = global.Activite?.name;
          if (open && global.Salle?.diveName === open) global.Activite.load(open);
        }
      }
    } catch { /* serveur indisponible : la bande garde le dernier état */ }
    st.timer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }
  function start() {
    if (!document.getElementById("regress-band")) return;
    poll();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }

  global.RegressLive = { chipHtml, journalHtml, bandRows, bandHtml, summary, title, poll, get data() { return st.data; } };
})(globalThis);
