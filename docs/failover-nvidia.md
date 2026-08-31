# Failover NVIDIA (cascade codage-first)

Quand le compte Claude atteint sa limite de session, le fleet ne dispose
d'aucune intelligence pour réagir (le conducteur est lui-même une session
Claude, morte en même temps). La patte failover de `scripts/dispatch.mjs` est
donc du code déterministe, sans IA dans la boucle de routage.

## Où va le failover

Depuis le 2026-08-31, le failover route vers l'endpoint **NVIDIA** gratuit
compatible OpenAI (`https://integrate.api.nvidia.com/v1`, chat/completions) en
essayant une **cascade ordonnée, priorité codage**. Le modèle suivant n'est
essayé **que si** le précédent échoue (erreur / quota / timeout / réponse vide) :

1. `moonshotai/kimi-k3`
2. `deepseek-ai/deepseek-v4-pro-0813`
3. `nvidia/nemotron-3-ultra-550b-a55b`
4. `deepseek-ai/deepseek-v4-flash-0731`

> Identifiants namespacés `vendor/model`, vérifiés en direct via
> `GET /v1/models` le 2026-08-31.

**Dernier recours** : si toute la cascade est down (ou la clé absente), le leg
retombe une fois sur `codex/gpt-5.6-sol` (OAuth, tool-use restauré) avant
d'abandonner proprement. Jamais de boucle de retry.

## Emplacement de la clé

`NVIDIA_API_KEY` est lue depuis `I:\orchestrateur\.env` (déjà gitignoré) — ou
depuis `process.env` si déjà exportée. Elle n'est envoyée **qu'**à
`integrate.api.nvidia.com` (header `Authorization`), **jamais** forwardée à un
process enfant : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` **et** `NVIDIA_API_KEY`
sont scrubés de l'env enfant. Aucun secret n'est loggé.

```
# I:\orchestrateur\.env
NVIDIA_API_KEY=nvapi-...
```

## Pourquoi un client direct et pas le harness codex

L'option propre aurait été de garder **codex** comme harness agentique
(tool-use préservé) en pointant son provider sur NVIDIA. **Impossible ici** :
codex-cli 0.147.0 a supprimé `wire_api = "chat"` et exige désormais l'API
Responses, alors que NVIDIA n'expose que chat/completions (`/v1/responses` →
404). Le leg failover parle donc chat/completions à NVIDIA directement.

**Conséquence assumée** : ce leg est un appel **single-shot**. Le modèle NVIDIA
renvoie du code/texte concret, mais **ne peut pas** exécuter Bash/Edit ni
déclencher le callback de notification. C'est un mode dégradé dont le seul but
est de ne pas perdre le tour pendant que Claude est indisponible.

## Auto-test (sans déclencher de vraie limite)

```
node scripts/dispatch.mjs --test-failover        # sonde le primaire (kimi-k3)
node scripts/dispatch.mjs --test-failover-all     # parcourt toute la cascade
```

Le hook exerce l'endpoint en direct **sans** toucher aux logs projets, aux
sidecars, au pid, ni au flag `logs/claude-limited.until`. Sortie 0 si au moins
un modèle sondé répond, 1 sinon.

> Note : l'endpoint gratuit est à latence variable (de ~2 s à >80 s selon la
> charge) et un modèle peut renvoyer un `ECONNRESET` ponctuel — c'est
> précisément pourquoi la cascade essaie le rung suivant sur échec.
