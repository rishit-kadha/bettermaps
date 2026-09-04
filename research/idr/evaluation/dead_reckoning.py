"""
Kinematic Dead-Reckoning Trajectory Integrator & Outage Evaluation Module.

Evaluates dead-reckoning trajectories across synthetic GNSS outages:
- Outage durations: 5s, 10s, 20s, 30s, 60s.
- Multiple non-overlapping outage intervals across evaluation sessions.
- Initialized from reference state at t_0 (position, heading, speed).
- Driven strictly by predicted [v_f, omega_z] during outage.
- NEVER re-anchored or corrected during the outage interval.
- Computes:
    Final Position Error (ATE): Euclidean distance to reference at t_outage
    Along-track error (longitudinal)
    Cross-track error (lateral)
    Mean, Median, 90th percentile errors across intervals
"""

import numpy as np
from typing import Dict, List, Tuple, Any, Optional


def latlon_to_local_xy(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> Tuple[np.ndarray, np.ndarray]:
    """Converts WGS-84 (lat, lon) coordinates to local metric ENU tangent plane."""
    R_earth = 6378137.0  # WGS-84 equatorial radius (meters)
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    lat0_rad = np.radians(lat0)
    lon0_rad = np.radians(lon0)
    
    x = R_earth * (lon_rad - lon0_rad) * np.cos(lat0_rad)
    y = R_earth * (lat_rad - lat0_rad)
    return x, y


def integrate_trajectory(
    v_f: np.ndarray,
    omega_z: np.ndarray,
    init_heading_rad: float,
    dt: float = 0.100
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Kinematic forward dead-reckoning integration:
        psi_{k+1} = psi_k + omega_{z, k} * dt
        x_{k+1} = x_k + v_{f, k} * cos(psi_k) * dt
        y_{k+1} = y_k + v_{f, k} * sin(psi_k) * dt
    
    Returns:
        (x_arr, y_arr, psi_arr) starting from (0, 0, init_heading_rad).
    """
    N = len(v_f)
    x = np.zeros(N + 1, dtype=np.float64)
    y = np.zeros(N + 1, dtype=np.float64)
    psi = np.zeros(N + 1, dtype=np.float64)
    psi[0] = init_heading_rad
    
    for k in range(N):
        psi[k + 1] = psi[k] + omega_z[k] * dt
        # Midpoint or forward Euler
        psi_mid = psi[k] + 0.5 * omega_z[k] * dt
        x[k + 1] = x[k] + v_f[k] * np.cos(psi_mid) * dt
        y[k + 1] = y[k] + v_f[k] * np.sin(psi_mid) * dt
        
    return x[1:], y[1:], psi[1:]


def evaluate_outages_for_session(
    v_pred: np.ndarray,
    omega_pred: np.ndarray,
    ref_coords: np.ndarray, # [N, 2] -> [lat, lon]
    ref_targets: np.ndarray, # [N, 2] -> [v_ref, omega_ref]
    outage_durations_s: List[int] = [5, 10, 20, 30, 60],
    dt: float = 0.100
) -> Dict[int, List[Dict[str, float]]]:
    """
    Evaluates dead-reckoning across multiple non-overlapping synthetic outages.
    """
    N = min(len(v_pred), len(ref_coords))
    results_by_duration: Dict[int, List[Dict[str, float]]] = {}
    
    # Pre-convert full reference trajectory to metric XY
    lat0 = ref_coords[0, 0]
    lon0 = ref_coords[0, 1]
    x_ref_full, y_ref_full = latlon_to_local_xy(ref_coords[:N, 0], ref_coords[:N, 1], lat0, lon0)
    
    # Calculate reference heading angle at each point
    dx_ref = np.gradient(x_ref_full, dt)
    dy_ref = np.gradient(y_ref_full, dt)
    heading_ref_full = np.arctan2(dy_ref, dx_ref)
    
    for dur_s in outage_durations_s:
        dur_samples = int(round(dur_s / dt))
        results_by_duration[dur_s] = []
        
        # Non-overlapping intervals with buffer
        step = dur_samples + 50  # 50 samples gap between outages
        starts = list(range(20, N - dur_samples, step))
        
        for start_idx in starts:
            end_idx = start_idx + dur_samples
            
            # Initial state at start_idx
            init_psi = heading_ref_full[start_idx]
            
            # Integrate dead reckoning during outage
            v_sub = v_pred[start_idx:end_idx]
            omega_sub = omega_pred[start_idx:end_idx]
            
            x_dr, y_dr, psi_dr = integrate_trajectory(v_sub, omega_sub, init_psi, dt)
            
            # Reference trajectory relative to start_idx
            x_ref_rel = x_ref_full[start_idx:end_idx] - x_ref_full[start_idx]
            y_ref_rel = y_ref_full[start_idx:end_idx] - y_ref_full[start_idx]
            
            # Final position error
            final_err = np.sqrt((x_dr[-1] - x_ref_rel[-1]) ** 2 + (y_dr[-1] - y_ref_rel[-1]) ** 2)
            
            # Mean error along the outage
            mean_err = np.mean(np.sqrt((x_dr - x_ref_rel) ** 2 + (y_dr - y_ref_rel) ** 2))
            
            # Longitudinal (along-track) and lateral (cross-track) decomposition at end
            final_heading_ref = heading_ref_full[end_idx - 1]
            dx_end = x_dr[-1] - x_ref_rel[-1]
            dy_end = y_dr[-1] - y_ref_rel[-1]
            along_track = dx_end * np.cos(final_heading_ref) + dy_end * np.sin(final_heading_ref)
            cross_track = -dx_end * np.sin(final_heading_ref) + dy_end * np.cos(final_heading_ref)
            
            # Trajectory distance traveled
            distance_m = np.sum(ref_targets[start_idx:end_idx, 0] * dt)
            rel_err_pct = (final_err / distance_m * 100.0) if distance_m > 5.0 else 0.0
            
            results_by_duration[dur_s].append({
                "start_s": round(start_idx * dt, 1),
                "duration_s": dur_s,
                "distance_m": round(float(distance_m), 1),
                "final_ate_m": round(float(final_err), 2),
                "mean_ate_m": round(float(mean_err), 2),
                "along_track_m": round(float(along_track), 2),
                "cross_track_m": round(float(cross_track), 2),
                "rel_err_pct": round(float(rel_err_pct), 2)
            })
            
    return results_by_duration


def summarize_outage_benchmark(
    all_session_results: List[Dict[int, List[Dict[str, float]]]]
) -> Dict[str, Any]:
    """Aggregates outage statistics across all test sessions and intervals."""
    summary = {}
    for dur_s in [5, 10, 20, 30, 60]:
        dur_records = []
        for sess_res in all_session_results:
            if dur_s in sess_res:
                dur_records.extend(sess_res[dur_s])
                
        if not dur_records:
            continue
            
        ates = np.array([r["final_ate_m"] for r in dur_records])
        alongs = np.array([abs(r["along_track_m"]) for r in dur_records])
        crosses = np.array([abs(r["cross_track_m"]) for r in dur_records])
        rel_pcts = np.array([r["rel_err_pct"] for r in dur_records])
        
        summary[f"{dur_s}s"] = {
            "outage_duration_s": dur_s,
            "sample_count": len(ates),
            "final_ate_mean_m": round(float(np.mean(ates)), 2),
            "final_ate_median_m": round(float(np.median(ates)), 2),
            "final_ate_p90_m": round(float(np.percentile(ates, 90)), 2),
            "along_track_mean_m": round(float(np.mean(alongs)), 2),
            "cross_track_mean_m": round(float(np.mean(crosses)), 2),
            "rel_err_median_pct": round(float(np.median(rel_pcts)), 2)
        }
    return summary

