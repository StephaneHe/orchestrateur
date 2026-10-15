// HTML output of the models (chef and musicians), rendered safely (0.105.0).
//
// User request (2026-10-16): replies must be HTML "et que le client web soit
// capable de les afficher correctement". Model text is untrusted: it can echo
// file contents, web pages or another musician's output. So nothing written
// by a model ever reaches innerHTML as is:
//   - `isHtml(text)` tells an HTML fragment from legacy Markdown / plain text;
//   - `sanitize(html)` re-serialises it through a strict allowlist: unknown
//     tags are dropped (their text kept, escaped), script/style/iframe/svg…
//     are dropped WITH their content, only a few attributes survive, links
//     keep http(s), mailto, "/" and "#" targets only, and every tag is closed
//     so a fragment can never break out of its bubble;
//   - `toPlain(html)` gives Markdown-like text (text-to-speech, summaries).
// Pure string processing, no DOM: loaded by the browser and imported by the
// Node test suite (`scripts/_test_html_output.mjs`). No import/export; sets
// globalThis.HtmlRender, like turn-core.js and tts.js.
(function (global) {
  "use strict";

  const VOID = new Set(["br", "hr"]);
  const ALLOWED = new Set([
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
    "code", "pre", "kbd", "samp", "var", "blockquote", "q", "cite", "abbr", "time",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "a", "span", "div", "section", "article", "header", "footer", "aside", "nav", "main",
    "figure", "figcaption", "details", "summary",
  ]);
  VOID.add("col");
  // Dropped together with everything they contain.
  const DROP_CONTENT = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
    "template", "noscript", "noembed", "noframes", "textarea", "title", "svg", "math",
    "xmp", "plaintext", "select", "head",
  ]);
  const GLOBAL_ATTRS = new Set(["title", "lang"]);
  const NUM = /^\d{1,3}$/;
  const LANG_CLASS = /^(?:lang|language)-[\w+#.-]{1,30}$/;
  const TAG_ATTRS = {
    a: { href: "url" },
    td: { colspan: NUM, rowspan: NUM },
    th: { colspan: NUM, rowspan: NUM, scope: /^(?:row|col|rowgroup|colgroup)$/ },
    col: { span: NUM },
    ol: { start: /^-?\d{1,6}$/ },
    details: { open: "bool" },
    time: { datetime: /^[\dTZ:+.\- ]{1,40}$/ },
    code: { class: LANG_CLASS },
    pre: { class: LANG_CLASS },
  };
  const BLOCK = new Set([
    "p", "div", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
    "pre", "blockquote", "section", "article", "details", "dl", "dd", "dt", "header",
    "footer", "aside", "nav", "main", "figure", "summary", "thead", "tbody",
  ]);

  // Comment | doctype / processing instruction | tag with its attributes.
  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
  const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n" };

  function decodeEntities(s) {
    return String(s).replace(ENTITY, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      const v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Text keeps the model's own entities (&amp; &lt; …) and escapes the rest.
  const escText = (s) => String(s)
    .replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});)/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Control characters, whitespace and zero-width / line-separator code points.
  const INVISIBLE = new RegExp("[" + [[0, 0x20], [0x7f, 0xa0], [0x200b, 0x200f], [0x2028, 0x2029], [0xfeff, 0xfeff]]
    .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", "gu");

  /** Only http(s), mailto, same-origin absolute paths and anchors. */
  function safeHref(raw) {
    // Browsers ignore control characters and whitespace inside a scheme
    // (« java\tscript: », « &#x6A;avascript: »): judge the decoded, squeezed value.
    const v = decodeEntities(raw).replace(INVISIBLE, "");
    return /^(?:https?:\/\/|mailto:|\/(?!\/)|#)/i.test(v) ? v : null;
  }

  function cleanAttrs(tag, attrStr) {
    const allowed = TAG_ATTRS[tag] || {};
    const out = [];
    const seen = new Set();
    let href = null;
    ATTR.lastIndex = 0;
    let m;
    while ((m = ATTR.exec(attrStr || ""))) {
      const name = m[1].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
      const rule = allowed[name] || (GLOBAL_ATTRS.has(name) ? "text" : null);
      if (!rule) continue;
      if (rule === "url") { href = safeHref(value); continue; }
      if (rule === "bool") { out.push(` ${name}`); continue; }
      if (rule instanceof RegExp && !rule.test(value.trim())) continue;
      out.push(` ${name}="${escAttr(rule === "text" ? value.slice(0, 300) : value.trim())}"`);
    }
    if (tag === "a" && href) out.unshift(` href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"`);
    return out.join("");
  }

  function stripCode(s) {
    return String(s || "").replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  }
  const BLOCK_CLOSE = /<\/(?:p|div|ul|ol|li|table|tr|td|th|h[1-6]|pre|blockquote|section|article|details|dl|dd|dt|summary|figure)\s*>/gi;
  const LEADING_TAG = /^(?:<!doctype[^>]*>\s*|<!--[\s\S]*?-->\s*)*<(?:html|body|[a-z][a-z0-9]*)\b[^>]*>/i;

  /**
   * HTML fragment, or legacy Markdown / plain text? Inline code and code
   * fences are ignored, so a Markdown answer that *talks about* `<div>` stays
   * Markdown. HTML = it starts with a tag and closes an element somewhere,
   * or it closes at least two block elements.
   */
  function isHtml(text) {
    const s = stripCode(text).trim();
    if (!s || s.indexOf("<") < 0) return false;
    const closes = (s.match(BLOCK_CLOSE) || []).length;
    if (closes >= 2) return true;
    if (LEADING_TAG.test(s) && (closes >= 1 || /<\/[a-z][a-z0-9]*\s*>|<br\s*\/?>/i.test(s))) {
      const name = s.replace(/^(?:<!doctype[^>]*>\s*|<!--[\s\S]*?-->\s*)*<([a-z][a-z0-9]*)[\s\S]*$/i, "$1").toLowerCase();
      return ALLOWED.has(name) || name === "html" || name === "body";
    }
    return false;
  }

  /** Walks tokens; calls `onText(text)`, `onOpen(tag, attrs, selfClose)`, `onClose(tag)`. */
  function walk(src, onText, onOpen, onClose) {
    const s = String(src || "");
    let i = 0;
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(s))) {
      if (m.index > i) onText(s.slice(i, m.index));
      i = TOKEN.lastIndex;
      if (!m[2]) continue; // comment, doctype, processing instruction
      const tag = m[2].toLowerCase();
      if (!m[1] && DROP_CONTENT.has(tag)) {
        const close = new RegExp(`</${tag}\\s*>`, "ig");
        close.lastIndex = i;
        const c = close.exec(s);
        i = c ? close.lastIndex : s.length;
        TOKEN.lastIndex = i;
        continue;
      }
      if (m[1]) onClose(tag); else onOpen(tag, m[3], !!m[4]);
    }
    if (i < s.length) onText(s.slice(i));
  }

  /** Allowlisted, well-formed HTML from untrusted model output. */
  function sanitize(html) {
    const out = [];
    const stack = [];
    walk(html,
      (text) => {
        // Stray « < » never opens anything: escText turns it into &lt;.
        let t = escText(text);
        if (!stack.length) {
          // Top-level prose between blocks (e.g. a NEEDS_USER_INPUT line) keeps its line breaks.
          const body = t.trim();
          t = body ? (/^\s/.test(t) ? " " : "") + body.replace(/\r?\n/g, "<br>") + (/\s$/.test(t) ? " " : "") : (t ? "\n" : "");
        }
        out.push(t);
      },
      (tag, attrs, selfClose) => {
        if (!ALLOWED.has(tag)) return;
        out.push(`<${tag}${cleanAttrs(tag, attrs)}>`);
        if (!VOID.has(tag) && !selfClose) stack.push(tag);
        else if (!VOID.has(tag)) out.push(`</${tag}>`);
      },
      (tag) => {
        if (!ALLOWED.has(tag) || VOID.has(tag)) return;
        const at = stack.lastIndexOf(tag);
        if (at < 0) return; // stray close tag: never closes the host bubble
        while (stack.length > at) out.push(`</${stack.pop()}>`);
      });
    while (stack.length) out.push(`</${stack.pop()}>`);
    return out.join("").trim();
  }

  /**
   * Markdown-like plain text of an HTML fragment: headings as « ## », list
   * items as « - », <pre> as a code fence, tables as pipe rows. Used by the
   * text-to-speech and the one-line summaries.
   */
  function toPlain(html) {
    const out = [];
    let pre = 0;
    let row = null, rowHasTh = false, firstRow = true;
    const push = (t) => { if (row && row.length) row[row.length - 1] += t; else out.push(t); };
    walk(html,
      (text) => {
        const t = decodeEntities(text);
        push(pre ? t : t.replace(/\s+/g, " "));
      },
      (tag) => {
        if (/^h[1-6]$/.test(tag)) out.push("\n\n" + "#".repeat(+tag[1]) + " ");
        else if (tag === "li") out.push("\n- ");
        else if (tag === "br") push("\n");
        else if (tag === "pre") { pre++; out.push("\n```\n"); }
        else if (tag === "table") { firstRow = true; out.push("\n"); }
        else if (tag === "tr") { row = []; rowHasTh = false; }
        else if (tag === "td" || tag === "th") { if (row) { row.push(""); if (tag === "th") rowHasTh = true; } }
        else if (tag === "hr") out.push("\n---\n");
        else if (BLOCK.has(tag)) out.push("\n\n");
      },
      (tag) => {
        if (tag === "li") return;
        if (tag === "pre") { pre = Math.max(0, pre - 1); out.push("\n```\n"); }
        else if (tag === "tr" && row) {
          const cells = row.map((c) => c.replace(/\s+/g, " ").replace(/\|/g, "/").trim());
          out.push("\n| " + cells.join(" | ") + " |");
          if (firstRow && rowHasTh) out.push("\n|" + cells.map(() => "---").join("|") + "|");
          firstRow = false;
          row = null;
        }
        else if (/^h[1-6]$/.test(tag) || BLOCK.has(tag)) out.push("\n\n");
      });
    return out.join("")
      .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+(?=\S)/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  }

  global.HtmlRender = { isHtml, sanitize, toPlain, safeHref, decodeEntities };
})(typeof globalThis !== "undefined" ? globalThis : this);
