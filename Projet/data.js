// ============================================================
//  data.js — Sources de données + logique d'influences
//  Priorité : Cache IndexedDB → Gemini API → Wikidata (fallback)
// ============================================================

import { getInfluences, saveInfluences, getUniverse, saveUniverse } from "./db.js";

// ============================================================
//  GEMINI — Configuration partagée (system instruction + schema)
// ============================================================

const GEMINI_URL = "/api/gemini";

const GEMINI_SYSTEM_INSTRUCTION =
  "Tu es un expert en généalogie culturelle. Ta base de connaissances couvre le cinéma, " +
  "la littérature, les séries TV, les animés, les manga, les BD, les comics, le théâtre " +
  "et les jeux vidéo. Ta mission est de trouver des liens de parenté documentés entre les " +
  "œuvres. Priorise les influences directes (déclarées par l'auteur, référencées dans des " +
  "sources sérieuses), puis les parentés esthétiques évidentes et reconnues par les critiques. " +
  "Ne jamais inventer de liens. Exclure tout contenu adulte, pornographique ou érotique.";

// Schéma JSON strict pour les influences (utilisé partout)
const INFLUENCE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name:   { type: "string",  description: "Titre canonique de l'œuvre" },
      type:   { type: "string",  description: "cinema|serie|anime|manga|bd|comics|theatre|litterature|jeu" },
      year:   { type: "string",  description: "Année de sortie" },
      author: { type: "string",  description: "Réalisateur, auteur ou studio" },
      reason: { type: "string",  description: "Explication du lien en 1 phrase (type de connexion)" },
      weight: { type: "number",  description: "Confiance du lien : 1.0=documenté/certain, 0.7=très probable, 0.5=probable, 0.3=spéculatif" },
    },
    required: ["name", "type", "year", "reason", "weight"],
  },
};

// ============================================================
//  1. FICHIERS LOCAUX
// ============================================================

async function loadLocalData() {
  const [movies, books, games] = await Promise.all([
    fetch("data/movies.json").then(r => r.json()).catch(() => []),
    fetch("data/books.json").then(r  => r.json()).catch(() => []),
    fetch("data/games.json").then(r  => r.json()).catch(() => []),
  ]);
  const nodes = [
    ...movies.map(m => ({ ...m, type: "cinema" })),
    ...books.map(b  => ({ ...b, type: "litterature" })),
    ...games.map(g  => ({ ...g, type: "jeu" })),
  ];
  const index = {};
  for (const n of nodes) index[n.id] = n;
  return { nodes, index };
}

// ============================================================
//  2. SEARCH — OMDb / Open Library / RAWG
// ============================================================

export async function searchOMDb(query) {
  return searchTMDB(query);

  // fallback OMDb (si TMDB indisponible)
  const url = "/api/omdb?s=" + encodeURIComponent(query) + "&type=movie";
  const data = await fetch(url).then(r => r.json());
  if (data.Response === "False") return [];
  return data.Search.map(m => ({
    id: m.imdbID, name: m.Title, year: m.Year, type: "cinema", poster: m.Poster
  }));
}

async function searchTMDB(query) {
  const url = "/api/tmdb?query=" + encodeURIComponent(query) + "&language=fr-FR&include_adult=false";
  try {
    const data = await fetch(url).then(r => r.json());
    return (data.results || [])
      .filter(m => m.media_type === "movie" || m.media_type === "tv")
      .slice(0, 10)
      .map(m => ({
        id:          "tmdb-" + m.id,
        tmdbId:      m.id,
        name:        m.title || m.name,
        year:        (m.release_date || m.first_air_date || "").slice(0, 4),
        type:        "cinema",
        poster:      m.poster_path
          ? "https://image.tmdb.org/t/p/w185" + m.poster_path
          : null,
        description: (m.overview || "").slice(0, 120),
      }));
  } catch (e) {
    console.warn("[TMDB] Erreur search:", e);
    return searchOMDb(query); // fallback OMDb si TMDB échoue
  }
}

export async function searchBooks(query) {
  const data = await fetch(
    "https://openlibrary.org/search.json?q=" + encodeURIComponent(query) + "&limit=10"
  ).then(r => r.json());
  return (data.docs || []).map(b => ({
    id:          b.key.replace("/works/", ""),
    name:        b.title,
    year:        b.first_publish_year || "",
    type:        "litterature",
    author:      (b.author_name || []).slice(0, 2).join(", "),
    description: Array.isArray(b.first_sentence) ? b.first_sentence[0] : "",
    poster:      b.cover_i
      ? "https://covers.openlibrary.org/b/id/" + b.cover_i + "-M.jpg"
      : null,
  }));
}

export async function searchRAWG(query) {
  const url = "/api/rawg?search=" + encodeURIComponent(query) + "&page_size=8";
  const data = await fetch(url).then(r => r.json());
  if (!data.results?.length) return [];
  return data.results.map(g => ({
    id: "rawg-" + g.id, name: g.name,
    year: g.released?.slice(0, 4) || "", type: "jeu",
    poster: g.background_image || null,
  }));
}

// ============================================================
//  3. INFLUENCES — Gemini (priorité) → Wikidata (fallback)
//     + cache IndexedDB
// ============================================================

export async function fetchInfluences(node, dir, minResults) {
  if (minResults === undefined) minResults = 6;

  // 1. Cache
  const cached = await getInfluences(node.id, dir);
  if (cached !== null) {
    console.log("[cache]", dir, node.name, "→", cached.length, "items");
    return { items: cached, fromCache: true };
  }

  // 2. Pré-fetch Wikipedia + Wikidata en parallèle (contexte pour Gemini)
  const [wikiContext, wikidataItems] = await Promise.all([
    fetchWikipediaContext(node.name, node.year),
    dir === "up"
      ? fetchWikidataInfluences(node.name, node.year)
      : fetchWikidataInfluenced(node.name, node.year),
  ]);

  // 3. Gemini — requête 1 : influences enrichies du contexte Wikipedia
  let items = await fetchGeminiInfluences(node.name, node.year, node.type, dir, minResults, wikiContext);

  // 4. Fusionner avec les résultats Wikidata (source complémentaire)
  if (wikidataItems.length) {
    const existingNames = new Set(items.map(i => slugify(i.name)));
    const newFromWiki   = wikidataItems.filter(i => !existingNames.has(slugify(i.name)));
    items = items.concat(newFromWiki);
    if (newFromWiki.length) console.log("[wikidata] +", newFromWiki.length, "liens supplémentaires");
  }

  // 5. Fallback : si Gemini a échoué ET Wikidata a des résultats, on les utilise seuls
  if (!items.length && wikidataItems.length) {
    console.log("[fallback wikidata pur]", node.name);
    items = wikidataItems;
  }

  // 6. Gemini — requête 2 : dédoublonnage + détection d'univers en batch
  if (items.length) {
    items = await normalizeInfluences(items, node);
  }

  // 6.5. Vérification des liens faibles (weight < 0.55) — requête 3
  if (items.length) {
    items = await verifyWeakLinks(items, node);
  }

  // 7. Vérification des types via Wikidata (P31 + P495)
  if (items.length) {
    items = await verifyItemTypes(items);
  }

  // 8. Sauvegarder
  if (items.length) {
    await saveInfluences(node.id, node, dir, items);
    console.log("[saved]", dir, node.name, "→", items.length, "items");
  }

  return { items, fromCache: false };
}

// ============================================================
//  3b. NORMALISATION — Gemini requête 2
//      Dédoublonnage + détection d'univers en une seule passe
// ============================================================

async function normalizeInfluences(items, contextNode) {
  if (items.length === 0) return items;

  const list = items.map((item, i) =>
    (i + 1) + '. "' + item.name + '" (' + (item.year || "?") + ") — " + item.type
    + (item.weight !== undefined ? " [weight:" + item.weight.toFixed(1) + "]" : "")
  ).join("\n");

  const normalizeSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        name:     { type: "string" },
        type:     { type: "string" },
        year:     { type: "string" },
        author:   { type: "string" },
        reason:   { type: "string" },
        weight:   { type: "number" },
        universe: { type: "string" },
      },
      required: ["name", "type", "year", "reason", "weight"],
    },
  };

  const prompt = [
    'Ces œuvres sont liées à "' + contextNode.name + '" (' + (contextNode.year || "?") + ").",
    "",
    list,
    "",
    "Tâches :",
    "1. DOUBLONS : fusionne les œuvres identiques (même titre en langues différentes,",
    "   sous-titres différents, opus numérotés autrement). Garde le titre le plus canonique.",
    "2. UNIVERS : indique la franchise majeure (Star Wars, Marvel, etc.) ou omets le champ si standalone.",
    "3. Conserve le weight de chaque œuvre (corrige-le si tu as une meilleure information).",
    "4. reason : 1 phrase ≤12 mots expliquant le lien avec l'œuvre principale.",
  ].join("\n");

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: normalizeSchema,
        },
      }),
    });

    const data = await res.json();
    if (data.error) { console.warn("[normalize] Erreur Gemini:", data.error.message); return items; }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const arr = JSON.parse(text);
    console.log("[normalize]", contextNode.name, "→", items.length, "→", arr.length, "après dédup");

    return arr.map((item, i) => ({
      id:          "gemini-" + slugify(item.name) + "-" + i,
      name:        (item.name || "").trim(),
      type:        item.type || "cinema",
      year:        String(item.year || ""),
      author:      (item.author || "").trim(),
      description: (item.reason || "").trim(),
      weight:      typeof item.weight === "number" ? item.weight : 0.7,
      universe:    item.universe || null,
    })).filter(i => i.name.length > 0);

  } catch (e) {
    console.warn("[normalize] Erreur:", e);
    return items;
  }
}

// ============================================================
//  3c. VÉRIFICATION des liens faibles — second regard Gemini
//      Pour les connexions incertaines (weight < 0.55), confirme
//      si le lien est documenté, probable ou spéculatif.
// ============================================================

async function verifyWeakLinks(items, contextNode) {
  const borderline = items.filter(i => (i.weight ?? 0.7) < 0.55);
  if (!borderline.length) return items;

  const list = borderline.map((item, idx) =>
    (idx + 1) + '. "' + item.name + '" → "' + contextNode.name + '" : ' + (item.description || "lien incertain")
  ).join("\n");

  const verifySchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        index:   { type: "number",  description: "Numéro du lien (1-based)" },
        verdict: { type: "string",  description: "documenté|probable|spéculatif" },
      },
      required: ["index", "verdict"],
    },
  };

  const prompt = [
    'Pour chaque lien ci-dessous entre une œuvre et "' + contextNode.name + '", indique :',
    '- "documenté" : l\'auteur l\'a déclaré ou il est référencé dans des sources sérieuses',
    '- "probable" : lien esthétique évident, reconnu par les critiques',
    '- "spéculatif" : purement théorique, sans sources vérifiables',
    "",
    list,
  ].join("\n");

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseSchema: verifySchema,
        },
      }),
    });

    const data = await res.json();
    if (data.error) { console.warn("[verify] Erreur:", data.error.message); return items; }

    const verdicts = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "[]");
    const verdictMap = new Map(verdicts.map(v => [v.index, v.verdict]));

    // Appliquer les verdicts aux items borderline
    const borderlineIds = new Set(borderline.map(i => i.id));
    let bIdx = 0;
    return items
      .map(item => {
        if (!borderlineIds.has(item.id)) return item;
        bIdx++;
        const verdict = verdictMap.get(bIdx);
        if (verdict === "spéculatif") return null; // supprimé
        if (verdict === "documenté")  return { ...item, weight: Math.max(item.weight ?? 0.5, 0.7) };
        return item; // "probable" → inchangé
      })
      .filter(Boolean);

  } catch (e) {
    console.warn("[verify] Erreur:", e);
    return items;
  }
}

// ============================================================
//  4. DÉTECTION D'UNIVERS via Gemini
//     Retourne : { universe: "Star Wars" | null }
//     null = aucun univers/franchise reconnu
// ============================================================

export async function detectUniverse(node) {
  // Cache IndexedDB
  const cached = await getUniverse(node.id);
  if (cached !== undefined) {
    console.log("[cache univers]", node.name, "→", cached);
    return cached; // peut être null (= pas d'univers)
  }

  const prompt = [
    "Tu es un expert en franchises culturelles (cinéma, séries TV, animés, manga, BD, comics, théâtre, littérature, jeux vidéo).",
    "",
    'L\'oeuvre suivante appartient-elle à une franchise ou un univers étendu connu ?',
    'Titre : "' + node.name + '" (' + (node.year || "?") + ') — type : ' + node.type,
    "",
    "Règles strictes :",
    "- Réponds UNIQUEMENT si l'oeuvre fait partie d'une franchise MAJEURE et CLAIREMENT IDENTIFIABLE",
    "  (ex: Star Wars, Marvel, DC, Harry Potter, Le Seigneur des Anneaux, Dune, Dragon Ball,",
    "  Ghost in the Shell, Alien, Indiana Jones, James Bond, Zelda, Final Fantasy, etc.)",
    "- Si l'oeuvre est une oeuvre standalone sans franchise établie → réponds null",
    "- Utilise le NOM CANONIQUE de la franchise (ex: 'Star Wars' pas 'Guerre des étoiles')",
    "",
    'Réponds UNIQUEMENT avec ce JSON (rien d\'autre) :',
    '{ "universe": "Nom de la franchise" }',
    "ou",
    '{ "universe": null }',
  ].join("\n");

  const url = GEMINI_URL;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
      }),
    });

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonMatch = codeBlock ? [codeBlock[1]] : text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) { await saveUniverse(node.id, null); return null; }

    const parsed  = JSON.parse(jsonMatch[0]);
    const universe = parsed.universe || null;

    console.log("[univers]", node.name, "→", universe);
    await saveUniverse(node.id, universe);
    return universe;

  } catch (e) {
    console.warn("[univers] Erreur:", e);
    await saveUniverse(node.id, null);
    return null;
  }
}

// ============================================================
//  5. WIKIPEDIA — contexte pour enrichir Gemini
// ============================================================

async function fetchWikipediaContext(title, year) {
  // Cherche d'abord en anglais, puis en français
  for (const lang of ["en", "fr"]) {
    try {
      // Étape 1 : trouver le titre exact de la page
      const searchUrl = "https://" + lang + ".wikipedia.org/w/api.php"
        + "?action=opensearch&search=" + encodeURIComponent(title)
        + "&limit=5&format=json&origin=*";
      const searchData = await fetch(searchUrl).then(r => r.json());
      const candidates = searchData[1] || [];
      if (!candidates.length) continue;

      // Préférer le candidat dont la description contient l'année
      let pageTitle = candidates[0];
      if (year) {
        const hit = candidates.find((_, i) => (searchData[2][i] || "").includes(String(year)));
        if (hit) pageTitle = hit;
      }

      // Étape 2 : récupérer l'extrait + sections clés
      const extractUrl = "https://" + lang + ".wikipedia.org/w/api.php"
        + "?action=query&prop=extracts&exlimit=1&explaintext=true"
        + "&titles=" + encodeURIComponent(pageTitle)
        + "&format=json&origin=*";
      const extractData = await fetch(extractUrl).then(r => r.json());
      const pages = extractData.query?.pages || {};
      const page  = Object.values(pages)[0];
      if (!page?.extract || page.missing) continue;

      // Garder l'intro (500 car.) + chercher les sections influences/legacy
      const full = page.extract;
      const intro = full.slice(0, 500);

      // Extraire les passages mentionnant influences/inspirations
      const influenceRegex = /(?:influenc|inspir|based on|adapt|homm|legacy|heritage|référence)[^\n]{0,400}/gi;
      const influenceSnippets = [...full.matchAll(influenceRegex)]
        .map(m => m[0].trim())
        .slice(0, 4)
        .join(" … ");

      const context = (intro + (influenceSnippets ? "\n\nExtraits pertinents : " + influenceSnippets : ""))
        .slice(0, 1200);

      console.log("[wikipedia]", title, "→", context.length, "car. (" + lang + ")");
      return context;
    } catch (e) { /* essaie la langue suivante */ }
  }
  return null;
}

// ============================================================
//  6. GEMINI — influences
// ============================================================

function typeLabel(type) {
  const labels = {
    cinema:      "film",
    serie:       "série TV",
    anime:       "animé",
    manga:       "manga",
    bd:          "bande dessinée franco-belge",
    comics:      "comics (Marvel / DC / indépendant)",
    theatre:     "pièce de théâtre",
    litterature: "roman / livre",
    jeu:         "jeu vidéo",
  };
  return labels[type] || "œuvre culturelle";
}

async function fetchGeminiInfluences(title, year, type, dir, minResults, wikiContext) {
  if (minResults === undefined) minResults = 3;
  const maxResults = minResults + 4;

  const ctx = '"' + title + '"' + (year ? " (" + year + ")" : "") + " — " + typeLabel(type);

  const dirBlock = dir === "up"
    ? [
        "Quelles œuvres ont INFLUENCÉ " + ctx + " ?",
        "Cherche : sources citées par l'auteur/réalisateur, précédents du même genre,",
        "références philosophiques, littéraires, visuelles ou stylistiques.",
      ]
    : [
        "Quelles œuvres ont été INFLUENCÉES PAR " + ctx + " ?",
        "Cherche : œuvres citant explicitement cette influence, successeurs directs,",
        "adaptations, hommages, œuvres dans la même lignée reconnue.",
      ];

  const contextBlock = wikiContext
    ? ["", "CONTEXTE WIKIPEDIA (priorité aux connexions mentionnées ici) :", wikiContext, ""]
    : [];

  const prompt = [
    ...dirBlock,
    ...contextBlock,
    "Pour chaque œuvre, analyse le lien et précise :",
    "- Le TYPE DE CONNEXION : thématique, esthétique, narrative, philosophique ou technique",
    "- Si documenté (déclaré par l'auteur) ou esthétique (évident, reconnu par les critiques)",
    "",
    "RÈGLES :",
    "1. Entre " + minResults + " et " + maxResults + " connexions — priorise les documentées (weight ≥ 0.7).",
    "2. TITRES CANONIQUES — titre original toujours :",
    "   • Films/séries anglais → titre anglais (ex: Star Wars: Episode IV - A New Hope)",
    "   • Anime/manga → titre romanisé japonais ou titre anglais officiel",
    "   • Films français/européens → titre français original",
    "3. Types variés : films, séries, livres, mangas, jeux si pertinent.",
    "4. author : réalisateur (films), auteur (livres), studio (jeux).",
    "5. reason : 1 phrase ≤12 mots — type de connexion + pourquoi.",
    "6. weight : 1.0=documenté/certain · 0.7=très probable · 0.5=probable · 0.3=spéculatif",
  ].join("\n");

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 3000,
          responseMimeType: "application/json",
          responseSchema: INFLUENCE_SCHEMA,
        },
      }),
    });

    const data = await res.json();
    if (data.error) { console.error("[Gemini] Erreur API:", data.error.message); return []; }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) {
      console.warn("[Gemini] Réponse vide — raison:", data.candidates?.[0]?.finishReason);
      return [];
    }

    const arr = JSON.parse(text);
    console.log("[Gemini]", dir, title, "→", arr.length, "résultats");

    return arr
      .map((item, i) => ({
        id:          "gemini-" + slugify(item.name) + "-" + i,
        name:        (item.name || "").trim(),
        type:        item.type || "cinema",
        year:        String(item.year || ""),
        author:      (item.author || "").trim(),
        description: (item.reason || "").trim(),
        weight:      typeof item.weight === "number" ? item.weight : 0.7,
      }))
      .filter(i => i.name.length > 0 && i.weight >= 0.35);

  } catch (e) {
    console.error("[Gemini] Erreur:", e);
    return [];
  }
}

// ============================================================
//  6. VÉRIFICATION DE TYPE — Wikidata P31 (instance of) + P495 (pays)
// ============================================================

// P31 → type direct (sans ambiguïté de pays)
const P31_DIRECT = {
  // Anime
  'Q229390':   'anime',   // anime television series
  'Q1107':     'anime',   // anime
  'Q220898':   'anime',   // OVA
  'Q11514024': 'anime',   // anime film
  // Manga
  'Q21198342': 'manga',   // manga series
  'Q17517379': 'manga',   // manga
  'Q1184536':  'manga',   // manga magazine
  'Q2479823':  'manga',   // manga chapter
  // BD (explicitement franco-belge dans Wikidata)
  'Q2359661':  'bd',      // album de bande dessinée
  'Q14406742': 'bd',      // comic strip (franco-belge souvent)
  // Théâtre
  'Q25379':    'theatre', // pièce de théâtre
  'Q1261026':  'theatre', // œuvre théâtrale
  'Q49928':    'theatre', // comédie musicale
  'Q11635':    'theatre', // opéra
  // Jeu vidéo
  'Q7889':     'jeu',     // jeu vidéo
  'Q16070514': 'jeu',     // série de jeux vidéo
  'Q7058673':  'jeu',     // jeu vidéo de rôle
  // Roman / Livre
  'Q7725310':  'litterature', // œuvre littéraire
  'Q571':      'litterature', // livre
  'Q8261':     'litterature', // roman
  'Q49084':    'litterature', // nouvelle
  'Q47461344': 'litterature', // œuvre écrite
  'Q386724':   'litterature', // œuvre
  // Film
  'Q11424':    'cinema',  // film
  'Q24862':    'cinema',  // court-métrage
  'Q506240':   'cinema',  // film documentaire
  // Série TV
  'Q5398426':  'serie',   // série télévisée
  'Q63952888': 'serie',   // mini-série
  'Q15416':    'serie',   // émission de télévision
  'Q21191270': 'serie',   // épisode pilote
};

// P31 ambigus : résolution par pays (P495)
// '_anim_film' → anime si Japon, sinon cinema
// '_comic'     → bd si France/Belgique/Suisse, sinon comics
// '_tv_anim'   → anime si Japon, sinon serie
const P31_AMBIGUOUS = {
  'Q202866':   '_anim_film',  // film d'animation
  'Q1004':     '_comic',      // comic book
  'Q104213':   '_comic',      // roman graphique
  'Q2289657':  '_tv_anim',    // série d'animation
  'Q336141':   '_tv_anim',    // série animée
  'Q1322839':  '_tv_anim',    // anime (autre QID)
};

const JAPAN_QID      = 'Q17';
const BD_COUNTRY_QIDS = new Set(['Q142', 'Q31', 'Q39']); // France, Belgique, Suisse

async function verifyItemTypes(items) {
  if (!items.length) return items;

  // Étape 1 : lookups QID en parallèle (allSettled = tolérant aux erreurs)
  const qidResults = await Promise.allSettled(
    items.map(item => wikidataQID(item.name, item.year))
  );
  const qids = qidResults.map(r => r.status === 'fulfilled' ? r.value : null);

  const validPairs = qids
    .map((qid, i) => ({ qid, idx: i }))
    .filter(p => p.qid);

  if (!validPairs.length) return items;

  // Étape 2 : une seule requête SPARQL batch P31 + P495
  const values = validPairs.map(p => 'wd:' + p.qid).join(' ');
  const sparql  = 'SELECT ?item ?p31 ?country WHERE {'
    + ' VALUES ?item { ' + values + ' }'
    + ' ?item wdt:P31 ?p31 .'
    + ' OPTIONAL { ?item wdt:P495 ?country . }'
    + ' }';

  try {
    const url  = 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql) + '&format=json';
    const res  = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    const rows = json.results?.bindings || [];

    // Regrouper par QID
    const byQid = {};
    for (const row of rows) {
      const qid = row.item.value.split('/').pop();
      if (!byQid[qid]) byQid[qid] = { p31s: new Set(), countries: new Set() };
      byQid[qid].p31s.add(row.p31.value.split('/').pop());
      if (row.country) byQid[qid].countries.add(row.country.value.split('/').pop());
    }

    // Résoudre le type pour chaque item
    return items.map((item, i) => {
      const qid = qids[i];
      if (!qid || !byQid[qid]) return item;

      const { p31s, countries } = byQid[qid];
      const isJapanese = countries.has(JAPAN_QID);
      const isBD       = [...countries].some(c => BD_COUNTRY_QIDS.has(c));

      let resolved = null;

      // 1. Types directs (pas d'ambiguïté)
      for (const p31 of p31s) {
        if (P31_DIRECT[p31]) { resolved = P31_DIRECT[p31]; break; }
      }

      // 2. Types ambigus résolus par pays
      if (!resolved) {
        for (const p31 of p31s) {
          const amb = P31_AMBIGUOUS[p31];
          if (!amb) continue;
          if (amb === '_anim_film') { resolved = isJapanese ? 'anime' : 'cinema'; break; }
          if (amb === '_comic')     { resolved = isBD       ? 'bd'    : 'comics'; break; }
          if (amb === '_tv_anim')   { resolved = isJapanese ? 'anime' : 'serie';  break; }
        }
      }

      // 3. Série TV japonaise → anime
      if (!resolved) {
        const isTVSeries = [...p31s].some(p => ['Q5398426','Q63952888','Q15416'].includes(p));
        if (isTVSeries) resolved = isJapanese ? 'anime' : 'serie';
      }

      if (resolved && resolved !== item.type) {
        console.log('[typeVerify]', item.name, ':', item.type, '→', resolved);
        return { ...item, type: resolved };
      }
      return item;
    });

  } catch (e) {
    console.warn('[typeVerify] SPARQL erreur — types inchangés:', e.message);
    return items;
  }
}

// ============================================================
//  7. WIKIDATA — influences
// ============================================================

async function fetchWikidataInfluences(title, year) {
  const qid = await wikidataQID(title, year);
  if (!qid) return [];
  // P737 influencé par | P144 basé sur | P941 inspiré par
  // P840 lieu narratif (livre/film basé sur un autre) | P1269 facette de
  // P155 fait suite à | P8371 références à l'œuvre
  const sparql
    = "SELECT DISTINCT ?item ?itemLabel ?itemDescription ?date WHERE {"
    + " { wd:" + qid + " wdt:P737 ?item . }"
    + " UNION { wd:" + qid + " wdt:P144 ?item . }"
    + " UNION { wd:" + qid + " wdt:P941 ?item . }"
    + " UNION { wd:" + qid + " wdt:P155 ?item . }"
    + " UNION { wd:" + qid + " wdt:P8371 ?item . }"
    + " UNION { wd:" + qid + " wdt:P1269 ?item . }"
    + " ?item wdt:P31 ?type ."
    + " VALUES ?type { wd:Q11424 wd:Q2431196 wd:Q7725310 wd:Q571 wd:Q7889"
    + "   wd:Q1004 wd:Q11032 wd:Q5398426 wd:Q229390 wd:Q2297927 }"
    + " OPTIONAL { ?item wdt:P577 ?date . }"
    + ' SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }'
    + " } LIMIT 40";
  return sparqlToItems(sparql, "wikidata-up " + title);
}

async function fetchWikidataInfluenced(title, year) {
  const qid = await wikidataQID(title, year);
  if (!qid) return [];
  // Relations inverses + P4969 œuvre dérivée + P156 suivi par + P179 partie de série
  const sparql
    = "SELECT DISTINCT ?item ?itemLabel ?itemDescription ?date WHERE {"
    + " { ?item wdt:P737 wd:" + qid + " . }"
    + " UNION { ?item wdt:P144 wd:" + qid + " . }"
    + " UNION { ?item wdt:P941 wd:" + qid + " . }"
    + " UNION { wd:" + qid + " wdt:P4969 ?item . }"
    + " UNION { wd:" + qid + " wdt:P156 ?item . }"
    + " UNION { ?item wdt:P8371 wd:" + qid + " . }"
    + " ?item wdt:P31 ?type ."
    + " VALUES ?type { wd:Q11424 wd:Q2431196 wd:Q7725310 wd:Q571 wd:Q7889"
    + "   wd:Q1004 wd:Q11032 wd:Q5398426 wd:Q229390 wd:Q2297927 }"
    + " OPTIONAL { ?item wdt:P577 ?date . }"
    + ' SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }'
    + " } LIMIT 40";
  return sparqlToItems(sparql, "wikidata-down " + title);
}

async function sparqlToItems(sparql, label) {
  const url = "https://query.wikidata.org/sparql?query="
    + encodeURIComponent(sparql) + "&format=json";
  try {
    const res  = await fetch(url, { headers: { Accept: "application/json" } });
    const json = await res.json();
    const rows = json.results?.bindings || [];
    console.log("[wikidata]", label, "→", rows.length);
    return rows
      .map(b => ({
        id:          b.item.value.split("/").pop(),
        name:        b.itemLabel?.value || "?",
        type:        guessType(b.itemDescription?.value || ""),
        year:        b.date?.value?.slice(0, 4) || "",
        description: b.itemDescription?.value || "",
        weight:      0.75,  // Wikidata = lien vérifié, confiance élevée
      }))
      .filter(n => n.name !== "?" && !/^Q\d+$/.test(n.name));
  } catch (e) {
    console.warn("[wikidata] SPARQL erreur:", e);
    return [];
  }
}

async function wikidataQID(title, year) {
  const mediaKeywords = [
    "manga","anime","film","movie","novel","book","video game","comic",
    "series","television","animated","jeu","roman","bande dessinée",
  ];

  function pickBest(results) {
    if (!results?.length) return null;
    if (year) {
      const hit = results.find(e => e.description?.includes(String(year)));
      if (hit) return hit.id;
    }
    const hit = results.find(e => {
      const d = (e.description || "").toLowerCase();
      return mediaKeywords.some(k => d.includes(k));
    });
    return hit ? hit.id : results[0].id;
  }

  // Cherche d'abord en anglais, puis en français si pas de résultat
  for (const lang of ["en", "fr"]) {
    try {
      const url = "https://www.wikidata.org/w/api.php"
        + "?action=wbsearchentities"
        + "&search=" + encodeURIComponent(title)
        + "&language=" + lang + "&format=json&origin=*&limit=12";
      const data = await fetch(url).then(r => r.json());
      const qid = pickBest(data.search);
      if (qid) return qid;
    } catch (e) { /* continue */ }
  }
  return null;
}

function guessType(d) {
  d = d.toLowerCase();
  if (d.includes("video game") || d.includes("jeu vid") || d.includes("game"))           return "jeu";
  if (d.includes("manga") || d.includes("manhwa") || d.includes("manhua"))               return "manga";
  if (d.includes("anime") || d.includes("animated series") || d.includes("animation"))   return "anime";
  if (d.includes("comic") || d.includes("graphic novel") || d.includes("superhero"))     return "comics";
  if (d.includes("bande dessinée") || d.includes("bd ") || d.includes("franco"))         return "bd";
  if (d.includes("play") || d.includes("theatre") || d.includes("théâtre")
    || d.includes("stage") || d.includes("musical"))                                      return "theatre";
  if (d.includes("television series") || d.includes("tv series") || d.includes("série")
    || d.includes("sitcom") || d.includes("miniseries"))                                  return "serie";
  if (d.includes("novel") || d.includes("book") || d.includes("roman")
    || d.includes("light novel") || d.includes("short story"))                           return "litterature";
  return "cinema";
}

function slugify(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ============================================================
//  7. INDEX LOCAL
// ============================================================
//  8. DÉCOUVERTE APPROFONDIE — "Trouve-moi autre chose"
//     Appelé quand un nœud a déjà été exploré.
//     Envoie la liste des œuvres déjà présentes et demande
//     des connexions inédites, inattendues ou indirectes.
// ============================================================

export async function fetchMoreInfluences(node, existingNames) {
  const wikiContext = await fetchWikipediaContext(node.name, node.year);

  const excluded = existingNames.slice(0, 30);
  const excludeBlock = excluded.length
    ? ['', 'Ces œuvres sont DÉJÀ présentes, ne les retourne PAS :', '"' + excluded.join('", "') + '"', '']
    : [];

  const contextBlock = wikiContext
    ? ['', 'CONTEXTE WIKIPEDIA :', wikiContext, '']
    : [];

  const ctx = '"' + node.name + '" (' + (node.year || '?') + ') — ' + typeLabel(node.type);

  const angles = [
    {
      label: 'indirect',
      prompt: [
        'Quelles œuvres MOINS CONNUES ont inspiré ' + ctx + ' ?',
        ...excludeBlock,
        ...contextBlock,
        'Cherche : influences philosophiques/visuelles citées par l\'auteur, précédents de niche,',
        'références culturelles indirectes, connexions thématiques profondes non évidentes.',
        '',
        'Pour chaque œuvre : reason = 1 phrase ≤12 mots. weight = confiance du lien.',
        '1=documenté · 0.7=très probable · 0.5=probable · 0.3=spéculatif.',
        'Entre 5 et 10 résultats DIFFÉRENTS des œuvres exclues.',
      ].join('\n'),
    },
    {
      label: 'thematique',
      prompt: [
        'Quelles œuvres partagent les mêmes THÈMES, ESTHÉTIQUE ou MOUVEMENT ARTISTIQUE que ' + ctx + ' ?',
        ...excludeBlock,
        ...contextBlock,
        'Cherche : même courant culturel, même ambiance reconnue par les critiques,',
        'même période historique, mêmes sujets de fond (société, philosophie, identité…).',
        '',
        'Pour chaque œuvre : reason = 1 phrase ≤12 mots. weight = confiance du lien.',
        'Entre 5 et 10 résultats DIFFÉRENTS des œuvres exclues.',
      ].join('\n'),
    },
    {
      label: 'fondateurs',
      prompt: [
        'Quelles sont les ŒUVRES FONDATRICES du genre ou de l\'époque de ' + ctx + ' ?',
        ...excludeBlock,
        ...contextBlock,
        'Cherche : œuvres qui ont défini le genre, classiques de la même période,',
        'précurseurs qui ont rendu possible ce type d\'œuvre, canons reconnus par les historiens.',
        '',
        'Pour chaque œuvre : reason = 1 phrase ≤12 mots. weight = confiance du lien.',
        'Entre 5 et 10 résultats DIFFÉRENTS des œuvres exclues.',
      ].join('\n'),
    },
  ];

  const existingSet = new Set(existingNames.map(n => slugify(n)));
  let results = [];

  for (const angle of angles) {
    if (results.length >= 3) break;

    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
          contents: [{ parts: [{ text: angle.prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 2000,
            responseMimeType: "application/json",
            responseSchema: INFLUENCE_SCHEMA,
          },
        }),
      });
      const data = await res.json();
      if (data.error) { console.warn('[fetchMore/' + angle.label + '] Erreur:', data.error.message); continue; }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) { console.warn('[fetchMore/' + angle.label + '] Réponse vide'); continue; }

      const arr = JSON.parse(text);
      const newItems = arr
        .map((item, i) => ({
          id:          'more-' + slugify(item.name) + '-' + i,
          name:        (item.name || '').trim(),
          type:        item.type || 'cinema',
          year:        String(item.year || ''),
          author:      (item.author || '').trim(),
          description: (item.reason || '').trim(),
          weight:      typeof item.weight === 'number' ? item.weight : 0.6,
        }))
        .filter(item => item.name.length > 0
          && item.weight >= 0.35
          && !existingSet.has(slugify(item.name)));

      console.log('[fetchMore/' + angle.label + ']', node.name, '→', newItems.length, 'nouvelles influences');
      results = newItems;

    } catch (e) {
      console.error('[fetchMore/' + angle.label + '] Erreur:', e);
    }
  }

  if (!results.length) return [];
  return await verifyItemTypes(results);
}

// ============================================================

let _localIndex = {};

export async function initLocalData() {
  const { index } = await loadLocalData();
  _localIndex = index;
  return index;
}

export function getLocalNode(id) { return _localIndex[id] || null; }
