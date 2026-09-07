# Offline Regional Road Network Packs & Memory Budget Management

## 1. Architectural Overview

BetterMaps incorporates an offline-first regional road network architecture designed to support high-accuracy Bayesian road-constrained Dead Reckoning (IDR) in areas with zero cellular connectivity, dense urban canyons, or during simulated benchmark playback.

Offline regional packs contain pre-compiled topological road graphs (nodes, segments, bearings, speed limits, multi-point polylines, and intersections) partitioned into degree-grid spatial tiles ($0.05^\circ \times 0.05^\circ$).

---

## 2. Source Priority Hierarchy

When a spatial coordinate requires road segment coverage, `RoadDataManager` queries data sources strictly in descending priority order:

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 0: Active RAM Cache (LocalRoadNetworkProvider)        │  Latency: < 0.1 ms
└──────────────────────────────┬──────────────────────────────┘
                               │ Miss
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: Installed Offline Regional Pack (Bundled / Storage)│  Latency: ~1 - 5 ms
└──────────────────────────────┬──────────────────────────────┘
                               │ Miss (Pack not installed)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 2: Persistent Storage Cache (expo-file-system)        │  Latency: ~5 - 15 ms
└──────────────────────────────┬──────────────────────────────┘
                               │ Miss
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: Overpass API (OSM Online Fetch)                    │  Latency: ~200 - 800 ms
└──────────────────────────────┬──────────────────────────────┘
                               │ Error / Offline
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 4: Unavailable (ESKF proceeds unconstrained)          │
└─────────────────────────────────────────────────────────────┘
```

### Strict Network Isolation Invariant
> **CRITICAL RULE:** If an installed offline regional pack covers the requested geographic bounding box, **Overpass API must NEVER be contacted**, even if the network is active. Network requests are strictly reserved for unbundled regions lacking local offline coverage.

### Google Maps Visual Tile Isolation
> **POLICY:** Offline regional packs store **vector road topology and kinematic metadata for the positioning estimator only**. Google Maps visual raster and vector display tiles remain online-only and are strictly subject to Google Maps Platform Terms of Service (zero visual tile scraping or offline caching).

---

## 3. Pack Specification & Directory Structure

Each regional pack is packaged as an isolated directory containing a manifest and tile payloads:

```
assets/region_packs/
├── delhi_ncr/
│   ├── manifest.json
│   ├── tile_28_550_77_150.json
│   ├── tile_28_550_77_200.json
│   └── ... (17 tiles, 45.6 KB total)
└── coventry/
    ├── manifest.json
    ├── tile_52_350_-1_550.json
    ├── tile_52_400_-1_550.json
    └── ... (11 tiles, 65.2 KB total)
```

### 3.1 Manifest Schema (`RegionPackManifest`)
```typescript
interface RegionPackManifest {
  id: string;                      // e.g. "delhi_ncr", "coventry_uk"
  name: string;                    // e.g. "Delhi NCR (Central & South)"
  version: string;                 // e.g. "1.0.0"
  description: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  totalSegments: number;
  totalNodes: number;
  totalSizeBytes: number;
  generatedAt: string;
  tiles: RegionPackTileEntry[];    // Array of tile index records
}

interface RegionPackTileEntry {
  tileKey: string;                 // e.g. "28.550:77.150"
  filename: string;                // e.g. "tile_28_550_77_150.json"
  bounds: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  segmentCount: number;
  nodeCount: number;
  sizeBytes: number;
}
```

### 3.2 Bundled Regional Packs
1. **Delhi NCR (`delhi_ncr`):**
   - **Bounds:** Lat $[28.500, 28.650]$, Lon $[77.100, 77.300]$
   - **Coverage:** Extends from South Delhi residential areas ($28.58^\circ\text{N}, 77.16^\circ\text{E}$) through Connaught Place, India Gate, and Ring Road arteries.
   - **Metrics:** 17 spatial tiles, 45.6 KB on-disk footprint.
2. **Coventry UK (`coventry_uk`):**
   - **Bounds:** Lat $[52.350, 52.450]$, Lon $[-1.600, -1.450]$
   - **Coverage:** Full IO-VNBD benchmark dataset test circuit (Kenilworth Road, Warwick Road, Coventry Ring Road, Earlsdon).
   - **Metrics:** 11 spatial tiles, 65.2 KB on-disk footprint.

---

## 4. Bounded RAM Budget & 3-Tier Memory Management

To guarantee zero out-of-memory (OOM) crashes on low-end edge devices, `RoadDataManager` and `LocalRoadNetworkProvider` enforce a strict **15 MB active RAM budget**.

### 4.1 In-Memory Byte Size Estimation
For every spatial tile loaded into the active road graph:
$$\text{Tile RAM Bytes} = \sum_{\text{seg}} (250 + 40 \times N_{\text{geom}}) + \sum_{\text{node}} 120 + \sum_{\text{ix}} 100$$
This accurately accounts for JavaScript V8/Hermes object wrapper overhead, string keys, and spatial index references.

### 4.2 Three-Tier Memory Pressure States

| State | Memory Utilization | Trigger Threshold | Actions Enforced |
| :--- | :--- | :--- | :--- |
| **NORMAL** | $< 70\%$ | $< 10.5\text{ MB}$ | Standard lookahead prefetching active (ahead, rear, flank tiles). |
| **PRESSURE** | $70\% - 85\%$ | $10.5\text{ MB} - 12.75\text{ MB}$ | Prune unpinned distant tiles; maintain lookahead buffer. |
| **AGGRESSIVE** | $85\% - 100\%$ | $> 12.75\text{ MB}$ | **Suspend speculative lookahead.** Immediately evict rear and furthest tiles outside the immediate $150\text{ m}$ safety radius. Force GC release. |

### 4.3 Distance-Prioritized Eviction
When eviction is triggered:
1. All currently loaded tiles are ranked by Euclidean distance from the vehicle's current position.
2. Pinned tiles (e.g. tiles containing the active planned navigation route) are protected from eviction.
3. Furthest unpinned tiles are removed from both `LocalRoadNetworkProvider` and `SpatialGridIndex` until memory drops below the target safe threshold.

---

## 5. UI Integration & Diagnostics

### 5.1 Diagnostics Panel Metrics
`DiagnosticsPanel.tsx` displays live telemetry cards:
- **ROAD COVERAGE & PREFETCH:**
  - `Source Position`: `LIVE` vs `REPLAY`
  - `Active Region`: Current regional pack ID (e.g. `delhi_ncr` or `coventry_uk`)
  - `Coalesced Skips`: Counter of position updates coalesced to conserve CPU
  - `Last Trigger Reason`: `DISPLACEMENT`, `HEADING`, `SPEED`, `HEARTBEAT`, or `COALESCED`
- **ROAD RAM BUDGET (15 MB):**
  - `Active Tiles`: Count of active tiles in memory
  - `RAM Used / Cap`: Current bytes vs 15 MB limit
  - `Utilization`: Gauge showing real-time % of RAM budget
  - `Pressure State`: `NORMAL`, `PRESSURE`, or `AGGRESSIVE`

### 5.2 Offline Regions Modal (`OfflineRegionsModal.tsx`)
Accessible via the **Offline Packs** pill in `TopHeaderStack.tsx`, allowing users to:
- View all installed and bundled regional packs.
- Inspect geographic bounding boxes, tile counts, and disk storage sizes.
- Verify active source priority order and offline status.
