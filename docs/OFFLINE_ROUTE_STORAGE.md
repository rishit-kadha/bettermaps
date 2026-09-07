# Offline Route Storage Architecture

## Overview
The BetterMaps offline route system provides durable, provider-neutral persistence of pre-existing trip routes that survives app restarts, process kills, and device reboots.

## Architecture

```
IRoutingProvider  (Google Routes, OSRM, Valhalla, Mock)
      |
      v
 NormalizedRoute  (provider-neutral route model)
      |
      v
PersistentOfflineRouteStore  (src/core/navigation/routing/OfflineRouteStore.ts)
      |  <- IStorageDriver contract
      v
 FileStorageDriver  (src/adapters/storage/FileStorageDriver.ts)
      |  <- expo-file-system
      v
  Device Filesystem  (documentDirectory/bettermaps_<namespace>.json)
```

## Components

### IStorageDriver (`src/core/storage/IStorageDriver.ts`)
Generic async key-value storage contract:
- `getItem(key)` -> `string | null`
- `setItem(key, value)` -> `void`
- `removeItem(key)` -> `void`
- `getAllKeys()` -> `string[]`
- `clear()` -> `void`

No Expo, React Native, or SQLite imports - pure interface.

### FileStorageDriver (`src/adapters/storage/FileStorageDriver.ts`)
- Backed by `expo-file-system` (lazy require to avoid Node.js compilation breakage)
- Writes one JSON file per namespace: `documentDirectory/bettermaps_<namespace>.json`
- In-memory cache for fast reads within a session
- Graceful error handling: never throws, falls back to empty store

### PersistentOfflineRouteStore
Async route store with:
- `saveRoute(route)` - validates then persists at key `route:<id>`
- `loadRoute(id)` - reads, parses, re-validates before returning
- `deleteRoute(id)` - removes, clears active pointer if matched
- `listRoutes()` - loads all `route:*` keys
- `hasRoute(id)` - existence check
- `getActiveRoute()` - reads `__active_route_id__` then loads that route
- `setActiveRoute(route | null)` - saves route then sets pointer
- `clearAll()` - wipes entire namespace
- `validateRoute(unknown)` - standalone validation without saving

### Route Validation Rules
1. Route must be a non-null object
2. `id` must be a non-empty string
3. `name` must be a string
4. `sourceProvider` must be a string
5. `totalDistanceMeters` must be a positive finite number < 1,000,000
6. `estimatedDurationSeconds` must be finite
7. `creationTimestampMs` must be finite
8. `polylinePoints` must be an array with >= 2 points
9. Each point must have finite latitude in [-90, 90] and longitude in [-180, 180]

## Route Lifecycle

```
[Online: Fetch route from provider]
         |
[Validate route]
         |
[PersistentOfflineRouteStore.saveRoute()]
         |
[FileStorageDriver.setItem('route:<id>', JSON)]
         |
[Device filesystem: bettermaps_route-store.json]
         |
[App restart / process kill]
         |
[PersistentOfflineRouteStore.getActiveRoute()]
         |
[FileStorageDriver.getItem('__active_route_id__')]
         |
[FileStorageDriver.getItem('route:<id>')]
         |
[Validate & deserialize NormalizedRoute]
         |
[ProbabilisticRouteConstraint.setRoute(route)]
         |
[ESKF soft measurement updates during IDR]
```

## Provider Neutrality
The ESKF, road matcher, and route constraint never import `FileStorageDriver`, `expo-file-system`, or any other platform SDK.
All platform-specific code is isolated in `src/adapters/storage/`.

## Backward Compatibility
The original synchronous in-memory `OfflineRouteStore` remains available and is unchanged.
Existing code that uses the synchronous interface continues to work without modification.