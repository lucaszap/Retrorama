// ============================================================
//  script.js — Graphe d'influences Retrorama
//  Nœuds univers : gros nœud franchise, clic pour éclater/réduire
//  Influences : survol → toggle ↑ Amont / ↓ Aval
// ============================================================

import {
  searchOMDb, searchBooks, searchRAWG,
  fetchInfluences, fetchMoreInfluences, detectUniverse,
  initLocalData
} from "./data.js";
import { dbStats, exportJSON } from "./db.js";

// ============================================================
//  ÉTAT GLOBAL
// ============================================================

let graphData   = { nodes: [], links: [] };
let activeTypes = new Set(["cinema", "serie", "anime", "manga", "bd", "comics", "theatre", "litterature", "jeu"]);
let simulation  = null;

const expandedUp   = new Set();
const expandedDown = new Set();
const expanding    = new Set();

// Univers : Map nom→id, Set des ids univers éclatés
const universeNodes   = new Map(); // "Star Wars" → "univ-star-wars"
const expandedUnivs   = new Set(); // ids univers actuellement éclatés

// Suivi position tap (détection tap vs drag sur mobile)
let touchStartX = 0, touchStartY = 0;

// Détection clic simple vs double-clic
let _clickTimer   = null;
let _clickPending = null;
let _lastTapId    = null;
let _lastTapTime  = 0;

// ============================================================
//  COULEURS & GÉOMÉTRIE
// ============================================================

const COLOR = {
  cinema:      "#d4291a",
  serie:       "#e8741a",
  anime:       "#e040c0",
  manga:       "#9b59b6",
  bd:          "#3498db",
  comics:      "#1abc9c",
  theatre:     "#f39c12",
  litterature: "#4a90c4",
  jeu:         "#5aab72",
  universe:    "#1a1a4a",
  default:     "#888078",
};

// Palette de couleurs d'accent pour les univers (cyclique)
const UNIV_ACCENTS = [
  "#c9a84c", "#e05a2b", "#7ac97a", "#4a90c4",
  "#b06fc0", "#c0826f", "#6fc0b0", "#c06f8f",
];
const univAccentMap = new Map(); // nom univers → couleur accent
let univAccentIdx = 0;

function univAccent(name) {
  if (!univAccentMap.has(name)) {
    univAccentMap.set(name, UNIV_ACCENTS[univAccentIdx % UNIV_ACCENTS.length]);
    univAccentIdx++;
  }
  return univAccentMap.get(name);
}

function nodeRadius(d) {
  if (d.nodeType === "universe") return 28;
  if (d.depth === 0)             return 14;
  if (Math.abs(d.depth) === 1)   return 9;
  return 6;
}

function colorStroke(type) {
  return {
    cinema:      "#8a1c10",
    serie:       "#9a4a0a",
    anime:       "#902090",
    manga:       "#6a3090",
    bd:          "#1a6090",
    comics:      "#0a7060",
    theatre:     "#a06000",
    litterature: "#2a5a80",
    jeu:         "#3a7050",
  }[type] || "#3a3632";
}

function truncate(str, max) {
  return str && str.length > max ? str.slice(0, max) + "…" : (str || "");
}

function slugify(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Correspondances de titres français ↔ anglais pour la déduplication
const FR_EN_ALIASES = {
  "laguerre des etoiles":          "starwarsepisodeiv",
  "laguerredes etoiles":           "starwarsepisodeiv",
  "laguerre des toiles":           "starwarsepisodeiv",
  "le seigneur des anneaux":       "the lord of the rings",
  "les temps modernes":            "modern times",
  "le cuirassé potemkine":         "battleship potemkin",
  "la liste de schindler":         "schindlers list",
  "le voyage dans la lune":        "a trip to the moon",
  "nosferatu le vampire":          "nosferatu",
  "le cabinet du docteur caligari":"the cabinet of dr caligari",
  "metropolis":                    "metropolis",
};

function normalizeTitle(name) {
  const clean = (name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // retire les accents
    .replace(/^the\s+/i, "")
    .replace(/^le\s+|^la\s+|^les\s+|^l['']\s*/i, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  return FR_EN_ALIASES[clean] || clean;
}

function findDuplicateNode(inf) {
  const normIncoming = normalizeTitle(inf.name);
  if (!normIncoming) return null;
  return graphData.nodes.find(existing => {
    if (existing.nodeType === "universe") return false;
    if (normalizeTitle(existing.name) !== normIncoming) return false;
    if (inf.year && existing.year) {
      if (Math.abs(parseInt(inf.year) - parseInt(existing.year)) > 1) return false;
    }
    return true;
  });
}

// ============================================================
//  ÉLÉMENTS DOM
// ============================================================

const svgEl        = document.getElementById("graph-svg");
const loader       = document.getElementById("loader");
const loaderMsg    = document.getElementById("loader-msg");
const statusMsg    = document.getElementById("status-msg");
const statusN      = document.getElementById("status-nodes");
const statusL      = document.getElementById("status-links");
const searchEl     = document.getElementById("search");
const searchRes    = document.getElementById("search-results");
const DEPTH_DEFAULT = 2;
const welcomeEl    = document.getElementById("welcome");

// Info panel (clic nœud)
const infoPanelEl  = document.getElementById("info-panel");
const ipType       = document.getElementById("ip-type");
const ipTitle      = document.getElementById("ip-title");
const ipYear       = document.getElementById("ip-year");
const ipDesc       = document.getElementById("ip-desc");
const ipPoster     = document.getElementById("ip-poster");


// ============================================================
//  SVG + ZOOM + MARKERS
// ============================================================

const svg = d3.select(svgEl);
const defs = svg.append("defs");

defs.append("marker").attr("id","arrow-up")
  .attr("viewBox","0 0 10 10").attr("refX",10).attr("refY",5)
  .attr("markerWidth",5).attr("markerHeight",5).attr("orient","auto-start-reverse")
  .append("path").attr("d","M0,0 L10,5 L0,10 z").attr("fill","rgba(201,168,76,.7)");

defs.append("marker").attr("id","arrow-down")
  .attr("viewBox","0 0 10 10").attr("refX",10).attr("refY",5)
  .attr("markerWidth",5).attr("markerHeight",5).attr("orient","auto-start-reverse")
  .append("path").attr("d","M0,0 L10,5 L0,10 z").attr("fill","rgba(106,168,212,.7)");

const zoomLayer = svg.append("g").attr("id","zoom-layer");
const zoom = d3.zoom().scaleExtent([0.05, 6])
  .on("zoom", e => zoomLayer.attr("transform", e.transform));
svg.call(zoom);

// ── Ajustement dynamique selon hauteur réelle du header (mobile) ──
function adjustLayout() {
  const hh     = document.getElementById('header').offsetHeight;
  const panelH = infoPanelEl.classList.contains('open') ? infoPanelEl.scrollHeight : 0;
  const bot    = 28 + panelH;
  const svgH   = window.innerHeight - hh - bot;

  svgEl.style.top    = hh + 'px';
  svgEl.style.left   = '0';
  svgEl.style.width  = window.innerWidth + 'px';
  svgEl.style.height = svgH + 'px';
  svgEl.style.bottom = '';

  welcomeEl.style.top    = hh + 'px';
  welcomeEl.style.bottom = bot + 'px';
  welcomeEl.style.height = '';
  loader.style.top = (hh + 8) + 'px';
}
const _ro = new ResizeObserver(adjustLayout);
_ro.observe(document.getElementById('header'));
_ro.observe(infoPanelEl);
window.addEventListener('resize', adjustLayout);
adjustLayout();

// ── Fit automatique du graphe dans le viewport ──────────────
function fitGraph(animated) {
  const nodes = graphData.nodes.filter(n => n.x !== undefined && !n.hiddenByUniverse);
  if (!nodes.length) return;
  const w = svgEl.clientWidth, h = svgEl.clientHeight;
  if (!w || !h) return;
  const pad = 70;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const r = nodeRadius(n) + 18;
    x0 = Math.min(x0, n.x - r); x1 = Math.max(x1, n.x + r);
    y0 = Math.min(y0, n.y - r); y1 = Math.max(y1, n.y + r);
  }
  const bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
  const k  = Math.min(w / bw, h / bh, 2.5);
  const tx = w / 2 - k * (x0 + x1) / 2;
  const ty = h / 2 - k * (y0 + y1) / 2;
  const t  = d3.zoomIdentity.translate(tx, ty).scale(k);
  if (animated) svg.transition().duration(700).ease(d3.easeCubicInOut).call(zoom.transform, t);
  else          svg.call(zoom.transform, t);
}

// Calques : halos univers → liens → nœuds
const gHalos = zoomLayer.append("g").attr("id","g-halos");
const gLinks = zoomLayer.append("g").attr("id","g-links");
const gNodes = zoomLayer.append("g").attr("id","g-nodes");

// ============================================================
//  DRAG
// ============================================================

function dragBehavior() {
  return d3.drag()
    .on("start", (e,d) => { if (!e.active) simulation?.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on("drag",  (e,d) => {
      const t = d3.zoomTransform(svgEl);
      const r = nodeRadius(d) + 4;
      const [lx0, ly0] = t.invert([r, r]);
      const [lx1, ly1] = t.invert([svgEl.clientWidth - r, svgEl.clientHeight - r]);
      d.fx = Math.max(lx0, Math.min(lx1, e.x));
      d.fy = Math.max(ly0, Math.min(ly1, e.y));
    })
    .on("end",   (e,d) => { if (!e.active) simulation?.alphaTarget(0); d.fx=null; d.fy=null; });
}

// ============================================================
//  TOOLTIP
// ============================================================

const TYPE_LABEL = {
  cinema:      "Film",
  serie:       "Série TV",
  anime:       "Animé",
  manga:       "Manga",
  bd:          "Bande dessinée",
  comics:      "Comics",
  theatre:     "Théâtre",
  litterature: "Roman",
  jeu:         "Jeu vidéo",
  universe:    "Univers",
};
const TYPE_COLOR = {
  cinema:      "var(--cinema)",
  serie:       "var(--serie)",
  anime:       "var(--anime)",
  manga:       "var(--manga)",
  bd:          "var(--bd)",
  comics:      "var(--comics)",
  theatre:     "var(--theatre)",
  litterature: "var(--lit)",
  jeu:         "var(--jeu)",
  universe:    "var(--gold)",
};


function showInfoPanel(d) {
  if (d.nodeType === "universe") {
    ipType.textContent  = "Univers / Franchise";
    ipType.style.color  = univAccent(d.name);
    ipTitle.textContent = d.name;
    ipYear.textContent  = d.memberCount + " œuvre" + (d.memberCount > 1 ? "s" : "");
    ipDesc.textContent  = expandedUnivs.has(d.id) ? "Cliquer pour réduire" : "Voir les œuvres de cet univers";
    ipPoster.classList.remove("has-poster");
  } else {
    ipType.textContent  = TYPE_LABEL[d.type] || d.type;
    ipType.style.color  = TYPE_COLOR[d.type] || "var(--red)";
    ipTitle.textContent  = d.name;
    ipYear.textContent   = d.year || "";
    const ipAuthorEl = document.getElementById("ip-author");
    if (ipAuthorEl) ipAuthorEl.textContent = d.author ? "✦ " + d.author : "";
    ipDesc.textContent   = d.description ? truncate(d.description, 220) : "";
    if (d.poster && d.poster !== "N/A") { ipPoster.src = d.poster; ipPoster.classList.add("has-poster"); }
    else ipPoster.classList.remove("has-poster");
  }
  infoPanelEl.classList.add("open");
  adjustLayout();
  setTimeout(() => fitGraph(true), 320);
}
function hideInfoPanel() {
  infoPanelEl.classList.remove("open");
  adjustLayout();
  setTimeout(() => fitGraph(true), 320);
}

function nodeScreenPos(d) {
  const t = d3.zoomTransform(svgEl);
  return { x: t.applyX(d.x), y: t.applyY(d.y) };
}

// ============================================================
//  GESTION DES NŒUDS UNIVERS
// ============================================================

function universeNodeId(name) {
  return "univ-" + slugify(name);
}

// Crée ou met à jour le nœud univers dans graphData
function upsertUniverseNode(universeName) {
  const uid = universeNodeId(universeName);

  // Compter les membres
  const members = graphData.nodes.filter(
    n => n.nodeType !== "universe" && n.universeId === uid
  );

  if (!universeNodes.has(universeName)) {
    // Créer le nœud univers — ouvert par défaut
    universeNodes.set(universeName, uid);
    expandedUnivs.add(uid);
    graphData.nodes.push({
      id:          uid,
      nodeType:    "universe",
      name:        universeName,
      type:        "universe",
      memberCount: members.length,
      depth:       0,
    });
  } else {
    // Mettre à jour memberCount
    const un = graphData.nodes.find(n => n.id === uid);
    if (un) un.memberCount = members.length;
  }

  return uid;
}

// Après avoir détecté l'univers d'un nœud, l'assigner
function assignNodeToUniverse(nodeId, universeName) {
  if (!universeName) return;
  const n = graphData.nodes.find(n => n.id === nodeId);
  if (!n || n.nodeType === "universe") return;

  const uid = universeNodeId(universeName);
  n.universeId       = uid;
  n.universeName     = universeName;
  n.hiddenByUniverse = false; // visible par défaut (l'univers est ouvert)

  upsertUniverseNode(universeName);
}

// Clic sur un nœud univers → éclater ou réduire
function toggleUniverse(univNode) {
  const uid = univNode.id;

  if (expandedUnivs.has(uid)) {
    // ── RÉDUIRE : masquer les membres, les ramener sur le hub
    expandedUnivs.delete(uid);
    graphData.nodes.forEach(n => {
      if (n.universeId === uid) {
        n.hiddenByUniverse = true;
        // Ancrer temporairement au hub pour éviter qu'ils s'éparpillent
        if (univNode.x !== undefined) { n.fx = univNode.x; n.fy = univNode.y; }
      }
    });
  } else {
    // ── ÉCLATER : afficher les membres, les disposer autour du hub
    expandedUnivs.add(uid);
    const members = graphData.nodes.filter(n => n.universeId === uid);
    members.forEach((n, i) => {
      n.hiddenByUniverse = false;
      n.fx = null; n.fy = null;
      if (univNode.x !== undefined) {
        const angle = (2 * Math.PI * i) / Math.max(members.length, 1);
        const dist  = 70 + members.length * 8;
        n.x = univNode.x + Math.cos(angle) * dist;
        n.y = univNode.y + Math.sin(angle) * dist;
        n.vx = 0; n.vy = 0;
      }
    });
  }

  // Mettre à jour le compteur (membres totaux, visibles ou non)
  const un = graphData.nodes.find(n => n.id === uid);
  if (un) un.memberCount = graphData.nodes.filter(n => n.universeId === uid).length;

  redraw();
  setTimeout(() => fitGraph(true), 350);
}

// ============================================================
//  DESSIN DU GRAPHE
// ============================================================

function redraw() {
  // Filtrer les nœuds : actifs par type + pas cachés par univers réduit
  const visibleNodes = graphData.nodes.filter(n => {
    if (n.nodeType === "universe") return true; // toujours visible
    if (n.hiddenByUniverse) return false;
    return activeTypes.has(n.type);
  });
  const visibleIds = new Set(visibleNodes.map(n => n.id));

  const visibleLinks = graphData.links.filter(l => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    return visibleIds.has(s) && visibleIds.has(t);
  });

  // Liens internes univers (nœud ↔ son univers) — toujours affichés si les deux sont visibles
  const univLinks = [];
  visibleNodes.forEach(n => {
    if (n.nodeType !== "universe" && n.universeId && visibleIds.has(n.universeId) && !n.hiddenByUniverse) {
      univLinks.push({ source: n.id, target: n.universeId, dir: "univ" });
    }
  });

  const allLinks = [...visibleLinks, ...univLinks];

  statusN.textContent = visibleNodes.filter(n => n.nodeType !== "universe").length + " nœuds";
  statusL.textContent = visibleLinks.length + " liens";

  // ── HALOS UNIVERS (cercles translucides derrière) ────────
  const univVisible = visibleNodes.filter(n => n.nodeType === "universe");

  gHalos.selectAll("circle.halo-univ")
    .data(univVisible, d => d.id)
    .join(
      enter => enter.append("circle").attr("class","halo-univ")
        .attr("r", 0)
        .attr("fill", d => univAccent(d.name))
        .attr("fill-opacity", 0.04)
        .attr("stroke", d => univAccent(d.name))
        .attr("stroke-opacity", 0.15)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "6 4")
        .call(el => el.transition().duration(600).attr("r", d => {
          const memberCount = graphData.nodes.filter(n => n.universeId === d.id && !n.hiddenByUniverse).length;
          return Math.max(60, memberCount * 35);
        })),
      update => update.call(el => el.transition().duration(300).attr("r", d => {
        const memberCount = graphData.nodes.filter(n => n.universeId === d.id && !n.hiddenByUniverse).length;
        return Math.max(60, memberCount * 35);
      })),
      exit => exit.transition().duration(300).attr("r", 0).remove()
    );

  // ── LIENS ────────────────────────────────────────────────
  const link = gLinks.selectAll("line")
    .data(allLinks, d => {
      const s = d.source?.id ?? d.source;
      const t = d.target?.id ?? d.target;
      return s + "->" + t + "-" + (d.dir || "up");
    })
    .join(
      enter => enter.append("line")
        .attr("class", d => d.dir === "univ" ? "link-universe" : "link-" + (d.dir === "down" ? "downstream" : "upstream"))
        .attr("stroke-width", d => d.dir === "univ" ? 1 : Math.max(0.6, (d.weight ?? 0.7) * 2))
        .attr("stroke-dasharray", d => d.dir === "univ" ? "4 4" : null)
        .attr("marker-end", d => {
          if (d.dir === "univ")  return null;
          if (d.dir === "down")  return "url(#arrow-down)";
          return "url(#arrow-up)";
        })
        .attr("opacity", 0)
        .call(el => el.transition().duration(400).attr("opacity", 1)),
      update => update,
      exit  => exit.transition().duration(200).attr("opacity",0).remove()
    );

  // ── NŒUDS ────────────────────────────────────────────────
  const node = gNodes.selectAll("g.node")
    .data(visibleNodes, d => d.id)
    .join(
      enter => {
        const g = enter.append("g").attr("class","node").attr("opacity",0);

        // ── Nœud UNIVERS ──────────────────────────────────
        g.filter(d => d.nodeType === "universe").call(gu => {

          // Halo pulsant
          gu.append("circle").attr("class","univ-pulse")
            .attr("r", d => nodeRadius(d) + 8)
            .attr("fill","none")
            .attr("stroke", d => univAccent(d.name))
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "4 3")
            .attr("opacity", 0.5)
            .call(pulse);

          // Cercle principal
          gu.append("circle").attr("class","main")
            .attr("r", d => nodeRadius(d))
            .attr("fill", COLOR.universe)
            .attr("stroke", d => univAccent(d.name))
            .attr("stroke-width", 2.5);

          // Icône "⬡" ou initiale au centre
          gu.append("text").attr("class","univ-icon")
            .attr("x",0).attr("y", 5)
            .attr("text-anchor","middle")
            .attr("fill", d => univAccent(d.name))
            .attr("font-size","14px")
            .attr("font-family","'Barlow Condensed', sans-serif")
            .attr("font-weight","700")
            .attr("letter-spacing","1px")
            .text(d => d.name.slice(0,2).toUpperCase());

          // Label en dessous
          gu.append("text").attr("class","label")
            .attr("x",0).attr("y", d => nodeRadius(d) + 16)
            .attr("text-anchor","middle")
            .attr("fill", d => univAccent(d.name))
            .attr("font-family","'Playfair Display', serif")
            .attr("font-size","11px")
            .attr("font-style","italic")
            .attr("paint-order","stroke")
            .attr("stroke","#0c0c0c").attr("stroke-width","3px")
            .text(d => d.name);

          // Badge nombre de membres
          gu.append("text").attr("class","univ-count")
            .attr("x",0).attr("y", d => -nodeRadius(d) - 6)
            .attr("text-anchor","middle")
            .attr("fill","#888")
            .attr("font-family","'Barlow Condensed', sans-serif")
            .attr("font-size","9px")
            .attr("letter-spacing","1px")
            .text(d => d.memberCount + " œuvre" + (d.memberCount > 1 ? "s" : ""));
        });

        // ── Nœud NORMAL ───────────────────────────────────
        g.filter(d => d.nodeType !== "universe").call(gn => {

          // Anneau univers coloré si le nœud appartient à un univers
          gn.append("circle").attr("class","ring-univ")
            .attr("r", d => nodeRadius(d) + 5)
            .attr("fill","none")
            .attr("stroke", d => d.universeName ? univAccent(d.universeName) : "transparent")
            .attr("stroke-width", 2)
            .attr("opacity", d => d.universeName ? 0.7 : 0);

          // Anneau cliquable standard
          gn.append("circle").attr("class","ring")
            .attr("r", d => nodeRadius(d) + 4)
            .attr("fill","none")
            .attr("stroke","#c9a84c").attr("stroke-width",1)
            .attr("stroke-dasharray","3 3")
            .attr("opacity", d => (expandedUp.has(d.id) && expandedDown.has(d.id)) ? 0 : 0.35);

          // Cercle principal
          gn.append("circle").attr("class","main")
            .attr("r", d => nodeRadius(d))
            .attr("fill", d => COLOR[d.type] || COLOR.default)
            .attr("stroke", d => d.depth === 0 ? "#c9a84c" : colorStroke(d.type))
            .attr("stroke-width", d => d.depth === 0 ? 2 : 1);

          // Spinner
          gn.append("circle").attr("class","spinner-ring")
            .attr("r", d => nodeRadius(d) + 7)
            .attr("fill","none").attr("stroke","#c9a84c")
            .attr("stroke-width",1.5).attr("stroke-dasharray","20 40").attr("opacity",0);

          // Label
          gn.append("text").attr("class","label")
            .attr("x",0).attr("y", d => nodeRadius(d) + 12)
            .attr("text-anchor","middle")
            .attr("fill","#b0a898")
            .attr("font-family","'Barlow Condensed', sans-serif")
            .attr("font-size", d => d.depth === 0 ? "11px" : "9px")
            .attr("paint-order","stroke")
            .attr("stroke","#0c0c0c").attr("stroke-width","3px").attr("stroke-linejoin","round")
            .text(d => truncate(d.name, d.depth === 0 ? 26 : 20));
        });

        g.call(el => el.transition().duration(400).attr("opacity",1));
        return g;
      },

      update => {
        // Mettre à jour le compteur sur les univers
        update.filter(d => d.nodeType === "universe")
          .select("text.univ-count")
          .text(d => d.memberCount + " œuvre" + (d.memberCount > 1 ? "s" : ""));

        // Mettre à jour l'anneau univers sur les nœuds normaux
        update.filter(d => d.nodeType !== "universe")
          .select("circle.ring-univ")
          .attr("stroke", d => d.universeName ? univAccent(d.universeName) : "transparent")
          .attr("opacity", d => d.universeName ? 0.7 : 0);

        update.filter(d => d.nodeType !== "universe")
          .select("circle.ring")
          .attr("opacity", d => (expandedUp.has(d.id) && expandedDown.has(d.id)) ? 0 : 0.35);

        return update;
      },

      exit => exit.transition().duration(200).attr("opacity",0).remove()
    );

  // ── INTERACTIONS ─────────────────────────────────────────
  node
    .on("mouseover", (event, d) => {
      d3.select(event.currentTarget).select("circle.main")
        .attr("stroke","#c9a84c").attr("stroke-width",2);
    })
    .on("mouseout", (event, d) => {
      d3.select(event.currentTarget).select("circle.main")
        .attr("stroke", d.nodeType === "universe" ? univAccent(d.name)
              : d.depth === 0 ? "#c9a84c" : colorStroke(d.type))
        .attr("stroke-width", d.nodeType === "universe" ? 2.5 : d.depth === 0 ? 2 : 1);
    })
    .on("click", (event, d) => {
      event.stopPropagation();

      // Double-clic : reset sur ce nœud
      if (_clickPending && _clickPending.id === d.id) {
        clearTimeout(_clickTimer);
        _clickTimer = null; _clickPending = null;
        hideInfoPanel();
        selectNode(d);
        return;
      }

      // Sinon : attendre 260ms pour voir si un 2e clic suit
      _clickPending = d;
      _clickTimer = setTimeout(() => {
        _clickTimer = null; _clickPending = null;

        showInfoPanel(d);

        if (d.nodeType === "universe") {
          toggleUniverse(d);
        } else {
          const doneUp   = expandedUp.has(d.id);
          const doneDown = expandedDown.has(d.id);
          if (doneUp && doneDown) {
            expandNodeMore(d); // déjà exploré → cherche autre chose
          } else {
            if (!doneUp)   expandNode(d, "up");
            if (!doneDown) expandNode(d, "down");
          }
        }
      }, 260);
    })
    .on("touchstart.tap", (event, d) => {
      const t = event.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
    }, { passive: true })
    .on("touchend.tap", (event, d) => {
      const t = event.changedTouches[0];
      if (Math.abs(t.clientX - touchStartX) < 15 && Math.abs(t.clientY - touchStartY) < 15) {
        d3.select(event.currentTarget).select("circle.main")
          .attr("stroke","#c9a84c").attr("stroke-width",2);

        const now = Date.now();
        const isDoubleTap = _lastTapId === d.id && (now - _lastTapTime) < 350;
        _lastTapId = d.id; _lastTapTime = now;

        if (isDoubleTap) {
          hideInfoPanel();
          selectNode(d);
          return;
        }

        showInfoPanel(d);
        if (d.nodeType === "universe") {
          toggleUniverse(d);
        } else {
          const doneUp = expandedUp.has(d.id), doneDown = expandedDown.has(d.id);
          if (doneUp && doneDown) expandNodeMore(d);
          else { if (!doneUp) expandNode(d, "up"); if (!doneDown) expandNode(d, "down"); }
        }
      }
    }, { passive: true })
    .call(dragBehavior());

  // ── SIMULATION ───────────────────────────────────────────
  if (simulation) simulation.stop();

  // Force de clustering : attire chaque membre vers son hub univers
  function universeClusterForce(alpha) {
    for (const n of visibleNodes) {
      if (!n.universeId || n.nodeType === "universe") continue;
      const hub = visibleNodes.find(u => u.id === n.universeId);
      if (!hub || hub.x === undefined) continue;
      const dx = hub.x - n.x, dy = hub.y - n.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const strength = 0.15 * alpha;
      n.vx += (dx / dist) * strength;
      n.vy += (dy / dist) * strength;
    }
  }

  simulation = d3.forceSimulation(visibleNodes)
    .force("link", d3.forceLink(allLinks).id(d => d.id)
      .distance(d => d.dir === "univ" ? 60 : 80)
      .strength(d => d.dir === "univ" ? 0.6 : 0.7))
    .force("charge", d3.forceManyBody()
      .strength(d => d.nodeType === "universe" ? -350 : -180))
    .force("cluster", universeClusterForce)
    .force("center", d3.forceCenter(svgEl.clientWidth/2, svgEl.clientHeight/2))
    .force("collision", d3.forceCollide(d => nodeRadius(d) + (d.nodeType === "universe" ? 36 : 12)))
    .force("bounds", () => {
      const w = svgEl.clientWidth, h = svgEl.clientHeight;
      for (const n of visibleNodes) {
        const r = nodeRadius(n) + 4;
        if (n.x < r)     n.vx += (r - n.x)     * 0.04;
        if (n.x > w - r) n.vx -= (n.x - (w-r)) * 0.04;
        if (n.y < r)     n.vy += (r - n.y)      * 0.04;
        if (n.y > h - r) n.vy -= (n.y - (h-r))  * 0.04;
      }
    })
    .on("tick", () => {
      // Halos suivent leur nœud univers
      gHalos.selectAll("circle.halo-univ")
        .attr("cx", d => d.x || 0)
        .attr("cy", d => d.y || 0);

      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx*dx + dy*dy) || 1;
          return d.target.x - (dx/dist) * (nodeRadius(d.target) + 6);
        })
        .attr("y2", d => {
          const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx*dx + dy*dy) || 1;
          return d.target.y - (dy/dist) * (nodeRadius(d.target) + 6);
        });

      node.attr("transform", d => "translate(" + (d.x||0) + "," + (d.y||0) + ")");
    })
    .on("end", () => fitGraph(true));
}

// Animation pulse sur les nœuds univers
function pulse(sel) {
  sel.transition().duration(2000).ease(d3.easeSinInOut)
    .attr("r", d => nodeRadius(d) + 14)
    .attr("opacity", 0.2)
    .transition().duration(2000).ease(d3.easeSinInOut)
    .attr("r", d => nodeRadius(d) + 8)
    .attr("opacity", 0.5)
    .on("end", function(d) { pulse(d3.select(this)); });
}

// CSS inline pour les liens univers (gris tireté)
svg.select("defs").append("style").text(
  ".link-universe { stroke: rgba(255,255,255,0.08); }"
);

// ============================================================
//  EXPAND — influences + détection univers
// ============================================================

async function expandNode(nodeData, dir) {
  if (expandedUp.has(nodeData.id) && dir === "up") return;
  if (expandedDown.has(nodeData.id) && dir === "down") return;
  if (expanding.has(nodeData.id + dir)) return;

  expanding.add(nodeData.id + dir);

  const nodeEl = gNodes.selectAll("g.node").filter(d => d.id === nodeData.id);
  startSpinner(nodeEl);

  const depthVal = DEPTH_DEFAULT;

  const minResults = Math.max(depthVal, 1) * 3 + 3; // 6 min, scale avec la profondeur
  const maxDepth   = depthVal;

  setStatus("Recherche " + (dir === "up" ? "amont" : "aval") + " de \"" + nodeData.name + "\"…");

  try {
    await recurseExpand(nodeData, dir, 0, maxDepth, minResults, new Set([nodeData.id]));

    if (dir === "up")  expandedUp.add(nodeData.id);
    else               expandedDown.add(nodeData.id);

    // Détecter l'univers du nœud principal et de tous les nouveaux
    detectAndAssignUniverses();

    setStatus("\"" + nodeData.name + "\" — " + (dir === "up" ? "influences reçues" : "influences données") + " chargées");
    updateDbStats();
  } catch (err) {
    console.error("expandNode erreur:", err);
    setStatus("Erreur : " + err.message);
  }

  stopSpinner(nodeEl);
  expanding.delete(nodeData.id + dir);
  redraw();
}

// Exploration approfondie : nœud déjà exploré → cherche des connexions inédites
async function expandNodeMore(nodeData) {
  if (expanding.has(nodeData.id + "more")) return;
  expanding.add(nodeData.id + "more");

  const nodeEl = gNodes.selectAll("g.node").filter(d => d.id === nodeData.id);
  startSpinner(nodeEl);
  setStatus("Recherche approfondie de \"" + nodeData.name + "\"…");

  try {
    const existingNames = graphData.nodes
      .filter(n => n.nodeType !== "universe")
      .map(n => n.name);

    const newItems = await fetchMoreInfluences(nodeData, existingNames);

    if (!newItems.length) {
      setStatus("\"" + nodeData.name + "\" — aucune nouvelle connexion trouvée");
    } else {
      const existingIds  = new Set(graphData.nodes.map(n => n.id));
      const existingSlug = new Set(graphData.nodes.map(n => slugify(n.name)));

      for (const inf of newItems) {
        const key = slugify(inf.name);
        if (existingSlug.has(key)) continue; // déjà présent
        const nodeId = "more-" + key;
        if (existingIds.has(nodeId)) continue;

        // Rattacher visuellement au nœud source (depth +1)
        graphData.nodes.push({ ...inf, id: nodeId, depth: 1 });
        graphData.links.push({ source: nodeData.id, target: nodeId, dir: "down", weight: inf.weight ?? 0.6 });
        existingIds.add(nodeId);
        existingSlug.add(key);
      }

      detectAndAssignUniverses();
      setStatus("\"" + nodeData.name + "\" — " + newItems.length + " nouvelles connexions");
    }
  } catch (err) {
    console.error("expandNodeMore erreur:", err);
    setStatus("Erreur : " + err.message);
  }

  stopSpinner(nodeEl);
  expanding.delete(nodeData.id + "more");
  redraw();
  setTimeout(() => fitGraph(true), 350);
}

async function recurseExpand(node, dir, depth, maxDepth, minResults, visited) {
  if (depth >= maxDepth) return;

  const { items: influences, fromCache } = await fetchInfluences(node, dir, minResults);
  if (fromCache) setStatus("[cache] " + node.name + " — " + influences.length + " influences");

  const existingIds = new Set(graphData.nodes.map(n => n.id));

  for (const inf of influences) {
    const duplicate = findDuplicateNode(inf);
    const key = duplicate ? duplicate.id : (inf.id || slugify(inf.name));

    if (visited.has(key)) continue;
    visited.add(key);

    if (!existingIds.has(key)) {
      const d = dir === "up" ? -(depth + 1) : (depth + 1);
      graphData.nodes.push({ ...inf, id: key, depth: d });
      existingIds.add(key);
    } else if (duplicate && !duplicate.description && inf.description) {
      duplicate.description = inf.description;
    }

    const s = dir === "up" ? key     : node.id;
    const t = dir === "up" ? node.id : key;

    const alreadyLinked = graphData.links.some(l => {
      const ls = l.source?.id ?? l.source;
      const lt = l.target?.id ?? l.target;
      return ls === s && lt === t;
    });
    if (!alreadyLinked) graphData.links.push({ source: s, target: t, dir, weight: inf.weight ?? 0.7 });

    const childNode = graphData.nodes.find(n => n.id === key);
    if (childNode) await recurseExpand(childNode, dir, depth + 1, maxDepth, minResults, visited);
  }
}

// Détecte les univers de tous les nœuds qui n'en ont pas encore
async function detectAndAssignUniverses() {
  // Phase 1 : champ `universe` injecté par normalizeInfluences (immédiat, sans API)
  for (const node of graphData.nodes) {
    if (node.nodeType === "universe" || node.universeName !== undefined) continue;
    if (node.universe !== undefined) {
      node.universeName = node.universe || null;
      if (node.universe) assignNodeToUniverse(node.id, node.universe);
    }
  }
  redraw(); // afficher ce qu'on a déjà

  // Phase 2 : appels Gemini en parallèle pour les nœuds sans univers
  const toDetect = graphData.nodes.filter(
    n => n.nodeType !== "universe" && n.universeName === undefined
  );

  if (!toDetect.length) return;

  await Promise.all(toDetect.map(async node => {
    const universe = await detectUniverse(node);
    node.universeName = universe || null;
    if (universe) assignNodeToUniverse(node.id, universe);
  }));

  redraw();
}

// ============================================================
//  SPINNER
// ============================================================

function startSpinner(nodeG) {
  nodeG.select("circle.spinner-ring").attr("opacity",1)
    .call(function spin(sel) {
      sel.attr("stroke-dashoffset",0)
        .transition().duration(800).ease(d3.easeLinear)
        .attrTween("stroke-dashoffset", () => d3.interpolate(0,-60))
        .on("end", () => {
          if (nodeG.select("circle.spinner-ring").attr("opacity") > 0) spin(nodeG.select("circle.spinner-ring"));
        });
    });
}
function stopSpinner(nodeG) {
  nodeG.select("circle.spinner-ring").interrupt().attr("opacity",0);
}

// ============================================================
//  RECHERCHE — dropdown multi-sources
// ============================================================

const TYPE_META = {
  cinema:      { label:"Film",           color:"var(--cinema)" },
  serie:       { label:"Série TV",       color:"var(--serie)" },
  anime:       { label:"Animé",          color:"var(--anime)" },
  manga:       { label:"Manga",          color:"var(--manga)" },
  bd:          { label:"BD",             color:"var(--bd)" },
  comics:      { label:"Comics",         color:"var(--comics)" },
  theatre:     { label:"Théâtre",        color:"var(--theatre)" },
  litterature: { label:"Roman",          color:"var(--lit)" },
  jeu:         { label:"Jeu vidéo",      color:"var(--jeu)" },
};

let searchTimeout = null;

async function handleSearchInput(query) {
  query = query.trim();
  searchRes.innerHTML = "";
  searchRes.classList.remove("open");
  if (query.length < 2) return;

  searchRes.innerHTML = "<div class=\"search-item\" style=\"color:var(--grey);font-size:11px;letter-spacing:1px;\">Recherche…</div>";
  searchRes.classList.add("open");

  try {
    const [movies, books, games] = await Promise.all([
      searchOMDb(query).catch(() => []),
      searchBooks(query).catch(() => []),
      searchRAWG(query).catch(() => []),
    ]);
    const all = [...movies.slice(0,4), ...books.slice(0,3), ...games.slice(0,3)];
    searchRes.innerHTML = "";
    if (!all.length) {
      searchRes.innerHTML = "<div class=\"search-item\" style=\"color:var(--grey);font-size:11px;\">Aucun résultat</div>";
      return;
    }
    all.forEach(item => {
      const meta = TYPE_META[item.type] || { label: item.type, color:"var(--grey)" };
      const el   = document.createElement("div"); el.className = "search-item";
      const img  = document.createElement("img"); img.className = "si-poster";
      if (item.poster && item.poster !== "N/A") { img.src = item.poster; img.onerror = () => { img.style.visibility="hidden"; }; }
      else img.style.visibility = "hidden";
      const info  = document.createElement("div"); info.className = "si-info";
      const title = document.createElement("div"); title.className = "si-title"; title.textContent = item.name;
      const year  = document.createElement("div"); year.className  = "si-year";  year.textContent  = item.year || "";
      info.appendChild(title); info.appendChild(year);
      const badge = document.createElement("div"); badge.className = "si-type";
      badge.textContent = meta.label; badge.style.borderColor = meta.color; badge.style.color = meta.color;
      el.appendChild(img); el.appendChild(info); el.appendChild(badge);
      el.addEventListener("click", () => { searchEl.value = item.name; searchRes.classList.remove("open"); selectNode(item); });
      searchRes.appendChild(el);
    });
    searchRes.classList.add("open");
  } catch(e) {
    searchRes.innerHTML = ""; searchRes.classList.remove("open");
  }
}

function selectNode(item) {
  if (welcomeEl) welcomeEl.classList.add("hidden");
  hideInfoPanel();
  const cx = svgEl.clientWidth / 2, cy = svgEl.clientHeight / 2;

  // Reset complet
  graphData = { nodes: [{ ...item, depth: 0, x: cx, y: cy, fx: cx, fy: cy }], links: [] };
  expandedUp.clear(); expandedDown.clear(); expanding.clear();
  universeNodes.clear(); expandedUnivs.clear();

  svg.call(zoom.transform, d3.zoomIdentity);
  setStatus("\"" + item.name + "\" — Cliquez le nœud pour explorer ses influences");
  redraw();

  // Détecter l'univers du nœud racine
  detectUniverse(item).then(universe => {
    if (universe) {
      assignNodeToUniverse(item.id, universe);
      redraw();
    }
  });

  setTimeout(() => { const n = graphData.nodes[0]; if (n) { n.fx=null; n.fy=null; } }, 800);
}

// ============================================================
//  HELPERS
// ============================================================

function showLoader(msg) { loaderMsg.textContent = msg || "Chargement…"; loader.classList.add("visible"); }
function hideLoader()    { loader.classList.remove("visible"); }
function setStatus(msg)  { statusMsg.textContent = msg; }

async function updateDbStats() {
  try {
    const stats = await dbStats();
    const el = document.getElementById("db-stats");
    if (el) el.textContent = stats.total + " en cache";
  } catch(e) {}
}

// ============================================================
//  EVENTS
// ============================================================

searchEl.addEventListener("input", e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => handleSearchInput(e.target.value), 350);
});
searchEl.addEventListener("keydown", e => {
  if (e.key === "Enter")  { clearTimeout(searchTimeout); searchRes.classList.remove("open"); handleSearchInput(e.target.value); }
  if (e.key === "Escape") { searchRes.classList.remove("open"); }
});
document.addEventListener("click", e => {
  if (!e.target.closest("#search-zone")) searchRes.classList.remove("open");
});

document.querySelectorAll(".filter-btn").forEach(btn => {
  const type = btn.dataset.type;
  btn.addEventListener("click", () => {
    const isActive = btn.dataset.active === "true";
    if (isActive) { activeTypes.delete(type); btn.dataset.active = "false"; }
    else          { activeTypes.add(type);    btn.dataset.active = "true"; }
    redraw();
  });
});

document.getElementById("btn-export")?.addEventListener("click", () => exportJSON());
document.getElementById("ip-close")?.addEventListener("click", hideInfoPanel);


// ============================================================
//  INIT
// ============================================================

(async () => {
  await initLocalData();
  await updateDbStats();
  setStatus("Prêt — tapez un titre pour commencer");
})();
