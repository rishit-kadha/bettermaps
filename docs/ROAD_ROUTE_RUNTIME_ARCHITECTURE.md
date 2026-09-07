# Road/Route Runtime Architecture

## Overview
This document describes the complete runtime pipeline from sensor input through ESKF road/route-constrained positioning.

## Pipeline

```
+----------------------------------------------------------------+
|               Sensor Input (100 Hz)                            |
|  IMU Accelerometer + Gyroscope (body frame)                    |
+---------------------------+------------------------------------+
                            |
                            v
+----------------------------------------------------------------+
|          Learned Motion Model (ML)                             |
|  TinyCausalTCN / LightweightGRU / ShallowMLP (ONNX-ready)    |
|  Output: MotionPrediction { dvBody, dqBody, covBody }          |
+---------------------------+------------------------------------+
                            |
                            v
+----------------------------------------------------------------+
|          15-State ESKF Propagation                             |
|  State: [pos(3), vel(3), att(3), a_bias(3), g_bias(3)]        |
|  Error propagation via F matrix + Q process noise              |
+----------+---------------+------------------------------------+
           |               |
     +-----v-----+   +-----v------+
     |   GNSS    |   |    NHC     |
     | position  |   | zero-lat   |
     | update    |   | vel update |
     +-----+-----+   +-----+------+
           |               |
           +-------+-------+
                   |
                   v
+----------------------------------------------------------------+
|          Multi-Candidate Road Matching                         |
|                                                                |
|  1. Spatial query via SpatialGridIndex (O(1), < 0.1 ms)       |
|     LocalRoadNetworkProvider.findNearbySegments(pos, 45m)      |
|                                                                |
|  2. 5-Factor Bayesian Scoring per candidate:                   |
|     S = S_dist x S_heading x S_topo x S_route x S_dir         |
|                                                                |
|  3. Strict ambiguity gating:                                   |
|     P(C1) >= 0.65  AND  P(C1) - P(C2) >= 0.20                |
+--------------------------+-------------------------------------+
                           |
          +----------------+------------------+
          |                                   |
          v                                   v
+--------------------+           +-----------------------+
|  Road Constraint   |           |   Route Constraint    |
|  (if candidate     |           |   (if active route    |
|   accepted)        |           |    set)               |
|                    |           |                       |
| z = p_proj - p_nom |           | z = p_proj - p_nom    |
| H = [I2 | 0_2x13] |           | H = [I2 | 0_2x13]    |
| R = (s^2 + kd^2)I2|           | R = (sr^2 + kd^2)I2  |
| s_base = 2.5m      |           | s_base = 5.0m         |
| SOFT UPDATE ONLY   |           | SOFT UPDATE ONLY      |
| NO HARD SNAPPING   |           | NO HARD SNAPPING      |
+--------+-----------+           +-----------+-----------+
         +---------------------+-----------+
                               |
                               v
+----------------------------------------------------------------+
|          ESKF Posterior State + Covariance                     |
|  Updated position, velocity, attitude, biases                  |
|  Position uncertainty: s_pos (evolves with road constraint)    |
+----------------------------------------------------------------+
```

## Scoring Factors (5-Factor Bayesian Formula)

| Factor | Symbol | Formula | Notes |
|--------|--------|---------|-------|
| Distance | S_dist | exp(-d^2/2*sigma_d^2), sigma_d=10m | Gaussian decay from road |
| Heading | S_heading | max(0, cos(delta_theta)) | Cosine alignment |
| Topology | S_topo | 1.4x (same seg), 1.3x (adj node), 1.0x (other) | Graph connectivity |
| Route prior | S_route | 1.5x (on route), 1.0x (off route) | Pre-existing trip route |
| Directionality | S_dir | 1.0 (legal bearing), gated (wrong-way) | One-way enforcement via headingDiff |

## Ambiguity Gating Contract (User-Specified, Non-Negotiable)

```
ACCEPT candidate C1 iff:
  P(C1) >= 0.65
  P(C1) - P(C2) >= 0.20
```

If either condition fails, no road/route constraint update is applied - the ESKF propagates unconstrained for that tick.

## Provider Neutrality Guarantee

| Layer | What it sees |
|-------|-------------|
| Eskf | Raw numeric arrays only |
| ProbabilisticRoadConstraint | IRoadNetworkProvider interface |
| ProbabilisticRouteConstraint | LatLonAlt[] polyline only |
| MultiCandidateRoadMatcher | IRoadNetworkProvider interface |
| LocalRoadNetworkProvider | Coventry JSON + SpatialGridIndex |
| SpatialGridIndex | RoadSegment[] array |

The ESKF and road matcher never import Google, MapLibre, OSM, OSRM, SQLite, or any React Native map SDK.

## Offline Guarantee
`LocalRoadNetworkProvider.isOffline()` = `true`
All spatial queries run entirely in-process from the bundled JSON dataset.
Zero network calls at runtime.

## Latency Budget
| Stage | Target | Measured |
|-------|--------|----------|
| SpatialGridIndex queryRadius | < 0.1 ms | < 0.05 ms |
| MultiCandidateRoadMatcher.match() | < 0.5 ms | < 0.3 ms |
| Full ESKF tick (propagate + all updates) | < 1 ms | 0.027 ms mean |
| 100 Hz budget | 10 ms | << headroom |