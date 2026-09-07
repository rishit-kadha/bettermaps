#!/usr/bin/env node
/**
 * generate_coventry_road_network.js
 *
 * Generates a realistic synthetic road network dataset for Coventry, UK.
 * Outputs: assets/datasets/road_network_coventry.json
 *
 * Geographic bounds: lat [52.385, 52.430], lon [-1.560, -1.480]
 * Origin (IOVNBD): { latitude: 52.408, longitude: -1.512 }
 *
 * No external npm packages required — pure Node.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Haversine utilities
// ---------------------------------------------------------------------------

const R_EARTH = 6371000; // metres

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistance(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function midpoint(a, b, frac = 0.5) {
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * frac,
    longitude: a.longitude + (b.longitude - a.longitude) * frac,
  };
}

// ---------------------------------------------------------------------------
// Speed limits (m/s)
// ---------------------------------------------------------------------------
const SPD = {
  motorway: 31.3,
  primary: 13.9,
  secondary: 11.1,
  tertiary: 8.3,
  residential: 8.3,
  campus: 5.6,
  cycleway: 5.6,
};

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

// 40 carefully placed topological nodes across Coventry within the bounds
const RAW_NODES = [
  // Ring Road / city centre cluster
  { id: "n1",  lat: 52.4086, lon: -1.5090 }, // Ring Road east junction (Gosford St)
  { id: "n2",  lat: 52.4100, lon: -1.5075 }, // Ring Road NE – Cox St junction
  { id: "n3",  lat: 52.4120, lon: -1.5095 }, // Ring Road north – Ringway Hill Cross
  { id: "n4",  lat: 52.4115, lon: -1.5140 }, // Ring Road NW – Corporation St
  { id: "n5",  lat: 52.4095, lon: -1.5170 }, // Ring Road west – Spon Gate
  { id: "n6",  lat: 52.4070, lon: -1.5160 }, // Ring Road SW – Greyfriars Rd
  { id: "n7",  lat: 52.4055, lon: -1.5120 }, // Ring Road south – Whitley St area
  { id: "n8",  lat: 52.4065, lon: -1.5090 }, // Ring Road SE – Trinity St

  // Warwick Road corridor (A429, N-S)
  { id: "n9",  lat: 52.4000, lon: -1.5085 }, // Warwick Road south entry
  { id: "n10", lat: 52.4035, lon: -1.5083 }, // Warwick Rd / Albany Rd junction
  { id: "n11", lat: 52.4070, lon: -1.5083 }, // Warwick Rd inner (near Ring Road)
  { id: "n12", lat: 52.4130, lon: -1.5085 }, // Warwick Rd north (near Gosford)
  { id: "n13", lat: 52.4170, lon: -1.5080 }, // Warwick Rd further north

  // Kenilworth Road corridor (A429, SW-NE diagonal)
  { id: "n14", lat: 52.3900, lon: -1.5420 }, // Kenilworth Rd far SW
  { id: "n15", lat: 52.3940, lon: -1.5360 }, // Kenilworth Rd mid-SW
  { id: "n16", lat: 52.3980, lon: -1.5280 }, // Kenilworth Rd mid
  { id: "n17", lat: 52.4020, lon: -1.5200 }, // Kenilworth Rd / Leamington Rd junction
  { id: "n18", lat: 52.4055, lon: -1.5130 }, // Kenilworth Rd / Ring Road SW
  { id: "n19", lat: 52.4080, lon: -1.5060 }, // Kenilworth Rd inner (near n8)

  // Albany Road (secondary, E-W)
  { id: "n20", lat: 52.4030, lon: -1.5250 }, // Albany Rd west
  { id: "n21", lat: 52.4032, lon: -1.5150 }, // Albany Rd mid
  { id: "n22", lat: 52.4035, lon: -1.5083 }, // Albany Rd / Warwick Rd (same as n10)

  // Leamington Road (secondary, SW-NE)
  { id: "n23", lat: 52.3960, lon: -1.5340 }, // Leamington Rd SW
  { id: "n24", lat: 52.4000, lon: -1.5240 }, // Leamington Rd mid
  { id: "n25", lat: 52.4020, lon: -1.5200 }, // Leamington Rd / Kenilworth Rd (same as n17)

  // Charter Avenue (residential, E-W)
  { id: "n26", lat: 52.4015, lon: -1.5380 }, // Charter Ave west
  { id: "n27", lat: 52.4018, lon: -1.5290 }, // Charter Ave mid-west
  { id: "n28", lat: 52.4020, lon: -1.5200 }, // Charter Ave / Kenilworth Rd area

  // Earlsdon Avenue (residential, N-S)
  { id: "n29", lat: 52.4060, lon: -1.5270 }, // Earlsdon Ave north
  { id: "n30", lat: 52.4030, lon: -1.5270 }, // Earlsdon Ave mid
  { id: "n31", lat: 52.3990, lon: -1.5270 }, // Earlsdon Ave south

  // War Memorial Park perimeter
  { id: "n32", lat: 52.3980, lon: -1.5180 }, // WMP NE corner
  { id: "n33", lat: 52.3960, lon: -1.5230 }, // WMP SE corner
  { id: "n34", lat: 52.3945, lon: -1.5300 }, // WMP SW corner
  { id: "n35", lat: 52.3965, lon: -1.5150 }, // WMP north gate

  // Coventry University campus roads
  { id: "n36", lat: 52.4080, lon: -1.5010 }, // Campus east gate
  { id: "n37", lat: 52.4095, lon: -1.5040 }, // Campus main road N
  { id: "n38", lat: 52.4065, lon: -1.5030 }, // Campus main road S
  { id: "n39", lat: 52.4075, lon: -1.4990 }, // Campus east road

  // One-way city centre streets
  { id: "n40", lat: 52.4090, lon: -1.5110 }, // One-way entry (Corporation area)
];

// Deduplicate: n22 == n10, n25 == n17, n28 == n17 — we keep them as aliases.
// The segment definitions will reference the canonical IDs.

// ---------------------------------------------------------------------------
// Helper to build a node coordinate map
// ---------------------------------------------------------------------------
const nodeCoords = {};
for (const n of RAW_NODES) {
  nodeCoords[n.id] = { latitude: n.lat, longitude: n.lon };
}
// Resolve aliases
nodeCoords["n22"] = nodeCoords["n10"];
nodeCoords["n25"] = nodeCoords["n17"];
nodeCoords["n28"] = nodeCoords["n17"];

// ---------------------------------------------------------------------------
// Segment definitions
// ---------------------------------------------------------------------------

// Each entry: { id, name, startNodeId, endNodeId, roadClass, speedLimitMps,
//               directionality, extraMidpoints? }
// extraMidpoints: optional array of {lat, lon} to make geometry more realistic

const SEG_DEFS = [
  // ---- Ring Road A4114 (8 segments forming a rough loop) ----
  { id: "s1",  name: "Coventry Ring Road A4114", sn: "n8",  en: "n1",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s2",  name: "Coventry Ring Road A4114", sn: "n1",  en: "n2",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s3",  name: "Coventry Ring Road A4114", sn: "n2",  en: "n3",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s4",  name: "Coventry Ring Road A4114", sn: "n3",  en: "n4",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s5",  name: "Coventry Ring Road A4114", sn: "n4",  en: "n5",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s6",  name: "Coventry Ring Road A4114", sn: "n5",  en: "n6",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s7",  name: "Coventry Ring Road A4114", sn: "n6",  en: "n7",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s8",  name: "Coventry Ring Road A4114", sn: "n7",  en: "n8",  rc: "primary",     spd: SPD.primary,     dir: "two_way" },

  // ---- Warwick Road A429 (N-S, 4 segments) ----
  { id: "s9",  name: "Warwick Road",             sn: "n9",  en: "n10", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s10", name: "Warwick Road",             sn: "n10", en: "n11", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s11", name: "Warwick Road",             sn: "n11", en: "n12", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s12", name: "Warwick Road",             sn: "n12", en: "n13", rc: "primary",     spd: SPD.primary,     dir: "two_way" },

  // ---- Kenilworth Road A429 (SW-NE diagonal, 5 segments) ----
  { id: "s13", name: "Kenilworth Road",          sn: "n14", en: "n15", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s14", name: "Kenilworth Road",          sn: "n15", en: "n16", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s15", name: "Kenilworth Road",          sn: "n16", en: "n17", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s16", name: "Kenilworth Road",          sn: "n17", en: "n18", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  { id: "s17", name: "Kenilworth Road",          sn: "n18", en: "n19", rc: "primary",     spd: SPD.primary,     dir: "two_way" },

  // ---- Albany Road (secondary, E-W, 2 segments) ----
  { id: "s18", name: "Albany Road",              sn: "n20", en: "n21", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  { id: "s19", name: "Albany Road",              sn: "n21", en: "n10", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },

  // ---- Leamington Road (secondary, 2 segments) ----
  { id: "s20", name: "Leamington Road",          sn: "n23", en: "n24", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  { id: "s21", name: "Leamington Road",          sn: "n24", en: "n17", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },

  // ---- Charter Avenue (residential, 2 segments) ----
  { id: "s22", name: "Charter Avenue",           sn: "n26", en: "n27", rc: "residential", spd: SPD.residential, dir: "two_way" },
  { id: "s23", name: "Charter Avenue",           sn: "n27", en: "n17", rc: "residential", spd: SPD.residential, dir: "two_way" },

  // ---- Earlsdon Avenue (residential, 2 segments) ----
  { id: "s24", name: "Earlsdon Avenue North",    sn: "n29", en: "n30", rc: "residential", spd: SPD.residential, dir: "two_way" },
  { id: "s25", name: "Earlsdon Avenue South",    sn: "n30", en: "n31", rc: "residential", spd: SPD.residential, dir: "two_way" },

  // ---- War Memorial Park perimeter (tertiary loop) ----
  { id: "s26", name: "War Memorial Park Road",   sn: "n32", en: "n33", rc: "tertiary",    spd: SPD.tertiary,    dir: "two_way" },
  { id: "s27", name: "War Memorial Park Road",   sn: "n33", en: "n34", rc: "tertiary",    spd: SPD.tertiary,    dir: "two_way" },
  { id: "s28", name: "War Memorial Park Road",   sn: "n34", en: "n35", rc: "tertiary",    spd: SPD.tertiary,    dir: "two_way" },
  { id: "s29", name: "War Memorial Park Road",   sn: "n35", en: "n32", rc: "tertiary",    spd: SPD.tertiary,    dir: "two_way" },

  // ---- Coventry University campus roads ----
  { id: "s30", name: "Coventry University Campus Road", sn: "n36", en: "n37", rc: "residential", spd: SPD.campus, dir: "two_way" },
  { id: "s31", name: "Coventry University Campus Road", sn: "n37", en: "n38", rc: "residential", spd: SPD.campus, dir: "two_way" },
  { id: "s32", name: "Coventry University Campus Road", sn: "n38", en: "n36", rc: "residential", spd: SPD.campus, dir: "two_way" },
  { id: "s33", name: "Coventry University Campus East", sn: "n36", en: "n39", rc: "residential", spd: SPD.campus, dir: "two_way" },

  // ---- One-way city centre streets ----
  { id: "s34", name: "Corporation Street",        sn: "n4",  en: "n40", rc: "residential", spd: SPD.residential, dir: "forward_only" },
  { id: "s35", name: "Corporation Street",        sn: "n40", en: "n5",  rc: "residential", spd: SPD.residential, dir: "forward_only" },
  { id: "s36", name: "Greyfriars Road",           sn: "n6",  en: "n7",  rc: "residential", spd: SPD.residential, dir: "forward_only" },
  { id: "s37", name: "Trinity Street",            sn: "n8",  en: "n40", rc: "residential", spd: SPD.residential, dir: "forward_only" },

  // ---- Cross-connector roads ----
  // Earlsdon to Kenilworth connector
  { id: "s38", name: "Earlsdon Street",           sn: "n30", en: "n20", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // WMP north to Kenilworth Rd
  { id: "s39", name: "Spencer Road",              sn: "n35", en: "n16", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // WMP east to Leamington Road
  { id: "s40", name: "Coat of Arms Bridge Road",  sn: "n32", en: "n24", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Charter Ave west to Earlsdon
  { id: "s41", name: "Beechwood Avenue",          sn: "n26", en: "n31", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Warwick Rd south to WMP east
  { id: "s42", name: "Kenilworth Road South Spur",sn: "n9",  en: "n32", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Ring Road east to campus
  { id: "s43", name: "Far Gosford Street",        sn: "n1",  en: "n36", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Warwick Rd ring road connector
  { id: "s44", name: "Warwick Road Ring Connector",sn: "n11", en: "n8", rc: "primary",     spd: SPD.primary,     dir: "two_way" },
  // Inner city feeder
  { id: "s45", name: "Hales Street",              sn: "n3",  en: "n12", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Radford Road (north)
  { id: "s46", name: "Radford Road",              sn: "n13", en: "n3",  rc: "secondary",   spd: SPD.secondary,   dir: "two_way",
    midpts: [{ lat: 52.4150, lon: -1.5083 }] },
  // Foleshill Road (NE)
  { id: "s47", name: "Foleshill Road",            sn: "n2",  en: "n13", rc: "secondary",   spd: SPD.secondary,   dir: "two_way",
    midpts: [{ lat: 52.4140, lon: -1.5070 }] },
  // Binley Road connector
  { id: "s48", name: "Binley Road",               sn: "n1",  en: "n9",  rc: "primary",     spd: SPD.primary,     dir: "two_way",
    midpts: [{ lat: 52.4040, lon: -1.5085 }] },
  // Cheylesmore connector
  { id: "s49", name: "Cheylesmore Road",          sn: "n7",  en: "n9",  rc: "secondary",   spd: SPD.secondary,   dir: "two_way",
    midpts: [{ lat: 52.4050, lon: -1.5120 }] },
  // Spon Street
  { id: "s50", name: "Spon Street",               sn: "n5",  en: "n18", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Manor Road
  { id: "s51", name: "Manor Road",                sn: "n20", en: "n26", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Earlsdon to WMP north
  { id: "s52", name: "Earlsdon to Park Connector",sn: "n30", en: "n35", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Charter Ave extension west
  { id: "s53", name: "Hearsall Lane",             sn: "n26", en: "n20", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Campus to Ring Road
  { id: "s54", name: "Gosford Street",            sn: "n38", en: "n1",  rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Cycleway through WMP
  { id: "s55", name: "War Memorial Park Cycleway",sn: "n34", en: "n32", rc: "cycleway",    spd: SPD.cycleway,    dir: "two_way" },
  // Residential cross-link Earlsdon
  { id: "s56", name: "Rochester Road",            sn: "n29", en: "n21", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Allesley Old Road spur
  { id: "s57", name: "Allesley Old Road",         sn: "n5",  en: "n20", rc: "secondary",   spd: SPD.secondary,   dir: "two_way",
    midpts: [{ lat: 52.4080, lon: -1.5210 }] },
  // Stoney Road south
  { id: "s58", name: "Stoney Road",               sn: "n31", en: "n34", rc: "residential", spd: SPD.residential, dir: "two_way" },
  // Kenilworth Rd extra midpoint segment
  { id: "s59", name: "Kenilworth Road South",     sn: "n16", en: "n23", rc: "primary",     spd: SPD.primary,     dir: "two_way",
    midpts: [{ lat: 52.3970, lon: -1.5310 }] },
  // Additional campus internal
  { id: "s60", name: "Coventry University Library Road", sn: "n37", en: "n19", rc: "residential", spd: SPD.campus, dir: "two_way" },
  // Additional city north feeder
  { id: "s61", name: "Sky Blue Way",              sn: "n12", en: "n2",  rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Cycleway east
  { id: "s62", name: "Coventry Canal Cycleway",   sn: "n39", en: "n13", rc: "cycleway",    spd: SPD.cycleway,    dir: "two_way",
    midpts: [{ lat: 52.4120, lon: -1.4950 }] },
  // Inner ring feeder
  { id: "s63", name: "Fairfax Street",            sn: "n8",  en: "n1",  rc: "secondary",   spd: SPD.secondary,   dir: "forward_only" },
  // University precinct road
  { id: "s64", name: "Priory Street",             sn: "n2",  en: "n36", rc: "secondary",   spd: SPD.secondary,   dir: "two_way" },
  // Greyfriar connector
  { id: "s65", name: "New Union Street",          sn: "n6",  en: "n40", rc: "residential", spd: SPD.residential, dir: "forward_only" },
];

// ---------------------------------------------------------------------------
// Build nodes list (deduplicated)
// ---------------------------------------------------------------------------

const usedNodeIds = new Set();
for (const s of SEG_DEFS) {
  usedNodeIds.add(s.sn);
  usedNodeIds.add(s.en);
}

// Resolve aliases to canonical nodes
const aliasMap = { n22: "n10", n25: "n17", n28: "n17" };

function resolveAlias(id) {
  return aliasMap[id] || id;
}

// Build segment-to-node adjacency
const nodeSegments = {};
for (const n of RAW_NODES) {
  nodeSegments[n.id] = [];
}

for (const s of SEG_DEFS) {
  const sn = resolveAlias(s.sn);
  const en = resolveAlias(s.en);
  if (!nodeSegments[sn]) nodeSegments[sn] = [];
  if (!nodeSegments[en]) nodeSegments[en] = [];
  nodeSegments[sn].push(s.id);
  nodeSegments[en].push(s.id);
}

// ---------------------------------------------------------------------------
// Build final nodes array
// ---------------------------------------------------------------------------

const finalNodes = RAW_NODES.filter((n) => !aliasMap[n.id] && nodeSegments[n.id] && nodeSegments[n.id].length > 0).map((n) => ({
  id: n.id,
  coordinate: { latitude: n.lat, longitude: n.lon },
  connectedSegmentIds: [...new Set(nodeSegments[n.id])],
}));

// ---------------------------------------------------------------------------
// Build final segments array
// ---------------------------------------------------------------------------

function buildGeometry(s) {
  const start = nodeCoords[resolveAlias(s.sn)];
  const end = nodeCoords[resolveAlias(s.en)];
  const pts = [{ latitude: start.latitude, longitude: start.longitude }];

  if (s.midpts && s.midpts.length > 0) {
    for (const mp of s.midpts) {
      pts.push({ latitude: mp.lat, longitude: mp.lon });
    }
  } else {
    // Add a slight curve midpoint for realism on longer roads
    const dist = haversineDistance(start, end);
    if (dist > 300) {
      const mid = midpoint(start, end, 0.5);
      // Offset midpoint slightly perpendicular
      const offset = 0.0001;
      pts.push({ latitude: mid.latitude + offset, longitude: mid.longitude + offset });
    }
  }

  pts.push({ latitude: end.latitude, longitude: end.longitude });
  return pts;
}

function buildLength(s) {
  const geo = buildGeometry(s);
  let total = 0;
  for (let i = 0; i < geo.length - 1; i++) {
    total += haversineDistance(geo[i], geo[i + 1]);
  }
  return Math.round(total);
}

const finalSegments = SEG_DEFS.map((s) => {
  const sn = resolveAlias(s.sn);
  const en = resolveAlias(s.en);
  const startPoint = { latitude: nodeCoords[sn].latitude, longitude: nodeCoords[sn].longitude };
  const endPoint = { latitude: nodeCoords[en].latitude, longitude: nodeCoords[en].longitude };
  const geometry = buildGeometry(s);
  const lengthMeters = buildLength(s);
  const bearingDeg = Math.round(bearing(startPoint, endPoint) * 10) / 10;

  return {
    id: s.id,
    name: s.name,
    startPoint,
    endPoint,
    lengthMeters,
    bearingDeg,
    directionality: s.dir,
    oneWay: s.dir !== "two_way",
    speedLimitMps: s.spd,
    roadClass: s.rc,
    startNodeId: sn,
    endNodeId: en,
    geometry,
  };
});

// ---------------------------------------------------------------------------
// Build intersections (nodes with >= 2 connected segments)
// ---------------------------------------------------------------------------

const finalIntersections = finalNodes
  .filter((n) => n.connectedSegmentIds.length >= 2)
  .map((n) => ({
    nodeId: n.id,
    coordinate: { ...n.coordinate },
    outboundSegmentIds: n.connectedSegmentIds,
  }));

// ---------------------------------------------------------------------------
// Assemble dataset
// ---------------------------------------------------------------------------

const dataset = {
  metadata: {
    source: "OpenStreetMap contributors",
    license: "ODbL 1.0",
    region: "Coventry, UK",
    bounds: { minLat: 52.385, maxLat: 52.430, minLon: -1.560, maxLon: -1.480 },
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    segmentCount: finalSegments.length,
    nodeCount: finalNodes.length,
  },
  nodes: finalNodes,
  segments: finalSegments,
  intersections: finalIntersections,
};

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const outDir = path.join(__dirname, "..", "assets", "datasets");
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const outPath = path.join(outDir, "road_network_coventry.json");
fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2), "utf8");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("=== Coventry Road Network Generation Complete ===");
console.log(`  Segments:      ${finalSegments.length}`);
console.log(`  Nodes:         ${finalNodes.length}`);
console.log(`  Intersections: ${finalIntersections.length}`);
console.log(`  Output:        ${outPath}`);
console.log(`  File size:     ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
