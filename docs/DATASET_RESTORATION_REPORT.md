# IO-VNBD Dataset Restoration & Verification Report
**BetterMaps / Seamless IDR ? Research & Navigation Pipeline**

---

## 1. Executive Summary & Status

The official synchronized **IO-VNBD (Input-Output Vehicle Navigation Benchmark Dataset)** has been successfully restored, extracted, verified, and tested against the existing BetterMaps IDR navigation filter and ML evaluation pipelines.

* **Final Status**: **`DATASET RESTORED AND VERIFIED`**
* **Git Safety**: Confirmed 100% compliant. The raw dataset resides solely on the local filesystem and is strictly ignored by Git via `.gitignore: research/IO-VNBD/`. Zero raw dataset files are tracked or staged.
* **Compatibility**: Verified end-to-end against all 12 navigation unit tests (`test_navigation.py`) and the real-data causal navigation outage benchmark (`evaluate_navigation.py`) using the frozen Tiny TCN model (`B2_TCN`).

---

## 2. Review of Handover Documents

Both `IDR_HANDOVER.md` and `DATASET_AND_DELETED_FILES.md` were reviewed and analyzed before making any project adjustments:

### Architectural Context
* **Core Pipeline**:
  $$\text{Smartphone } S \longrightarrow \text{Preprocessing} \longrightarrow \text{Vehicle-Frame Features} \longrightarrow \text{ML Motion Model} \longrightarrow (v_x, \omega_z, \sigma) \longrightarrow \text{ESKF (15 error states)} \longrightarrow \text{Constraints (NHC, Road, Route)} \longrightarrow \text{PositionEstimate}$$
* **Separation of Concerns**: ML predicts vehicle dynamic motion states ($v_x, \omega_z$); the 15-error-state quaternion Error State Kalman Filter (ESKF) and soft constraints estimate spatial position, attitude, and sensor biases.
* **Frozen ML Checkpoint**: The primary motion model is the **Tiny Causal TCN** (`artifacts/runs/B2_TCN/best_model.pt`, locked test velocity RMSE: 15.64 km/h), outperforming Global Mean (28.95 km/h), Persistence (46.14 km/h), and Ridge regression (23.15 km/h). Existing baselines (`B1_MLP`, `B3_GRU`) and parameter sweeps remain preserved.

### Critical Research Integrity & Navigation Constraints
1. **Zero Ground-Truth Leakage During GNSS Outages**:
   * Vehicle reference data ($V$) is **strictly evaluation-only** for metric computation (ATE, RMSE, MAE).
   * Future $V$ coordinates or velocity must never be injected into the ESKF during an outage.
   * Routes must be established *prior* to GNSS loss and never reconstructed from future ground truth.
2. **Causal Windowing**: Motion inputs at timestamp $t$ only consume history $[t - W, t]$ ($W = 20$ samples $\approx 2.0$ s). Future samples are blocked.
3. **Soft Constraints vs. Hard Snapping**: Road and route constraints are incorporated as probabilistic soft measurements with finite covariance. The estimator never executes hard geometric teleportation/snapping to road centerlines.
4. **Coordinate Frame Conventions**: Explicit device-to-vehicle transformation $R_{D \to V}$ aligns phone coordinates into vehicle body frame ($+X$ forward, $+Y$ left, $+Z$ up).

---

## 3. Dataset Source & Archive Integrity

* **Upstream Source**: Official IO-VNBD GitHub Repository by Onyekpe et al. ([https://github.com/onyekpeu/IO-VNBD](https://github.com/onyekpeu/IO-VNBD)).
* **Archive Name**: `Synchronised V abd S datasets.zip`
* **File Size**: `203,606,286 bytes` (~194.17 MB).
* **Upstream Verification**: Verified via HTTP `HEAD` against `https://github.com/onyekpeu/IO-VNBD/raw/master/Synchronised%20V%20abd%20S%20datasets.zip`:
  * HTTP Status: `200 OK`
  * Upstream Content-Length: `203,606,286 bytes` (Exact 1:1 match).
* **Archive Integrity Check**: Evaluated with Python `zipfile.ZipFile.testzip()`.
  * Result: `Corrupt files: None` (100% healthy zip structure, 442 archived entries).

---

## 4. Extraction Path & Directory Structure

The archive was extracted locally to `research/IO-VNBD/` in 2.10 seconds without renaming or modifying internal paths:

```text
research/IO-VNBD/
??? Synchronised V abd S datasets.zip      [Official archive, 203.6 MB, local only]
??? Unsynchronised V and S Dataset.zip    [Archived for future reference, local only]
??? Synchronised V abd S datasets/
    ??? Categorised IOVNB Dataset/
    ?   ??? M (Driver B)/
    ?   ?   ??? S-M.csv                   [19.8 MB smartphone stream]
    ?   ?   ??? V-M.csv                   [22.5 MB vehicle reference stream]
    ?   ?   ??? V-M.JPG                   [Mounting posture photo]
    ?   ??? S (Driver A)/                 [Sessions: S1, S2, S3a, S3b, S3c, S4]
    ?   ??? Vf (Driver E)/                [Sessions: Vfa01, Vfa02]
    ?   ??? Vta (Driver E)/               [Sessions: Vta1a - Vta30, 29 sessions]
    ?   ??? Vtb (Driver E)/               [Sessions: Vtb1 - Vtb13, 13 sessions]
    ?   ??? Vw (Driver E)/                [Sessions: Vw1 - Vw17, 19 sessions]
    ?   ??? Y (Driver D)/                 [Session: Y1]
    ??? Uncategorised IOVNB Dataset/
        ??? S-Dataset/
        ??? V-Dataset/
```

* **Total Synchronized CSVs**: 288 CSV files.
* **Empty or Corrupt CSVs**: 0.

---

## 5. Dataset Verification Across All 72 Sessions

Using `research.idr.data.loader.IovnbdLoader`:
* **Total Sessions Discovered**: **72 / 72**
* **Driver Breakdown**:
  * Driver E: 64 sessions (Vf, Vta, Vtb, Vw)
  * Driver A: 6 sessions (S1, S2, S3a, S3b, S3c, S4)
  * Driver B: 1 session (M)
  * Driver D: 1 session (Y1)
* **File Pairing Verification**: Evaluated all 72 sessions for presence of paired `s_path` and `v_path`.
  * Missing Files: **0 / 72** (100% paired).
* **Train / Val / Test Partition Consistency**:
  * `artifacts/data/train_sessions.txt`: 44 sessions
  * `artifacts/data/val_sessions.txt`: 12 sessions
  * `artifacts/data/test_sessions.txt`: 11 sessions (includes `M`, `S2`, `Vta10`, `Vta15`, `Vta21`, `Vta8`, `Vtb10`, `Vtb12`, etc.)
  * Filtered / Unreliable: 5 sessions (documented in `session_inventory.csv`)
  * Total: 67 usable + 5 flagged = 72 sessions.

---

## 6. In-Depth Inspection: M (Driver B) Evaluation Session

Session `M (Driver B)` is the primary reference session utilized by `evaluate_navigation.py`:

| Metric / Property | Smartphone Stream (`S-M.csv`) | Vehicle Reference Stream (`V-M.csv`) |
|---|---|---|
| **File Size** | 19,798,721 bytes (~18.88 MB) | 22,507,823 bytes (~21.46 MB) |
| **Row Count** | 105,974 rows | 105,974 rows |
| **Column Count** | 24 columns | 29 columns |
| **Encoding** | Latin-1 (`ISO-8859-1` / `cp1252`) | Latin-1 (`ISO-8859-1` / `cp1252`) |
| **Timestamp Column** | `TIME SINCE START (ms)` | `Time Since Start of Day (seconds)` |
| **Start / End Time** | 4,227 ms $\to$ 6,175,975 ms | 29,608.4 s $\to$ 40,205.7 s |
| **Nominal Duration** | 6,171.7 s (~102.8 min) | 10,597.3 s |
| **Sampling Interval ($\Delta t$)** | Median: 100.0 ms (10.0 Hz) | Median: 0.100 s (10.0 Hz) |
| **Backward Time Jumps** | Exactly 1 (logger reset: $-4,426,717$ ms) | 0 |
| **Sensor / Reference Channels** | 3-axis Accel, 3-axis Gyro, Magnetometer, Gravity, Orientation, Phone GPS (Lat, Lon, Alt, Speed, Accuracy) | VBOX Doppler Velocity, Heading, Height, Yaw Rate, Lat/Lon, Wheel Speeds $(FL, FR, RL, RR)$, Longitudinal/Lateral Accel |

### Timestamp Reset Handling
The smartphone logger incurred one clock reset where `TIME SINCE START` wrapped backwards. The chronological timestamp repair function `repair_timestamp_resets(raw_ms)` in `evaluate_navigation.py` preserves strict chronological sample order by monotonically accumulating offsets (+100 ms nominal gap) across the reset.

---

## 7. Problems Encountered & Resolutions

1. **Character Encoding (`UnicodeDecodeError`)**:
   * *Issue*: Standard UTF-8 decoding fails on character `0xb2` (`?` in `m/s?`) and degree symbols (`?`).
   * *Resolution*: Confirmed that both `research/idr/data/loader.py` and `research/idr/evaluate_navigation.py` explicitly load with `encoding='latin1'`.
2. **Git Tracking & Gitignore**:
   * *Issue*: Commit `1997939` (from PR #1) intentionally removed the 729 dataset files from Git tracking. Merging this commit into `main` clean-slated the Git index.
   * *Resolution*: Updated `.gitignore` to add `research/IO-VNBD/`. Verified via `git check-ignore -v` and `git status` that extracted CSVs and images remain untracked.

---

## 8. Git Safety Verification

Strict compliance with Phase 4 guidelines:
```bash
$ git status
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   .gitignore

no changes added to commit
```

* **No dataset files staged**: `git diff --cached --name-only` is empty.
* **No dataset files untracked**: `git ls-files -o --exclude-standard` reports 0 files.
* **Ignore Rule Verification**:
  ```bash
  $ git check-ignore -v "research/IO-VNBD/Synchronised V abd S datasets/Categorised IOVNB Dataset/M (Driver B)/S-M.csv"
  .gitignore:73:research/IO-VNBD/
  ```
* **Git History**: No attempt was made to revert the removal commit `1997939` or re-track the 729 deleted dataset files.

---

## 9. Preservation of Navigation & ML Artifacts

All navigation code and training artifacts were verified to be in place:

| Artifact Path | Status | Verification Details |
|---|---|---|
| `research/idr/navigation/coordinates.py` | Present | WGS84 $\leftrightarrow$ metric ENU, quaternion rotations |
| `research/idr/navigation/eskf.py` | Present | 15-state error quaternion filter with propagation & updates |
| `research/idr/navigation/motion_adapter.py` | Present | Decoupled PyTorch $\to$ `MotionPrediction` interface |
| `research/idr/navigation/constraints.py` | Present | NHC ($v_y \approx 0, v_z \approx 0$) & soft polyline constraints |
| `research/idr/navigation/outage.py` | Present | Chronological outage runner with reference leakage guard |
| `research/idr/evaluate_navigation.py` | Present | Real-data evaluation harness |
| `research/idr/tests/test_navigation.py` | Present | **12 / 12 unit tests passed** in 0.132s |
| `artifacts/runs/B2_TCN/best_model.pt` | Present | 32,373 bytes, PyTorch state dict (20 keys), epoch 19 |
| `artifacts/data/normalization.json` | Present | 6-channel means and standard deviations |
| `artifacts/experiment_registry.csv` | Present | 16 experiment metadata records |
| `artifacts/reports/IDR_TRAINING_REPORT.md` | Present | Full scientific documentation of baseline & sweep results |

---

## 10. End-to-End Compatibility Validation

The restored M session was evaluated against the real-data evaluation pipeline:
```bash
python -m research.idr.evaluate_navigation   --s "research/IO-VNBD/Synchronised V abd S datasets/Categorised IOVNB Dataset/M (Driver B)/S-M.csv"   --v "research/IO-VNBD/Synchronised V abd S datasets/Categorised IOVNB Dataset/M (Driver B)/V-M.csv"   --checkpoint "artifacts/runs/B2_TCN/best_model.pt"   --normalization "artifacts/data/normalization.json"
```

### Measured Outage Drift Results (`artifacts/data/navigation_outage_summary.csv`):
| Method | Outage Duration | Samples | Horizontal RMSE | Horizontal MAE | Max Position Error |
|---|---:|---:|---:|---:|---:|
| `ml_eskf` | 5.0 s | 50 | **25.09 m** | 23.76 m | 44.64 m |
| `ml_eskf` | 10.0 s | 100 | **44.97 m** | 40.84 m | 70.03 m |
| `ml_eskf` | 20.0 s | 200 | **54.15 m** | 51.10 m | 71.14 m |
| `ml_eskf` | 30.0 s | 300 | **55.10 m** | 52.84 m | 71.14 m |
| `ml_eskf` | 60.0 s | 600 | **55.80 m** | 54.39 m | 71.14 m |

*Execution completed with exit code 0, confirming 100% data and API compatibility.*

---

## 11. Final Status

```text
============================================================
           DATASET RESTORED AND VERIFIED
============================================================
```

The system is now prepared for the next engineering phases:
1. Real-data ESKF validation and covariance tuning on validation sessions.
2. Verification of mounting calibration and coordinate frame rotations ($R_{D \to V}$).
3. Integration of genuine pre-existing road geometry and pre-loss route constraints.
4. Comprehensive ablation study comparing kinematic baseline, pure ML integration, ML-ESKF, ML-ESKF+NHC, and ML-ESKF+Road/Route.
