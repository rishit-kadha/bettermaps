# BetterMaps — Offline Map & Road Network Download Architecture

## Overview
The BetterMaps offline engine enables dead reckoning (IDR) navigation and map matching without an active cellular or internet connection.

### Legal and Architectural Boundary
To comply with mapping provider Terms of Service (such as Google Maps API TOS Section 3.2.4):
1. **App-Owned Vector Road Network**: Road network topology (nodes, directed segments, speed limits, lane counts, intersections, and multi-point geometries) is packaged, stored, and indexed locally inside BetterMaps.
2. **Visual Basemap Rendering**: Visual basemap rendering relies on standard map SDK tile rendering when online, or vector/cached layers. BetterMaps renders its app-owned road network polylines and routes dynamically on top of the basemap.
3. **No Tile Scraping**: BetterMaps never scrapes or caches proprietary raster/vector tiles from third-party map APIs.

---

## Download UX & Interaction Model

### 1. Offline Regions Modal (`src/components/ui/OfflineRegionsModal.tsx`)
- Displays all currently installed region packs.
- Shows total pack count and cumulative storage footprint.
- Each pack card displays:
  - Pack name and ID
  - Bounding box (SW and NE coordinates)
  - Tile count and segment count
  - Creation timestamp
  - Estimated disk usage (MB)
  - Delete button (`[ Delete ]`) with immediate store synchronization
- Top action bar features a prominent `[ + DOWNLOAD AN AREA ]` button.

### 2. "Download an Area" Framing Modal (`src/components/offline/AreaDownloadModal.tsx`)
Inspired by Google Maps' intuitive offline download workflow:
- **Visual Viewport Framing**: A semi-transparent overlay frames the center 80% width by 50% height viewport, representing the geographic bounding box to be captured.
- **Dynamic Calculation**: As the user pans, zooms, or configures the map, the bounding box coordinates are converted into:
  - Lat/Lon bounds (`minLat`, `maxLat`, `minLon`, `maxLon`)
  - Calculated surface area in square kilometers ($km^2$)
  - Total road network tile cells covered
  - Estimated download / storage footprint (MB)
- **Named Pack Input**: Allows assigning custom labels to the region pack (defaulting to e.g. "Custom Region").
- **Multi-Stage Download State Machine**:
  ```
  [IDLE] ──(Tap Download)──► [PREPARING]
                                  │
                                  ▼
                            [DOWNLOADING] (0% -> 100%)
                                  │
                                  ▼
                             [INDEXING] (Spatial Grid Indexing)
                                  │
                                  ▼
                            [VALIDATING] (Schema & Coordinate Integrity)
                                  │
                                  ▼
                             [INSTALLED] (Pack Registered with Manager)
  ```
- **Live Visual Progress**: Animated progress bar and human-readable status text for each download phase.

---

## Offline Region Storage & Indexing Architecture

```
┌────────────────────────────────────────────────────────┐
│               AreaDownloadModal (UI)                   │
└──────────────────────────┬─────────────────────────────┘
                           │ creates pack descriptor
                           ▼
┌────────────────────────────────────────────────────────┐
│     OfflineRegionPackManager (Singleton Store)         │
│  - registers pack metadata                             │
│  - manages disk allocation                             │
│  - validates bounding box coverage                     │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
┌─────────────────────────┐ ┌─────────────────────────────┐
│  SpatialGridIndex       │ │  RoadDataManager           │
│  - 100m grid cells      │ │  - prefers local pack data  │
│  - O(1) segment lookup  │ │  - bypasses remote fetch    │
└─────────────────────────┘ └─────────────────────────────┘
```

### Pre-Bundled & Default Packs
- **Coventry, UK Benchmark Region**: Bundled by default (`assets/datasets/road_network_coventry.json`), providing 65 segments and 37 topological nodes covering the IO-VNBD benchmark driving trajectory.
- **Custom Downloaded Packs**: Stored in the app document directory and dynamically loaded into the spatial index on demand.
