#!/usr/bin/env node
/**
 * convert_osm_to_coventry_dataset.js
 *
 * Converts real OpenStreetMap highway geometry for Coventry into the BetterMaps
 * IRoadNetworkProvider schema.
 *
 * Inputs: scripts/osm_coventry_raw.json (1511 real OSM ways)
 * Outputs: assets/datasets/road_network_coventry.json
 */

const fs = require('fs');
const path = require('path');

const R_EARTH = 6371000; // metres

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDist(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

function computeBearing(lat1, lon1, lat2, lon2) {
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function parseSpeedLimit(tags) {
  if (tags.maxspeed) {
    const val = parseFloat(tags.maxspeed);
    if (!isNaN(val)) {
      if (tags.maxspeed.includes('mph')) return val * 0.44704;
      return val / 3.6; // assume km/h
    }
  }
  const h = tags.highway;
  if (h === 'motorway') return 31.3;
  if (h === 'trunk') return 22.4;
  if (h === 'primary') return 13.9;
  if (h === 'secondary') return 11.1;
  if (h === 'tertiary') return 8.9;
  if (h === 'residential') return 8.9; // 20 mph standard UK residential
  return 8.3;
}

function main() {
  const rawPath = path.join(__dirname, 'osm_coventry_raw.json');
  if (!fs.existsSync(rawPath)) {
    console.error('Missing osm_coventry_raw.json!');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const ways = raw.elements.filter(e => e.type === 'way' && e.geometry && e.geometry.length >= 2);
  console.log(`Processing ${ways.length} real OSM ways...`);

  const segments = [];
  const nodeMap = new Map(); // nodeId -> { id, coordinate, connectedSegmentIds: Set }

  let globalMinLat = 90, globalMaxLat = -90, globalMinLon = 180, globalMaxLon = -180;

  for (const way of ways) {
    const geom = way.geometry.map(p => ({
      latitude: Number(p.lat.toFixed(7)),
      longitude: Number(p.lon.toFixed(7))
    }));

    if (geom.length < 2) continue;

    // Calculate length
    let lengthMeters = 0;
    for (let i = 0; i < geom.length - 1; i++) {
      lengthMeters += haversineDist(
        geom[i].latitude, geom[i].longitude,
        geom[i + 1].latitude, geom[i + 1].longitude
      );
    }
    lengthMeters = Math.round(lengthMeters * 10) / 10;
    if (lengthMeters < 3.0) continue; // Skip negligible sub-3m micro-segments

    const startPoint = geom[0];
    const endPoint = geom[geom.length - 1];
    const bearingDeg = Number(computeBearing(startPoint.latitude, startPoint.longitude, geom[1].latitude, geom[1].longitude).toFixed(1));

    const segId = `s_${way.id}`;
    const startNodeId = `n_${way.nodes ? way.nodes[0] : ('w_' + way.id + '_s')}`;
    const endNodeId = `n_${way.nodes ? way.nodes[way.nodes.length - 1] : ('w_' + way.id + '_e')}`;

    const isOneWay = way.tags?.oneway === 'yes';
    const directionality = isOneWay ? 'forward_only' : 'two_way';
    const speedLimitMps = Number(parseSpeedLimit(way.tags || {}).toFixed(1));
    const roadClass = way.tags?.highway || 'residential';
    const name = way.tags?.name || (roadClass.charAt(0).toUpperCase() + roadClass.slice(1) + ' Road');

    segments.push({
      id: segId,
      name,
      startPoint,
      endPoint,
      lengthMeters,
      bearingDeg,
      directionality,
      oneWay: isOneWay,
      speedLimitMps,
      roadClass,
      startNodeId,
      endNodeId,
      geometry: geom
    });

    // Track bounds
    for (const pt of geom) {
      if (pt.latitude < globalMinLat) globalMinLat = pt.latitude;
      if (pt.latitude > globalMaxLat) globalMaxLat = pt.latitude;
      if (pt.longitude < globalMinLon) globalMinLon = pt.longitude;
      if (pt.longitude > globalMaxLon) globalMaxLon = pt.longitude;
    }

    // Register start and end nodes
    if (!nodeMap.has(startNodeId)) {
      nodeMap.set(startNodeId, {
        id: startNodeId,
        coordinate: startPoint,
        connectedSegmentIds: new Set()
      });
    }
    nodeMap.get(startNodeId).connectedSegmentIds.add(segId);

    if (!nodeMap.has(endNodeId)) {
      nodeMap.set(endNodeId, {
        id: endNodeId,
        coordinate: endPoint,
        connectedSegmentIds: new Set()
      });
    }
    nodeMap.get(endNodeId).connectedSegmentIds.add(segId);
  }

  // Build nodes array
  const nodes = [];
  const intersections = [];

  for (const [nodeId, nData] of nodeMap.entries()) {
    const connArr = Array.from(nData.connectedSegmentIds);
    nodes.push({
      id: nodeId,
      coordinate: nData.coordinate,
      connectedSegmentIds: connArr
    });

    if (connArr.length >= 2) {
      intersections.push({
        nodeId,
        coordinate: nData.coordinate,
        outboundSegmentIds: connArr
      });
    }
  }

  const dataset = {
    metadata: {
      source: "OpenStreetMap contributors",
      license: "ODbL 1.0",
      region: "Coventry, UK",
      bounds: {
        minLat: Number(globalMinLat.toFixed(4)),
        maxLat: Number(globalMaxLat.toFixed(4)),
        minLon: Number(globalMinLon.toFixed(4)),
        maxLon: Number(globalMaxLon.toFixed(4))
      },
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      segmentCount: segments.length,
      nodeCount: nodes.length,
      intersectionCount: intersections.length
    },
    nodes,
    segments,
    intersections
  };

  const outPath = path.join(__dirname, '..', 'assets', 'datasets', 'road_network_coventry.json');
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2), 'utf8');

  const stats = fs.statSync(outPath);
  console.log(`\n=== Successfully Compiled Real Coventry Road Network ===`);
  console.log(`  Segments: ${segments.length}`);
  console.log(`  Nodes: ${nodes.length}`);
  console.log(`  Intersections: ${intersections.length}`);
  console.log(`  File size: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`  Bounds: lat [${dataset.metadata.bounds.minLat}, ${dataset.metadata.bounds.maxLat}], lon [${dataset.metadata.bounds.minLon}, ${dataset.metadata.bounds.maxLon}]`);
}

main();
