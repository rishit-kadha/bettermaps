# Mobile IDR Architecture Audit & Migration Blueprint

**Document Version:** 1.0.0  
**Audit Date:** September 5, 2026  
**Auditor:** Antigravity Autonomous Navigation & Research Agent  
**Target Systems:** BetterMaps Mobile Positioning Stack (`src/core/positioning/`) vs. Research ESKF Reference (`research/idr/navigation/`)

---

## 1. Executive Summary

This architecture audit establishes the definitive gap analysis between the existing mobile positioning implementation in the React Native / Expo application and the validated 15-state quaternion Error-State Kalman Filter (ESKF) research implementation.

The recent physical device forensic evaluation ([`docs/ROAD_ROUTE_CONSTRAINT_FORENSIC_AUDIT.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/docs/ROAD_ROUTE_CONSTRAINT_FORENSIC_AUDIT.md)) revealed critical structural deficiencies in the mobile positioning stack. This document defines the migration blueprint to replace the mobile kinematic strapdown accumulator with a production-grade, provider-neutral 15-state ESKF architecture.

---

## 2. Comprehensive Stack Audit: Mobile vs. Research

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       FEATURE-BY-FEATURE AUDIT                                         │
├──────────────────────────────┬───────────────────────────────┬─────────────────────────────────────────┤
│ ARCHITECTURAL DIMENSION      │ CURRENT MOBILE (`src/`)       │ RESEARCH REFERENCE (`research/idr/`)   │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Core Estimator Architecture  │ Kinematic ENU strapdown       │ 15-state quaternion Error-State Kalman  │
│                              │ accumulator ($v \Delta t \sin\theta$)│ Filter with continuous covariance       │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ State Representation         │ 2D ENU position ($E, N$) +    │ 16-element nominal state:               │
│                              │ scalar heading ($\theta$)      │ [p_enu(3), v_enu(3), q_nb(4), ba(3), bg(3)]│
│                              │ No velocity or bias state     │ 15-element error state vector           │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Uncertainty Tracking         │ Heuristic scalar confidence   │ Full 15x15 covariance matrix ($P$)      │
│                              │ No covariance propagation     │ Continuous process noise ($Q_c$)        │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ GNSS Ingestion               │ Hard direct overwrite:        │ Bayesian Kalman measurement update:     │
│                              │ currentEastMeters = enu.east  │ z = p_gnss - p_nom, H = [I3, 0], R=25*I │
│                              │ Instantaneous state snap      │ Innovation-based state correction       │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Learned Motion Integration   │ Heuristic velocity integrator │ Rigorous projection measurement:        │
│                              │ Replaces longitudinal speed   │ z_v = v_model - R_bn[0]*v_n             │
│                              │ directly                      │ H derived from rotation kinematics      │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Non-Holonomic (NHC)          │ None                          │ Soft zero lateral/vertical velocity     │
│ Constraints                  │                               │ z = -v_b[1:3], R = diag(0.35^2, 0.20^2) │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Route Constraint             │ Bounded heuristic vector pull │ Soft pseudo-observation update in ESKF: │
│                              │ Output assigned to display;   │ z = p_proj - p_nom[0:2]                 │
│                              │ internal accumulator discarded│ R = (sigma_base^2 + (0.5*d)^2) * I2     │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Road Network Graph           │ None (Only reference polyline)│ None (Only polyline arrays)             │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Candidate Selection          │ Global brute-force min dist   │ Single polyline closest point           │
│                              │ Hard 30m gating cutoff        │ Single polyline closest point           │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Route Prior Origin           │ Built directly from full      │ Given as a-priori array                 │
│                              │ reference trajectory (leak!)  │                                         │
├──────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Provider Neutrality          │ Leaks Google Maps types into  │ Completely provider-neutral             │
│                              │ positioning adapters          │                                         │
└──────────────────────────────┴───────────────────────────────┴─────────────────────────────────────────┤
```

---

## 3. Reusable vs. Newly Ported Components

### 3.1 Reusable Components (Keep & Adapt)

- **Sensor Ingestion Layer (`src/adapters/imu/`, `src/adapters/location/`)**:
  - `AndroidImuProvider.ts` and `AndroidGnssLocationProvider.ts` correctly ingest physical sensor events.
  - Device-to-vehicle channel mapping in `motionEstimator.ts` correctly handles the IO-VNBD portrait windshield mount (pitch rate $\to$ vehicle yaw rate).
- **Learned Motion Model Adapters (`src/core/positioning/motionEstimator.ts`)**:
  - `LearnedMotionEstimator` ingestion of 6-channel sliding windows, Z-score normalization, and inference orchestration.
  - Can be seamlessly connected behind the runtime-neutral `MotionPrediction` interface.
- **Geodesic Math Utilities (`src/core/positioning/coordinates.ts`)**:
  - `haversineDistance`, `wgs84ToEnu`, `enuToWgs84` are verified and mathematically sound.
- **PositionEstimate Contract (`src/core/types/positioning.ts`)**:
  - Interface contract (`IPositioningEngine`, `PositionEstimate`) is already well-designed; the internal engine implementation will be swapped without breaking UI consumers.

### 3.2 Newly Ported & Created Components (The New Mobile ESKF Architecture)

1. **`src/core/positioning/eskf/`**:
   - `EskfTypes.ts`: 16-element nominal state, 15-element error state, measurement interfaces.
   - `EskfConfig.ts`: Noise densities, random walk variances, gating thresholds.
   - `EskfMath.ts`: Quaternion algebra, skew-symmetric matrices, closed-form matrix inversions ($1 \times 1$, $2 \times 2$, $3 \times 3$), Joseph-form covariance updates.
   - `EskfMeasurements.ts`: Jacobians and residuals for GNSS, ML motion, NHC, and soft polyline constraints.
   - `Eskf.ts`: Production mobile ESKF engine with propagation, update, and stabilization.
2. **`src/core/navigation/routing/`**:
   - `RoutingTypes.ts`: Provider-neutral `NormalizedRoute`, `RouteWaypoint`, `RouteSegment`.
   - `IRoutingProvider.ts`: Interface isolating routing calculations.
   - `OfflineRouteStore.ts`: Local route caching and session association.
3. **`src/core/navigation/road/`**:
   - `RoadTypes.ts`: `RoadSegment`, `RoadCandidate`, `CandidateScoring`.
   - `IRoadNetworkProvider.ts`: Offline-first road graph provider interface.
   - `MultiCandidateRoadMatcher.ts`: Multi-hypothesis candidate selection with confidence gating and along-track continuity.
4. **`src/core/positioning/EskfPositioningEngine.ts`**:
   - Production positioning engine implementing `IPositioningEngine` that drives the ESKF, applies continuous Bayesian updates, and feeds corrections back into the persistent filter state.

---

## 4. Coordinate Conventions & Transformation Pipeline

The frozen coordinate transformation chain is formalized as follows:

```
[Phone Sensor Body Frame (S)]
       │
       ▼  R_bs (Mounting Calibration / Device-to-Vehicle Channel Mapping)
[Vehicle Body Frame (B: +X Fwd, +Y Left, +Z Up)]
       │
       ▼  R_nb = R(q_nb) (Body-to-Navigation Quaternion Rotation)
[Local Tangent Navigation Frame (N: +X East, +Y North, +Z Up)]
       │
       ▼  Geodetic Projection (Ellipsoidal / Spherical WGS84)
[Geographic WGS84 Frame (Latitude, Longitude, Altitude)]
```

### Key Convention Rules

- **Attitude Quaternion**: Scalar-first $\mathbf{q}_{nb} = [w, x, y, z]^T$, representing active rotation from body frame $\mathcal{F}_b$ to navigation frame $\mathcal{F}_n$.
- **Attitude Error**: Body-frame right-multiplicative error: $\mathbf{q}_{nb} = \hat{\mathbf{q}}_{nb} \otimes \delta \mathbf{q}(\delta \vec{\theta})$.
- **Gravity Vector**: $\vec{g}_n = [0, 0, -9.80665]^T\,\text{m/s}^2$ in local ENU.
- **Velocity Vector**: $\vec{v}_n = [v_{\text{east}}, v_{\text{north}}, v_{\text{up}}]^T\,\text{m/s}$ in local ENU.

---

## 5. Frozen Measurement Models & Jacobians

All measurement equations are frozen in [`docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md). A summary is provided below:

### 5.1 Learned Forward Velocity Observation

- **Measurement Equation**:
  $$z_v = v_{\text{pred}} - \hat{\vec{v}}_b[0], \quad \hat{\vec{v}}_b = \hat{R}_{nb}^T \hat{\vec{v}}_n$$
- **Jacobian ($H_v \in \mathbb{R}^{1 \times 15}$)**:
  $$H_v = \begin{bmatrix} 0_{1 \times 3} & \hat{R}_{bn}[0, :] & (-[\hat{\vec{v}}_b]_\times)_{0, :} & 0_{1 \times 3} & 0_{1 \times 3} \end{bmatrix}$$
- **Covariance**: $R_v = \sigma_{v_{\text{pred}}}^2$.

### 5.2 Non-Holonomic Constraints (NHC)

- **Measurement Equation**:
  $$\vec{z}_{\text{nhc}} = -\hat{\vec{v}}_b[1:3] \in \mathbb{R}^2$$
- **Jacobian ($H_{\text{nhc}} \in \mathbb{R}^{2 \times 15}$)**:
  $$H_{\text{nhc}} = \begin{bmatrix} 0_{2 \times 3} & \hat{R}_{bn}[1:3, :] & (-[\hat{\vec{v}}_b]_\times)_{1:3, :] & 0_{2 \times 3} & 0_{2 \times 3} \end{bmatrix}$$
- **Covariance**: $R_{\text{nhc}} = \text{diag}(0.35^2, 0.20^2)\,\text{m}^2/\text{s}^2$.

### 5.3 GNSS Position Observation

- **Measurement Equation**:
  $$\vec{z}_{\text{pos}} = \vec{p}_{\text{gnss}} - \hat{\vec{p}}_n \in \mathbb{R}^3$$
- **Jacobian ($H_{\text{pos}} \in \mathbb{R}^{3 \times 15}$)**:
  $$H_{\text{pos}} = \begin{bmatrix} I_3 & 0_{3 \times 12} \end{bmatrix}$$
- **Covariance**: $R_{\text{pos}} = \sigma_{\text{gnss}}^2 I_3$.

### 5.4 Soft Road / Route Position Constraints

- **Measurement Equation**:
  $$\vec{z}_{\text{poly}} = \vec{p}_{\text{target}}[0:2] - \hat{\vec{p}}_n[0:2] \in \mathbb{R}^2$$
- **Jacobian ($H_{\text{poly}} \in \mathbb{R}^{2 \times 15}$)**:
  $$H_{\text{poly}} = \begin{bmatrix} I_2 & 0_{2 \times 13} \end{bmatrix}$$
- **Residual-Inflated Covariance**:
  $$R_{\text{poly}} = I_2 \cdot \left(8.0^2 + (0.50 \cdot \|\vec{z}_{\text{poly}}\|)^2\right)\,\text{m}^2$$

---

## 6. Provider Neutrality & Data Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                   External Map / Routing Providers                     │
│    (Google Maps SDK, Google Routes, MapLibre, OSRM, GraphHopper)      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Adapter Translation Layer
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Provider-Neutral Abstraction Layer                   │
│           (src/core/navigation/routing/ & src/core/navigation/road/)   │
│   NormalizedRoute, RoadSegment, RoadCandidate, IOfflineRouteStore       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Clean Normalized Geometry
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  IDR Positioning & Constraint Core                     │
│               (src/core/positioning/ & src/core/positioning/eskf/)     │
│   EskfPositioningEngine, Eskf, ProbabilisticRouteConstraint            │
│   NO dependencies on Google, MapLibre, or specific rendering engines   │
└────────────────────────────────────────────────────────────────────────┘
```

### Architectural Guardrails

1. **Zero Provider SDK Imports in `src/core/`**: No imports of `@react-native-maps`, `@google/`, `@maplibre/`, or external network protocols inside any file under `src/core/`.
2. **Offline-First Contract**: `IRoadNetworkProvider` and `IOfflineRouteStore` operate seamlessly from local memory, JSON caches, or embedded spatial indices without network calls.
3. **Reference vs. Route Separation**:
   - `ReferenceTrajectory`: Type strictly reserved for offline benchmarking and post-hoc ATE evaluation.
   - `PreExistingRoute`: Type representing a pre-trip navigation plan created prior to GNSS outage.
   - The estimator will throw or fail lint if `ReferenceTrajectory` is passed to any positioning method.

---

## 7. Migration Execution Plan

With this architecture audit and mathematical specification frozen, implementation proceeds sequentially across the following phases:

1. **Step 1:** Implement `src/core/positioning/eskf/` core modules (`EskfMath.ts`, `EskfTypes.ts`, `EskfConfig.ts`, `EskfMeasurements.ts`, `Eskf.ts`).
2. **Step 2:** Write deterministic TypeScript unit tests and run golden-vector comparison against Python reference (`tests/golden/EskfGoldenVector.test.ts`).
3. **Step 3:** Implement provider-neutral abstractions (`IRoutingProvider.ts`, `IRoadNetworkProvider.ts`, `OfflineRouteStore.ts`, `MultiCandidateRoadMatcher.ts`).
4. **Step 4:** Implement `ProbabilisticRouteConstraint.ts` and `ProbabilisticRoadConstraint.ts` with confidence gating.
5. **Step 5:** Construct `EskfPositioningEngine.ts` and integrate it into `IovnbdReplaySource.ts` and `NavigationManager.ts`.
6. **Step 6:** Execute physical-device validation on OnePlus Nord CE4 and evaluate ablation modes R0 through R6.
