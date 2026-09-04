# BetterMaps 🧭 — Training Dataset & IDR Data Architecture Guide

This document describes the dataset architecture, preprocessing methodology, coordinate frame transformations, session partitioning, and serialized artifacts used to train and evaluate the **BetterMaps Intelligent Dead Reckoning (IDR)** models.

---

## 1. Upstream Dataset: IO-VNBD

BetterMaps IDR models are trained on the **IO-VNBD (Inertial Odometry Vehicle Navigation Benchmark Dataset)** created by Onyekpeu et al. (Coventry University).

- **Repository**: [https://github.com/onyekpeu/IO-VNBD](https://github.com/onyekpeu/IO-VNBD)
- **Local Path**: `research/IO-VNBD/Synchronised V abd S datasets/Categorised IOVNB Dataset/`
- **Sensors Logged**:
  - **Smartphone IMU**: 3-axis Accelerometer ($m/s^2$), 3-axis Gyroscope ($rad/s$), and internal GPS receiver logged via AndroSensor at 10 Hz.
  - **Reference Ground Truth**: Racelogic VBOX 3i dual-antenna GNSS/inertial system logging at 10 Hz (Doppler velocity with $<0.1\,\text{km/h}$ accuracy, heading, and true yaw rate from a calibrated gyro).

### Dataset Scope & Volume

The dataset includes **72 paired sessions** spanning diverse driving styles, road geometries, and drivers:

| Driver Group | Driving Style | Session IDs                                                    | Session Count | Characteristics                                                           |
| :----------- | :------------ | :------------------------------------------------------------- | :-----------: | :------------------------------------------------------------------------ |
| **Driver A** | Defensive     | `S1`, `S2`, `S3a`, `S3b`, `S3c`, `S4`                          |       6       | Urban, suburban, and highway loops (up to 2.6 hours)                      |
| **Driver B** | Defensive     | `M`                                                            |       1       | Long highway and ring-road circuit (105k samples, ~2.9h)                  |
| **Driver D** | Defensive     | `Y1`                                                           |       1       | Urban and rural mixed route (70k samples, ~1.9h)                          |
| **Driver E** | Aggressive    | `Vfa01`-`Vfa02`, `Vta1a`-`Vta23`, `Vtb1`-`Vtb12`, `Vw1`-`Vw20` |      64       | Aggressive lane changes, rapid acceleration, roundabouts, stationary runs |
| **Total**    | Mixed         | —                                                              |    **72**     | **29.74 driving hours / 1,065,400 sliding windows**                       |

---

## 2. Session Inventory & Audit (`artifacts/data/session_inventory.csv`)

Every IO-VNBD session has been audited, synchronized, and calibrated. The full master table is stored at [`artifacts/data/session_inventory.csv`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/session_inventory.csv).

Key audit findings:

- **69 Sessions Verified Reliable**: High cross-correlation between smartphone IMU and VBOX ground truth.
- **2 Stationary Benchmark Runs**: `Vw1` and `Vw15` (engine idling / warmup, speed $<1.0\,\text{km/h}$, used exclusively as stationary bias calibration baselines).
- **3 Sessions Flagged Unreliable**: Excluded from training due to unalignable logging artifacts.

---

## 3. Coordinate Frame Calibration ($\mathbf{R}_{D \to V}$)

Per rigorous research integrity rules, **no axis mapping is globally hardcoded** (e.g., `gyro_pitch -> yaw` is never universally hardcoded). Instead, each session is explicitly transformed from the **Device Frame ($F_D$)** to the **Vehicle Body Frame ($F_V$)**:

$$\mathbf{x}_V = \mathbf{R}_{D \to V} \, \mathbf{x}_D$$

### 3.1 Frame Definitions

- **Device Frame ($F_D$)**: Android standard sensor coordinate system ($+X$ right across screen, $+Y$ top of screen, $+Z$ out of screen).
- **Vehicle Body Frame ($F_V$)**: ENU-compatible right-handed vehicle body frame:
  - **$+X_V$ (Longitudinal)**: Forward along vehicle driving axis.
  - **$+Y_V$ (Lateral)**: Left lateral axis.
  - **$+Z_V$ (Vertical)**: Up antiparallel to gravity (vehicle yaw rotation axis).

### 3.2 Mathematical Calibration Algorithm ([`research/idr/preprocessing/orientation.py`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/research/idr/preprocessing/orientation.py))

1. **Vertical Axis Determination**: The smartphone's gyro channels are correlated with the reference vehicle yaw rate during turn maneuvers to identify the active vertical rotation axis $\mathbf{u}_z \in \mathbb{R}^3$ in device coordinates.
2. **Gravity Compensation**: Mean static gravity vector $\mathbf{g}_D$ is estimated and dynamic linear acceleration is extracted: $\mathbf{a}_{\text{dyn}} = \mathbf{a}_{\text{raw}} - \mathbf{g}_D$.
3. **Horizontal Projection**: Acceleration is projected onto the plane orthogonal to $\mathbf{u}_z$:
   $$\mathbf{a}_{\text{horiz}} = \mathbf{a}_{\text{dyn}} - (\mathbf{a}_{\text{dyn}} \cdot \mathbf{u}_z) \mathbf{u}_z$$
4. **Forward Axis Identification ($\mathbf{u}_x$)**: Covariance between horizontal acceleration and vehicle acceleration ($\frac{dv_{\text{ref}}}{dt}$) is evaluated during positive throttle, straight-line segments.
5. **Lateral Axis ($\mathbf{u}_y$)**: Completed as $\mathbf{u}_y = \mathbf{u}_z \times \mathbf{u}_x$.
6. **Orthonormal Rotation Matrix**:
   $$\mathbf{R}_{D \to V} = \begin{bmatrix} \mathbf{u}_x^T \\ \mathbf{u}_y^T \\ \mathbf{u}_z^T \end{bmatrix}$$

### 3.3 Canonical 6-Channel Model Input

The transformed 6-channel input array $\mathbf{X} \in \mathbb{R}^{N \times 6}$ contains:

- `Channel 0`: Forward longitudinal dynamic acceleration $a_{\text{long}}$ ($m/s^2$)
- `Channel 1`: Left lateral acceleration $a_{\text{lat}}$ ($m/s^2$)
- `Channel 2`: Vertical dynamic acceleration $a_{\text{vert}}$ ($m/s^2$)
- `Channel 3`: Yaw angular rate $\omega_{\text{yaw}}$ ($rad/s$, positive counter-clockwise)
- `Channel 4`: Pitch angular rate $\omega_{\text{pitch}}$ ($rad/s$)
- `Channel 5`: Roll angular rate $\omega_{\text{roll}}$ ($rad/s$)

---

## 4. Two-Stage Time Synchronization ($\tau^*$)

Because smartphone GPS receivers incorporate internal filtering latency (~1–5 seconds) relative to raw IMU hardware interrupts, cross-correlating GPS speed directly against VBOX Doppler velocity yields the **GPS receiver's latency**, not the **IMU hardware's timestamp offset**.

To resolve this, BetterMaps implements a **two-stage alignment algorithm** ([`research/idr/data/loader.py`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/research/idr/data/loader.py)):

1. **Stage 1 (Coarse Speed Alignment)**: Performs cross-correlation between smartphone GPS speed and VBOX Doppler velocity over a wide window ($\pm 1500$ samples = $\pm 150\text{ s}$) to identify coarse session offset $\tau_{\text{coarse}}$.
2. **Stage 2 (Fine Gyro Alignment)**: Searches within $[\tau_{\text{coarse}} - 60, \tau_{\text{coarse}} + 60]$ samples ($\pm 6\text{ s}$) using candidate smartphone gyroscope channels against VBOX Yaw Rate during active turns ($|\omega_z| > 1.5^\circ/\text{s}$).

---

## 5. Strict Session-Level Partitioning & Test-Set Locking

To guarantee zero time-series data leakage, splitting is performed **strictly at the session level**. No session is split across train and test sets.

Summary of partitions ([`artifacts/data/split_summary.csv`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/split_summary.csv)):

| Partition         | Sessions | Windows ($T=20, s=1$) |  Duration   | Drivers Included  | Session IDs File                                                                                                      |
| :---------------- | :------: | :-------------------: | :---------: | :---------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **Train**         |    45    |        703,976        | 19.55 hours | Driver A, B, D, E | [`train_sessions.txt`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/train_sessions.txt) |
| **Validation**    |    12    |        211,655        | 5.88 hours  | Driver A, E       | [`val_sessions.txt`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/val_sessions.txt)     |
| **Test (Locked)** |    10    |        123,713        | 3.44 hours  | Driver A, E       | [`test_sessions.txt`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/test_sessions.txt)   |

### Test-Set Locking Protocol

- Hyperparameter tuning, model selection (MLP vs. TCN vs. GRU), and loss weight sweeping ($\lambda_\omega \in [0.1, 4.0]$) were conducted **strictly on the Validation set**.
- The winning configuration (Tiny Causal TCN with $\lambda_\omega^* = 0.5$) was **frozen** before executing a single, final evaluation on the locked Test set.

---

## 6. Feature Normalization (`artifacts/data/normalization.json`)

Standardization statistics were fitted **strictly on the Train split** to prevent data snooping:

$$\mathbf{x}_{\text{norm}} = \frac{\mathbf{x} - \mu_{\text{train}}}{\sigma_{\text{train}}}$$

The parameters serialized at [`artifacts/data/normalization.json`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/data/normalization.json):

| Channel | Physical Name       | Train Mean ($\mu$) |           Train Std ($\sigma$)            | Physical Unit |
| :------ | :------------------ | :----------------: | :---------------------------------------: | :------------ |
| 0       | `a_long_mps2`       |      $0.0000$      |                 $1.6981$                  | $m/s^2$       |
| 1       | `a_lat_mps2`        |      $0.0000$      |                 $1.0665$                  | $m/s^2$       |
| 2       | `a_vert_mps2`       |      $0.0000$      |                 $1.7311$                  | $m/s^2$       |
| 3       | `omega_yaw_radps`   |     $-0.0040$      | $0.2594$ ($\approx 14.86^\circ/\text{s}$) | $rad/s$       |
| 4       | `omega_pitch_radps` |      $0.0003$      |                 $0.1523$                  | $rad/s$       |
| 5       | `omega_roll_radps`  |     $-0.0003$      |                 $0.1212$                  | $rad/s$       |

---

## 7. Replay Dataset Fixture (`assets/datasets/S1_clean_10hz.json`)

To enable testing without needing a vehicle or internet access, session `S1` was extracted, time-aligned, calibrated, and packaged as a mobile asset:

- **Path**: [`assets/datasets/S1_clean_10hz.json`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/assets/datasets/S1_clean_10hz.json)
- **Duration**: 5,174.4 seconds (1.44 hours, 51,744 samples at 10 Hz)
- **Contents**:
  - `timestamps_s`: Monotonic 100ms time base.
  - `imu`: 6-channel calibrated vehicle-frame sensor arrays.
  - `gnss`: Ground-truth VBOX coordinates (latitude, longitude, Doppler speed, true heading).
- **Generating Additional Fixtures**:
  Use the extractor script:
  ```bash
  python scripts/extract_iovnbd_session.py --session S2 --output assets/datasets/S2_clean_10hz.json
  ```

---

## 8. Serialized Model Checkpoints (`artifacts/runs/`)

Trained PyTorch checkpoints are stored under `artifacts/runs/`:

| Directory           | Architecture      | Parameters | Checkpoint File | Description                                     |
| :------------------ | :---------------- | :--------: | :-------------- | :---------------------------------------------- |
| `B1_MLP`            | Shallow MLP       |  ~10,000   | `best_model.pt` | Flattened 120-feature input                     |
| `B2_TCN`            | Tiny Causal TCN   |   4,962    | `best_model.pt` | 4-layer causal dilated 1D CNN                   |
| `B3_GRU`            | Lightweight GRU   |   3,874    | `best_model.pt` | 1-layer 32-hidden GRU                           |
| `Sweep_TCN_lam_0_5` | **Frozen Winner** | **4,962**  | `best_model.pt` | **Selected IDR model ($\lambda_\omega^*=0.5$)** |

Each checkpoint dictionary contains:

- `epoch`: Best validation epoch index
- `model_state`: PyTorch `state_dict`
- `model_class`: Class name string
- `lambda_omega`: Loss weighting factor
- `val_loss`: Best validation composite loss
- `metrics`: Dictionary of velocity and yaw rate accuracy metrics

---

_For detailed evaluation metrics across all 16 experiments, refer to [`artifacts/reports/IDR_TRAINING_REPORT.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/reports/IDR_TRAINING_REPORT.md) and [`artifacts/experiment_registry.csv`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/experiment_registry.csv)._
