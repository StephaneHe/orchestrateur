---
name: project_fleet_ports
description: Table des ports assignés à chaque service du fleet (sans conflits)
type: project
modified: 2026-09-08T15:44:24.116Z
---
Ports assignés — mis à jour le 2026-08-03 :

| Service | Port(s) | Type | Notes |
|---|---|---|---|
| index (annuaire) | 80 | web WSL | page d'annuaire principale |
| share-api | 3000 | web WSL | Fastify |
| boxapp | 3001 | web WSL | Express + better-sqlite3 |
| shelfapp | 8097 | web WSL | Flask |
| basketapp | 8001 | web WSL | FastAPI |
| orchestrateur | 7777 | web Windows | dashboard Claude Code |
| Ollama | 11434 | WSL | modèles |
| liveapp | 8093 | web Windows | serveur vidéo local |

**How to apply:** Référencer cette table pour tout nouveau service, éviter ces ports.
