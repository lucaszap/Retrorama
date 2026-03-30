// ============================================================
//  db.js — Cache IndexedDB des influences
//
//  Structure :
//    DB "retrorama-db" version 1
//    └── store "influences"
//          clé : nodeId (string)
//          valeur : {
//            id, name, type, year,
//            upstream:   [ { id, name, type, year, description } ],
//            downstream: [ { id, name, type, year, description } ],
//            fetchedAt: timestamp
//          }
//
//  API publique :
//    db.getInfluences(id, dir)        → tableau | null
//    db.saveInfluences(id, node, dir, items) → void
//    db.exportJSON()                  → télécharge retrorama-cache.json
//    db.stats()                       → { total, upstream, downstream }
// ============================================================

const DB_NAME    = "retrorama-db";
const DB_VERSION = 2;
const STORE      = "influences";

// ── Ouverture ─────────────────────────────────────────────────
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Lecture ───────────────────────────────────────────────────

/**
 * Retourne le tableau d'influences en cache pour un nœud et une direction.
 * @param {string} id   — identifiant du nœud (imdbID, QID, etc.)
 * @param {string} dir  — "up" | "down"
 * @returns {Array|null} — tableau d'items ou null si absent du cache
 */
export async function getInfluences(id, dir) {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);

    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = e => {
        const record = e.target.result;
        if (!record) { resolve(null); return; }
        const data = dir === "up" ? record.upstream : record.downstream;
        resolve(data ?? null);
      };
      req.onerror = e => reject(e.target.error);
    });
  } catch (e) {
    console.warn("db.getInfluences erreur:", e);
    return null;
  }
}

// ── Écriture ──────────────────────────────────────────────────

/**
 * Sauvegarde (ou enrichit) le cache pour un nœud.
 * @param {string} id       — identifiant du nœud
 * @param {object} nodeInfo — { name, type, year } (métadonnées du nœud)
 * @param {string} dir      — "up" | "down"
 * @param {Array}  items    — tableau d'influences à stocker
 */
export async function saveInfluences(id, nodeInfo, dir, items) {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    return new Promise((resolve, reject) => {
      // Lire l'entrée existante pour ne pas écraser l'autre direction
      const getReq = store.get(id);
      getReq.onsuccess = e => {
        const existing = e.target.result || {
          id,
          name:       nodeInfo.name  || "",
          type:       nodeInfo.type  || "",
          year:       nodeInfo.year  || "",
        };

        // Fusionner les items avec ceux déjà présents (déduplication par id/name)
        const existingItems = (dir === "up" ? existing.upstream : existing.downstream) || [];
        const merged = mergeItems(existingItems, items);

        if (dir === "up") existing.upstream   = merged;
        else              existing.downstream = merged;

        existing.fetchedAt = Date.now();

        const putReq = store.put(existing);
        putReq.onsuccess = () => resolve();
        putReq.onerror   = e => reject(e.target.error);
      };
      getReq.onerror = e => reject(e.target.error);
    });
  } catch (e) {
    console.warn("db.saveInfluences erreur:", e);
  }
}

// ── Déduplication ─────────────────────────────────────────────

function mergeItems(existing, incoming) {
  const seen = new Set(existing.map(i => normalizeKey(i)));
  const result = [...existing];
  for (const item of incoming) {
    const k = normalizeKey(item);
    if (!seen.has(k)) { seen.add(k); result.push(item); }
  }
  return result;
}

function normalizeKey(item) {
  // Utilise l'id si disponible, sinon le nom normalisé
  if (item.id && !/^claude-/.test(item.id)) return item.id;
  return (item.name || "").toLowerCase().trim();
}

// ── Export JSON ───────────────────────────────────────────────

/**
 * Télécharge tout le cache sous forme de fichier JSON.
 */
export async function exportJSON() {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);

    const all = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });

    const json = JSON.stringify(all, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "retrorama-cache.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("db.exportJSON erreur:", e);
  }
}

// ── Statistiques ──────────────────────────────────────────────

export async function dbStats() {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);

    const all = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });

    return {
      total:      all.length,
      upstream:   all.filter(r => r.upstream?.length).length,
      downstream: all.filter(r => r.downstream?.length).length,
    };
  } catch (e) {
    return { total: 0, upstream: 0, downstream: 0 };
  }
}

// ============================================================
//  UNIVERS — cache de détection de franchise
//  store "universes" : { id, universe, fetchedAt }
//  universe = string (nom de la franchise) | null (standalone)
// ============================================================

export async function getUniverse(id) {
  try {
    const db    = await openDB();
    // Créer le store si absent (upgrade manuel non possible ici → on tente juste)
    if (!db.objectStoreNames.contains("universes")) return undefined;
    const tx    = db.transaction("universes", "readonly");
    const store = tx.objectStore("universes");
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = e => {
        const rec = e.target.result;
        // undefined = jamais interrogé | null = standalone | string = franchise
        resolve(rec ? rec.universe : undefined);
      };
      req.onerror = e => reject(e.target.error);
    });
  } catch (e) { return undefined; }
}

export async function saveUniverse(id, universe) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains("universes")) return;
    const tx    = db.transaction("universes", "readwrite");
    const store = tx.objectStore("universes");
    return new Promise((resolve, reject) => {
      const req = store.put({ id, universe, fetchedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  } catch (e) { console.warn("saveUniverse erreur:", e); }
}
