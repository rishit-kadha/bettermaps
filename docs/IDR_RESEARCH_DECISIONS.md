# BetterMaps IDR: Research Decisions Record (Post-Red-Team Review)

**Project:** BetterMaps — Intelligent Dead Reckoning for Seamless Navigation  
**Initiative:** Smart India Hackathon (SIH) — Edge Vehicle Navigation under GNSS-Denied Environments  
**Document Type:** Rigorous Research Decision Record & Red-Team Audit  
**Companion Document:** [`docs/IDR_MODEL_SPECIFICATION.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/docs/IDR_MODEL_SPECIFICATION.md)  
**Date:** September 4, 2026  
**Status:** Post-Red-Team Revision (Rigorous Scientific Downgrade & Alignment)

---

## Executive Summary: Red-Team Changes

Following a comprehensive scientific and engineering red-team review, several premature "LOCKED" designations from the preliminary draft have been downgraded. Specifically:

1. **Phone-to-Vehicle Frame Alignment:** The assumption that projected horizontal acceleration defines the forward axis has been **REJECTED**. Acceleration points backward during braking, lateral during cornering, and vanishes at constant speed. The alignment is now decomposed into gravity-based tilt, gyro-based relative yaw, and GNSS-course-correlated mounting azimuth.
2. **Gravity Compensation:** Low-pass filtering raw acceleration ($\tau \approx 2\text{ s}$) has been **REJECTED**. Sustained braking or acceleration is absorbed as fake gravity. A 6-DOF attitude filter (complementary / EKF) fusing gyro rates with low-frequency gravity is now specified.
3. **50 Hz Sampling on IO-VNBD:** Downgraded from "Locked" to **RECOMMENDED BUT EMPIRICALLY OPEN**. IO-VNBD is natively 10 Hz; interpolation does not recover frequencies $> 5\text{ Hz}$. The native 10 Hz pipeline remains the primary scientific benchmark; 50 Hz is an experimental transfer candidate.
4. **TCN Receptive Field:** The preliminary TCN layer configuration had a mathematical receptive field of only 15 samples (0.30s at 50 Hz), not 2.0s. It has been corrected to a 6-layer dilated architecture ($d \in [1, 2, 4, 8, 16, 32]$) spanning 127 samples ($2.54\text{ s}$). Model family is downgraded from "Locked" to **RECOMMENDED CANDIDATE** to be evaluated against MLP and GRU baselines.
5. **High-Rate Labels:** All references to "carrier-phase fixes" on smartphone GNSS have been **REMOVED**. The offline smoother output is strictly defined as a **PSEUDO-REFERENCE**, not gold truth.
6. **Non-Holonomic Constraints (NHC):** Hard zero-velocity constraints ($v_{\text{lat}} = 0$) are **REJECTED**. NHC is now formulated as a soft, probabilistic measurement update in the ESKF with non-zero dynamic covariance.

---

## 1. LOCKED DECISIONS (Strongly Supported by Evidence)

These decisions are physically, mathematically, and empirically grounded and are locked for implementation:

| Decision Area                  | Locked Choice                                                      | Core Evidence & Justification                                                                                                                                                                                                                       |
| :----------------------------- | :----------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System Boundary**            | Local Vehicle-Motion Estimator Only                                | The ML model predicts body-frame forward speed $v_f$ and yaw rate $\omega_z$. It **never** predicts latitude/longitude, **never** performs map matching, **never** consumes road-condition metadata, and **never** requires GNSS at inference time. |
| **Primary Sensors**            | 3-Axis Accel + 3-Axis Gyro (6 channels)                            | Universal across all budget smartphones; immune to cabin electromagnetic disturbances. Magnetometer is excluded from continuous ML due to observed $3\ \mu\text{T}$ cabin electrical steps (`Vw01`).                                                |
| **Ground-Truth Labels**        | Racelogic VBOX Doppler Speed + CAN Yaw Rate                        | Gold-standard reference sensors in IO-VNBD ($\pm 0.1\text{ km/h}$, $\pm 0.1^\circ/\text{s}$). Phone GPS speed is strictly excluded from labels due to $1–4\text{ s}$ dynamic latency.                                                               |
| **Dataset Alignment**          | Mandatory Automated Session Shift ($\tau^*$)                       | Audit proved unshifted IO-VNBD runs contain inter-session clock offsets from $-21.5\text{ s}$ to $+30.0\text{ s}$. Training on unshifted data corrupts learning with desynchronized noise.                                                          |
| **Data Split Integrity**       | Strict Session-Level Grouping                                      | Entire drives/sessions remain 100% within Train, Validation, or Test. Slicing single files (`Vw04`/`Vw01`) across partitions is rejected to prevent auto-correlation leakage. Normalization statistics are fit strictly on Train.                   |
| **Temporal Window**            | 2.0 Seconds Causal History ($W = 2.0\text{ s}$)                    | Sufficient context to observe braking and gear-shift transients. Strictly causal ($t \le t_k$); zero future samples in input tensor.                                                                                                                |
| **Navigation Cadence**         | 10 Hz Output Interval ($\Delta t_{\text{stride}} = 100\text{ ms}$) | Fulfills Smart India Hackathon requirement for responsive, real-time on-device navigation HUD tracking.                                                                                                                                             |
| **Primary Target Formulation** | Instantaneous Rates: $[v_f(t), \omega_z(t)]$                       | Clean physical units ($\text{m/s}$, $\text{rad/s}$) that directly interface with ESKF state matrices at 10 Hz. Rejects the previous 1.0s displacement target which caused step mismatch.                                                            |
| **Road Metadata Role**         | Evaluation-Only Stratification                                     | Unknown in real-world outages. Used exclusively for post-training robustness benchmarking across gravel, rain, potholes, and hills.                                                                                                                 |

---

## 2. RECOMMENDED BUT EMPIRICALLY OPEN (Good Defaults to Validate)

These choices represent our best current engineering hypotheses, but are explicitly subject to experimental validation:

| Decision Area          | Recommended Choice                                                 | Empirical Question / Tradeoff                                                                                                      | Validation Protocol                                                                                                                                 |
| :--------------------- | :----------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input Grid Rate**    | $50\text{ Hz}$ Canonical Grid ($\Delta t = 20\text{ ms}$)          | Does $5\times$ spline upsampling of 10 Hz IO-VNBD introduce interpolation artifacts compared to a native 10 Hz baseline?           | Run parallel baseline experiments: (A) Native 10 Hz inputs, (B) 50 Hz resampled inputs. Compare velocity RMSE and position drift.                   |
| **Model Family**       | Tiny 1D Dilated TCN ($< 45\text{k}$ params)                        | Is TCN superior to a lightweight GRU or a rolling-feature MLP on mobile CPU?                                                       | Execute a 3-way architecture benchmark: MLP baseline vs Tiny-TCN vs Tiny-GRU under identical data, splits, and metrics.                             |
| **Uncertainty Head**   | Heteroscedastic Gaussian NLL Head: $[\sigma_v^2, \sigma_\omega^2]$ | Does the network learn genuine physical uncertainty, or does it exploit NLL loss by inflating variance during difficult maneuvers? | Evaluate Expected Calibration Error (ECE), Z-score variance normality, and compare ESKF drift with learned covariance vs fixed tuned covariance.    |
| **Auxiliary Target**   | Multi-Task 1.0s Past Displacement Head                             | Does an auxiliary head improve generalization or simply add loss weighting complexity?                                             | Train with and without auxiliary displacement head ($\lambda_{\text{aux}} = 0$ vs $0.1$). Evaluate primary velocity RMSE.                           |
| **Two-Phase Transfer** | Phase 1 (IO-VNBD Pretrain) $\to$ Phase 2 (BetterMaps Transfer)     | Does pretraining on English roads in a Ford Fiesta transfer beneficially to Indian road dynamics on a OnePlus phone?               | Compare zero-shot IO-VNBD model on BetterMaps data vs fine-tuned model vs model trained from scratch on BetterMaps data.                            |
| **ZUPT Integration**   | Dual: ESKF Measurement + Output Clamp                              | What are the optimal empirical detection thresholds on physical smartphones?                                                       | Benchmark stationary detector across 34 min stationary run `Vw01` and real-world stoplight sequences. Tune acceleration and gyro energy thresholds. |

---

## 3. NOT YET DETERMINED (Open Research Questions)

The following items are explicitly unresolved and require dedicated experiments:

1. **High-Rate BetterMaps Reference Generation:**  
   How will we supervise 50 Hz adaptation on BetterMaps phone recordings given that phone GNSS updates at only $\sim 1–4\text{ Hz}$?  
   _Options:_ (A) Unsupervised / self-supervised domain adaptation, (B) Offline RTS Kalman smoother pseudo-labels, (C) Mounting an external reference receiver.
2. **Dynamic Mounting Azimuth Tracking:**  
   How should the phone-to-vehicle azimuth $\psi_{\text{mount}}$ be tracked if the user picks up or adjusts the phone on the dashboard while driving through a tunnel?
3. **Loss Weighting Factor ($\lambda_\omega$):**  
   What exact numerical balance between linear velocity loss ($\text{m/s}$) and yaw rate loss ($\text{rad/s}$) minimizes end-to-end dead-reckoning trajectory drift?
4. **On-Device INT8 Execution Jitter:**  
   What are the actual p95 and p99 inference latencies of the quantized model on the OnePlus physical device using TFLite XNNPACK vs ONNX Runtime Mobile?

---

## 4. RED-TEAM FINDINGS TABLE

|   Severity   | Identified Issue                                     | Why It Was Wrong / Risky                                                                                                                      | Required Correction Implemented                                                                                                                                                   |
| :----------: | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** | **Acceleration used to define vehicle forward axis** | Instantaneous acceleration points backward during braking, lateral in turns, and is zero at constant speed.                                   | **Replaced.** Azimuth is computed by correlating horizontal IMU forces with GNSS speed derivative during positive throttle ($a_{\text{GNSS}} > 1\text{ m/s}^2$) and low yaw rate. |
| **CRITICAL** | **2-Second Low-Pass Filter for Gravity**             | A 2-second low-pass on raw acceleration absorbs sustained braking (3s) or highway acceleration (6s) as fake gravity.                          | **Replaced.** Gravity is isolated via a 6-DOF attitude filter (complementary / EKF) fusing gyro rates with low-frequency gravity when $\|\mathbf{a}\| \approx 1\text{g}$.         |
| **CRITICAL** | **TCN Receptive Field Arithmetic Mismatch**          | The proposed 3-layer TCN had a receptive field of only 15 samples ($0.30\text{ s}$ at 50 Hz), not the claimed $2.0\text{ s}$ ($100$ samples). | **Replaced.** Mathematically derived a 6-layer dilated TCN ($d \in [1, 2, 4, 8, 16, 32]$) with true receptive field of 127 samples ($2.54\text{ s}$).                             |
|   **HIGH**   | **50 Hz Locked for IO-VNBD**                         | IO-VNBD is natively 10 Hz. Spline upsampling cannot recover missing high-frequency dynamics ($> 5\text{ Hz}$).                                | **Downgraded.** Native 10 Hz is established as the clean benchmark; 50 Hz is an experimental transfer candidate.                                                                  |
|   **HIGH**   | **Carrier-Phase Wording for Phone GNSS**             | The phone's Fused Location Provider does not provide dual-frequency carrier-phase tracking.                                                   | **Removed.** Eliminated "carrier-phase" language; labeled smoother output strictly as a **PSEUDO-REFERENCE**.                                                                     |
|   **HIGH**   | **Prematurely Locking Tiny-TCN**                     | Locking an architecture without comparative baseline experiments violates scientific rigor.                                                   | **Downgraded.** Tiny-TCN is a candidate recommendation; must be benchmarked against MLP and GRU baselines.                                                                        |
|   **HIGH**   | **Hard Non-Holonomic Constraints (NHC)**             | Enforcing $v_{\text{lat}} \equiv 0$ causes Kalman filter divergence during cornering tire sideslip or road camber.                            | **Replaced.** Formulated NHC as a soft, probabilistic measurement update with dynamic measurement covariance $\mathbf{R}_{\text{NHC}}$.                                           |
|  **MEDIUM**  | **Arbitrary ZUPT Thresholds**                        | $                                                                                                                                             | a                                                                                                                                                                                 | < 0.2\text{ m/s}^2$ would fail to detect idle stationary state where engine vibration $\sigma = 0.28\text{ m/s}^2$ (`Vw01`). | **Downgraded.** Labeled as empirical starting point; defined threshold calibration protocol on stationary data. |
|  **MEDIUM**  | **Reverse Motion Logic**                             | "Negative acceleration means reverse" is false; braking while moving forward produces large negative acceleration.                            | **Corrected.** Explicitly scoped v1 to forward navigation; reverse motion flagged as future extension.                                                                            |
|  **MEDIUM**  | **Theoretical Mobile Latency Claimed as Fact**       | Describing "<5 ms" as measured performance when no model has been compiled for mobile.                                                        | **Corrected.** Relabeled all runtime numbers as **DESIGN TARGETS**; specified future on-device benchmarking protocol.                                                             |

---

## 5. RED-TEAM VERDICT & IMPLEMENTATION GATE

### Verdict Summary

1. **Architecture Verdict:** **SOUND.** The hybrid separation between deterministic preprocessing, tiny learned motion estimator, and physics-based ESKF is scientifically robust and avoids common end-to-end black-box failure modes.
2. **Model-Target Verdict:** **SOUND.** Instantaneous forward velocity and yaw rate $[v_f, \omega_z]$ correctly interface with ESKF state matrices at 10 Hz. The heteroscedastic uncertainty head provides an essential mechanism for adaptive Kalman filtering.
3. **Data/Label Verdict:** **REALISTIC.** The limitations of IO-VNBD (10 Hz, aliased vibrations, session clock offsets) and BetterMaps phone recordings (low-rate GNSS) are now honestly documented and bounded.
4. **Biggest Unresolved Scientific Risk:** Generating trustworthy high-rate ($> 10\text{ Hz}$) velocity labels on real-world Indian road recordings without expensive external reference equipment.
5. **Biggest Implementation Risk:** Numerical instability in Gaussian NLL loss training causing the network to artificially inflate predicted variance $\sigma^2$ instead of learning accurate motion representations.
6. **What is Safe to Implement Now:**
   - Automated per-session cross-correlation alignment (`find_global_lag`).
   - Leakage-free dataset splitting (grouped strictly by session and driver).
   - Deterministic 6-DOF attitude estimation and gravity compensation.
   - Preprocessing and tensor windowing for the native 10 Hz IO-VNBD benchmark.
   - The three foundational baselines: Baseline 1 (GNSS hold), Baseline 2 (Deterministic Strapdown INS + ZUPT), Baseline 3 (Shallow Ridge/MLP).
7. **What MUST be Experimentally Validated Before Claiming Results:**
   - That Tiny-TCN actually outperforms a simple MLP or GRU baseline.
   - That 50 Hz spline upsampling on IO-VNBD does not degrade dead-reckoning accuracy compared to native 10 Hz.
   - That predicted heteroscedastic uncertainty is well-calibrated and actually improves ESKF drift over fixed tuned covariances.

---

### Implementation Gate

# Gate Status: YELLOW

**Justification:**  
The specification is now mathematically coherent, physically defensible, and free of blocking contradictions. Core decisions are grounded in verified empirical facts from the IO-VNBD audit.

However, because the primary model architecture (Tiny-TCN vs GRU vs MLP), the input sampling rate (10 Hz native vs 50 Hz resampled), and the uncertainty loss stability remain **empirical research hypotheses**, implementation may proceed **under the strict condition that all candidate architectures and sampling rates are treated as experimental comparisons rather than foregone conclusions.**
