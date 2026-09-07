# Mobile ESKF Mathematical Specification

**Document Version:** 1.0.0  
**Status:** FROZEN REFERENCE SPECIFICATION  
**Target Systems:** BetterMaps Mobile IDR (`src/core/positioning/eskf/`) & Research Reference (`research/idr/navigation/eskf.py`)  
**Date:** September 5, 2026

---

## 1. Coordinate Frames & Conventions

### 1.1 Navigation Frame ($\mathcal{F}_n$): Local East-North-Up (ENU)

The navigation frame is a Cartesian frame local to a chosen reference tangent origin $\vec{o} = (\phi_0, \lambda_0, h_0)$:

- **$+X_n$ (East):** Points east along the local parallel of latitude.
- **$+Y_n$ (North):** Points true north along the local meridian.
- **$+Z_n$ (Up):** Points upward along the local ellipsoidal normal.

The nominal gravity vector in $\mathcal{F}_n$ is strictly:
$$\vec{g}_n = \begin{bmatrix} 0 \\ 0 \\ -g \end{bmatrix}, \quad g = 9.80665\,\text{m/s}^2$$

### 1.2 Vehicle Body Frame ($\mathcal{F}_b$): Forward-Left-Up (FLU)

The body frame is attached to the vehicle center of rotation:

- **$+X_b$ (Forward):** Longitudinal axis of the vehicle, pointing forward in the primary travel direction.
- **$+Y_b$ (Left):** Lateral axis of the vehicle, pointing out the vehicle's left side.
- **$+Z_b$ (Up):** Vertical axis of the vehicle, pointing upward normal to the vehicle chassis.

> [!IMPORTANT]
> **Phone vs. Vehicle Frame**: The mobile phone physical sensor frame $\mathcal{F}_s$ is **not** assumed identical to the vehicle frame $\mathcal{F}_b$. An explicit mounting calibration matrix / channel mapping $R_{bs}$ transforms phone sensor samples into vehicle body coordinates before entering the estimator:
> $$\vec{a}_b = R_{bs} \vec{a}_s, \quad \vec{\omega}_b = R_{bs} \vec{\omega}_s$$

### 1.3 Attitude Representation & Quaternion Convention

Attitude is parameterized by a scalar-first unit quaternion:
$$\mathbf{q}_{nb} = \begin{bmatrix} q_w \\ q_x \\ q_y \\ q_z \end{bmatrix} = \begin{bmatrix} w \\ \vec{v} \end{bmatrix} \in \mathbb{H}, \quad \|\mathbf{q}_{nb}\| = 1$$

- **Rotation Operator**: $\mathbf{q}_{nb}$ represents the rotation from the vehicle body frame $\mathcal{F}_b$ to the navigation frame $\mathcal{F}_n$.
- **Hamilton Quaternion Product**:
  $$\mathbf{p} \otimes \mathbf{q} = \begin{bmatrix} p_w q_w - \vec{p}_v \cdot \vec{q}_v \\ p_w \vec{q}_v + q_w \vec{p}_v + \vec{p}_v \times \vec{q}_v \end{bmatrix}$$
- **Rotation Matrix (Direction Cosine Matrix $R_{nb}$)**:
  Any vector $\vec{u}_b \in \mathcal{F}_b$ is rotated to $\vec{u}_n \in \mathcal{F}_n$ via $\vec{u}_n = R_{nb} \vec{u}_b$:
  $$R_{nb} = \begin{bmatrix} 1 - 2(q_y^2 + q_z^2) & 2(q_x q_y - q_z q_w) & 2(q_x q_z + q_y q_w) \\ 2(q_x q_y + q_z q_w) & 1 - 2(q_x^2 + q_z^2) & 2(q_y q_z - q_x q_w) \\ 2(q_x q_z - q_y q_w) & 2(q_y q_z + q_x q_w) & 1 - 2(q_x^2 + q_y^2) \end{bmatrix}$$
- **Reverse Transformation ($R_{bn}$)**:
  $$\vec{u}_b = R_{bn} \vec{u}_n = R_{nb}^T \vec{u}_n$$

### 1.4 Attitude Error Convention (Body-Frame Right-Multiplicative)

The true quaternion $\mathbf{q}_{nb}$ is related to the nominal estimate $\hat{\mathbf{q}}_{nb}$ by a right-multiplicative error quaternion:
$$\mathbf{q}_{nb} = \hat{\mathbf{q}}_{nb} \otimes \delta \mathbf{q}(\delta \vec{\theta})$$
where for small error angles $\delta \vec{\theta} \in \mathbb{R}^3$:
$$\delta \mathbf{q}(\delta \vec{\theta}) \approx \begin{bmatrix} 1 \\ \frac{1}{2} \delta \vec{\theta} \end{bmatrix}$$
In matrix form:
$$R_{nb} = \hat{R}_{nb} \exp([\delta \vec{\theta}]_\times) \approx \hat{R}_{nb} (I_3 + [\delta \vec{\theta}]_\times)$$
where $[\cdot]_\times$ is the standard skew-symmetric cross-product operator:
$$[\vec{v}]_\times = \begin{bmatrix} 0 & -v_z & v_y \\ v_z & 0 & -v_x \\ -v_y & v_x & 0 \end{bmatrix}$$

---

## 2. State Space Formulation

### 2.1 Nominal State Vector ($\hat{\mathbf{x}} \in \mathbb{R}^{16}$)

The nominal state tracks large-signal kinematic quantities:
$$\hat{\mathbf{x}} = \begin{bmatrix} \hat{\vec{p}}_n \\ \hat{\vec{v}}_n \\ \hat{\mathbf{q}}_{nb} \\ \hat{\vec{b}}_a \\ \hat{\vec{b}}_g \end{bmatrix} \begin{array}{l} \in \mathbb{R}^3 \quad \text{Position in ENU (meters)} \\ \in \mathbb{R}^3 \quad \text{Velocity in ENU (m/s)} \\ \in \mathbb{H} \quad \text{Attitude quaternion (body to ENU)} \\ \in \mathbb{R}^3 \quad \text{Accelerometer bias (m/s}^2\text{)} \\ \in \mathbb{R}^3 \quad \text{Gyroscope bias (rad/s)} \end{array}$$

### 2.2 Error State Vector ($\delta \mathbf{x} \in \mathbb{R}^{15}$)

The error state tracks small zero-mean Gaussian perturbations:
$$\delta \mathbf{x} = \begin{bmatrix} \delta \vec{p}_n \\ \delta \vec{v}_n \\ \delta \vec{\theta} \\ \delta \vec{b}_a \\ \delta \vec{b}_g \end{bmatrix} \begin{array}{l} \in \mathbb{R}^3 \quad \text{Position error in ENU (m)} \\ \in \mathbb{R}^3 \quad \text{Velocity error in ENU (m/s)} \\ \in \mathbb{R}^3 \quad \text{Attitude error in body frame (rad)} \\ \in \mathbb{R}^3 \quad \text{Accelerometer bias error (m/s}^2\text{)} \\ \in \mathbb{R}^3 \quad \text{Gyroscope bias error (rad/s)} \end{array}$$

### 2.3 Error State Covariance Matrix ($P \in \mathbb{R}^{15 \times 15}$)

$$P = \mathbb{E}[\delta \mathbf{x} \, \delta \mathbf{x}^T] = \begin{bmatrix} P_{pp} & P_{pv} & P_{p\theta} & P_{pa} & P_{pg} \\ P_{vp} & P_{vv} & P_{v\theta} & P_{va} & P_{vg} \\ P_{\theta p} & P_{\theta v} & P_{\theta\theta} & P_{\theta a} & P_{\theta g} \\ P_{ap} & P_{av} & P_{a\theta} & P_{aa} & P_{ag} \\ P_{gp} & P_{gv} & P_{g\theta} & P_{ga} & P_{gg} \end{bmatrix}$$

---

## 3. Nominal State & Covariance Propagation

### 3.1 Kinematic Propagation Equations

Given compensated body-frame IMU measurements over interval $\Delta t = t_k - t_{k-1}$:
$$\vec{a}_b = \vec{a}_{\text{meas}} - \hat{\vec{b}}_a$$
$$\vec{\omega}_b = \vec{\omega}_{\text{meas}} - \hat{\vec{b}}_g$$

1. **Attitude Propagation**:
   $$\hat{\mathbf{q}}_{nb, k} = \text{normalize}\left(\hat{\mathbf{q}}_{nb, k-1} \otimes \mathbf{q}_{\text{rot}}(\vec{\omega}_b \Delta t)\right)$$
   where:
   $$\mathbf{q}_{\text{rot}}(\vec{\phi}) = \begin{cases} \begin{bmatrix} \cos(\|\vec{\phi}\|/2) \\ \frac{\vec{\phi}}{\|\vec{\phi}\|} \sin(\|\vec{\phi}\|/2) \end{bmatrix} & \text{if } \|\vec{\phi}\| \ge 10^{-10} \\ \begin{bmatrix} 1.0 \\ \frac{1}{2} \vec{\phi} \end{bmatrix} & \text{otherwise} \end{cases}$$

2. **Navigation-Frame Acceleration**:
   $$\hat{\vec{a}}_n = \hat{R}_{nb, k-1} \vec{a}_b + \vec{g}_n$$

3. **Position and Velocity Propagation**:
   $$\hat{\vec{p}}_{n, k} = \hat{\vec{p}}_{n, k-1} + \hat{\vec{v}}_{n, k-1} \Delta t + \frac{1}{2} \hat{\vec{a}}_n \Delta t^2$$
   $$\hat{\vec{v}}_{n, k} = \hat{\vec{v}}_{n, k-1} + \hat{\vec{a}}_n \Delta t$$
   $$\hat{\vec{b}}_{a, k} = \hat{\vec{b}}_{a, k-1}, \quad \hat{\vec{b}}_{g, k} = \hat{\vec{b}}_{g, k-1}$$

### 3.2 Error-State System Dynamics Matrix ($F \in \mathbb{R}^{15 \times 15}$)

From the continuous-time error perturbation equations:
$$\dot{\delta \vec{p}}_n = \delta \vec{v}_n$$
$$\dot{\delta \vec{v}}_n = -\hat{R}_{nb} [\vec{a}_b]_\times \delta \vec{\theta} - \hat{R}_{nb} \delta \vec{b}_a + \vec{w}_a$$
$$\dot{\delta \vec{\theta}} = -[\vec{\omega}_b]_\times \delta \vec{\theta} - \delta \vec{b}_g + \vec{w}_g$$
$$\dot{\delta \vec{b}}_a = \vec{w}_{ba}, \quad \dot{\delta \vec{b}}_g = \vec{w}_{bg}$$

The continuous-time Jacobian matrix $F$ is structured as:
$$F = \begin{bmatrix} 0_{3 \times 3} & I_3 & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & -\hat{R}_{nb} [\vec{a}_b]_\times & -\hat{R}_{nb} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & -[\vec{\omega}_b]_\times & 0_{3 \times 3} & -I_3 \\ 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \end{bmatrix}$$

The first-order discrete state transition matrix $\Phi$ is:
$$\Phi = I_{15} + F \Delta t$$

### 3.3 Noise Coupling & Process Noise Covariance

The continuous noise coupling matrix $G \in \mathbb{R}^{15 \times 12}$ maps random sensor noise:
$$G = \begin{bmatrix} 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ \hat{R}_{nb} & 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & I_3 & 0_{3 \times 3} & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & I_3 & 0_{3 \times 3} \\ 0_{3 \times 3} & 0_{3 \times 3} & 0_{3 \times 3} & I_3 \end{bmatrix}$$

Continuous process noise spectral density matrix $Q_c \in \mathbb{R}^{12 \times 12}$:
$$Q_c = \text{diag}\left(\sigma_a^2 I_3, \, \sigma_g^2 I_3, \, \sigma_{ba}^2 I_3, \, \sigma_{bg}^2 I_3\right)$$

- Accelerometer noise density: $\sigma_a = 0.35\,\text{m/s}^2$
- Gyroscope noise density: $\sigma_g = 0.03\,\text{rad/s}$
- Accel bias random walk: $\sigma_{ba} = 0.01\,\text{m/s}^2/\sqrt{\text{s}}$
- Gyro bias random walk: $\sigma_{bg} = 0.002\,\text{rad/s}/\sqrt{\text{s}}$

Discrete covariance propagation:
$$P_k = \Phi P_{k-1} \Phi^T + G Q_c G^T \Delta t$$

---

## 4. Measurement Models & Jacobians

### 4.1 Learned Motion Prediction (Forward Velocity & Yaw Rate)

The learned model predicts scalar forward velocity $v_{\text{model}}$ and yaw rate $\omega_{\text{model}}$ in the vehicle body frame:

#### 4.1.1 Forward Velocity Measurement Model

Forward velocity is the projection of the navigation-frame velocity into the vehicle body longitudinal forward axis $+X_b$:
$$v_{\text{forward}} = \mathbf{e}_x^T \vec{v}_b = \mathbf{e}_x^T R_{nb}^T \vec{v}_n, \quad \mathbf{e}_x = \begin{bmatrix} 1 \\ 0 \\ 0 \end{bmatrix}$$

Substituting nominal and error perturbations:
$$\vec{v}_n = \hat{\vec{v}}_n + \delta \vec{v}_n, \quad R_{nb} \approx \hat{R}_{nb} (I_3 + [\delta \vec{\theta}]_\times) \implies R_{nb}^T \approx (I_3 - [\delta \vec{\theta}]_\times) \hat{R}_{nb}^T$$
$$v_{\text{forward}} \approx \mathbf{e}_x^T (I_3 - [\delta \vec{\theta}]_\times) \hat{R}_{nb}^T (\hat{\vec{v}}_n + \delta \vec{v}_n)$$
$$v_{\text{forward}} \approx \mathbf{e}_x^T \hat{\vec{v}}_b + \mathbf{e}_x^T \hat{R}_{bn} \delta \vec{v}_n - \mathbf{e}_x^T [\delta \vec{\theta}]_\times \hat{\vec{v}}_b$$

Using the identity $-[\delta \vec{\theta}]_\times \hat{\vec{v}}_b = [\hat{\vec{v}}_b]_\times \delta \vec{\theta}$:
$$v_{\text{forward}} \approx \hat{\vec{v}}_b[0] + \hat{R}_{bn}[0, :] \delta \vec{v}_n + \left(\mathbf{e}_x^T [\hat{\vec{v}}_b]_\times\right) \delta \vec{\theta}$$
Note that $\mathbf{e}_x^T [\hat{\vec{v}}_b]_\times = - ([\hat{\vec{v}}_b]_\times)_{0, :} = [0, \hat{v}_{b, z}, -\hat{v}_{b, y}]$.

**Measurement Residual**:
$$z_v = v_{\text{model}} - \hat{\vec{v}}_b[0] \in \mathbb{R}$$

**Measurement Jacobian ($H_v \in \mathbb{R}^{1 \times 15}$)**:
$$H_v = \begin{bmatrix} 0_{1 \times 3} & \hat{R}_{bn}[0, :] & (-[\hat{\vec{v}}_b]_\times)_{0, :} & 0_{1 \times 3} & 0_{1 \times 3} \end{bmatrix}$$
where:
$$\hat{R}_{bn}[0, :] = \text{Row 0 of } \hat{R}_{nb}^T$$
$$(-[\hat{\vec{v}}_b]_\times)_{0, :} = \begin{bmatrix} 0 & \hat{v}_{b, z} & -\hat{v}_{b, y} \end{bmatrix}$$

**Measurement Variance**:
$$R_v = \sigma_{v_{\text{model}}}^2$$

---

#### 4.1.2 Yaw Rate Calibration Model

When raw gyro sample $\vec{\omega}_{\text{meas}}$ is available, the model output $\omega_{\text{pred}, z}$ observes body yaw rate $\omega_{b, z} = \omega_{\text{meas}, z} - b_{g, z}$:
$$z_\omega = \omega_{\text{pred}, z} - (\omega_{\text{meas}, z} - \hat{b}_{g, z})$$

**Measurement Jacobian ($H_\omega \in \mathbb{R}^{1 \times 15}$)**:
$$H_\omega = \begin{bmatrix} 0_{1 \times 14} & -1.0 \end{bmatrix}$$

**Measurement Variance**:
$$R_\omega = \sigma_{\omega_{\text{pred}}}^2$$

---

### 4.2 Non-Holonomic Constraints (NHC)

For non-holonomic road vehicles, lateral and vertical velocities in the body frame are nominally zero:
$$v_{b, y} = \mathbf{e}_y^T R_{nb}^T \vec{v}_n \approx 0$$
$$v_{b, z} = \mathbf{e}_z^T R_{nb}^T \vec{v}_n \approx 0$$

**Measurement Residual**:
$$\vec{z}_{\text{nhc}} = \begin{bmatrix} 0 - \hat{v}_{b, y} \\ 0 - \hat{v}_{b, z} \end{bmatrix} = -\hat{\vec{v}}_b[1:3] \in \mathbb{R}^2$$

**Measurement Jacobian ($H_{\text{nhc}} \in \mathbb{R}^{2 \times 15}$)**:
$$H_{\text{nhc}} = \begin{bmatrix} 0_{2 \times 3} & \hat{R}_{bn}[1:3, :] & (-[\hat{\vec{v}}_b]_\times)_{1:3, :} & 0_{2 \times 3} & 0_{2 \times 3} \end{bmatrix}$$
where:
$$\hat{R}_{bn}[1:3, :] = \begin{bmatrix} \text{Row 1 of } \hat{R}_{nb}^T \\ \text{Row 2 of } \hat{R}_{nb}^T \end{bmatrix}$$
$$(-[\hat{\vec{v}}_b]_\times)_{1:3, :} = \begin{bmatrix} -\hat{v}_{b, z} & 0 & \hat{v}_{b, x} \\ \hat{v}_{b, y} & -\hat{v}_{b, x} & 0 \end{bmatrix}$$

**Measurement Covariance**:
$$R_{\text{nhc}} = \begin{bmatrix} \sigma_{\text{lat}}^2 & 0 \\ 0 & \sigma_{\text{vert}}^2 \end{bmatrix}, \quad \sigma_{\text{lat}} = 0.35\,\text{m/s}, \quad \sigma_{\text{vert}} = 0.20\,\text{m/s}$$

**Gating**: NHC is activated only when forward speed $\|\hat{\vec{v}}_n\| > 1.5\,\text{m/s}$ to prevent spurious constraints while stationary.

---

### 4.3 GNSS Position & Velocity Updates

Incoming reference GNSS fix provides geodetic position $(\phi, \lambda, h)$, projected to local ENU $\vec{p}_{\text{gnss}} \in \mathbb{R}^3$:

**Position Residual**:
$$\vec{z}_{\text{pos}} = \vec{p}_{\text{gnss}} - \hat{\vec{p}}_n \in \mathbb{R}^3$$

**Position Jacobian ($H_{\text{pos}} \in \mathbb{R}^{3 \times 15}$)**:
$$H_{\text{pos}} = \begin{bmatrix} I_3 & 0_{3 \times 12} \end{bmatrix}$$

**Position Covariance**:
$$R_{\text{pos}} = \sigma_{\text{gnss, horiz}}^2 I_3 \quad (\text{or } \text{diag}(\sigma_E^2, \sigma_N^2, \sigma_U^2))$$

**Velocity Residual (when GNSS ground speed & course are available)**:
$$\vec{z}_{\text{vel}} = \vec{v}_{\text{gnss}} - \hat{\vec{v}}_n \in \mathbb{R}^3$$
$$H_{\text{vel}} = \begin{bmatrix} 0_{3 \times 3} & I_3 & 0_{3 \times 9} \end{bmatrix}, \quad R_{\text{vel}} = \sigma_{\text{gnss, vel}}^2 I_3$$

---

### 4.4 Soft Road and Route Polyline Position Constraints

Given candidate projection coordinate $\vec{p}_{\text{target}} \in \mathbb{R}^2$ (East, North) on the selected road or pre-existing route:

**Residual**:
$$\vec{z}_{\text{poly}} = \vec{p}_{\text{target}} - \hat{\vec{p}}_n[0:2] \in \mathbb{R}^2$$

**Jacobian ($H_{\text{poly}} \in \mathbb{R}^{2 \times 15}$)**:
$$H_{\text{poly}} = \begin{bmatrix} I_2 & 0_{2 \times 13} \end{bmatrix}$$

**Residual-Inflated Covariance**:
$$R_{\text{poly}} = I_2 \cdot \left(\sigma_{\text{base}}^2 + (\kappa \cdot d_{\perp})^2\right)$$
where $\sigma_{\text{base}} = 8.0\,\text{m}$, $\kappa = 0.50$, and $d_{\perp} = \|\vec{z}_{\text{poly}}\|$.

---

## 5. Generalized Kalman Update & State Injection

For any measurement vector $\vec{z} \in \mathbb{R}^m$, Jacobian $H \in \mathbb{R}^{m \times 15}$, and covariance $R_m \in \mathbb{R}^{m \times m}$ ($m \le 3$):

1. **Innovation Covariance**:
   $$S = H P H^T + R_m \in \mathbb{R}^{m \times m}$$

2. **Kalman Gain**:
   $$K = P H^T S^{-1} \in \mathbb{R}^{15 \times m}$$
   Because $m \in \{1, 2, 3\}$, $S^{-1}$ is computed via closed-form analytical determinant inversions:
   - $m = 1$: Scalar inversion $1 / S$.
   - $m = 2$: $2 \times 2$ Cramer's rule.
   - $m = 3$: $3 \times 3$ cofactor matrix division by determinant.

3. **Error State Correction**:
   $$\delta \hat{\mathbf{x}} = K \vec{z} \in \mathbb{R}^{15}$$

4. **Nominal State Injection**:
   $$\hat{\vec{p}}_n \leftarrow \hat{\vec{p}}_n + \delta \hat{\mathbf{x}}[0:3]$$
   $$\hat{\vec{v}}_n \leftarrow \hat{\vec{v}}_n + \delta \hat{\mathbf{x}}[3:6]$$
   $$\hat{\mathbf{q}}_{nb} \leftarrow \text{normalize}\left(\hat{\mathbf{q}}_{nb} \otimes \mathbf{q}_{\text{rot}}(\delta \hat{\mathbf{x}}[6:9])\right)$$
   $$\hat{\vec{b}}_a \leftarrow \hat{\vec{b}}_a + \delta \hat{\mathbf{x}}[9:12]$$
   $$\hat{\vec{b}}_g \leftarrow \hat{\vec{b}}_g + \delta \hat{\mathbf{x}}[12:15]$$

5. **Joseph-Form Covariance Update**:
   To guarantee positive semi-definiteness and numerical stability under finite-precision mobile floating-point arithmetic:
   $$P \leftarrow (I_{15} - K H) P (I_{15} - K H)^T + K R_m K^T$$

6. **Numerical Stabilization**:
   $$P \leftarrow \frac{1}{2} (P + P^T)$$
   $$P_{ii} \leftarrow \max(P_{ii}, 10^{-12})$$
   Ensure off-diagonal correlation $|P_{ij}| \le 0.999 \sqrt{P_{ii} P_{jj}}$.

---

## 6. Verification Tolerances Against Python Reference

In accordance with user instruction, blanket $10^{-5}$ tolerances are replaced with **component-specific, physically justified tolerances**:

| State Component                             | Numerical Tolerance                                    | Justification                                                                            |
| :------------------------------------------ | :----------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| **Position ($\vec{p}_n$)**                  | $\text{Max Error} \le 0.05\,\text{m}$ ($5\,\text{cm}$) | Floating-point accumulation over 100 s; $5\,\text{cm}$ is $0.1\%$ of GPS accuracy.       |
| **Velocity ($\vec{v}_n$)**                  | $\text{Max Error} \le 0.02\,\text{m/s}$                | Millimeter-per-second precision is well below sensor noise floor ($0.35\,\text{m/s}^2$). |
| **Attitude Quaternion ($\mathbf{q}_{nb}$)** | $\text{Max Error} \le 10^{-4}$                         | Direction Cosine angle deviation $< 0.01^\circ$.                                         |
| **Sensor Biases ($\vec{b}_a, \vec{b}_g$)**  | $\text{Max Error} \le 10^{-4}$                         | Parameter convergence matching.                                                          |
| **Covariance Diagonal ($P_{ii}$)**          | $\text{Relative Error} \le 0.5\%$                      | Matches matrix arithmetic between NumPy LAPACK and TypeScript.                           |
