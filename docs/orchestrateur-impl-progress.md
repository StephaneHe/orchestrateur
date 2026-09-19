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

## Lot 3 — serveur (le chef redémarre) — FAIT (commits) — **RESTART 7777 REQUIS**
- [x] Commit séparé du diff boot EADDRINUSE en attente (B3) → commit 95c6bbd (server.js seul)
- [x] Pas de drain de file sur result synthetic (B1) → condition `!ev.synthetic` dans le pump watcher
- [x] /api/pupitre : cache (mtime+size, TTL 2,5 s) + skip parked + champs `queueDepth`/`noFailover`/`limitedUntil`
- [x] P1 chef-stuck : reducers ignorent `user_prompt` sourcé (scanProjectState + reduceMusician + deriveState + client Musician.transition) ; route morte `/sse/logs/:project` supprimée ; watcher borné (blocs 4 MiB + setImmediate) ; `lastNonPartialType` ignore `notification` et `user_prompt` sourcé
- Vérif : `node --check` server.js + fleet-status-core.mjs + app.js OK ; deriveState testé (callback/@shortcut → pas live ; init → live) ; 0 appelant de /sse/logs. Serveur NON redémarré (le chef le fait).

## Notes
- Le cache /api/pupitre a un TTL de 2,5 s (< poll client 5 s) : le fichier inchangé est réutilisé entre clients/poll rapprochés, mais un log statique est re-scanné au poll suivant pour rafraîchir silence/PID.
- Parked : non scannés (entrée minimale `{name, state:'idle'}`) → économise 13 lectures/poll ; leurs lignes /pupitre montrent « — » (parkés dé-emphasés de toute façon).
- Client Musician.transition (app.js) modifié aussi (user_prompt sourcé) : c'est du CLIENT → hard-reload, pas restart. Groupé ici par cohérence du fix.
