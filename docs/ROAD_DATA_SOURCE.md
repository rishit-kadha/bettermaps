# Road Network Data Source

## Provider
OpenStreetMap (OSM) contributors

## License
Open Database License (ODbL) v1.0
https://www.openstreetmap.org/copyright

Attribution required: (c) OpenStreetMap contributors

## Redistribution Rights
- Permitted for offline deployment on edge/mobile devices
- Permitted for redistribution within app bundles with attribution
- Permitted for derivative datasets with share-alike requirement
- Cannot remove attribution
- Cannot relicense under a proprietary license

## Dataset
- **File:** `assets/datasets/road_network_coventry.json`
- **Region:** Coventry, United Kingdom
- **Geographic Bounds:** lat [52.385, 52.430], lon [-1.560, -1.480]
- **Generation Method:** Synthetic dataset derived from OSM highway geometry for the IO-VNBD benchmark driving region
- **Schema Version:** 1

## Content
- **65 road segments** covering major and minor roads
- **37 topological nodes** defining segment connectivity
- **36 intersection records** for junction-aware matching
- Road classes: primary, secondary, tertiary, residential, cycleway
- Key roads: Kenilworth Road (A429), Warwick Road (A429/A45), Coventry Ring Road (A4114), Charter Avenue, Albany Road, Earlsdon Avenue, War Memorial Park perimeter, Coventry University campus roads
- One-way streets: Corporation Street, Greyfriars Road, Trinity Street, Fairfax Street, New Union Street
- Speed limits: primary 13.9 m/s (50 km/h), secondary 11.1 m/s (40 km/h), residential 8.3 m/s (30 km/h), campus 5.6 m/s (20 km/h)

## JSON Schema
```json
{
  "metadata": { "source", "license", "region", "bounds", "schemaVersion", "segmentCount", "nodeCount" },
  "nodes": [ { "id", "coordinate", "connectedSegmentIds" } ],
  "segments": [ { "id", "name", "startPoint", "endPoint", "lengthMeters", "bearingDeg",
                  "directionality", "speedLimitMps", "roadClass", "startNodeId", "endNodeId", "geometry" } ],
  "intersections": [ { "nodeId", "coordinate", "outboundSegmentIds" } ]
}
```

## Regeneration
Run `node scripts/generate_coventry_road_network.js` from the project root.
The generator requires no npm packages - pure Node.js.

## Future Expansion
To extend coverage (e.g., entire Coventry city, or West Midlands):
1. Use the Overpass API: https://overpass-turbo.eu
2. Query: `way[highway](bbox)` with the target bounding box
3. Export as GeoJSON and convert with a custom segment extractor
4. Keep provider-neutral: only `LocalRoadNetworkProvider` needs updating, core ESKF unchanged