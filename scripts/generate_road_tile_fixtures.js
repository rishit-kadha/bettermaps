/**
 * generate_road_tile_fixtures.js
 *
 * Deterministic partitioning of the real offline Coventry road network dataset
 * (assets/datasets/road_network_coventry.json) into discrete RoadTile fixtures for Phase 1.5.
 *
 * ARCHITECTURAL INVARIANTS:
 * - Real geometry from OpenStreetMap dataset only.
 * - ZERO fabrication, tracing, or interpolation from vehicle trajectories or reference GPS.
 * - Non-Coventry regional benchmark locations are honestly reported as OFFLINE_UNAVAILABLE.
 * - Deterministic output saved under assets/datasets/road_tiles_test/.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SOURCE_DATASET = path.join(ROOT_DIR, 'assets', 'datasets', 'road_network_coventry.json');
const OUTPUT_DIR = path.join(ROOT_DIR, 'assets', 'datasets', 'road_tiles_test');

if (!fs.existsSync(SOURCE_DATASET)) {
  console.error(`Source road dataset not found at: ${SOURCE_DATASET}`);
  process.exit(1);
}

const rawData = fs.readFileSync(SOURCE_DATASET, 'utf8');
const dataset = JSON.parse(rawData);

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Bounding box helper for segments
function getSegmentBbox(seg) {
  let minLat = Math.min(seg.startPoint.latitude, seg.endPoint.latitude);
  let maxLat = Math.max(seg.startPoint.latitude, seg.endPoint.latitude);
  let minLon = Math.min(seg.startPoint.longitude, seg.endPoint.longitude);
  let maxLon = Math.max(seg.startPoint.longitude, seg.endPoint.longitude);

  if (seg.geometry && Array.isArray(seg.geometry)) {
    for (const pt of seg.geometry) {
      if (pt.latitude < minLat) minLat = pt.latitude;
      if (pt.latitude > maxLat) maxLat = pt.latitude;
      if (pt.longitude < minLon) minLon = pt.longitude;
      if (pt.longitude > maxLon) maxLon = pt.longitude;
    }
  }

  return { minLat, maxLat, minLon, maxLon };
}

function bboxesOverlap(b1, b2) {
  return !(
    b1.maxLat < b2.minLat ||
    b1.minLat > b2.maxLat ||
    b1.maxLon < b2.minLon ||
    b1.minLon > b2.maxLon
  );
}

function isCoordInBbox(coord, bbox) {
  return (
    coord.latitude >= bbox.minLat &&
    coord.latitude <= bbox.maxLat &&
    coord.longitude >= bbox.minLon &&
    coord.longitude <= bbox.maxLon
  );
}

// Haversine distance in meters
function haversineDistanceMeters(c1, c2) {
  const R = 6371000;
  const dLat = ((c2.latitude - c1.latitude) * Math.PI) / 180;
  const dLon = ((c2.longitude - c1.longitude) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((c1.latitude * Math.PI) / 180) *
      Math.cos((c2.latitude * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------------------------------------------------------------
// Tile Definitions (Real Partitioning of Coventry Dataset)
// ---------------------------------------------------------------------------
const TILE_SPECS = [
  {
    fileName: 'tile_coventry_east.json',
    key: { scheme: 'deg', key: '100:5240:-151' },
    bounds: { minLat: 52.395, maxLat: 52.420, minLon: -1.520, maxLon: -1.490 },
    region: 'Coventry East (Warwick Rd, Kenilworth Rd East, Ring Rd South)',
    description: 'Covers IO-VNBD session M starting area and east arterial corridors',
  },
  {
    fileName: 'tile_coventry_west.json',
    key: { scheme: 'deg', key: '100:5240:-155' },
    bounds: { minLat: 52.395, maxLat: 52.420, minLon: -1.565, maxLon: -1.515 },
    region: 'Coventry West (Earlsdon, Charter Ave, Kenilworth Rd West)',
    description: 'Covers IO-VNBD session S2 starting area and west residential arteries',
  },
  {
    fileName: 'tile_coventry_central.json',
    key: { scheme: 'deg', key: '100:5241:-152' },
    bounds: { minLat: 52.405, maxLat: 52.425, minLon: -1.530, maxLon: -1.505 },
    region: 'Coventry Central Hub (City Centre, Ring Rd North, University Campus)',
    description: 'Central topological hub straddling East and West tiles with high intersection density',
  },
];

console.log(`[generate_road_tile_fixtures] Reading source: ${SOURCE_DATASET}`);
console.log(`Source dataset has ${dataset.segments.length} segments, ${dataset.nodes.length} nodes, ${dataset.intersections ? dataset.intersections.length : 0} intersections.\n`);

const nodeMap = new Map();
for (const n of dataset.nodes) {
  nodeMap.set(n.id, n);
}

const intersectionMap = new Map();
if (dataset.intersections) {
  for (const ix of dataset.intersections) {
    intersectionMap.set(ix.nodeId, ix);
  }
}

const generatedTiles = [];

for (const spec of TILE_SPECS) {
  // 1. Filter segments overlapping tile bounds
  const tileSegments = dataset.segments.filter((s) =>
    bboxesOverlap(getSegmentBbox(s), spec.bounds)
  );

  // 2. Identify referenced nodes
  const referencedNodeIds = new Set();
  for (const s of tileSegments) {
    if (s.startNodeId) referencedNodeIds.add(s.startNodeId);
    if (s.endNodeId) referencedNodeIds.add(s.endNodeId);
  }

  // Also include nodes whose coordinates are inside the tile bounds
  for (const n of dataset.nodes) {
    if (isCoordInBbox(n.coordinate, spec.bounds)) {
      referencedNodeIds.add(n.id);
    }
  }

  const tileNodes = [];
  for (const nid of referencedNodeIds) {
    const node = nodeMap.get(nid);
    if (node) {
      tileNodes.push(node);
    }
  }

  // 3. Identify intersections among the referenced nodes
  const tileIntersections = [];
  for (const n of tileNodes) {
    const ix = intersectionMap.get(n.id);
    if (ix) {
      tileIntersections.push(ix);
    }
  }

  const tileObject = {
    key: spec.key,
    bounds: spec.bounds,
    segments: tileSegments,
    nodes: tileNodes,
    intersections: tileIntersections,
    metadata: {
      source: dataset.metadata.source,
      license: dataset.metadata.license,
      region: spec.region,
      description: spec.description,
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      segmentCount: tileSegments.length,
      nodeCount: tileNodes.length,
      intersectionCount: tileIntersections.length,
    },
  };

  const outPath = path.join(OUTPUT_DIR, spec.fileName);
  const jsonContent = JSON.stringify(tileObject, null, 2);
  fs.writeFileSync(outPath, jsonContent, 'utf8');

  console.log(`Generated fixture: ${spec.fileName}`);
  console.log(`  Tile Key: ${spec.key.scheme}:${spec.key.key}`);
  console.log(`  Bounds: lat [${spec.bounds.minLat}, ${spec.bounds.maxLat}], lon [${spec.bounds.minLon}, ${spec.bounds.maxLon}]`);
  console.log(`  Segments: ${tileSegments.length} | Nodes: ${tileNodes.length} | Intersections: ${tileIntersections.length}`);
  console.log(`  File size: ${(jsonContent.length / 1024).toFixed(1)} KB`);

  generatedTiles.push({
    fileName: spec.fileName,
    key: spec.key,
    bounds: spec.bounds,
    segmentCount: tileSegments.length,
    nodeCount: tileNodes.length,
    intersectionCount: tileIntersections.length,
    byteSize: jsonContent.length,
  });
}

// ---------------------------------------------------------------------------
// Multi-Tile Shared Segment Analysis
// ---------------------------------------------------------------------------
const eastTile = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'tile_coventry_east.json'), 'utf8'));
const westTile = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'tile_coventry_west.json'), 'utf8'));
const centralTile = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'tile_coventry_central.json'), 'utf8'));

const eastIds = new Set(eastTile.segments.map((s) => s.id));
const westIds = new Set(westTile.segments.map((s) => s.id));
const centIds = new Set(centralTile.segments.map((s) => s.id));

const sharedEastWest = [...eastIds].filter((id) => westIds.has(id));
const sharedEastCentral = [...eastIds].filter((id) => centIds.has(id));
const sharedWestCentral = [...westIds].filter((id) => centIds.has(id));
const uniqueEast = [...eastIds].filter((id) => !westIds.has(id) && !centIds.has(id));

console.log('\n--- Multi-Tile Shared Segment Topology ---');
console.log(`Shared East & West segments: ${sharedEastWest.length}`);
console.log(`Shared East & Central segments: ${sharedEastCentral.length}`);
console.log(`Shared West & Central segments: ${sharedWestCentral.length}`);
console.log(`Unique East segments: ${uniqueEast.length}`);

// ---------------------------------------------------------------------------
// 10 IO-VNBD Benchmark Sessions Coverage Audit (Honesty Invariant)
// ---------------------------------------------------------------------------
const BENCHMARK_SESSIONS = [
  { id: 'M', coord: { latitude: 52.40256, longitude: -1.50348 }, region: 'Coventry East' },
  { id: 'S2', coord: { latitude: 52.40314, longitude: -1.55798 }, region: 'Coventry West' },
  { id: 'Vta8', coord: { latitude: 52.86297, longitude: -1.68282 }, region: 'Burton upon Trent (Staffordshire East)' },
  { id: 'Vta10', coord: { latitude: 52.88177, longitude: -1.71742 }, region: 'Stretton (Staffordshire East)' },
  { id: 'Vta15', coord: { latitude: 52.96543, longitude: -1.75695 }, region: 'Uttoxeter (Staffordshire North)' },
  { id: 'Vta21', coord: { latitude: 53.04053, longitude: -1.81736 }, region: 'Cheadle (Staffordshire North)' },
  { id: 'Vtb12', coord: { latitude: 52.55384, longitude: -1.46679 }, region: 'Nuneaton (Warwickshire North)' },
  { id: 'Vtb4', coord: { latitude: 53.17105, longitude: -1.67288 }, region: 'Matlock (Derbyshire Peak District)' },
  { id: 'Vw14b', coord: { latitude: 52.34884, longitude: -2.07422 }, region: 'Bromsgrove (Worcestershire North)' },
  { id: 'Vw8', coord: { latitude: 52.20313, longitude: -2.19773 }, region: 'Worcester South (Worcestershire South)' },
];

console.log('\n--- 10-Session Geographic Coverage Audit ---');
const sessionAudits = [];

for (const session of BENCHMARK_SESSIONS) {
  let minDistanceM = Infinity;
  let nearestSegmentId = null;
  let nearestSegmentName = null;

  for (const s of dataset.segments) {
    const d1 = haversineDistanceMeters(session.coord, s.startPoint);
    const d2 = haversineDistanceMeters(session.coord, s.endPoint);
    const d = Math.min(d1, d2);
    if (d < minDistanceM) {
      minDistanceM = d;
      nearestSegmentId = s.id;
      nearestSegmentName = s.name || 'unnamed';
    }
  }

  let status = 'UNAVAILABLE';
  let matchedTile = null;

  if (isCoordInBbox(session.coord, eastTile.bounds)) {
    status = 'COVERED_COVENTRY_EAST';
    matchedTile = 'tile_coventry_east.json';
  } else if (isCoordInBbox(session.coord, westTile.bounds)) {
    status = 'COVERED_COVENTRY_WEST';
    matchedTile = 'tile_coventry_west.json';
  } else if (isCoordInBbox(session.coord, centralTile.bounds)) {
    status = 'COVERED_COVENTRY_CENTRAL';
    matchedTile = 'tile_coventry_central.json';
  }

  const auditEntry = {
    sessionId: session.id,
    coordinate: session.coord,
    region: session.region,
    status,
    matchedTile,
    nearestSegmentId,
    nearestSegmentName,
    nearestSegmentDistanceMeters: Math.round(minDistanceM),
  };
  sessionAudits.push(auditEntry);

  console.log(
    `Session ${session.id.padEnd(6)} | ${session.region.padEnd(40)} | Status: ${status.padEnd(24)} | Dist to Coventry: ${(minDistanceM / 1000).toFixed(1)} km`
  );
}

const manifest = {
  description: 'Road tile test fixtures and benchmark session coverage catalog for Phase 1.5',
  generatedAt: new Date().toISOString(),
  sourceDataset: 'assets/datasets/road_network_coventry.json',
  tiles: generatedTiles,
  topology: {
    sharedEastWestCount: sharedEastWest.length,
    sharedEastCentralCount: sharedEastCentral.length,
    sharedWestCentralCount: sharedWestCentral.length,
    uniqueEastCount: uniqueEast.length,
  },
  sessionCoverage: sessionAudits,
};

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);

console.log(`\nManifest written to: ${path.join(OUTPUT_DIR, 'manifest.json')}`);
console.log('Phase 1.5 fixture generation complete.\n');
