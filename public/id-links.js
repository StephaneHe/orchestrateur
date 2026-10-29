// Clickable identifiers in model output (0.107.0).
//
// User request (2026-10-16): « il faut que toutes references a un identifiant
// quelconque soit un lien qui ouvre un overlay qui decrit ou explique ce qu'est
// cet identifiant ». Every rendered model text goes through `mdToHtml`
// (app.js), whose sanitized output is passed to `linkify` here:
//   - explicit marks written by the models, `[[value]]` or `[[kind:value]]`
//     (instruction added by dispatch.mjs to every turn, idRefRule);
//   - and the known formats found in plain text: TODO item t-xxxxxx, pipeline
//     run p-…, queue entry q-…, version vX.Y.Z, file path, case of the page
//     Models (exact pipeline.step ids), commit / Routage task (hex), project name.
// Text inside <a> and <pre> is never touched. A click opens #idref-overlay,
// filled by GET /api/identify (scripts/id-resolve.mjs, the server's real data).
// The pure part (`linkify`, `strip`) has no DOM and is tested under Node
// (scripts/_test_id_links.mjs). No import/export; sets globalThis.IdLinks.
(function (global) {
  "use strict";

  const KINDS = ["todo", "run", "queue", "attente", "commit", "version", "projet", "fichier", "case"];
  const ALIASES = {
    todo: "todo", tache: "todo", "tâche": "todo", item: "todo", run: "run", execution: "run", "exécution": "run",
    queue: "queue", attente: "attente", pending: "attente", commit: "commit", sha: "commit", version: "version",
    projet: "projet", project: "projet", musicien: "projet", fichier: "fichier", file: "fichier", chemin: "fichier",
    path: "fichier", case: "case", slot: "case",
  };
  // Project names that are generic words are linked only when marked [[…]]. A
  // lowercase name (maybe an everyday word) is not linked right after a
  // determiner: « la garde » is prose, « garde a terminé » names the project.
  const COMMON_WORDS = new Set(["index", "test", "tests", "demo", "app", "server", "serveur", "docs", "notes",
    "data", "main", "home", "api", "web", "core", "chef", "projet", "lab"]);
  const DETERMINER = "(?<!(?:^|[^\\p{L}])(?:le|la|les|l'|l’|de|du|des|un|une|en|ma|ta|sa|ce|cette|mon|ton|son|the|a|an|this|my)\\s+)";
  const FILE_EXT = "mjs|cjs|js|jsx|ts|tsx|json|jsonl|ndjson|md|kt|kts|java|gradle|css|html|htm|ps1|psm1|py|sh|bat|cmd|txt|log|yml|yaml|toml|xml|csv|sql|apk|png|jpg|jpeg|gif|webp|mp4|webm|mov|svg|lock|env|go|rs|c|h|cpp";
  const NOT_FILES = /^(?:node|vue|next|nuxt|express|three|d3|chart|react|socket\.io|p5)\.js$/i;

  let vocab = { projects: [], slots: [], conductor: null };
  let rx = null;

  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function build() {
    const names = (vocab.projects || [])
      .filter((n) => n && n.length >= 3 && n !== vocab.conductor && !COMMON_WORDS.has(n.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const weak = names.filter((n) => /^\p{Ll}+$/u.test(n)).map(escRe);
    const strong = names.filter((n) => !/^\p{Ll}+$/u.test(n)).map(escRe);
    const slots = (vocab.slots || []).filter(Boolean).sort((a, b) => b.length - a.length).map(escRe);
    const B = "(?<![\\w./\\\\@#&-])";       // left boundary
    const E = "(?![\\w-]|\\.\\w)";            // right boundary
    const parts = [
      `\\[\\[(?<explicit>[^\\[\\]\\n<>]{1,200})\\]\\]`,
      `${B}(?<run>p-\\d{8}T\\d{6}-[0-9a-f]{6})${E}`,
      `${B}(?<queue>q-\\d{10,16}-[0-9a-f]{3,8})${E}`,
      `${B}(?<todo>t-[0-9a-f]{6})${E}`,
      `${B}(?<version>v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)${E}`,
      slots.length ? `${B}(?<slot>(?:${slots.join("|")}))${E}` : null,
      `${B}(?<file>(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/])?(?:[\\w@.-]+[\\\\/])*[\\w@-][\\w@.-]*\\.(?:${FILE_EXT})(?::\\d+(?::\\d+)?)?)(?![\\w/\\\\-])`,
      `${B}(?<hex>(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})${E}`,
      strong.length ? `${B}(?<project>${strong.join("|")})(?![\\w/\\\\-]|\\.\\w)` : null,
      weak.length ? `${B}${DETERMINER}(?<projectw>${weak.join("|")})(?![\\w/\\\\-]|\\.\\w)` : null,
    ].filter(Boolean);
    rx = new RegExp(parts.join("|"), "gu");
  }
  build();

  function setVocab(v) {
    vocab = { projects: Array.isArray(v?.projects) ? v.projects : [], slots: Array.isArray(v?.slots) ? v.slots : [], conductor: v?.conductor || null };
    build();
  }

  /** "[[kind:value]]" content → {kind, value}. */
  function splitExplicit(s) {
    const m = /^([a-zà-ÿ]{2,10})\s*:\s*(.+)$/i.exec(String(s).trim());
    if (m && ALIASES[m[1].toLowerCase()]) return { kind: ALIASES[m[1].toLowerCase()], value: m[2].trim() };
    return { kind: "", value: String(s).trim() };
  }

  const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));

  const IMAGE_RE = /\.(?:png|jpe?g|gif|webp)$/i;
  const VIDEO_RE = /\.(?:mp4|webm|mov)$/i;

  /** Inline preview for a cited image / video; "" for anything else. Served by GET /api/media. */
  function mediaPreview(value) {
    const v = String(value || "").trim();
    const isImg = IMAGE_RE.test(v), isVid = VIDEO_RE.test(v);
    if (!isImg && !isVid) return "";
    const src = `/api/media?path=${encodeURIComponent(v)}`;
    return isVid
      ? `<span class="media-prev media-video"><video controls preload="metadata" playsinline src="${escAttr(src)}"></video></span>`
      : `<span class="media-prev media-image"><img loading="lazy" alt="${escAttr(v.split(/[\\/]/).pop())}" src="${escAttr(src)}"></span>`;
  }

  function link(text, value, kind) {
    return `<a class="idref" href="#" role="button" data-idref="${escAttr(value)}"${kind ? ` data-idref-kind="${escAttr(kind)}"` : ""}` +
      ` title="Qu’est-ce que c’est ? (cliquer)">${text}</a>`;
  }

  /** Replaces identifiers in one text node (already HTML-escaped). */
  function linkText(t) {
    rx.lastIndex = 0;
    return t.replace(rx, (m, ...args) => {
      const g = args[args.length - 1];
      if (g.explicit !== undefined) {
        const { kind, value } = splitExplicit(unesc(g.explicit));
        if (!value) return m;
        return link(escAttr(value), value, kind) + (!kind || kind === "fichier" ? mediaPreview(value) : "");
      }
      if (g.file !== undefined) return NOT_FILES.test(m) ? m : link(m, unesc(m), "fichier") + mediaPreview(unesc(m));
      if (g.run !== undefined) return link(m, m, "run");
      if (g.queue !== undefined) return link(m, m, "queue");
      if (g.todo !== undefined) return link(m, m, "todo");
      if (g.version !== undefined) return link(m, m, "version");
      if (g.slot !== undefined) return link(m, m, "case");
      if (g.hex !== undefined) return link(m, m, "");
      if (g.project !== undefined || g.projectw !== undefined) return link(m, m, "projet");
      return m;
    });
  }

  /** Sanitized HTML → same HTML with identifiers turned into links. */
  function linkify(html) {
    const s = String(html || "");
    if (!s) return s;
    let skip = 0;             // depth inside <a> / <pre>
    const out = [];
    const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|<!--[\s\S]*?-->/g;
    let i = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > i) { const t = s.slice(i, m.index); out.push(skip ? t : linkText(t)); }
      const tag = (m[1] || "").toLowerCase();
      if (tag === "a" || tag === "pre") {
        if (m[0][1] === "/") skip = Math.max(0, skip - 1);
        else if (!/\/>$/.test(m[0])) skip++;
      }
      out.push(m[0]);
      i = re.lastIndex;
    }
    if (i < s.length) { const t = s.slice(i); out.push(skip ? t : linkText(t)); }
    return out.join("");
  }

  /** Plain text without the [[…]] marks (speech, summaries). */
  function strip(text) {
    return String(text || "").replace(/\[\[([^\[\]\n]{1,200})\]\]/g, (m, inner) => splitExplicit(inner).value || m);
  }

  const pure = { linkify, strip, setVocab, splitExplicit, KINDS };
  if (typeof document === "undefined") { global.IdLinks = pure; return; }

  // ── Overlay ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ov = { el: null, returnFocus: null, seq: 0, current: null };

  function overlayEl() {
    if (ov.el) return ov.el;
    const el = document.createElement("div");
    el.id = "idref-overlay";
    el.className = "idov";
    el.hidden = true;
    el.innerHTML = `<div class="idov-backdrop" data-idov-close></div>
      <section class="idov-dialog" role="dialog" aria-modal="true" aria-labelledby="idov-title">
        <header class="idov-head"><div class="idov-headtext"><span class="idov-kind"></span><h2 id="idov-title" class="idov-title"></h2></div>
          <button type="button" class="idov-close" data-idov-close aria-label="Fermer" title="Fermer (Échap)">✕</button></header>
        <div class="idov-body" aria-live="polite"></div>
      </section>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-idov-close]")) { close(); return; }
      const a = e.target.closest("[data-idov-link]");
      if (a) { e.preventDefault(); follow(JSON.parse(a.dataset.idovLink)); }
    });
    document.body.appendChild(el);
    ov.el = el;
    return el;
  }

  function contextProject(a) {
    const host = a.closest("[data-idref-project], [data-project], [data-musician]");
    if (host) return host.dataset.idrefProject || host.dataset.project || host.dataset.musician || "";
    // Outside the chef's thread, the open musician panel (route #/m/<name>) gives the context.
    const m = /^#\/m\/([^/?]+)/.exec(location.hash || "");
    return m && !a.closest("#cv-scroll") ? decodeURIComponent(m[1]) : "";
  }

  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: /T\d\d:\d\d/.test(String(s)) ? "short" : undefined });
  }

  function render(r) {
    const el = overlayEl();
    const dialog = el.querySelector(".idov-dialog");
    dialog.dataset.known = r.known ? "1" : "0";
    dialog.dataset.kind = r.kind || "";
    el.querySelector(".idov-kind").textContent = r.kindLabel || (r.known ? "Identifiant" : "Identifiant inconnu");
    el.querySelector(".idov-title").textContent = r.known ? (r.title || r.id) : r.id;
    const body = el.querySelector(".idov-body");
    if (!r.known) {
      body.innerHTML = `<p class="idov-unknown">⚠ Identifiant inconnu</p><p class="idov-msg">${esc(r.message || "L’orchestrateur ne trouve pas cet identifiant.")}</p>`;
      return;
    }
    const st = r.state ? `<span class="idov-state idov-tone-${esc(r.tone || "neutral")}">${esc(r.state)}</span>` : "";
    const proj = r.project ? `<span class="idov-proj">${esc(r.project)}</span>` : "";
    const date = r.date ? `<span class="idov-date">${esc(fmtDate(r.date))}</span>` : "";
    const rows = (r.fields || []).map((f) => `<div class="idov-row"><span class="idov-k">${esc(f.k)}</span><span class="idov-v">${esc(f.v)}</span></div>`).join("");
    const links = (r.links || []).map((l) => `<button type="button" class="idov-link" data-idov-link="${esc(JSON.stringify(l))}">${esc(l.label)}</button>`).join("");
    body.innerHTML = `<div class="idov-id"><code>${esc(r.id)}</code></div>
      ${st || proj || date ? `<div class="idov-tags">${st}${proj}${date}</div>` : ""}
      ${r.summary ? `<p class="idov-summary">${esc(r.summary).replace(/\n/g, "<br>")}</p>` : ""}
      ${rows ? `<div class="idov-rows">${rows}</div>` : ""}
      ${links ? `<div class="idov-links">${links}</div>` : ""}`;
  }

  async function open(id, kind, project) {
    const el = overlayEl();
    const seq = ++ov.seq;
    ov.current = { id, kind, project };
    if (el.hidden) ov.returnFocus = document.activeElement;
    el.querySelector(".idov-dialog").dataset.known = "";
    el.querySelector(".idov-kind").textContent = "Identifiant";
    el.querySelector(".idov-title").textContent = id;
    el.querySelector(".idov-body").innerHTML = `<p class="idov-loading">Recherche de ce que désigne « ${esc(id)} »…</p>`;
    el.hidden = false;
    document.body.classList.add("idov-open");
    el.querySelector(".idov-close").focus();
    const q = new URLSearchParams({ id });
    if (kind) q.set("kind", kind);
    if (project) q.set("project", project);
    let r;
    try {
      const resp = await fetch(`/api/identify?${q}`);
      if (resp.status === 404) throw new Error("route absente : le serveur n’a pas encore été redémarré sur une version qui explique les identifiants (0.107.0 ou plus)");
      r = await resp.json();
      if (!resp.ok || !r.ok) throw new Error(r.error || `HTTP ${resp.status}`);
    } catch (e) {
      r = { known: false, id, message: `Impossible de demander au serveur ce que désigne « ${id} » : ${e.message}.` };
    }
    if (seq !== ov.seq || el.hidden) return;
    render(r);
  }

  function close() {
    if (!ov.el || ov.el.hidden) return;
    ov.seq++;
    ov.el.hidden = true;
    document.body.classList.remove("idov-open");
    const f = ov.returnFocus;
    ov.returnFocus = null;
    if (f && document.contains(f) && f.focus) f.focus();
  }

  function follow(l) {
    close();
    if (l.musician && global.App?.openMusician) { global.App.openMusician(l.musician); return; }
    if (l.route) { location.hash = l.route; return; }
    if (l.open && global.SidePanel?.open) {
      global.SidePanel.open(l.open);
      if (l.open === "todo" && l.item && global.TodoPanel?.openItem) {
        let n = 0;
        const t = setInterval(() => { if (global.TodoPanel.openItem(l.item) || ++n > 20) clearInterval(t); }, 150);
      }
    }
  }

  async function loadVocab() {
    try {
      const r = await fetch("/api/identify/vocab");
      // The thread may have been drawn before the vocabulary arrived: redraw it once.
      if (r.ok) { setVocab(await r.json()); try { global.App?.renderChat?.(); } catch { /* not ready yet */ } return; }
    } catch { /* offline: fall back to the musicians known by the page */ }
    const names = global.App?.musicians ? [...global.App.musicians.keys()] : [];
    if (names.length) setVocab({ projects: names, slots: vocab.slots, conductor: global.App?.composer?.CONDUCTOR || "chef" });
  }

  // Missing or refused media: drop the preview, the link stays as it was.
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.closest && (t.tagName === "IMG" || t.tagName === "VIDEO")) { const p = t.closest(".media-prev"); if (p) p.remove(); }
  }, true);
  // Thumbnail → full size on click, back on a second click.
  document.addEventListener("click", (e) => {
    const img = e.target.closest && e.target.closest(".media-image img");
    if (img) { e.preventDefault(); e.stopPropagation(); img.classList.toggle("media-zoom"); }
  }, true);
  // Capture phase: a link inside a bubble, card or journal entry must not
  // trigger the host's own click handler (open drawer, fold/unfold…).
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a.idref");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    open(a.dataset.idref, a.dataset.idrefKind || "", contextProject(a));
  }, true);
  document.addEventListener("keydown", (e) => {
    // Only this overlay closes: the panel or drawer underneath stays open.
    if (e.key === "Escape" && ov.el && !ov.el.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if ((e.key === " ") && e.target.matches && e.target.matches("a.idref")) { e.preventDefault(); e.target.click(); }
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadVocab); else loadVocab();

  global.IdLinks = { ...pure, open, close, isOpen: () => !!(ov.el && !ov.el.hidden), reloadVocab: loadVocab };
})(typeof globalThis !== "undefined" ? globalThis : this);
