// ============================================================================
// public/permission-denial.js — détection d'un VRAI refus d'autorisation (0.29.1)
// ============================================================================
//
// Avant 0.29.1, toute `tool_result` dont le texte CONTENAIT « requires
// approval » était prise pour un refus. Un simple Read de public/app.js (qui
// contient cette chaîne) affichait donc un panneau « outil bloqué » sans objet.
//
// Règle : un refus = une `tool_result` avec `is_error: true` ET dont le texte
// COMMENCE par l'un des libellés réels du CLI claude, relevés dans les logs de
// la flotte (septembre 2026) :
//   · Claude requested permissions to use WebSearch, but you haven't granted it yet.
//   · Claude requested permissions to write to <chemin>, but you haven't granted it yet.
//   · This command requires approval
//   · This Bash|PowerShell command contains multiple operations. The following part(s) require(s) approval: …
//   · Permission to use Bash with command <…> has been denied.
//   · <tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>
// Un refus n'est ANNONCÉ que s'il est complet : outil ET aperçu de l'appel
// (commande, fichier…) — jamais un panneau vague.
//
// Script classique (pas de module) : chargé par index.html avant app.js, et par
// scripts/_test_permission_denial.mjs dans une VM.
// ============================================================================
(function (global) {
  "use strict";

  const DENIAL_PATTERNS = [
    /^Claude requested permissions? to .+ but you haven't granted it yet\.?/s,
    /^This command requires approval\b/,
    /^This (?:Bash|PowerShell) command contains multiple operations\. The following parts? requires? approval\b/,
    /^Permission to use \S+ .*has been denied\.?\s*$/s,
    /^<tool_use_error>[^<]*denied by your permission settings/,
  ];

  function resultText(b) {
    const c = b && b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(x => (x && typeof x.text === "string") ? x.text : "").join("\n");
    return "";
  }

  /** Vrai refus de permission ? (jamais sur le seul contenu d'un fichier lu) */
  function isDenialResult(b) {
    if (!b || b.type !== "tool_result" || b.is_error !== true) return false;
    const t = resultText(b).trim();
    return DENIAL_PATTERNS.some(re => re.test(t));
  }

  /** Aperçu lisible de l'appel refusé : commande, fichier, URL, requête… */
  function inputPreview(input) {
    if (!input || typeof input !== "object") return "";
    const v = input.command ?? input.file_path ?? input.path ?? input.notebook_path ??
      input.url ?? input.query ?? input.pattern ?? input.description ?? null;
    const s = v != null ? String(v) : "";
    return s.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  /** Motif lisible : première ligne du message du CLI, bornée. */
  function reasonOf(b) {
    return resultText(b).replace(/<\/?tool_use_error>/g, "").split("\n")[0].trim().slice(0, 200);
  }

  /**
   * Refus contenus dans un événement `user`. `toolUses` : id → {name, input}
   * des tool_use vus dans le tour. Ne renvoie que des refus COMPLETS.
   */
  function denialsFromUserEvent(raw, toolUses) {
    if (!raw || raw.type !== "user") return [];
    const out = [];
    for (const b of (raw.message && raw.message.content) || []) {
      if (!isDenialResult(b)) continue;
      const use = (toolUses && b.tool_use_id && toolUses[b.tool_use_id]) || null;
      const d = {
        toolId: b.tool_use_id || null,
        toolName: use && use.name ? use.name : null,
        preview: use ? inputPreview(use.input) : "",
        reason: reasonOf(b),
      };
      if (isComplete(d)) out.push(d);
    }
    return out;
  }

  /** Refus listés par le `result` du tour (`permission_denials` du CLI). */
  function denialsFromResult(res) {
    const list = res && Array.isArray(res.permission_denials) ? res.permission_denials : [];
    return list.map(p => ({
      toolId: p.tool_use_id || null,
      toolName: p.tool_name || null,
      preview: inputPreview(p.tool_input),
      reason: "",
    })).filter(isComplete);
  }

  function isComplete(d) { return !!(d && d.toolName && d.preview); }

  /** L'outil figure-t-il dans les --allowed-tools du musicien ? (« Bash(git:*) » compte pour Bash) */
  function toolAllowed(tools, name) {
    const list = Array.isArray(tools) ? tools : String(tools || "").split(",");
    return list.map(t => String(t).trim().replace(/\(.*$/, "")).includes(name);
  }

  global.PermissionDenial = {
    DENIAL_PATTERNS, isDenialResult, inputPreview, denialsFromUserEvent, denialsFromResult, isComplete, toolAllowed, resultText,
  };
})(typeof window !== "undefined" ? window : globalThis);
