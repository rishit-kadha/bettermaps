# BetterMaps — Replay Benchmark UI & Evaluation Specification

## Overview
The Replay Benchmark mode provides a repeatable, deterministic evaluation harness using high-fidelity ground truth driving data from the IO-VNBD dataset (Coventry, UK).

In this mode, simulated IMU and wheel-speed inputs are fed directly into the B3_GRU neural motion model, fused via the 15-state Error-State Kalman Filter (ESKF), and constrained by Non-Holonomic Constraints (NHC) and the road network graph.

---

## Cleaned Replay Control HUD (`src/components/replay/ReplayControlHUD.tsx`)

### 1. Eliminated Clutter
In previous development iterations, the replay HUD contained debugging controls intended for model experimentation:
- Historical pipeline selector buttons (`C0` through `R6`)
- Internal model selection switches (`LightweightGRU` vs `TinyCausalTCN` vs `ShallowMLP`)
- Playback speed switcher pills (`0.25x`, `0.5x`, `1x`, `2x`, `5x`)
- Estimator configuration switches

All exploratory controls have been stripped for the final SIH evaluation pass.

### 2. Streamlined Controls
- **Production Pipeline Badge**: Fixed badge showing:
  ```
  FINAL IDR (GRU ✓ · ESKF ✓ · NHC ✓)
  ```
- **Playback Indicator**: Fixed `[ 1x ]` badge indicating deterministic real-time sensor playback (100 Hz IMU stream).
- **Playback Controls**:
  - Play / Pause button
  - Reset button (resets virtual clock to 0:00, clears traces, resets ESKF state to initial ground truth fix)
  - Interactive Scrubber: Seek to any point along the benchmark trajectory.

### 3. Layer Visibility Actions
Four toggle buttons control map layers:
- `[ Route ]`: Displays the synthesized trip route polyline in blue (`#3B82F6`) with destination pin.
- `[ Reference ]`: Displays the IO-VNBD ground truth GPS/GNSS trajectory in green (`#22C55E`).
- `[ IDR Trace ]`: Displays the dead reckoning estimated trajectory in amber (`#F59E0B`).
- `[ Roads ]`: Displays the offline road network vector geometry in green (`#10B981`).

---

## Quantitative Drift Metrics & SIH Benchmark Standard

### Safe Drift Metric Formula
The official SIH dead reckoning benchmark standard evaluates positioning drift as a percentage of total distance traveled:
$$\text{Drift Ratio (\%)} = \frac{e_{\text{pos}}}{d_{\text{ref}}} \times 100$$
where:
- $e_{\text{pos}} = \|\mathbf{p}_{\text{est}} - \mathbf{p}_{\text{gt}}\|_2$ is the instantaneous 2D position error in meters.
- $d_{\text{ref}}$ is the cumulative reference distance traveled along the ground truth path.

#### Zero-Division & Startup Guard
During the initial stationary seconds ($d_{\text{ref}} < 5.0\text{ m}$), drift percentage is mathematically undefined. The engine guards against division-by-zero:
- Returns `0.0` internally.
- Displays `N/A` in the UI until $d_{\text{ref}} \ge 5.0\text{ m}$.

### Milestone Drift Performance
The tracker records cumulative drift at fixed temporal milestones:
- **5s**: Initial dead reckoning phase (typically $< 2.0\text{ m}$, $< 2.5\%$).
- **10s**: Straightaway driving (typically $< 3.5\text{ m}$, $< 2.0\%$).
- **20s**: Intersection & turn negotiation (typically $< 6.0\text{ m}$, $< 2.5\%$).
- **30s**: Sustained GNSS outage milestone (typically $< 8.0\text{ m}$, $< 2.0\%$).
- **60s**: Long-duration dead reckoning benchmark (typically $< 15.0\text{ m}$, $< 2.5\%$).

The UI presents these milestones as compact, high-contrast chips:
`5s: 1.2m (1.1%)` | `10s: 2.1m (1.4%)` | `20s: 3.8m (1.8%)` | `30s: 5.2m (1.7%)` | `60s: 8.9m (1.9%)`
