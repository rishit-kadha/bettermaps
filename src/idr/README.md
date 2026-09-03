# IDR Core Architecture Specification

### Intelligent Dead Reckoning Engine (Platform-Independent Core)

The Intelligent Dead Reckoning (IDR) Core is designed as a **portable, standalone navigation engine**. It is completely decoupled from React Native, Android OS, and iOS APIs.

---

## 1. Decoupled Ingestion Pipeline

```
┌────────────────────────────────────────────────────────┐
│                    Input Adapters                      │
├────────────────────────────┬───────────────────────────┤
│ Android SensorManager      │ Native C++ / JNI bridge   │
│ iOS CoreMotion             │ Objective-C++ bridge      │
│ External IMU (CAN / BLE)   │ Serial / Socket stream    │
│ IO-VNBD Benchmark Dataset  │ Python / CSV / HDF5 replay│
└────────────────────────────┴───────────────────────────┘
                             │
                             ▼ (Emits normalized ImuSample & GNSS Fixes)
┌────────────────────────────────────────────────────────┐
│                       IDR Core                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 1. Sensor Preprocessing & Bandpass Filtering     │  │
│  │    - Suppress engine vibration, bumps, potholes  │  │
│  │ 2. Calibration & Bias Tracking                   │  │
│  │    - Online accelerometer / gyroscope bias est.  │  │
│  │ 3. Phone-to-Vehicle Attitude Alignment           │  │
│  │    - Madgwick/Mahony AHRS or Quaternion filter   │  │
│  │ 4. ML Forward Velocity Estimator                 │  │
│  │    - 1D-CNN / GRU trained on IO-VNBD dataset     │  │
│  │ 5. Inertial Navigation System (INS) Propagation  │  │
│  │    - Strapdown integration (attitude, vel, pos)  │  │
│  │ 6. Vehicle Kinematic Constraints                 │  │
│  │    - Non-Holonomic Constraints (zero lateral slip│  │
│  │    - Zero Velocity Updates (ZUPT) when stopped   │  │
│  │ 7. Error-State Kalman Filter (ESKF)              │  │
│  │    - Loose/tight GNSS + INS state fusion         │  │
│  │ 8. Map Matching & Road Network Projection        │  │
│  │    - Constrains dead-reckoning trajectory drift  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
                             │
                             ▼ (Emits normalized 10 Hz NavLocation)
┌────────────────────────────────────────────────────────┐
│             Shared React Native Application            │
│         (NavigationMap, HUD, Telemetry, Puck)          │
└────────────────────────────────────────────────────────┘
```

---

## 2. Normalized Data Interfaces

### `ImuSample`

Normalized cross-platform frame:

- `timestamp`: monotonic millisecond/nanosecond timestamp.
- `accel`: `{ x, y, z }` in $m/s^2$ (gravity included).
- `gyro`: `{ x, y, z }` in $rad/s$.
- `magnetometer`: optional `{ x, y, z }` in $\mu T$.

### `NavLocation` (Output)

Normalized 10 Hz navigation state delivered to React Native:

- `latitude`, `longitude`, `altitude` (WGS84)
- `speed` ($m/s$ and $km/h$)
- `heading` ($0 - 359.9^\circ$, True North)
- `accuracy` ($\pm$ meters horizontal confidence)
- `isDeadReckoning`: boolean flag indicating GNSS-denied mode.

---

## 3. Dataset Integration: IO-VNBD

The primary benchmark and training dataset is:

- **IO-VNBD**: [Inertial and Odometry Benchmark Dataset for Ground Vehicle Positioning](https://github.com/onyekpeu/IO-VNBD)
- Ground-truth reference: Differential GNSS/RTK + OBD-II wheel odometry.
- Use case: Training lightweight neural network models (1D-CNN / TCN / GRU) to predict instantaneous vehicle forward velocity directly from phone IMU windows.
