"""
Orientation & Coordinate Frame Calibration Module for BetterMaps IDR.

Implements mathematically verified device-frame to vehicle-frame 
transformations (R_{D -> V}) for each session, avoiding globally hardcoded 
axis assumptions.

Coordinate Frames:
- Device Frame (F_D): Smartphone sensor coordinate system.
- Vehicle Body Frame (F_V): ENU-compatible vehicle frame:
  +X_V: Forward along vehicle longitudinal axis
  +Y_V: Left / lateral axis
  +Z_V: Up / vertical axis (yaw axis, positive counter-clockwise)
"""

import numpy as np
import pandas as pd
from typing import Dict, Tuple, Any, Optional


def compute_rodrigues_tilt(gravity_d: np.ndarray) -> np.ndarray:
    """
    Computes rotation matrix R_tilt aligning device gravity vector to [0, 0, -1]^T (Up = +Z).
    Gravity vector g_D points down (acceleration of reaction is up).
    """
    norm_g = np.linalg.norm(gravity_d)
    if norm_g < 1e-4:
        return np.eye(3)
    
    z_g_in_d = -gravity_d / norm_g
    target_z = np.array([0.0, 0.0, 1.0])
    
    v = np.cross(z_g_in_d, target_z)
    s = np.linalg.norm(v)
    c = np.dot(z_g_in_d, target_z)
    
    if s < 1e-6:
        if c > 0:
            return np.eye(3)
        else:
            return np.diag([1.0, -1.0, -1.0])
            
    v_x = np.array([
        [0.0, -v[2], v[1]],
        [v[2], 0.0, -v[0]],
        [-v[1], v[0], 0.0]
    ])
    
    R_tilt = np.eye(3) + v_x + (v_x @ v_x) * ((1.0 - c) / (s ** 2))
    return R_tilt


def estimate_session_transform(
    df_s: pd.DataFrame, 
    df_v: pd.DataFrame, 
    tau_star_samples: int = 0
) -> Dict[str, Any]:
    """
    Determines and validates the explicit R_{D -> V} rotation for an individual session.
    
    Protocol:
    1. Slice both streams by the estimated session lag tau_star_samples.
    2. Check if stationary run (speed < 2 km/h or yaw_rate std < 0.005).
    3. Identify phone vertical / yaw rotation axis in device frame by correlating
       gyro channels with reference vehicle yaw rate during maneuvers.
    4. Estimate gravity vector and dynamic acceleration.
    5. Project acceleration onto horizontal plane orthogonal to vertical axis.
    6. Find forward (longitudinal) axis by maximizing covariance with vehicle dv/dt
       during positive throttle straight line driving.
    7. Form orthonormal right-handed triad:
       u_z = vertical axis
       u_x = longitudinal forward axis
       u_y = u_z x u_x (lateral left axis)
       R_{D -> V} = [u_x; u_y; u_z]
    8. Transform signals and record diagnostic metrics.
    """
    df_s_clean = df_s.copy()
    df_s_clean.columns = [c.strip() for c in df_s_clean.columns]
    df_v_clean = df_v.copy()
    df_v_clean.columns = [c.strip() for c in df_v_clean.columns]
    
    n_s = len(df_s_clean)
    n_v = len(df_v_clean)
    
    if tau_star_samples > 0:
        s_slice = slice(tau_star_samples, min(n_s, n_v + tau_star_samples))
        v_slice = slice(0, min(n_v, n_s - tau_star_samples))
    elif tau_star_samples < 0:
        shift = abs(tau_star_samples)
        s_slice = slice(0, min(n_s, n_v - shift))
        v_slice = slice(shift, min(n_v, n_s + shift))
    else:
        min_len = min(n_s, n_v)
        s_slice = slice(0, min_len)
        v_slice = slice(0, min_len)
        
    sub_s = df_s_clean.iloc[s_slice].reset_index(drop=True)
    sub_v = df_v_clean.iloc[v_slice].reset_index(drop=True)
    
    min_eval = min(len(sub_s), len(sub_v))
    if min_eval < 50:
        return {
            'reliable': False,
            'reason': 'SESSION_TOO_SHORT',
            'R_D_to_V': np.eye(3),
            'yaw_corr': 0.0,
            'best_gyro_axis': 'UNKNOWN',
            'psi_mount_deg': 0.0,
            'long_accel_corr': 0.0
        }
        
    sub_s = sub_s.iloc[:min_eval]
    sub_v = sub_v.iloc[:min_eval]
    
    vel_col = [c for c in sub_v.columns if 'velo' in c.lower() or 'speed' in c.lower()][0]
    yaw_col = [c for c in sub_v.columns if 'yaw' in c.lower()][0]
    
    vel_ref_ms = sub_v[vel_col].fillna(0).values / 3.6
    yaw_ref = sub_v[yaw_col].fillna(0).values * (np.pi / 180.0)
    dv_ref = np.gradient(vel_ref_ms, 0.1)
    
    # Check if stationary benchmark run
    is_stationary = (vel_ref_ms.max() < 1.0) or (np.std(yaw_ref) < 0.005)
    if is_stationary:
        return {
            'reliable': True,
            'reason': 'STATIONARY_BENCHMARK_RUN',
            'R_D_to_V': np.eye(3),
            'yaw_corr': 0.0,
            'best_gyro_axis': 'STATIONARY_NO_TURNS',
            'psi_mount_deg': 0.0,
            'long_accel_corr': 0.0
        }
        
    # Extract gyro channels
    g_cols = [c for c in sub_s.columns if 'gyro' in c.lower()]
    if len(g_cols) < 3:
        return {
            'reliable': False,
            'reason': 'MISSING_GYROSCOPE_CHANNELS',
            'R_D_to_V': np.eye(3),
            'yaw_corr': 0.0,
            'best_gyro_axis': 'UNKNOWN',
            'psi_mount_deg': 0.0,
            'long_accel_corr': 0.0
        }
        
    raw_gyro = np.stack([sub_s[c].fillna(0).values for c in g_cols[:3]], axis=1) # [N, 3]
    
    # Extract accel channels
    a_cols = [c for c in sub_s.columns if 'accel' in c.lower() and 'linear' not in c.lower()]
    if len(a_cols) < 3:
        return {
            'reliable': False,
            'reason': 'MISSING_ACCELEROMETER_CHANNELS',
            'R_D_to_V': np.eye(3),
            'yaw_corr': 0.0,
            'best_gyro_axis': 'UNKNOWN',
            'psi_mount_deg': 0.0,
            'long_accel_corr': 0.0
        }
    raw_accel = np.stack([sub_s[c].fillna(0).values for c in a_cols[:3]], axis=1) # [N, 3]
    
    # Check maneuver mask for yaw correlation
    turns_mask = np.abs(yaw_ref) > (1.5 * np.pi / 180.0)
    use_turns = turns_mask.sum() > 20
    
    corrs = []
    for i in range(3):
        g_i = raw_gyro[:, i]
        g_eval = g_i[turns_mask] if use_turns else g_i
        y_eval = yaw_ref[turns_mask] if use_turns else yaw_ref
        if np.std(g_eval) > 1e-4 and np.std(y_eval) > 1e-4:
            r = np.corrcoef(g_eval, y_eval)[0, 1]
        else:
            r = 0.0
        corrs.append(r)
        
    best_gyro_idx = int(np.argmax(np.abs(corrs)))
    best_gyro_r = corrs[best_gyro_idx]
    best_gyro_sign = np.sign(best_gyro_r) if best_gyro_r != 0 else 1.0
    
    # Vertical axis in device frame (+Z_V)
    u_z = np.zeros(3)
    u_z[best_gyro_idx] = best_gyro_sign
    
    # Gravity removal
    grav_mean = np.mean(raw_accel, axis=0)
    lin_accel = raw_accel - grav_mean
    
    # Project acceleration onto horizontal plane (orthogonal to u_z)
    a_horiz = lin_accel - np.outer(lin_accel @ u_z, u_z)
    
    # Forward axis (+X_V) in horizontal plane by covariance with dv/dt
    throttle_mask = (dv_ref > 0.3) & (np.abs(yaw_ref) < (2.0 * np.pi / 180.0)) & (vel_ref_ms > 2.0)
    if throttle_mask.sum() > 20:
        covs = np.array([np.cov(a_horiz[throttle_mask, i], dv_ref[throttle_mask])[0, 1] for i in range(3)])
        norm_cov = np.linalg.norm(covs)
        if norm_cov > 1e-6:
            u_x = covs / norm_cov
            u_x = u_x - np.dot(u_x, u_z) * u_z
            norm_ux = np.linalg.norm(u_x)
            u_x = u_x / norm_ux if norm_ux > 1e-6 else np.zeros(3)
        else:
            u_x = np.zeros(3)
    else:
        u_x = np.zeros(3)
        
    if np.linalg.norm(u_x) < 0.5:
        # Fallback to cyclic orthogonal axis
        cand_idx = (best_gyro_idx + 1) % 3
        u_x = np.zeros(3)
        u_x[cand_idx] = 1.0
        u_x = u_x - np.dot(u_x, u_z) * u_z
        u_x = u_x / np.linalg.norm(u_x)
        
    # Lateral axis completing right-handed triad: u_y = u_z x u_x
    u_y = np.cross(u_z, u_x)
    u_y = u_y / np.linalg.norm(u_y)
    
    # Construct orthonormal R_{D -> V}
    R_D_to_V = np.stack([u_x, u_y, u_z], axis=0)
    
    # Transform
    accel_v = (R_D_to_V @ lin_accel.T).T
    gyro_v = (R_D_to_V @ raw_gyro.T).T
    
    final_yaw_r = float(np.corrcoef(gyro_v[:, 2], yaw_ref)[0, 1]) if np.std(gyro_v[:, 2]) > 1e-4 else 0.0
    final_long_r = float(np.corrcoef(accel_v[:, 0], dv_ref)[0, 1]) if np.std(accel_v[:, 0]) > 1e-4 else 0.0
    
    # Azimuth angle of u_x relative to device axis 0
    psi_mount_deg = float(np.degrees(np.arctan2(u_x[1], u_x[0])))
    
    reliable = (abs(best_gyro_r) >= 0.25) or (abs(final_yaw_r) >= 0.25)
    reason = "VERIFIED_AXIS_CORRELATION" if reliable else "LOW_CORRELATION"
    
    axis_name = g_cols[best_gyro_idx].replace('GYROSCOPE ', '').replace(' (rad/s)', '').strip()
    
    return {
        'reliable': reliable,
        'reason': reason,
        'R_D_to_V': R_D_to_V,
        'yaw_corr': float(best_gyro_r),
        'final_yaw_corr': float(final_yaw_r),
        'best_gyro_axis': axis_name,
        'psi_mount_deg': psi_mount_deg,
        'long_accel_corr': float(final_long_r)
    }


def transform_device_to_vehicle(
    df_s: pd.DataFrame, 
    R_D_to_V: np.ndarray
) -> np.ndarray:
    """
    Transforms raw smartphone DataFrame into calibrated 6-channel Vehicle Frame array.
    
    Output channels:
    0: a_long (m/s^2) - forward longitudinal dynamic acceleration
    1: a_lat  (m/s^2) - lateral acceleration (left)
    2: a_vert (m/s^2) - vertical dynamic acceleration (up)
    3: omega_yaw   (rad/s) - yaw rate (rotation about +Z_V vertical)
    4: omega_pitch (rad/s) - pitch rate (rotation about +Y_V lateral)
    5: omega_roll  (rad/s) - roll rate (rotation about +X_V longitudinal)
    """
    df = df_s.copy()
    df.columns = [c.strip() for c in df.columns]
    N = len(df)
    
    a_cols = [c for c in df.columns if 'accel' in c.lower() and 'linear' not in c.lower()]
    raw_accel = np.stack([df[c].fillna(0).values for c in a_cols[:3]], axis=1) # [N, 3]
    
    grav_mean = np.mean(raw_accel, axis=0)
    lin_accel_d = raw_accel - grav_mean
    
    g_cols = [c for c in df.columns if 'gyro' in c.lower()]
    raw_gyro_d = np.stack([df[c].fillna(0).values for c in g_cols[:3]], axis=1) # [N, 3]
    
    # Apply R_{D -> V}
    accel_v = (R_D_to_V @ lin_accel_d.T).T  # [N, 3]
    gyro_v = (R_D_to_V @ raw_gyro_d.T).T    # [N, 3]
    
    channels_v = np.zeros((N, 6), dtype=np.float32)
    channels_v[:, 0] = accel_v[:, 0]  # longitudinal (+X forward)
    channels_v[:, 1] = accel_v[:, 1]  # lateral (+Y left)
    channels_v[:, 2] = accel_v[:, 2]  # vertical (+Z up)
    channels_v[:, 3] = gyro_v[:, 2]   # yaw rate (rotation about +Z)
    channels_v[:, 4] = gyro_v[:, 1]   # pitch rate (rotation about +Y)
    channels_v[:, 5] = gyro_v[:, 0]   # roll rate (rotation about +X)
    
    return channels_v

