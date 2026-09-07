/**
 * generate_coventry_road_pack.js
 *
 * Compiles the Coventry road network dataset into the standardized Offline Region Pack format:
 * assets/region_packs/coventry/manifest.json
 * assets/region_packs/coventry/tiles/*.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STEP_DEG = 0.01;

function getTileKey(lat, lon) {
  const latIdx = Math.floor(lat / STEP_DEG);
  const lonIdx = Math.floor(lon / STEP_DEG);
  const stepInt = Math.round(STEP_DEG * 10000);
  return {
    scheme: 'deg',
    key: `${stepInt}:${latIdx}:${lonIdx}`,
    latIdx,
    lonIdx,
  };
}

function main() {
  const coventryJsonPath = path.join(__dirname, '..', 'assets', 'datasets', 'road_network_coventry.json');
  const outDir = path.join(__dirname, '..', 'assets', 'region_packs', 'coventry');
  const tilesDir = path.join(outDir, 'tiles');

  fs.mkdirSync(tilesDir, { recursive: true });

  const rawDataset = JSON.parse(fs.readFileSync(coventryJsonPath, 'utf8'));
  const segments = rawDataset.segments || [];
  const nodes = rawDataset.nodes || [];
  const intersections = rawDataset.intersections || [];

  const tileMap = new Map();

  for (const seg of segments) {
    const tileKey = getTileKey(seg.startPoint.latitude, seg.startPoint.longitude);
    const serialized = `${tileKey.scheme}:${tileKey.key}`;

    let tile = tileMap.get(serialized);
    if (!tile) {
      const minLat = tileKey.latIdx * STEP_DEG;
      const maxLat = (tileKey.latIdx + 1) * STEP_DEG;
      const minLon = tileKey.lonIdx * STEP_DEG;
      const maxLon = (tileKey.lonIdx + 1) * STEP_DEG;

      tile = {
        key: { scheme: tileKey.scheme, key: tileKey.key },
        bounds: { minLat, maxLat, minLon, maxLon },
        segments: [],
        nodes: [],
        intersections: [],
      };
      tileMap.set(serialized, tile);
    }
    tile.segments.push(seg);
  }

  for (const n of nodes) {
    const tileKey = getTileKey(n.coordinate.latitude, n.coordinate.longitude);
    const serialized = `${tileKey.scheme}:${tileKey.key}`;
    const tile = tileMap.get(serialized);
    if (tile) tile.nodes.push(n);
  }

  for (const ix of intersections) {
    const tileKey = getTileKey(ix.coordinate.latitude, ix.coordinate.longitude);
    const serialized = `${tileKey.scheme}:${tileKey.key}`;
    const tile = tileMap.get(serialized);
    if (tile) tile.intersections.push(ix);
  }

  const tiles = Array.from(tileMap.values());
  const manifestTiles = [];
  let totalBytes = 0;
  let globalMinLat = 90, globalMaxLat = -90, globalMinLon = 180, globalMaxLon = -180;

  for (const tile of tiles) {
    const keyParts = tile.key.key.split(':');
    const safeKey = keyParts.join('_');
    const fileName = `tile_${safeKey}.json`;
    const filePath = path.join(tilesDir, fileName);

    const jsonStr = JSON.stringify(tile, null, 2);
    fs.writeFileSync(filePath, jsonStr, 'utf8');

    const byteSize = Buffer.byteLength(jsonStr, 'utf8');
    totalBytes += byteSize;
    const hash = crypto.createHash('sha256').update(jsonStr).digest('hex').slice(0, 16);

    globalMinLat = Math.min(globalMinLat, tile.bounds.minLat);
    globalMaxLat = Math.max(globalMaxLat, tile.bounds.maxLat);
    globalMinLon = Math.min(globalMinLon, tile.bounds.minLon);
    globalMaxLon = Math.max(globalMaxLon, tile.bounds.maxLon);

    manifestTiles.push({
      key: tile.key,
      fileName: `tiles/${fileName}`,
      bounds: tile.bounds,
      segmentCount: tile.segments.length,
      nodeCount: tile.nodes.length,
      intersectionCount: tile.intersections.length,
      byteSize,
      checksum: hash,
    });
  }

  const manifest = {
    id: 'coventry_uk',
    name: 'Coventry UK Road Network',
    bbox: {
      minLat: globalMinLat,
      maxLat: globalMaxLat,
      minLon: globalMinLon,
      maxLon: globalMaxLon,
    },
    tileScheme: 'deg',
    roadDataVersion: 1,
    source: 'OpenStreetMap contributors',
    license: 'ODbL 1.0',
    createdAt: new Date().toISOString(),
    byteSize: totalBytes,
    checksum: crypto.createHash('sha256').update(JSON.stringify(manifestTiles)).digest('hex').slice(0, 16),
    tiles: manifestTiles,
  };

  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Successfully wrote Coventry pack to ${manifestPath}: ${manifestTiles.length} tiles, ${(totalBytes / 1024).toFixed(1)} KB.`);
}

main();
