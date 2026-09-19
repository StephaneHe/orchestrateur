# Implémentation P0 refonte Orchestrateur — progression

Spec : `docs/orchestrateur-redesign-validated.md` § « PLAN D'ACTION CONSOLIDÉ », P0 (Lot 1/2/3).
Cible version : 0.17.0. **Serveur 7777 NON redémarré par moi — le chef redéploie (Lot 3).**

## Lot 1 — rendu exact (client seul) — FAIT (commit)
- [x] PID MORT prioritaire sur STALLED (`pupitre-row.js` stateInfo)
- [x] Libellés FR orientés action (`app.js` STATE_LABELS, `pupitre-row.js` stateInfo) — chaînes d'état DOM inchangées
- [x] Briefing compte erreurs + bloqués (`app.js` openBriefing, helper needsAttn)
- [x] Détail live : assistant consolidé si aucun bloc streaming rendu (`pupitre-detail.js` onLive, flag streamedThisMsg)
- [x] Indicateur connexion / fraîcheur (`app.js` setConnState + SSE onopen/onerror + pollPupitre ; pill #conn-status dans index.html + styles.css)
- Vérif headless OK (cdp-lot1) : dead_wins, labels FR, codex_added=1, claude_no_double, conn ok/lost ; 0 erreur console.

## Lot 2 — cartes lisibles (client seul) — FAIT (commit)
- [x] Tri par attention (`attentionRank`/`byAttentionThenName`) puis nom, stable ; 3 sorts de layout ex-`freq` remplacés
- [x] 2e ligne de carte depuis /api/pupitre (`applyPupitreToCards` → `.m-telem` : PID ✓/✗, tour, model ; classe `pid-dead`)
- [x] Poll /api/pupitre 5 s, onglet visible seulement (setInterval dans init, gardé sur `document.hidden`)
- Vérif headless (cdp-lot2) : ordre Delta(stalled),Beta(error),Gamma(live),Alpha(unread),Zeta(idle) ; telem « PID ✗ · tour 1m05 · opus-4-8 » ; pid-dead ; 0 erreur.

## Lot 3 — serveur (le chef redémarre) — À FAIRE
- [ ] Commit séparé du diff boot EADDRINUSE en attente (B3)
- [ ] Pas de drain de file sur result synthetic (B1)
- [ ] /api/pupitre : cache mtime+size, skip parked, champs queueDepth/noFailover/limitedUntil
- [ ] P1 chef-stuck : reducers ignorent user_prompt sourcé, suppr /sse/logs, watcher borné, heal ignore notification/user_prompt sourcé

## Notes
- (à remplir au fil de l'eau)
