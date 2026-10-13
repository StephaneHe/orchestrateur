/* ==========================================================================
   public/git-panel.js — "⎇ Git" tab of the side panel (0.76.0)
   --------------------------------------------------------------------------
   User request (2026-10-13): in the same side panel as the TODO list, each
   musician's git tree — commits, branches, tags — READ-ONLY: nothing here can
   trigger a git operation (the server only runs `git log`, GET routes only).
   Reads GET /api/git-graph (projects) and GET /api/git-graph/:project?n=.
   The graph is drawn in SVG from the server's lane layout; rows are HTML.
   ========================================================================== */
(function () {
  "use strict";
  if (!globalThis.SidePanel) return;
  const LS_PROJECT = "git.project";
  const N_STEP = 80, N_MAX = 300;
  const COLORS = ["#e8a15c", "#5fd4ff", "#2dff7a", "#ff8c42", "#c792ea", "#ff2d8b", "#f5d76e", "#8fbcbb"];
  const st = { pane: null, projects: null, data: null, n: N_STEP, timer: null, error: null, loading: false };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } };
  const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const color = (lane) => COLORS[lane % COLORS.length];

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function current() {
    const repos = (st.projects || []).filter(p => p.repo).map(p => p.name);
    const want = lsGet(LS_PROJECT);
    return repos.includes(want) ? want : (repos[0] || "");
  }

  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  async function loadProjects() {
    const r = await fetch("/api/git-graph");
    if (!r.ok) throw httpError(r.status);
    st.projects = (await r.json()).projects || [];
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      if (!st.projects) await loadProjects();
      const p = current();
      if (!p) { st.data = { repo: false, commits: [] }; }
      else {
        const r = await fetch(`/api/git-graph/${encodeURIComponent(p)}?n=${st.n}`);
        if (!r.ok) throw httpError(r.status);
        st.data = await r.json();
      }
      st.error = null;
    } catch (e) {
      st.error = e.status ? await SidePanel.explainFailure(e.status, "Graphe git") : `Graphe git indisponible : ${e.message}`;
    } finally {
      st.loading = false;
    }
    render();
  }

  function refsHtml(refs) {
    const out = [];
    if (refs.head === "detached") out.push(`<span class="gg-ref gg-head" title="HEAD détaché">HEAD</span>`);
    for (const b of refs.branches) out.push(`<span class="gg-ref gg-branch${refs.head === b ? " gg-head" : ""}" title="${refs.head === b ? "Branche courante (HEAD)" : "Branche locale"}">${refs.head === b ? "HEAD → " : ""}${esc(b)}</span>`);
    for (const r of refs.remotes) out.push(`<span class="gg-ref gg-remote" title="Branche distante">${esc(r)}</span>`);
    for (const t of refs.tags) out.push(`<span class="gg-ref gg-tag" title="Tag">🏷 ${esc(t)}</span>`);
    return out.join("");
  }

  function graphSvg(layout, count, rowPx, laneW) {
    const x = (l) => laneW / 2 + l * laneW;
    const y = (r) => rowPx / 2 + r * rowPx;
    const w = Math.max(1, layout.lanes) * laneW;
    const h = Math.max(1, count) * rowPx + (layout.open.length ? rowPx / 2 : 0);
    const parts = [];
    for (const s of layout.segments) {
      const x1 = x(s.l1), y1 = y(s.r1), x2 = x(s.l2), y2 = y(s.r2);
      const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      parts.push(`<path d="${d}" stroke="${color(s.lane)}" class="gg-edge"/>`);
    }
    for (const o of layout.open) {
      const y1 = y(count - 1);
      parts.push(`<path d="M${x(o.from)} ${y1}L${x(o.lane)} ${y1 + rowPx * 0.5}" stroke="${color(o.lane)}" class="gg-edge gg-more"/>`);
    }
    layout.rows.forEach((row, r) => parts.push(`<circle cx="${x(row.lane)}" cy="${y(r)}" r="${Math.max(3, rowPx * 0.16)}" fill="${color(row.lane)}" class="gg-dot" data-row="${r}"/>`));
    return `<svg class="gg-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${parts.join("")}</svg>`;
  }

  function render() {
    const pane = st.pane;
    if (!pane) return;
    const sel = pane.querySelector(".gg-project");
    const cur = current();
    if (st.projects) {
      sel.innerHTML = st.projects.map(p => `<option value="${esc(p.name)}"${p.name === cur ? " selected" : ""}${p.repo ? "" : " disabled"}>${esc(p.name)}${p.repo ? "" : " (pas de dépôt git)"}</option>`).join("");
    } else if (st.error) {
      sel.innerHTML = `<option value="" disabled selected>— liste des musiciens indisponible —</option>`;
    }
    const body = pane.querySelector(".gg-body");
    const d = st.data;
    const more = pane.querySelector(".gg-more-btn");
    if (st.error && !d) { body.innerHTML = `<p class="gg-empty gg-unavailable">${esc(st.error)}</p>`; more.hidden = true; return; }
    if (!d) { body.innerHTML = `<p class="gg-empty">Chargement…</p>`; return; }
    if (d.repo === false) { body.innerHTML = `<p class="gg-empty">${cur ? `${esc(cur)} n’a pas de dépôt git.` : "Aucun dépôt git dans la flotte."}</p>`; more.hidden = true; return; }
    if (d.error) { body.innerHTML = `<p class="gg-empty">Lecture impossible : ${esc(d.error)}</p>`; more.hidden = true; return; }
    if (!d.commits.length) { body.innerHTML = `<p class="gg-empty">Aucun commit.</p>`; more.hidden = true; return; }
    const rowPx = Math.round(remPx() * 1.9), laneW = Math.round(remPx() * 0.95);
    const gw = Math.max(1, d.layout.lanes) * laneW;
    const rows = d.commits.map((c, r) => `<li class="gg-row${c.refs.head ? " is-head" : ""}" data-sha="${esc(c.sha)}" data-lane="${d.layout.rows[r].lane}" style="height:${rowPx}px;padding-left:${gw + 6}px" title="${esc(c.sha)}\n${esc(c.author)} — ${esc(fmtDate(c.date))}${c.parents.length > 1 ? `\nfusion de ${c.parents.length} parents` : ""}">
        <span class="gg-refs">${refsHtml(c.refs)}</span><span class="gg-subject">${esc(c.subject)}</span>
        <span class="gg-meta"><code class="gg-sha">${esc(c.short)}</code> ${esc(c.author)} · ${esc(fmtDate(c.date))}</span></li>`).join("");
    body.innerHTML = `<div class="gg-summary">${esc(d.project)} · HEAD ${d.head ? `<b>${esc(d.head)}</b>` : "—"} · ${d.commits.length} commit${d.commits.length > 1 ? "s" : ""}${d.truncated ? " (les plus récents)" : ""}</div>
      <div class="gg-graph">${graphSvg(d.layout, d.commits.length, rowPx, laneW)}<ol class="gg-rows">${rows}</ol></div>`;
    more.hidden = !d.truncated || st.n >= N_MAX;
  }

  SidePanel.register({
    id: "git", label: "Git", icon: "⎇",
    mount(pane) {
      st.pane = pane;
      pane.innerHTML = `<div class="gg-filters"><label class="gg-f">Musicien <select class="gg-project"></select></label>
        <span class="gg-ro" title="Aucune opération git ne peut être lancée d’ici">lecture seule</span></div>
        <div class="gg-body"><p class="gg-empty">Chargement…</p></div>
        <button type="button" class="gg-more-btn" hidden title="Affiche des commits plus anciens (lecture seule)">Plus de commits</button>`;
      pane.querySelector(".gg-project").addEventListener("change", (e) => { lsSet(LS_PROJECT, e.target.value); st.n = N_STEP; st.data = null; render(); load(); });
      pane.querySelector(".gg-more-btn").addEventListener("click", () => { st.n = Math.min(N_MAX, st.n + N_STEP); load(); });
    },
    onOpen() { st.projects = null; load(); clearInterval(st.timer); st.timer = setInterval(load, 30_000); },
    onClose() { clearInterval(st.timer); st.timer = null; },
  });
  globalThis.GitPanel = { reload: load };
})();
