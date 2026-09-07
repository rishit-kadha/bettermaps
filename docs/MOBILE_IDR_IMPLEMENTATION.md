# Mobile 15-State Quaternion Error-State Kalman Filter (ESKF) Implementation

**Authoritative Technical Documentation & Numerical Verification**  
_Project: BetterMaps / Seamless IDR_  
_Target Environment: React Native (Expo SDK 57), Node.js v24, Mobile Edge (Android / iOS)_

---

## 1. Executive Summary

This document describes the portable, provider-neutral 15-state quaternion Error-State Kalman Filter (ESKF) positioning engine implemented in `src/core/positioning/eskf/` and `src/core/positioning/EskfPositioningEngine.ts`.

It completely replaces the former direct 2D kinematic dead-reckoning accumulator with a mathematically rigorous Bayesian estimator mirroring the research architecture in `research/idr/navigation/`.

### Key System Guarantees

1. **Exact Mathematical Consistency**: Nominal state propagation, discrete transition matrix $\Phi = I_{15} + F \Delta t$, diagonalized continuous process noise $Q_d = G Q_c G^T \Delta t$, and analytical observation Jacobians match `research/idr/navigation/eskf.py` and `docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md`.
2. **Zero External Linear Algebra Dependencies**: Implemented in portable TypeScript without external libraries (`mathjs`, `numeric`, `eigen`). Small innovation matrices ($1\times 1, 2\times 2, 3\times 3$) are inverted via closed-form analytical determinants and Cramer's rule.
3. **Joseph-Form Covariance Stabilization**: Guarantees positive semi-definiteness ($P \succ 0$) and diagonal variance floor clamping ($\ge 10^{-12}$) to eliminate numerical degradation under 64-bit IEEE 754 floating-point arithmetic.
4. **Bayesian Soft Polyline Updates**: Road and route constraints are injected directly into the filter via formal observation models ($H_{\text{poly}} = [I_2, 0_{2\times 13}]$) with residual-inflated covariance $R_{\text{poly}} = (\sigma_{\text{base}}^2 + (\kappa d_\perp)^2) I_2$, eliminating non-Bayesian hard coordinate snapping.
5. **Strict Confidence & Margin Ambiguity Gating**: Multi-candidate road matcher accepts candidates only when $P(C_1) \ge 0.65$ and margin $P(C_1) - P(C_2) \ge 0.20$.
6. **Sub-Millisecond Execution**: Average tick latency is **$0.0276\,\text{ms}$ ($27.6\,\mu\text{s}$)**—over $36\times$ faster than the $1.0\,\text{ms}$ real-time mobile budget.
7. **Strict Provider Neutrality**: Core positioning and navigation code (`src/core/`) contains **zero** third-party map, tile, or routing SDK dependencies.

---

## 2. System Architecture & Information Dataflow

```
                     Sensor Input (Phone Accelerometer & Gyroscope)
                                          ↓
                      Vehicle-Frame Preprocessing (Coordinate Alignment)
                                          ↓
                           Eskf.propagate(IMU, dt)
                                          ↓
             ┌─────────────────────────────────────────────────────────┐
             │            Learned Motion Model Inference               │
             │       (Tiny Causal TCN / Lightweight GRU / MLP)         │
             └─────────────────────────────────────────────────────────┘
                                          ↓
              Eskf.updateForwardVelocity() & Eskf.updateYawRate()
                                          ↓
                       Eskf.updateNhc() (v_lat ≈ 0, v_vert ≈ 0)
                                          ↓
           ┌──────────────────────────────┴──────────────────────────────┐
           │                                                             │
  Probabilistic Road Network Constraint        Probabilistic Route Constraint
   (MultiCandidateRoadMatcher hypotheses)       (A priori trip polyline prior)
   Confidence >= 0.65, Margin >= 0.20           Along-track continuity gate
           │                                                             │
           └──────────────────────────────┬──────────────────────────────┘
                                          ↓
                       Posterior State & Covariance Extraction
                                          ↓
                    Normalized PositionEstimate (WGS84, Speed, Heading)
```

---

## 3. Mathematical State Formulation

### 3.1 Nominal State Vector ($\mathbf{x}_{\text{nom}} \in \mathbb{R}^{16}$)

$$\mathbf{x}_{\text{nom}} = \begin{bmatrix} \vec{p}_n^T & \vec{v}_n^T & \mathbf{q}_{nb}^T & \vec{b}_a^T & \vec{b}_g^T \end{bmatrix}^T$$

- $\vec{p}_n = [p_E, p_N, p_U]^T \in \mathbb{R}^3$: Metric position in local East-North-Up (ENU) frame (meters).
- $\vec{v}_n = [v_E, v_N, v_U]^T \in \mathbb{R}^3$: Metric velocity in local ENU frame (m/s).
- $\mathbf{q}_{nb} = [q_w, q_x, q_y, q_z]^T \in \mathbb{H}$: Scalar-first unit quaternion rotating vectors from vehicle body frame ($b$) to local ENU navigation frame ($n$): $\vec{v}_n = R_{nb} \vec{v}_b$.
- $\vec{b}_a = [b_{ax}, b_{ay}, b_{az}]^T \in \mathbb{R}^3$: Accelerometer sensor bias in vehicle body frame ($\text{m/s}^2$).
- $\vec{b}_g = [b_{gx}, b_{gy}, b_{gz}]^T \in \mathbb{R}^3$: Gyroscope sensor bias in vehicle body frame ($\text{rad/s}$).

### 3.2 Error State Vector ($\delta \mathbf{x} \in \mathbb{R}^{15}$)

$$\delta \mathbf{x} = \begin{bmatrix} \delta \vec{p}^T & \delta \vec{v}^T & \delta \vec{\theta}^T & \delta \vec{b}_a^T & \delta \vec{b}_g^T \end{bmatrix}^T$$

- $\delta \vec{p} \in \mathbb{R}^3$: Position error in ENU (meters).
- $\delta \vec{v} \in \mathbb{R}^3$: Velocity error in ENU (m/s).
- $\delta \vec{\theta} \in \mathbb{R}^3$: True attitude error in body frame, defined by the right-multiplicative formulation:
  $$\mathbf{q}_{nb} = \hat{\mathbf{q}}_{nb} \otimes \delta \mathbf{q}(\delta \vec{\theta}), \quad \delta \mathbf{q}(\delta \vec{\theta}) \approx \begin{bmatrix} 1 \\ \frac{1}{2} \delta \vec{\theta} \end{bmatrix}$$
- $\delta \vec{b}_a \in \mathbb{R}^3$: Accelerometer bias error in body frame ($\text{m/s}^2$).
- $\delta \vec{b}_g \in \mathbb{R}^3$: Gyroscope bias error in body frame ($\text{rad/s}$).

### 3.3 Continuous-Time System Dynamics Matrix ($F \in \mathbb{R}^{15 \times 15}$)

$$F = \begin{bmatrix} 0_{3 \times 3} & I_3 & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & -\hat{R}_{nb} [\vec{a}_b]_\times & -\hat{R}_{nb} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & -[\vec{\omega}_b]_\times & 0_{3 \times 3} & -I_3 \\ 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \end{bmatrix}$$

First-order discrete transition matrix:
$$\Phi = I_{15} + F \Delta t$$

---

## 4. Analytical Observation Models

### 4.1 Learned Forward Velocity Model ($m = 1$)

$$v_{\text{model}} = \mathbf{e}_x^T R_{bn} \vec{v}_n$$

- Residual: $z_v = v_{\text{model}} - \hat{\vec{v}}_b[0]$
- Jacobian: $H_v[0, 3:6] = \hat{R}_{bn}[0, :]$, $H_v[0, 6:9] = [0, \hat{v}_{b, z}, -\hat{v}_{b, y}]$
- Variance: $R_v = \sigma_{v_{\text{model}}}^2$

### 4.2 Learned Yaw Rate Model ($m = 1$)

$$\omega_{\text{model}} = \omega_{\text{meas}, z} - b_{gz}$$

- Residual: $z_\omega = \omega_{\text{model}} - (\omega_{\text{meas}, z} - \hat{b}_{gz})$
- Jacobian: $H_\omega[0, 14] = -1.0$
- Variance: $R_\omega = \sigma_{\omega_{\text{model}}}^2$

### 4.3 Non-Holonomic Constraints (NHC) ($m = 2$)

For non-holonomic wheeled vehicles, lateral and vertical velocities in the body frame are nominally zero ($v_{b, y} \approx 0, v_{b, z} \approx 0$):

- Residual: $\vec{z}_{\text{nhc}} = -\hat{\vec{v}}_b[1:3]$
- Jacobian:
  $$H_{\text{nhc}}[0, 3:6] = \hat{R}_{bn}[1, :], \quad H_{\text{nhc}}[0, 6:9] = [-\hat{v}_{b, z}, 0, \hat{v}_{b, x}]$$
  $$H_{\text{nhc}}[1, 3:6] = \hat{R}_{bn}[2, :], \quad H_{\text{nhc}}[1, 6:9] = [\hat{v}_{b, y}, -\hat{v}_{b, x}, 0]$$
- Covariance: $R_{\text{nhc}} = \text{diag}(\sigma_{\text{lat}}^2, \sigma_{\text{vert}}^2)$, $\sigma_{\text{lat}} = 0.35\,\text{m/s}, \sigma_{\text{vert}} = 0.20\,\text{m/s}$
- Speed Gating: Activated only when $\|\hat{\vec{v}}_n\| \ge 1.5\,\text{m/s}$.

### 4.4 Probabilistic Soft Polyline Constraints ($m = 2$)

Given target projection coordinate $\vec{p}_{\text{target}} = [E_{\text{target}}, N_{\text{target}}]^T$ on a high-confidence road segment or pre-existing route:

- Residual: $\vec{z}_{\text{poly}} = \vec{p}_{\text{target}} - \hat{\vec{p}}_n[0:2]$
- Jacobian: $H_{\text{poly}} = \begin{bmatrix} I_2 & 0_{2 \times 13} \end{bmatrix}$
- Residual-Inflated Covariance:
  $$R_{\text{poly}} = \left(\sigma_{\text{base}}^2 + (\kappa \cdot d_\perp)^2\right) I_2$$
  where $\sigma_{\text{base}} = 8.0\,\text{m}$, $\kappa = 0.50$, and $d_\perp = \|\vec{z}_{\text{poly}}\|$.

---

## 5. Automated Verification Results

The test suite executed via `node dist_test/tests/EskfTestSuite.js` confirms numerical correctness across all specifications.

### 5.1 Python Reference Golden Vector Comparison

A 50-step deterministic sequence comprising IMU acceleration, turning, GNSS position fixes, learned forward velocity, yaw rate bias calibration, NHC, and soft polyline constraints was generated via `scripts/generate_eskf_golden_vector.py` and compared against the TypeScript implementation.

| State Component                             | Max Absolute Error                        | Mean Absolute Error                   | Component Tolerance                   | Evaluation Result |
| :------------------------------------------ | :---------------------------------------- | :------------------------------------ | :------------------------------------ | :---------------- |
| **Position ($\vec{p}_n$)**                  | **$0.000000\,\text{m}$**                  | $0.000000\,\text{m}$                  | $\le 0.05\,\text{m}$ ($5\,\text{cm}$) | **PASS**          |
| **Velocity ($\vec{v}_n$)**                  | **$0.000000\,\text{m/s}$**                | $0.000000\,\text{m/s}$                | $\le 0.02\,\text{m/s}$                | **PASS**          |
| **Attitude Quaternion ($\mathbf{q}_{nb}$)** | **$6.072 \times 10^{-18}$**               | $1.704 \times 10^{-18}$               | $\le 1.0 \times 10^{-4}$              | **PASS**          |
| **Accelerometer Bias ($\vec{b}_a$)**        | **$0.000 \times 10^{0}\,\text{m/s}^2$**   | $0.000 \times 10^{0}\,\text{m/s}^2$   | $\le 1.0 \times 10^{-4}$              | **PASS**          |
| **Gyroscope Bias ($\vec{b}_g$)**            | **$1.748 \times 10^{-18}\,\text{rad/s}$** | $4.862 \times 10^{-19}\,\text{rad/s}$ | $\le 1.0 \times 10^{-4}$              | **PASS**          |
| **Covariance Diagonal ($P_{ii}$)**          | **$0.0000\%$**                            | $0.0000\%$                            | $\le 0.50\%$ relative                 | **PASS**          |

### 5.2 Multi-Candidate Road Matcher & Gating Contract

| Test Scenario                                  | Observed Output                              | Gating Criteria                   | Status   |
| :--------------------------------------------- | :------------------------------------------- | :-------------------------------- | :------- |
| **Clear Primary Road**                         | Matched `seg_1_primary`, Confidence: $0.994$ | $P(C_1) \ge 0.65$                 | **PASS** |
| **Equidistant Fork / Parallel Road**           | Rejected (`null`)                            | Margin $P(C_1) - P(C_2) \ge 0.20$ | **PASS** |
| **Orthogonal Heading ($90^\circ$ divergence)** | Rejected (`null`)                            | Heading divergence $\le 60^\circ$ | **PASS** |

### 5.3 Probabilistic Route Constraint & Gating

| Test Scenario                        | Cross-Track Distance | Observed Filter Action                                      | Status   |
| :----------------------------------- | :------------------- | :---------------------------------------------------------- | :------- |
| **Inside Corridor ($4\,\text{m}$)**  | $4.00\,\text{m}$     | Soft Bayesian update applied ($R \approx 73.0\,\text{m}^2$) | **PASS** |
| **Beyond Corridor ($45\,\text{m}$)** | $45.00\,\text{m}$    | Gated off (threshold: $35\,\text{m}$)                       | **PASS** |

### 5.4 Provider Neutrality Codebase Audit

- Total forbidden keyword violations detected in `src/core/`: **0**
- Third-party SDK imports detected: **0**
- Status: **PASS**

### 5.5 Execution Latency Benchmark

- Total iterations evaluated: 2,000 propagation ticks + measurement updates
- Total execution duration: $55.28\,\text{ms}$
- **Average execution time per tick: $0.0276\,\text{ms}$ ($27.6\,\mu\text{s}$)**
- Specified target budget: $< 1.0\,\text{ms}$
- Safety margin: **$36.2\times$ faster than target budget**
- Status: **PASS**

---

## 6. Ablation Experiment Matrix (R0 to R6)

The system supports the full canonical ablation hierarchy:

| Mode   | Identifier              | Active Estimators & Constraints                                | GNSS Outage Handling                   |
| :----- | :---------------------- | :------------------------------------------------------------- | :------------------------------------- |
| **R0** | `R0_IMU_ONLY`           | Pure Inertial Strapdown (Kinematic baseline)                   | Blocked throughout                     |
| **R1** | `R1_IMU_ML_VEL`         | IMU + Learned Forward Velocity $v_{\text{model}}$              | Blocked throughout                     |
| **R2** | `R2_IMU_ML_VEL_YAW`     | IMU + Learned Velocity $v$ + Learned Yaw Rate $\omega_z$       | Blocked throughout                     |
| **R3** | `R3_IMU_ML_NHC`         | IMU + Learned $(v, \omega_z)$ + Non-Holonomic Constraints      | Blocked throughout                     |
| **R4** | `R4_IMU_ML_NHC_ROAD`    | IMU + Learned $(v, \omega_z)$ + NHC + Soft Road Network Prior  | Blocked throughout                     |
| **R5** | `R5_IMU_ML_NHC_ROUTE`   | IMU + Learned $(v, \omega_z)$ + NHC + Pre-Existing Route Prior | Blocked throughout                     |
| **R6** | `R6_FULL_DROP_RECOVERY` | Complete Full-Stack Navigation Pipeline                        | Pre-Outage $\to$ Outage $\to$ Recovery |
