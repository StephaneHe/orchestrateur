// public/permission-core.js — règles des demandes d'autorisation interactives
// (0.45.0). Comme turn-core.js : ni import ni export, pose
// globalThis.PermissionCore. Chargé par le navigateur (overlay, cartes) ET
// importé par Node (serveur : masquage, risque, règles « toujours »), pour qu'un
// seul code décide de ce qui est affiché et de ce qu'une règle autorise.
(function (g) {
  "use strict";

  // ── Secrets : jamais en clair dans l'overlay ──────────────────────────────
  // On garde les 4 derniers caractères, comme la section « Clés API ».
  const SECRET_RES = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_\-]{16,}/g,
    /\bnvapi-[A-Za-z0-9_\-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAIza[0-9A-Za-z_\-]{30,}/g,
    /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
    /\b[a-f0-9]{48,}\b/gi,
  ];
  // NOM_DE_CLÉ=valeur, "password": "…", Authorization: Bearer …
  const ASSIGN_RE = /((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|authorization|bearer|client[_-]?secret|access[_-]?key)[A-Za-z0-9_\-]*["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^\s"',;]{8,})/gi;

  function maskValue(v) {
    const s = String(v);
    return "••••" + (s.length > 12 ? s.slice(-4) : "");
  }
  function maskSecrets(text) {
    if (typeof text !== "string" || !text) return text;
    let out = text.replace(ASSIGN_RE, (_, k, v) => k + maskValue(v));
    for (const re of SECRET_RES) out = out.replace(re, (m) => maskValue(m));
    return out;
  }
  function maskDeep(v, depth = 0) {
    if (depth > 8) return v;
    if (typeof v === "string") return maskSecrets(v);
    if (Array.isArray(v)) return v.map(x => maskDeep(x, depth + 1));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = maskDeep(x, depth + 1);
      return o;
    }
    return v;
  }

  // ── Lecture d'une entrée d'outil ──────────────────────────────────────────
  const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
  const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

  function commandOf(input) { return typeof input?.command === "string" ? input.command : ""; }
  function filePathOf(input) {
    const p = input?.file_path ?? input?.notebook_path ?? input?.path;
    return typeof p === "string" ? p : "";
  }

  /** Une commande « simple » : une seule commande, sans enchaînement, tube,
   *  redirection, sous-expression ni bloc. Seule une commande simple peut être
   *  couverte par une règle de préfixe (sinon `git status && rm -rf x` passerait
   *  sous `Bash(git status:*)`). */
  const COMPOSITE_FEATURES = [
    [/&&|\|\|/, "enchaînement (&&, ||)"],
    [/;/, "plusieurs commandes (;)"],
    [/(^|[^|])\|(?!\|)/, "tube (|)"],
    [/\$\(|`/, "sous-expression $( ) ou `…`"],
    [/>|</, "redirection (>, <)"],
    [/\r|\n/, "plusieurs lignes"],
    [/@\(/, "tableau @( )"],
    [/[{}]/, "bloc de script { }"],
    [/\b(Invoke-Expression|iex)\b|-EncodedCommand\b/i, "évaluation dynamique"],
  ];
  function compositeFeatures(cmd) {
    const out = [];
    for (const [re, label] of COMPOSITE_FEATURES) if (re.test(cmd)) out.push(label);
    return out;
  }
  function isSimpleCommand(cmd) { return !!cmd && compositeFeatures(cmd).length === 0; }

  // ── Risque : lecture seule / écriture / réseau / destructif / secrets ─────
  const DESTRUCTIVE_RE = /\b(rm\s+-[a-z]*[rf]|rm\s|rmdir|del\s|erase\s|Remove-Item|rd\s+\/s|format\s+[a-z]:|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f\b|--force)|branch\s+-D|checkout\s+--\s)|drop\s+(table|database)|truncate\s|Stop-Process|taskkill|shutdown|Restart-Computer|reg\s+delete|mkfs|dd\s+if=|Clear-Content|kill\s+-9)/i;
  const NETWORK_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|git\s+(push|pull|fetch|clone)|npm\s+(install|i|ci|publish|update)|npx\s|pip\s+install|ssh|scp|gh\s|adb\s|ftp|Send-MailMessage)\b/i;
  const WRITE_RE = /(>|\b(mkdir|md|touch|cp|mv|copy|move|ren|New-Item|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|Rename-Item|git\s+(commit|add|merge|rebase|tag|stash|checkout|switch|restore)|npm\s+version|sed\s+-i|tee)\b)/i;
  const SECRET_HINT_RE = /(\.env\b|\.token\b|credentials|id_rsa|id_ed25519|\.ssh[\\/]|secrets?\.|\.netrc|\.claude\.json|_API_KEY|apikey|password|\.pem\b|\.pfx\b|\.p12\b)/i;
  const READONLY_CMD_RE = /^\s*(ls|dir|cat|type|head|tail|pwd|echo|git\s+(status|log|diff|show|branch|rev-parse|ls-files)|Get-(Content|ChildItem|Item|Location|Process)|Select-String|grep|rg|find|wc|where|which|node\s+--version|npm\s+(ls|view|test|run\s+test))\b/i;

  function riskOf(tool, input) {
    const tags = new Set();
    const cmd = commandOf(input);
    const fp = filePathOf(input);
    const url = typeof input?.url === "string" ? input.url : "";
    if (SHELL_TOOLS.has(tool)) {
      if (DESTRUCTIVE_RE.test(cmd)) tags.add("destructif");
      if (NETWORK_RE.test(cmd)) tags.add("réseau");
      if (WRITE_RE.test(cmd)) tags.add("écriture");
      if (!tags.size) tags.add(READONLY_CMD_RE.test(cmd) && isSimpleCommand(cmd) ? "lecture seule" : "exécution");
    } else if (FILE_WRITE_TOOLS.has(tool)) {
      tags.add("écriture");
    } else if (FILE_READ_TOOLS.has(tool)) {
      tags.add("lecture seule");
    } else if (tool === "WebFetch" || tool === "WebSearch") {
      tags.add("réseau");
    } else {
      tags.add("exécution");
    }
    if (SECRET_HINT_RE.test(cmd) || SECRET_HINT_RE.test(fp) || SECRET_HINT_RE.test(url)) tags.add("secrets");
    const list = [...tags];
    const level = (tags.has("destructif") || tags.has("secrets")) ? "élevé"
      : (tags.has("lecture seule") && list.length === 1) ? "faible" : "moyen";
    return { tags: list, level };
  }

  // ── Pourquoi la demande ? ─────────────────────────────────────────────────
  function toolGranted(allowed, tool) {
    const list = Array.isArray(allowed) ? allowed : String(allowed || "").split(",");
    return list.map(s => s.trim()).some(r => r === tool);
  }
  function normPath(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
  function isInside(p, base) {
    if (!p || !base) return true;
    const a = normPath(p), b = normPath(base);
    return a === b || a.startsWith(b + "/");
  }
  function isAbsolute(p) { return /^([a-zA-Z]:[\\/]|[\\/])/.test(p || ""); }

  function whyAsked(tool, input, ctx = {}) {
    if (!toolGranted(ctx.allowedTools, tool)) {
      return { kind: "tool", text: `« ${tool} » ne fait pas partie des outils autorisés pour ce projet (règle manquante).` };
    }
    if (SHELL_TOOLS.has(tool)) {
      const f = compositeFeatures(commandOf(input));
      if (f.length) return { kind: "command", text: `${tool} est autorisé, mais l'analyse de sécurité du CLI demande confirmation pour une commande composite : ${f.join(", ")}.` };
      return { kind: "command", text: `${tool} est autorisé, mais l'analyse de sécurité du CLI demande confirmation pour cette commande (écriture, chemin hors du projet ou commande non reconnue comme sûre).` };
    }
    const fp = filePathOf(input);
    if (fp && isAbsolute(fp) && ctx.projectPath && !isInside(fp, ctx.projectPath) && !isInside(fp, ctx.cwd)) {
      return { kind: "path", text: `Chemin hors du dossier du projet (${fp}) : le CLI demande confirmation.` };
    }
    return { kind: "other", text: `Le CLI demande confirmation pour cet appel de ${tool}.` };
  }

  // ── Règles « toujours autoriser » ─────────────────────────────────────────
  const RULE_RE = /^([A-Za-z_][A-Za-z0-9_\-]{0,63})(?:\(([^\r\n]{1,400})\))?$/;
  function parseRule(rule) {
    const m = RULE_RE.exec(String(rule || "").trim());
    return m ? { tool: m[1], spec: m[2] ?? null } : null;
  }
  function validRule(rule) { return !!parseRule(rule); }

  // Outils dont le 2ᵉ mot fait partie de la commande (« git status », « npm test »).
  const TWO_WORD = new Set(["git", "npm", "npx", "pnpm", "yarn", "node", "docker", "gh", "adb", "python", "py", "pip", "cargo", "dotnet", "go", "gradle", "gradlew", "./gradlew", ".\\gradlew", "winget", "choco", "kubectl", "az", "gcloud", "codex", "claude"]);

  function relTo(base, p) {
    if (!base || !p) return p;
    const a = String(p).replace(/\\/g, "/"), b = String(base).replace(/\\/g, "/").replace(/\/+$/, "");
    return a.toLowerCase().startsWith(b.toLowerCase() + "/") ? a.slice(b.length + 1) : a;
  }

  function suggestRules(tool, input, ctx = {}) {
    const out = [];
    if (SHELL_TOOLS.has(tool)) {
      const cmd = commandOf(input).trim();
      if (isSimpleCommand(cmd)) {
        const words = cmd.split(/\s+/);
        let prefix = words[0];
        if (words.length > 1 && TWO_WORD.has(words[0].toLowerCase()) && !words[1].startsWith("-")) prefix += " " + words[1];
        if (prefix && prefix !== cmd) out.push({ rule: `${tool}(${prefix}:*)`, scope: "pattern", label: `les commandes simples qui commencent par « ${prefix} »` });
      }
      if (cmd && cmd.length <= 400 && !/[\r\n]/.test(cmd)) out.push({ rule: `${tool}(${cmd})`, scope: "exact", label: "exactement cette commande" });
      out.push({ rule: tool, scope: "tool", label: `toutes les commandes ${tool} (déconseillé : y compris destructives)` });
      return out;
    }
    if (FILE_WRITE_TOOLS.has(tool) || FILE_READ_TOOLS.has(tool)) {
      const fp = filePathOf(input);
      if (fp) {
        const rel = relTo(ctx.projectPath, fp);
        const dir = rel.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
        if (dir) out.push({ rule: `${tool}(${dir}/**)`, scope: "pattern", label: `les fichiers sous ${dir}/` });
        out.push({ rule: `${tool}(${rel})`, scope: "exact", label: "exactement ce fichier" });
      }
      out.push({ rule: tool, scope: "tool", label: `l'outil ${tool} entièrement` });
      return out;
    }
    if (tool === "WebFetch" && typeof input?.url === "string") {
      try { const h = new URL(input.url).hostname; out.push({ rule: `WebFetch(domain:${h})`, scope: "pattern", label: `les pages du domaine ${h}` }); } catch { /* URL illisible */ }
    }
    out.push({ rule: tool, scope: "tool", label: `l'outil ${tool} entièrement` });
    return out;
  }

  // Les règles Edit couvrent tous les outils d'édition (même convention que le CLI).
  function sameToolFamily(ruleTool, tool) {
    if (ruleTool === tool) return true;
    return ruleTool === "Edit" && FILE_WRITE_TOOLS.has(tool);
  }

  function resolveIn(base, p) {
    const s = String(p || "").replace(/\\/g, "/");
    if (isAbsolute(s) || !base) return s;
    return String(base).replace(/\\/g, "/").replace(/\/+$/, "") + "/" + s.replace(/^\.\//, "");
  }

  function ruleMatches(rule, tool, input, ctx = {}) {
    const r = parseRule(rule);
    if (!r || !sameToolFamily(r.tool, tool)) return false;
    if (r.spec == null) return true;
    if (SHELL_TOOLS.has(tool)) {
      const cmd = commandOf(input).trim();
      if (r.spec.endsWith(":*")) {
        const prefix = r.spec.slice(0, -2).trim();
        return !!prefix && isSimpleCommand(cmd) && (cmd === prefix || cmd.startsWith(prefix + " "));
      }
      return cmd === r.spec.trim();
    }
    if (FILE_WRITE_TOOLS.has(tool) || FILE_READ_TOOLS.has(tool)) {
      const fp = filePathOf(input);
      if (!fp) return false;
      const base = ctx.projectPath || ctx.cwd || "";
      const target = normPath(resolveIn(base, fp));
      if (r.spec.endsWith("/**")) {
        const dir = normPath(resolveIn(base, r.spec.slice(0, -3)));
        return target.startsWith(dir + "/");
      }
      return target === normPath(resolveIn(base, r.spec));
    }
    if (tool === "WebFetch" && r.spec.startsWith("domain:")) {
      try {
        const h = new URL(input.url).hostname.toLowerCase(), d = r.spec.slice(7).toLowerCase();
        return h === d || h.endsWith("." + d);
      } catch { return false; }
    }
    return false;
  }

  // ── Présentation ──────────────────────────────────────────────────────────
  function preview(tool, input) {
    const s = commandOf(input) || filePathOf(input) || input?.url || input?.pattern || input?.query || input?.description || "";
    return maskSecrets(String(s).replace(/\s+/g, " ").trim()).slice(0, 160);
  }

  /** Blocs de l'overlay, entrée COMPLÈTE (masquée) : [{label, kind, text}]
   *  kind : code | diff | text. */
  function detailBlocks(tool, input) {
    const m = maskDeep(input || {});
    const blocks = [];
    const used = new Set();
    const take = (k) => { used.add(k); return m[k]; };
    if (SHELL_TOOLS.has(tool) && typeof m.command === "string") blocks.push({ label: "Commande", kind: "code", text: take("command") });
    if (typeof m.file_path === "string") blocks.push({ label: "Fichier", kind: "text", text: take("file_path") });
    if (typeof m.notebook_path === "string") blocks.push({ label: "Notebook", kind: "text", text: take("notebook_path") });
    if (typeof m.url === "string") blocks.push({ label: "URL", kind: "text", text: take("url") });
    if (tool === "Write" && typeof m.content === "string") {
      blocks.push({ label: "Contenu écrit (fichier entier)", kind: "diff", text: take("content").split("\n").map(l => "+" + l).join("\n") });
    }
    if (typeof m.old_string === "string" || typeof m.new_string === "string") {
      const old = String(take("old_string") ?? ""), neu = String(take("new_string") ?? "");
      blocks.push({ label: m.replace_all ? "Modification (toutes les occurrences)" : "Modification", kind: "diff",
        text: old.split("\n").map(l => "-" + l).concat(neu.split("\n").map(l => "+" + l)).join("\n") });
      used.add("replace_all");
    }
    if (Array.isArray(m.edits)) {
      take("edits").forEach((e, i) => blocks.push({ label: `Modification ${i + 1}`, kind: "diff",
        text: String(e.old_string ?? "").split("\n").map(l => "-" + l).concat(String(e.new_string ?? "").split("\n").map(l => "+" + l)).join("\n") }));
    }
    const rest = Object.fromEntries(Object.entries(m).filter(([k]) => !used.has(k)));
    if (Object.keys(rest).length) blocks.push({ label: "Autres paramètres", kind: "code", text: JSON.stringify(rest, null, 2) });
    return blocks;
  }

  function fmtLeft(ms) {
    if (!(ms > 0)) return "0:00";
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  const DECISION_TEXT = {
    allow_once: "autorisé une fois",
    allow_always: "toujours autorisé",
    rule: "autorisé par une règle permanente",
    deny: "refusé",
    expired: "expiré sans réponse",
  };

  g.PermissionCore = {
    maskSecrets, maskDeep, riskOf, whyAsked, suggestRules, ruleMatches, parseRule, validRule,
    isSimpleCommand, compositeFeatures, preview, detailBlocks, fmtLeft, toolGranted, DECISION_TEXT,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
