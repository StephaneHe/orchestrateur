---
name: feedback_all_opus5
description: "Directive : TOUTES les opérations du fleet sur Opus 5.5 uniquement (defaults.model=claude-opus-5-5)"
metadata:
  type: feedback
  modified: 2026-09-25T09:49:34.182Z
---

**Directive utilisateur (2026-09-25) : « passe toutes les opérations sur uniquement le modèle opus 5 » puis « il devrait pouvoir utiliser opus 5.5 ».** Tous les dispatches tournent sur **`claude-opus-5-5`**.

**How to apply :** `defaults.model = "claude-opus-5-5"` dans config.json. **Ne plus router par nature de tâche** (Fable/Sonnet/Haiku/Opus4.8/codex) tant que la directive tient : supersede [[feedback_plan_opus5_code_opus48]] et le tableau de choix de models du CLAUDE.md.
