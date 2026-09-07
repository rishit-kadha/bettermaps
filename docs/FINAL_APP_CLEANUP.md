# BetterMaps — Final App Cleanup & SIH-Demo Polish Pass

## Overview
This document summarizes the changes completed during the **Final App Cleanup & SIH-Demo Polish Pass** for the Smart India Hackathon (SIH) demonstration and evaluation.

The goal of this pass was to turn the working prototype into a clean, coherent, and standalone dead reckoning (IDR) navigation application ready for presentation to jury members and technical evaluators.

---

## Key Changes & Polish Highlights

### 1. Header Cleanup
- **Live GNSS Pill Removed**: Removed the redundant green `[ Live GNSS: ON ]` pill from the top header stack (`src/components/navigation/TopHeaderStack.tsx`).
- **Streamlined Top Bar**: The top bar now cleanly showcases only the essential global controls:
  - `[ Diagnostics ]` (Left button)
  - `[ Offline Packs ]` (Right button)
- **Status Moved to Diagnostics**: Real-time GNSS lock status, fix age, satellite count, and fused coordinates are now located logically inside the dedicated Diagnostics Panel.

### 2. Diagnostics Panel Overhaul
- **Modern Bottom Sheet UX**: Converted from an overflowing modal into a modern 48% height bottom sheet with rounded top corners (`borderTopLeftRadius: 20`, `borderTopRightRadius: 20`, elevation 24) and an interactive drag handle pill (`width: 40, height: 4`).
- **Scannable Sectional Layout**: Organized into 6 distinct, structured diagnostic domains:
  1. **Positioning & Estimation**: Engine status, IDR DR status, heading, speed, covariance/accuracy.
  2. **AI Model (B3_GRU ONNX)**: Model runtime state, inference latency (ms), total inferences, window fill %, predicted forward speed.
  3. **Road Coverage & Prefetch**: Source position, region code, planner strategy, active cached tiles, cache hit count, coalescing skips.
  4. **Replay Benchmark & Drift**: Active session ID, virtual clock, reference distance, instantaneous positioning error (m), SIH Drift Ratio (%).
  5. **GNSS & Sensor Fusion**: Fix age, fix count, ESKF measurement updates, raw GNSS vs ESKF fused state comparisons.
  6. **Performance & RAM Budget**: Update frequency (Hz), road network RAM usage vs 15 MB budget, memory pressure status, cache eviction count.

### 3. Replay HUD Streamlining
- **Removed Deprecated Pipelines**: Removed historical/experimental pipeline modes (C0–R6), custom model selectors, and internal estimator tuning dials from the demonstration HUD.
- **Fixed Production Badge**: Replaced clutter with a clean badge: `FINAL IDR (GRU ✓ · ESKF ✓ · NHC ✓)`.
- **Fixed 1x Speed Indicator**: Replaced the multi-pill speed selector (`0.25x–5x`) with a fixed `[ 1x ]` indicator reflecting deterministic real-time benchmark playback.
- **Action Control Row**:
  - `[ Route ]`: Toggles display of the generated route polyline and destination pin.
  - `[ Reference ]`: Toggles the ground truth trajectory polyline.
  - `[ IDR Trace ]`: Toggles the dead reckoning estimated trajectory polyline.
  - `[ Roads ]`: Toggles the vector road network overlay.
- **Quantitative Evaluation Card**: Real-time error metric display featuring Position Error (m), Reference Distance (m), and SIH Drift Ratio (%).
- **Milestone Metrics**: Visual milestone chips tracking cumulative drift at key time intervals:
  - `5s`: Error & Drift %
  - `10s`: Error & Drift %
  - `20s`: Error & Drift %
  - `30s`: Error & Drift %
  - `60s`: Error & Drift %

### 4. Road Network & Replay Route Coordination
- **Route Synthesis from Fixture**: When starting a replay benchmark session, `IovnbdReplaySource` automatically downsamples fixture waypoints and generates a valid `ActiveRoute` and `NormalizedRoute`.
- **Dynamic Road Prefetching Feed**: The synthesized route and simulated vehicle positions are fed into `RoadDataManager`, triggering realistic road tile prefetching and map matching along the route.
- **Map Polyline Rendering**: `MapContainer` receives `activeRoute` from replay, rendering the route polyline and destination marker on the basemap.

### 5. Offline Map Area Selection & Download UX
- **Area Framing Tool**: Added `AreaDownloadModal` providing an intuitive "Download an Area" UX (similar to Google Maps offline downloads).
- **Interactive Bounds Selection**: Dynamic rectangular viewport calculation allowing users to frame a specific geographic region.
- **Resource Estimates**: Real-time calculation of geographic bounding box, estimated area ($km^2$), tile count, and download size (MB).
- **Multi-Stage Download Machine**: Realistic state progression (`Preparing` $\rightarrow$ `Downloading` $\rightarrow$ `Indexing` $\rightarrow$ `Validating` $\rightarrow$ `Installed`).
- **Unified Region Pack Storage**: Downloaded packs are automatically registered with `offlineRegionPackManager` and can be inspected or deleted from the `Offline Regions` modal.

---

## Architectural Guarantees
- **Strict Separation of Concerns**: Core estimation algorithms (ESKF, GRU, NHC) remain untouched.
- **Zero Google Maps Scraped Tiles**: Visual map tiles are loaded via legal online SDKs; app-owned road network vector geometry is rendered on top.
- **Offline Durability**: Downloaded packs and persistent route stores survive app restarts and process kills.
- **Standalone Release Build**: Packaged into a self-contained Android Release APK with bundled JavaScript assets and ONNX neural network models.
