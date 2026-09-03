# BetterMaps System Architecture
## SIH Problem Statement: "AI-ML based Intelligent Dead Reckoning System for Seamless Navigation"

---

## 1. Architectural Philosophy: React Native UI + Native Platform Adapters

BetterMaps is architected around a strict separation between a **single cross-platform React Native application layer** and **pluggable platform-specific native adapters**.

The React Native presentation layer is treated as the **cross-platform navigation frontend** that will run on both **Android** and **iOS**, while native adapters provide sensor/location access, and the **IDR Core** serves as the portable navigation engine.

```
                    React Native App
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
        UI          Navigation      App State
          │
          ▼
   Platform-neutral
   interfaces / bridge
          │
    ┌─────┴─────┐
    │           │
    ▼           ▼
 Android      iOS
 Adapter      Adapter
    │           │
    ├── GNSS    ├── GNSS
    ├── IMU     ├── IMU
    ├── Gyro    ├── Gyro
    ├── Mag     ├── Mag
    └── IDR     └── IDR
```

The React Native layer knows **only about interfaces and normalized data**, never Android `SensorEvent`, iOS `CMMotionManager`, or proprietary hardware primitives.

---

## 2. Location Architecture

All positioning engines adhere to the platform-independent contract [`ILocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/location.ts):

```
                    LocationProvider
                           │
              ┌────────────┴────────────┐
              │                         │
       Android adapter             iOS adapter
              │                         │
      Android Location APIs       Core Location
```

### Normalized Location State (`NavLocation`)
```typescript
export interface NavLocation {
  latitude: number;           // WGS84 latitude
  longitude: number;          // WGS84 longitude
  altitude?: number | null;   // Ellipsoid altitude (meters)
  accuracy?: number | null;   // Horizontal accuracy radius (meters)
  altitudeAccuracy?: number | null;
  heading?: number | null;    // Course bearing (0-359.9 deg, 0 = True North)
  speed?: number | null;      // Speed over ground (m/s)
  timestamp: number;          // Fix timestamp (epoch ms)
  providerType: ProviderType; // 'gnss' | 'idr' | 'hybrid' | 'mock'
  isDeadReckoning: boolean;   // true during GNSS outages
}
```

### Implementations:
- **Phase 1**: [`AndroidGnssLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/AndroidGnssLocationProvider.ts) (connects to Android `FusedLocationProviderClient`).
- **Future iOS**: [`IosGnssLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/IosGnssLocationProvider.ts) (connects to iOS `CoreLocation`).
- **Development/Testing**: [`MockLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/MockLocationProvider.ts) (simulates routes & GNSS dropouts).
- **Future Fusion**: `AndroidHybridLocationProvider` / `IosHybridLocationProvider` (GNSS + IMU + IDR).

---

## 3. Sensor Architecture

High-frequency IMU data is normalized across platforms:

```
React Native / IDR Core
          │
          ▼
   ImuProvider interface
          │
    ┌─────┴─────┐
    ▼           ▼
 Android       iOS
 Adapter     Adapter
    │           │
 Sensor       Core
 Manager     Motion
```

### Normalized Representation ([`ImuSample`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/imu.ts))
```typescript
export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface ImuSample {
  timestamp: number;          // Timestamp (monotonic ms)
  accel: Vector3D;            // Linear acceleration (m/s^2)
  gyro: Vector3D;             // Angular velocity (rad/s)
  magnetometer?: Vector3D;    // Geomagnetic field (uT)
}
```

### Platform Adapters:
- [`AndroidImuProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/imu/AndroidImuProvider.ts): Ingests Android `SensorManager` events (`SENSOR_DELAY_FASTEST`) and normalizes to SI units.
- [`IosImuProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/imu/IosImuProvider.ts): Ingests Apple `CMMotionManager` events.

---

## 4. IDR Core Architecture

The IDR positioning algorithm remains independent from both React Native and the mobile operating system:

```
Android native adapter ─┐
                        │
iOS native adapter ─────┼──► IDR Core
                        │
External IMU adapter ───┤
                        │
IO-VNBD adapter ────────┘
```

The IDR Core contains:
1. **Sensor Preprocessing**: High-pass & low-pass filtering to suppress engine vibrations, road noise, potholes, and bumps.
2. **Calibration**: Online bias tracking for accelerometer and gyroscope.
3. **Phone-to-Vehicle Alignment**: Dynamic attitude estimation (Madgwick/Mahony AHRS / rotation quaternion) to map phone axes to vehicle frame.
4. **ML Forward Velocity Estimator**: Lightweight 1D-CNN / GRU trained on the [IO-VNBD dataset](https://github.com/onyekpeu/IO-VNBD).
5. **INS Strapdown Propagation**: Numerical integration of attitude, velocity, and position.
6. **Vehicle Kinematic Constraints**: Non-Holonomic Constraints (NHC) enforcing zero lateral/vertical slip, and Zero Velocity Updates (ZUPT).
7. **GNSS + INS Fusion**: Error-State Kalman Filter (ESKF) running continuous calibration during GNSS lock and dead reckoning during outages.
8. **Map Matching**: Projects estimated trajectory onto road network geometries to eliminate drift.

---

## 5. Map & Presentation Layer Architecture

The complete presentation layer is implemented in React Native with clean isolation:

```
React Native App (App.tsx)
│
├── Map Screen (MapContainer.tsx: isolates Google Maps specifics)
│     └── Vehicle Marker (VehicleMarker.tsx: heading-aware chevron)
├── Navigation HUD (NavigationHUD.tsx: floating compass, recenter FAB, speedometer)
├── Diagnostics Panel (DiagnosticsPanel.tsx: live Hz, accuracy, lat/lon)
└── Navigation State (NavigationManager.ts: circular heading filter, update rate)
        │
        ▼
   LocationProvider (ILocationProvider)
        │
        ▼
Platform Adapter (AndroidGnssLocationProvider)
```

Google Maps-specific logic is entirely contained inside [`MapContainer.tsx`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/components/map/MapContainer.tsx). The rest of the application interacts with map states via generic props.

---

## 6. Phase 1 Implementation Status

- [x] **React Native Navigation UI**: Clean driving navigation interface with 100% map viewport.
- [x] **Android Native Location Adapter**: [`AndroidGnssLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/AndroidGnssLocationProvider.ts) streaming fine GPS fixes.
- [x] **Normalized Location State**: Emits unified `NavLocation` fixes.
- [x] **Real-Time Update Frequency**: Dynamic calculation of approximate Hz.
- [x] **Heading-Aware Puck**: Directional chevron when vehicle is in motion; stationary circle when stopped.
- [x] **Navigation Camera**: Course-Up (3D perspective @ 45° tilt) and North-Up (2D top-down) with manual pan release and Recenter FAB.
- [x] **Cross-Platform Sensor Interfaces**: [`ImuSample`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/imu.ts) and [`IImuProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/imu.ts) defined for Phase 2.
- [x] **IDR Core Specification**: Documented in [`src/idr/README.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/idr/README.md).
