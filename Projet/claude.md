# Retrorama — Cartographie des Influences

## Stack
- Vanilla JS ES modules (pas de bundler, pas de framework)
- D3.js v7 pour le graphe force-directed
- IndexedDB (db.js) pour le cache local
- Service Worker (sw.js) pour la PWA

## Architecture
- retrorama.html — UI, CSS inline, importe data.js et script.js
- script.js — logique D3, nœuds, interactions, univers
- data.js — APIs (Gemini, Wikidata, OMDb, OpenLibrary, RAWG)
- db.js — cache IndexedDB (stores: influences, universes)
- sw.js — Service Worker PWA

## Conventions
- Pas de build step, fichiers servis directement
- ES modules natifs (import/export)
- Clés API dans data.js (GEMINI_KEY, OMDB_KEY, RAWG_KEY)
- Serveur local : python -m http.server 8080