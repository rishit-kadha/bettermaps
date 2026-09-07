# BetterMaps Final Estimator Configuration & Evaluation Modes

## 1. Executive Summary

This document specifies the official configuration, architecture, and evaluation semantics for the **BetterMaps Final Inertial Dead-Reckoning (IDR) Estimator**.

Prior to this specification, the Replay Lab UI exposed an internal research ladder of historical experimental stages (`R0` through `R6`). While valuable during iterative development, exposing seven incremental stages created ambiguity regarding which configuration represented the shipping production estimator versus research ablations.

The Replay Lab interface and evaluation wiring have now been consolidated into **two canonical evaluation modes**:

1. **`FINAL IDR`** (Production Estimator: Learned ML + 15-State ESKF + NHC + Road Network + Route Context)
2. **`FINAL IDR · ROAD OFF`** (Road Ablation: Strict One-Variable Invariant isolating road network influence)

Historical modes (`C0` through `R6`) remain accessible via a secondary, collapsible diagnostic accordion for backwards compatibility and regression analysis.

---

## 2. Canonical Evaluation Modes

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   REPLAY LAB EVALUATION MODES                               │
├──────────────────────────────────────────────────────────────┬──────────────────────────────┤
│  Card 1: FINAL IDR                                           │  Card 2: FINAL IDR · ROAD OFF│
│  Badge: PRODUCTION                                           │  Badge: ROAD ABLATION        │
│  Sub: ROAD + ROUTE                                           │  Sub: ROUTE ONLY             │
│  Desc: TCN + ESKF + NHC + Road                               │  Desc: TCN + ESKF + NHC (Off)│
│  Pipeline: ML ✓  ESKF ✓  NHC ✓  ROAD ✓ (N)  ROUTE ✓          │  Pipeline: ML ✓ ... ROAD OFF │
└──────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

### 2.1 Mode 1: `FINAL IDR` (Production Estimator)

The `FINAL IDR` mode represents the complete, shipping BetterMaps vehicular dead-reckoning engine running on mobile edge hardware:

- **Learned Motion Model (ML):** Causal Temporal Convolutional Network (`TinyCausalTCN`) running at 100 Hz on device IMU streams (accelerometer and gyroscope). Outputs vehicle-frame velocity increments $\Delta v_{body}$, attitude increments $\Delta q_{body}$, and dynamic covariance matrices.
- **15-State Error-State Kalman Filter (ESKF):** True 15-dimensional state tracking position $\mathbf{p} \in \mathbb{R}^3$, velocity $\mathbf{v} \in \mathbb{R}^3$, attitude error $\boldsymbol{\theta} \in \mathbb{R}^3$, accelerometer bias $\mathbf{b}_a \in \mathbb{R}^3$, and gyroscope bias $\mathbf{b}_g \in \mathbb{R}^3$.
- **Non-Holonomic Constraints (NHC):** Zero lateral velocity and zero vertical velocity updates in the vehicle chassis frame ($v_{body,y} \approx 0, v_{body,z} \approx 0$), mitigating lateral slippage and vertical drift.
- **Offline Road Network Context (`roadConstraintEnabled = true`):** Real-time spatial query via `SpatialGridIndex` ($O(1)$ amortized, $<0.1\,\text{ms}$) against the bundled offline road graph (`LocalRoadNetworkProvider`). 5-factor Bayesian candidate scoring (`MultiCandidateRoadMatcher`) evaluates distance, heading alignment, speed limit consistency, road class, and topological continuity. Passing candidates execute soft Bayesian measurement updates (`ProbabilisticRoadConstraint`) into the ESKF error state with adaptive observation noise $\mathbf{R}_{road}$.
- **Probabilistic Route Context (`routeConstraintEnabled = true`):** If an active navigation route exists (`OfflineRouteStore`), the trajectory is projected onto the route polyline with progress gating to constrain cross-track error.
- **GNSS Drop & Recovery Schedule:**
  - $t \in [0, 20\,\text{s}]$: Pre-outage anchoring with real GNSS fixes to establish initial filter convergence and bias estimation.
  - $t \in [20\,\text{s}, t_{end}]$: Complete simulated GNSS outage (zero GNSS position or velocity fixes injected). Estimator relies purely on IMU + ML + NHC + Road + Route constraints.
  - Zero reference coordinate leakage: Reference trajectory coordinates are strictly isolated for ground-truth RMSE computation and are never leaked to the filter state.

### 2.2 Mode 2: `FINAL IDR · ROAD OFF` (Road Ablation)

The `FINAL IDR · ROAD OFF` mode is the scientific control designed to rigorously measure the marginal value of the road network:

- **Strict One-Variable Invariant:** Identical to `FINAL IDR` in every way except `roadConstraintEnabled = false`.
  - Identical ML model weights and execution (`TinyCausalTCN`).
  - Identical 15-state ESKF configuration, process noise $\mathbf{Q}$, and initial covariance $\mathbf{P}_0$.
  - Identical NHC lateral/vertical velocity updates.
  - Identical 20-second pre-outage GNSS anchoring and outage start timestamp.
  - Identical route constraint logic (if route is active).
  - Identical scoring, distance calculations, and milestone evaluation.
- **Isolation of Road Benefit:** Because all other variables are locked, any difference in positioning accuracy between `FINAL IDR` and `FINAL IDR · ROAD OFF` is mathematically attributable exclusively to the road-network constraint engine.

---

## 3. End-to-End Runtime Pipeline & Dataflow

```
                             ┌───────────────────────────────────┐
                             │       IMU Sensors (100 Hz)        │
                             │  Accelerometer + Gyroscope (Body) │
                             └─────────────────┬─────────────────┘
                                               │
                                               ▼
                             ┌───────────────────────────────────┐
                             │    Learned Motion Model (TCN)     │
                             │   Predicts Δv_body, Δq_body, Cov  │
                             └─────────────────┬─────────────────┘
                                               │
                                               ▼
                             ┌───────────────────────────────────┐
                             │    15-State ESKF Propagation      │
                             │  State: [pos, vel, att, ba, bg]   │
                             │  Covariance: P = F P F^T + Q      │
                             └──────────┬──────────────┬─────────┘
                                        │              │
                    ┌───────────────────┘              └────────────────────┐
                    ▼                                                       ▼
      ┌───────────────────────────┐                           ┌───────────────────────────┐
      │   NHC Measurement Update  │                           │   GNSS Measurement Update │
      │   v_body,y ≈ 0, v_body,z ≈ 0│                          │   Anchoring (t ≤ 20s)     │
      └─────────────┬─────────────┘                           │   OUTAGE (t > 20s): DROPPED   │
                    │                                         └─────────────┬─────────────┘
                    └───────────────────────┬───────────────────────────────┘
                                            │
                                            ▼
                    ┌────────────────────────────────────────────────────────┐
                    │               ROAD CONSTRAINT GATE                     │
                    │         if (roadConstraintEnabled === true)            │
                    └───────────────────────┬────────────────────────────────┘
                                            │
                       ┌────────────────────┴────────────────────┐
                 [Mode: FINAL IDR]                    [Mode: FINAL IDR · ROAD OFF]
                       │                                         │
                       ▼                                         ▼
         ┌───────────────────────────┐             ┌───────────────────────────┐
         │ SpatialGridIndex Query    │             │  Road Update Bypassed     │
         │ Candidate Scoring (5-fac) │             │  (Pure IMU + ML + NHC)    │
         │ ProbabilisticRoadConstraint│             └───────────────────────────┘
         │ ESKF Soft Update (H_road) │
         └─────────────┬─────────────┘
                       │
                       ▼
         ┌───────────────────────────┐
         │ ProbabilisticRouteConstr. │
         │ (Active Route Polyline)   │
         └─────────────┬─────────────┘
                       │
                       ▼
         ┌───────────────────────────┐
         │ Corrected 15-State Output │
         │  [Lat, Lon, Alt, Heading] │
         └───────────────────────────┘
```

---

## 4. Telemetry & Diagnostic Interface

The Replay Lab interface displays real-time execution telemetry reflecting the internal estimator state:

```typescript
export interface ReplayTelemetry {
  // Replay playback status
  isPlaying: boolean;
  speed: number;
  elapsedTimeMs: number;
  totalDurationMs: number;
  sessionId: string;

  // Active configuration
  mode: ExperimentMode; // Internal mode enum (R6_FULL_DROP_RECOVERY)
  evaluationMode: EvaluationMode; // "FINAL_IDR" | "FINAL_IDR_ROAD_ABLATION"
  roadConstraintEnabled: boolean; // true in FINAL_IDR, false in ROAD_ABLATION
  routeConstraintEnabled: boolean; // true when route is active

  // Real-time update counters (monotonic)
  roadUpdateCount: number; // Total soft ESKF road updates applied
  routeUpdateCount: number; // Total soft ESKF route updates applied

  // Error and milestone metrics
  positionErrorMeters: number;
  driftRatioPercent: number;
  milestones: {
    at5s?: number;
    at10s?: number;
    at20s?: number;
    at30s?: number;
    at60s?: number;
  };
}
```

### 4.1 Diagnostic Pipeline Indicators

The Replay HUD features a dedicated diagnostics row:

- In **`FINAL IDR`**:
  `[ML ✓]  [ESKF ✓]  [NHC ✓]  [ROAD ✓ (N)]  [ROUTE ✓]`
  - `ROAD ✓` renders with a green accent and includes the dynamic applied update counter `(N)`.
- In **`FINAL IDR · ROAD OFF`**:
  `[ML ✓]  [ESKF ✓]  [NHC ✓]  [ROAD OFF]  [ROUTE ✓]`
  - `ROAD OFF` renders in high-contrast red (`#EF5350`) to provide instant visual verification that road updates are inhibited.

---

## 5. Backwards Compatibility with Historical Modes (C0–R6)

For regression testing and granular ablation analysis, the historical research modes remain accessible via the `▼ Historical Modes (C0–R6)` collapsible accordion:

| Internal Mode ID        | Label in UI       | Description                                                    |
| :---------------------- | :---------------- | :------------------------------------------------------------- |
| `C0_REFERENCE_ONLY`     | `C0 · Ref Only`   | Reference trajectory only; zero estimator propagation          |
| `R0_PURE_IMU_RAW`       | `R0 · Pure IMU`   | Double integration of raw IMU without ML or ESKF corrections   |
| `R1_IMU_ESKF_NO_ML`     | `R1 · ESKF No ML` | Traditional 15-state ESKF with zero-velocity updates but no ML |
| `R2_IMU_ML_ESKF`        | `R2 · ML + ESKF`  | Learned TCN motion model + 15-state ESKF                       |
| `R3_DROP_RECOVERY`      | `R3 · Outage`     | Learned ML + ESKF + 20s GNSS Drop & Recovery schedule          |
| `R4_IMU_ML_NHC_ROAD`    | `R4 · Road`       | Learned ML + ESKF + NHC + Road Network updates                 |
| `R5_IMU_ML_NHC_ROUTE`   | `R5 · Route Est`  | Learned ML + ESKF + NHC + Route Context updates                |
| `R6_FULL_DROP_RECOVERY` | `R6 · Full`       | Full stack (ML + ESKF + NHC + Road + Route + Outage Schedule)  |

When a user taps either canonical evaluation card, the internal engine automatically sets `R6_FULL_DROP_RECOVERY` and configures `roadConstraintEnabled` accordingly, maintaining complete harmony between legacy and modern APIs.
