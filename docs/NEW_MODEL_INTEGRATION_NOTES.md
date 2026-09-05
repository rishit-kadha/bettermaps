# New Model Integration Notes
**BetterMaps / Seamless IDR ? Motion Prediction Pipeline**

This document establishes the authoritative technical specification and boundary contract for integrating the IDR motion prediction models into the BetterMaps navigation architecture.

---

## 1. Model Architecture(s) Developed

The project maintains a tiered set of motion prediction models designed for estimating vehicle longitudinal dynamics and turning rates from smartphone IMU signals:

1. **Tiny Causal TCN (`TinyCausalTcnMotionModel`) [Locked Reference Winner]**:
   * Multi-layer 1D dilated causal convolutional network with residual skip connections.
   * Dilation schedule: $d \in [1, 2, 4, 8]$ with kernel size $k = 3$.
   * Receptive field: $1 + 2 \times (1 + 2 + 4 + 8) = 31$ samples ($3.1\text{ s}$ at $10\text{ Hz}$), causally covering the $T = 20$ sample input window.
   * Hidden channels: 16. Total parameters: 5,938. Checkpoint: `artifacts/runs/B2_TCN/best_model.pt`.
   * Locked test velocity RMSE: **$15.64\text{ km/h}$** (lowest error across all tested models).

2. **Lightweight GRU (`LightweightGruMotionModel`) [Recurrent Candidate]**:
   * Single-layer Gated Recurrent Unit (16 hidden units) followed by a linear projection head.
   * Total parameters: 3,906. Checkpoint: `artifacts/runs/B3_GRU/best_model.pt`.
   * Fast hidden-state transition, compact footprint.

3. **Shallow MLP (`ShallowMlpMotionModel`) [Feedforward Baseline]**:
   * Multi-Layer Perceptron flattening the 20-sample window ($20 \times 6 = 120$ inputs) through hidden layers $120 \to 64 \to 32 \to 2$ with ReLU activations.
   * Total parameters: 9,890. Checkpoint: `artifacts/runs/B1_MLP/best_model.pt`.

4. **Heteroscedastic TCN (`HeteroscedasticTcnModel`) [Uncertainty Architecture]**:
   * Causal TCN backbone with dual output heads producing mean and log-variance:
     $$[\mu_v, \mu_\omega, \log\sigma_v^2, \log\sigma_\omega^2]$$
   * Includes numerical variance clamping to $[-6.0, 4.0]$ to prevent filter divergence.

5. **Loss Weight Sweeps (`Sweep_TCN_lam_*`)**:
   * Six trained variants sweeping the yaw-rate weighting parameter $\lambda_\omega \in [0.1, 0.25, 0.5, 1.0, 2.0, 4.0]$.
   * Sweep winner: $\lambda_\omega = 0.25$ (`Sweep_TCN_lam_0_25`).

---

## 2. Exact Model Input Features

The model consumes **6 calibrated vehicle-frame motion channels**:
1. `a_long`: Longitudinal acceleration along vehicle forward axis ($+X$), in $\text{m/s}^2$.
2. `a_lat`: Lateral acceleration along vehicle left axis ($+Y$), in $\text{m/s}^2$.
3. `a_vert`: Vertical acceleration along vehicle upward axis ($+Z$), in $\text{m/s}^2$.
4. `omega_yaw`: Yaw rate around vehicle vertical axis ($+Z$), in $\text{rad/s}$ (positive counter-clockwise).
5. `omega_pitch`: Pitch rate around vehicle lateral axis ($+Y$), in $\text{rad/s}$.
6. `omega_roll`: Roll rate around vehicle longitudinal axis ($+X$), in $\text{rad/s}$.

---

## 3. Exact Input Ordering

Channels must strictly follow the canonical sequence defined in `artifacts/data/normalization.json`:
```python
[
    "a_long",      # Index 0: forward accel (m/s^2)
    "a_lat",       # Index 1: lateral accel (m/s^2)
    "a_vert",      # Index 2: vertical accel (m/s^2)
    "omega_yaw",   # Index 3: yaw rate (rad/s)
    "omega_pitch", # Index 4: pitch rate (rad/s)
    "omega_roll"   # Index 5: roll rate (rad/s)
]
```

---

## 4. Input Tensor Shape Expected by the Model

* **Batch Input Shape**: `[Batch, Sequence_Length, Channels] = [B, 20, 6]`
* Single-window inference: `[1, 20, 6]`
* Inside `TinyCausalTcnMotionModel.forward()`, the tensor is transposed to `[B, 6, 20]` for 1D convolution, and features are sampled from the final timestep $t = T-1$.
* Inside `ShallowMlpMotionModel.forward()`, the tensor is flattened to `[B, 120]`.
* Inside `LightweightGruMotionModel.forward()`, the tensor remains `[B, 20, 6]`.

---

## 5. Sampling Frequency Assumed by the Model

* Nominal Sampling Rate: **$10.0\text{ Hz}$** (sampling interval $\Delta t = 100\text{ ms}$).
* Higher-rate smartphone streams (e.g. 50 Hz or 100 Hz) must be low-pass filtered and decimated or resampled to 10 Hz before window accumulation.

---

## 6. Window / History Length

* Temporal Window: **$T = 20$ samples** ($2.0\text{ s}$ duration at 10 Hz).
* Strict Causality: For estimation at time $t$, the window covers $[t - 1.9\text{ s}, t]$. Zero future samples are permitted.

---

## 7. Normalization / Scaling Requirements

* Standard Z-Score normalization is applied per channel before model execution:
  $$x_{\text{norm}}^{(i)} = \frac{x^{(i)} - \mu^{(i)}}{\max(\sigma^{(i)}, 10^{-6})}$$
* Statistics are loaded strictly from `artifacts/data/normalization.json` (computed on training sessions):
  * **Mean ($\mu$)**: `[-0.046304, 0.088613, -0.061730, 0.003923, 0.000412, -0.001649]`
  * **Std ($\sigma$)**: `[0.722591, 0.697424, 0.702888, 0.076214, 0.043513, 0.049386]`
* **Rule**: Inference never recomputes or updates normalization statistics from live data.

---

## 8. Coordinate / Frame Convention

* **Vehicle Navigation Body Frame**:
  * $+X$: Forward (longitudinal direction of travel)
  * $+Y$: Left (lateral axis)
  * $+Z$: Upward (normal to road surface, opposing gravity)
* **Transformation**: Smartphone sensor frames ($D$) do NOT equal vehicle body frame ($V$). An explicit direction cosine matrix $R_{D \to V} \in \mathbb{R}^{3 \times 3}$ calibrated from initial vehicle motion aligns phone accelerometer and gyroscope axes:
  $$a_V = R_{D \to V} a_D, \quad \omega_V = R_{D \to V} \omega_D$$

---

## 9. Exact Model Outputs

* **Deterministic Models (`B2_TCN`, `B3_GRU`, `B1_MLP`)**:
  Output tensor shape: `[B, 2]`
  * Column 0: Forward velocity $v_f$ (enforced non-negative via ReLU)
  * Column 1: Vehicle yaw rate $\omega_z$
* **Heteroscedastic Model (`HeteroscedasticTcnModel`)**:
  Outputs two tensors `(mu, log_var)`, each shape `[B, 2]`:
  * `mu`: $[v_f, \omega_z]$
  * `log_var`: $[\log\sigma_v^2, \log\sigma_\omega^2]$

---

## 10. Output Units

* **Forward Velocity ($v_f$)**: Meters per second ($\text{m/s}$). Note: $1\text{ m/s} = 3.6\text{ km/h}$.
* **Yaw Rate ($\omega_z$)**: Radians per second ($\text{rad/s}$). Note: $1\text{ rad/s} = 57.2958^\circ\text{/s}$.

---

## 11. Uncertainty Output Semantics

* **Standard 2-Output Models**:
  Do NOT output learned uncertainty. The adapter provides explicit, configurable fallback standard deviations:
  * Velocity std: $\sigma_v = 1.5\text{ m/s}$ ($5.4\text{ km/h}$)
  * Yaw rate std: $\sigma_\omega = 0.15\text{ rad/s}$ ($8.59^\circ\text{/s}$)
  * These values are documented as configured priors, not claimed to be learned uncertainty.
* **Heteroscedastic Model**:
  Outputs dynamic $\sigma_v = \exp(0.5 \log\sigma_v^2)$ and $\sigma_\omega = \exp(0.5 \log\sigma_\omega^2)$.

---

## 12. Checkpoint & Weights Format

* Checkpoints are stored as PyTorch `.pt` files containing:
  ```python
  {
      'epoch': int,
      'model_state': OrderedDict[str, torch.Tensor],
      'model_class': str,
      'lambda_omega': float,
      'val_loss': float,
      'metrics': dict
  }
  ```
* Checkpoints are loaded with `map_location='cpu'` and immediately put in `.eval()` mode with `torch.no_grad()`.

---

## 13. Preprocessing Performed Before Inference

1. **Timestamp Monotonicity Repair**: Logger timestamp resets are corrected with `repair_timestamp_resets()`.
2. **Mounting Calibration**: Accelerometer and gyroscope readings rotated by $R_{D \to V}$.
3. **Z-Score Normalization**: Normalized via training statistics.
4. **Causal History Slicing**: The most recent 20 samples ($T=20$) are assembled into `[1, 20, 6]`.

---

## 14. Postprocessing Performed After Inference

1. **Velocity Non-Negativity**: Forward velocity is clamped $v_f \ge 0\text{ m/s}$.
2. **MotionPrediction Conversion**: Wrapped in the runtime-neutral `MotionPrediction` dataclass:
   `(timestamp_s, forward_velocity_mps, yaw_rate_radps, velocity_std_mps, yaw_rate_std_radps, confidence)`.
3. **ESKF Measurement Injection**: The ESKF consumes `MotionPrediction` as a velocity/yaw-rate measurement with covariance matrix:
   $$R_m = \begin{bmatrix} \sigma_v^2 & 0 \\ 0 & \sigma_\omega^2 \end{bmatrix}$$

---

## 15. Assumptions About Android / iOS Sensor Data

* Accelerometer readings are in $\text{m/s}^2$ and include gravity when stationary.
* Gyroscope readings are in $\text{rad/s}$.
* The phone is rigidly mounted relative to the vehicle chassis during navigation (no loose tumbling).

---

## 16. Assumptions About GNSS

* High-quality GNSS is assumed available during initial driving to establish the local metric ENU origin, estimate $R_{D \to V}$, and prime initial velocity and heading.
* During simulated outages, GNSS fixes are strictly gated (zero measurements delivered to the filter).

---

## 17. Multiple Model Variants / Checkpoints Available

* `artifacts/runs/B2_TCN/best_model.pt` (Primary production candidate, Tiny Causal TCN)
* `artifacts/runs/B3_GRU/best_model.pt` (Lightweight GRU)
* `artifacts/runs/B1_MLP/best_model.pt` (Shallow MLP)
* `artifacts/runs/Sweep_TCN_lam_0_1/` through `Sweep_TCN_lam_4_0/` (Loss sweeps)
* `HeteroscedasticTcnModel` (Uncertainty head)

---

## 18. Model Intended for Runtime Deployment

* **Primary Runtime Candidate**: **`B2_TCN` (`TinyCausalTcnMotionModel`)**
  * Parameter count: 5,938 (~23 KB).
  * Inference latency: $< 1.0\text{ ms}$ on CPU.
  * Lowest velocity RMSE ($15.64\text{ km/h}$) on locked test data.
  * Excellent edge suitability for ONNX export and on-device execution.
