# TODO_LIST

Suivi léger des tâches en cours / différées côté orchestrateur.

## Fait

- [x] **Failover → cascade NVIDIA codage-first** (2026-08-31, v0.10.0). La patte
  failover de `scripts/dispatch.mjs` route vers NVIDIA (endpoint OpenAI-compatible)
  au lieu de codex/gpt-5.6-sol : `moonshotai/kimi-k3` → `deepseek-ai/deepseek-v4-pro-0813`
  → `nvidia/nemotron-3-ultra-550b-a55b` → `deepseek-ai/deepseek-v4-flash-0731`.
  Client direct chat/completions (codex 0.147 exige l'API Responses, indispo côté
  NVIDIA). Clé dans `.env`. Auto-test `--test-failover`. Doc : `docs/failover-nvidia.md`.

## À surveiller / différé

- [ ] **Tool-use en mode failover** : le leg NVIDIA est single-shot (pas de Bash/Edit,
  pas de callback auto). Réévaluer si/quand NVIDIA expose l'API Responses, ou câbler
  une mini-boucle agentique maison si le besoin se confirme.
- [ ] **Fiabilité endpoint NVIDIA gratuit** : latence variable (~2 s à >80 s) et
  `ECONNRESET` ponctuels observés sur les modèles deepseek lors du test 2026-08-31
  (kimi-k3 et nemotron-3-ultra OK). La cascade absorbe ces échecs ; surveiller si un
  rung devient durablement indisponible et réordonner le cas échéant.
- [ ] **Vérifier le leg en conditions réelles** : l'auto-test prouve le client + la
  cascade sans déclencher de vraie limite. La chaîne complète (flag `claude-limited.until`
  → `runNvidiaFailover` → events écrits dans le log projet) se validera à la prochaine
  vraie limite de session Claude.
