"""
IO-VNBD Data Ingestion & Preprocessing Loader for BetterMaps IDR.

Handles:
- Full discovery of all 72 categorized session pairs.
- Column normalization and encoding handling (Latin-1).
- Rigorous per-session time synchronization (two-stage speed + gyro cross-correlation).
- Per-session device-to-vehicle transformation estimation.
- Audit table generation -> artifacts/data/session_inventory.csv.
- Unified session data loading for training and evaluation.
"""

import os
import glob
import json
import numpy as np
import pandas as pd
from scipy import signal
from typing import Dict, List, Tuple, Any, Optional

from research.idr.preprocessing.orientation import (
    estimate_session_transform,
    transform_device_to_vehicle
)

DATASET_ROOT_DEFAULT = os.path.join(
    "research", "IO-VNBD", "Synchronised V abd S datasets", "Categorised IOVNB Dataset"
)


class IovnbdLoader:
    """Manages discovery, loading, and alignment of IO-VNBD dataset sessions."""

    def __init__(self, dataset_root: Optional[str] = None):
        self.dataset_root = dataset_root or DATASET_ROOT_DEFAULT
        if not os.path.exists(self.dataset_root):
            alt_root = os.path.abspath(self.dataset_root)
            if not os.path.exists(alt_root):
                raise FileNotFoundError(f"Dataset root not found: {self.dataset_root}")
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self._discover_sessions()

    def _discover_sessions(self) -> None:
        """Discovers all paired S-*.csv and V-*.csv files in the dataset tree."""
        s_files = glob.glob(os.path.join(self.dataset_root, "**", "S-*.csv"), recursive=True)
        
        for s_path in sorted(s_files):
            filename = os.path.basename(s_path)
            session_id = filename[2:-4]  # S-S1.csv -> S1
            folder = os.path.dirname(s_path)
            
            # Find matching V- file
            v_candidates = glob.glob(os.path.join(folder, f"V-*{session_id}*.csv"))
            if not v_candidates:
                v_candidates = glob.glob(os.path.join(folder, "V-*.csv"))
            v_path = v_candidates[0] if v_candidates else None
            
            # Parse driver and category from path
            rel_folder = os.path.relpath(folder, self.dataset_root)
            parts = rel_folder.split(os.sep)
            cat_folder = parts[0]
            
            if "(Driver A)" in cat_folder:
                driver = "Driver A"
                style = "Defensive"
            elif "(Driver B)" in cat_folder:
                driver = "Driver B"
                style = "Defensive"
            elif "(Driver D)" in cat_folder:
                driver = "Driver D"
                style = "Defensive"
            elif "(Driver E)" in cat_folder:
                driver = "Driver E"
                style = "Aggressive"
            else:
                driver = "Unknown"
                style = "Unknown"
                
            self.sessions[session_id] = {
                "session_id": session_id,
                "driver": driver,
                "style": style,
                "category_folder": cat_folder,
                "s_path": s_path,
                "v_path": v_path,
                "folder": folder
            }

    def get_session_ids(self) -> List[str]:
        return sorted(list(self.sessions.keys()))

    def estimate_alignment(
        self, df_s: pd.DataFrame, df_v: pd.DataFrame
    ) -> Tuple[int, float, float, float]:
        """
        Two-stage synchronization algorithm:
        Stage 1: Coarse lag estimation using GPS Speed vs VBOX Doppler Velocity cross-correlation
                 across a wide search window (up to +/- 1500 samples = +/- 150s).
        Stage 2: Fine lag refinement within [coarse_lag - 60, coarse_lag + 60] samples (+/- 6s)
                 using smartphone gyro channels vs VBOX Yaw Rate during turn maneuvers.
        
        Returns:
            (best_lag_samples, tau_star_sec, best_gyro_r, speed_r)
        """
        df_s_c = df_s.copy()
        df_v_c = df_v.copy()
        df_s_c.columns = [c.strip() for c in df_s_c.columns]
        df_v_c.columns = [c.strip() for c in df_v_c.columns]
        
        vel_col = [c for c in df_v_c.columns if 'velo' in c.lower() or 'speed' in c.lower()][0]
        yaw_col = [c for c in df_v_c.columns if 'yaw' in c.lower()][0]
        
        vel_v = df_v_c[vel_col].fillna(0).values
        yaw_v = df_v_c[yaw_col].fillna(0).values * (np.pi / 180.0)
        
        # Stationary run check
        if vel_v.max() < 1.0 or np.std(yaw_v) < 0.005:
            return 0, 0.0, 0.0, 0.0
            
        speed_cols = [c for c in df_s_c.columns if 'speed' in c.lower()]
        speed_s = df_s_c[speed_cols[0]].fillna(0).values if speed_cols else np.zeros(len(df_s_c))
        
        # Unit detection: if phone max speed is ~1/3.6 of VBOX max speed, it was logged in m/s
        if speed_s.max() > 0 and vel_v.max() > 50 and speed_s.max() < (vel_v.max() / 2.5):
            speed_s = speed_s * 3.6
            
        min_l = min(len(speed_s), len(vel_v))
        if min_l < 50:
            return 0, 0.0, 0.0, 0.0
            
        max_lag = min(1500, min_l // 2)
        s_centered = speed_s[:min_l] - np.mean(speed_s[:min_l])
        v_centered = vel_v[:min_l] - np.mean(vel_v[:min_l])
        
        coarse_lag = 0
        speed_r = 0.0
        if np.std(s_centered) > 0.5 and np.std(v_centered) > 0.5:
            corr = signal.correlate(s_centered, v_centered, mode='full')
            lags = signal.correlation_lags(min_l, min_l)
            mask = np.abs(lags) <= max_lag
            coarse_lag = int(lags[mask][np.argmax(corr[mask])])
            
            if coarse_lag > 0:
                speed_r = float(np.corrcoef(speed_s[:min_l][coarse_lag:], vel_v[:min_l][:-coarse_lag])[0, 1])
            elif coarse_lag < 0:
                speed_r = float(np.corrcoef(speed_s[:min_l][:coarse_lag], vel_v[:min_l][-coarse_lag:])[0, 1])
            else:
                speed_r = float(np.corrcoef(speed_s[:min_l], vel_v[:min_l])[0, 1])
                
        # Fine gyro alignment around coarse_lag (+/- 60 samples)
        fine_search = range(max(-max_lag, coarse_lag - 60), min(max_lag, coarse_lag + 60) + 1)
        best_lag = coarse_lag
        best_gyro_r = 0.0
        
        turns_mask = np.abs(yaw_v[:min_l]) > (1.5 * np.pi / 180.0)
        use_turns = turns_mask.sum() > 20
        
        g_cols = [c for c in df_s_c.columns if 'gyro' in c.lower()]
        for gc in g_cols[:3]:
            g = df_s_c[gc].fillna(0).values[:min_l]
            if np.std(g) < 1e-4:
                continue
            for l in fine_search:
                if l > 0:
                    g_sub = g[l:]
                    y_sub = yaw_v[:min_l][:-l]
                    m_sub = turns_mask[l:] if use_turns else slice(None)
                elif l < 0:
                    g_sub = g[:l]
                    y_sub = yaw_v[:min_l][-l:]
                    m_sub = turns_mask[:l] if use_turns else slice(None)
                else:
                    g_sub = g
                    y_sub = yaw_v[:min_l]
                    m_sub = turns_mask if use_turns else slice(None)
                    
                L = min(len(g_sub), len(y_sub))
                g_eval = g_sub[:L][m_sub] if use_turns else g_sub[:L]
                y_eval = y_sub[:L][m_sub] if use_turns else y_sub[:L]
                
                if len(g_eval) > 20 and np.std(g_eval) > 1e-4 and np.std(y_eval) > 1e-4:
                    r = abs(float(np.corrcoef(g_eval, y_eval)[0, 1]))
                    if r > best_gyro_r:
                        best_gyro_r = r
                        best_lag = int(l)
                        
        tau_star_sec = best_lag * 0.100
        return best_lag, float(tau_star_sec), float(best_gyro_r), float(speed_r)

    def build_inventory(self, output_csv: Optional[str] = None) -> pd.DataFrame:
        """
        Audits all 72 sessions, computes alignment offsets and frame transforms,
        and saves artifacts/data/session_inventory.csv.
        """
        records = []
        print(f"Auditing {len(self.sessions)} IO-VNBD sessions...")
        
        for idx, (sid, s_info) in enumerate(sorted(self.sessions.items())):
            v_path = s_info["v_path"]
            s_path = s_info["s_path"]
            
            if not v_path or not os.path.exists(v_path):
                records.append({
                    "session_id": sid,
                    "driver": s_info["driver"],
                    "style": s_info["style"],
                    "category": s_info["category_folder"],
                    "s_samples": 0,
                    "v_samples": 0,
                    "duration_s": 0.0,
                    "tau_star_sec": 0.0,
                    "gyro_corr": 0.0,
                    "speed_corr": 0.0,
                    "best_gyro_axis": "MISSING_V_FILE",
                    "psi_mount_deg": 0.0,
                    "reliable": False,
                    "reason": "MISSING_REFERENCE_FILE",
                    "usable_windows": 0
                })
                continue
                
            try:
                df_s = pd.read_csv(s_path, encoding='latin1')
                df_v = pd.read_csv(v_path, encoding='latin1')
                df_s.columns = [c.strip() for c in df_s.columns]
                df_v.columns = [c.strip() for c in df_v.columns]
                
                n_s = len(df_s)
                n_v = len(df_v)
                duration_s = n_s * 0.10
                
                # Estimate two-stage alignment
                lag_samples, tau_s, gyro_r, speed_r = self.estimate_alignment(df_s, df_v)
                
                # Estimate transform
                transform_info = estimate_session_transform(df_s, df_v, tau_star_samples=lag_samples)
                
                # Overall reliability
                is_stationary = transform_info.get("reason") == "STATIONARY_BENCHMARK_RUN"
                reliable = is_stationary or (gyro_r >= 0.25) or (speed_r >= 0.70)
                reason = transform_info["reason"] if reliable else "LOW_CORRELATION"
                
                # Usable windows (20 samples, stride 1)
                aligned_len = min(n_s - abs(lag_samples), n_v - abs(lag_samples))
                usable_windows = max(0, aligned_len - 20 + 1)
                
                records.append({
                    "session_id": sid,
                    "driver": s_info["driver"],
                    "style": s_info["style"],
                    "category": s_info["category_folder"],
                    "s_samples": n_s,
                    "v_samples": n_v,
                    "duration_s": round(duration_s, 1),
                    "tau_star_sec": round(tau_s, 2),
                    "gyro_corr": round(gyro_r, 4),
                    "speed_corr": round(speed_r, 4),
                    "best_gyro_axis": transform_info["best_gyro_axis"],
                    "psi_mount_deg": round(transform_info["psi_mount_deg"], 1),
                    "reliable": reliable,
                    "reason": reason,
                    "usable_windows": usable_windows
                })
            except Exception as e:
                records.append({
                    "session_id": sid,
                    "driver": s_info["driver"],
                    "style": s_info["style"],
                    "category": s_info["category_folder"],
                    "s_samples": 0,
                    "v_samples": 0,
                    "duration_s": 0.0,
                    "tau_star_sec": 0.0,
                    "gyro_corr": 0.0,
                    "speed_corr": 0.0,
                    "best_gyro_axis": "READ_ERROR",
                    "psi_mount_deg": 0.0,
                    "reliable": False,
                    "reason": f"ERROR: {str(e)}",
                    "usable_windows": 0
                })
                
        df_inv = pd.DataFrame(records)
        if output_csv:
            os.makedirs(os.path.dirname(output_csv), exist_ok=True)
            df_inv.to_csv(output_csv, index=False)
            print(f"Saved session inventory to {output_csv}")
            
        return df_inv

    def load_session(
        self, session_id: str, apply_alignment: bool = True
    ) -> Dict[str, Any]:
        """
        Loads and returns a fully aligned, transformed session dictionary:
        - X: [N, 6] Vehicle-frame calibrated IMU array
        - y: [N, 2] Reference targets [v_forward (m/s), yaw_rate (rad/s)]
        - time_s: [N] Monotonic aligned timestamp array
        - ref_coords: [N, 2] [Latitude, Longitude] for trajectory evaluation
        - transform_info: Dict with R_D_to_V and calibration metrics
        """
        if session_id not in self.sessions:
            raise KeyError(f"Unknown session: {session_id}")
            
        s_info = self.sessions[session_id]
        df_s = pd.read_csv(s_info["s_path"], encoding='latin1')
        df_v = pd.read_csv(s_info["v_path"], encoding='latin1')
        df_s.columns = [c.strip() for c in df_s.columns]
        df_v.columns = [c.strip() for c in df_v.columns]
        
        # Alignment
        if apply_alignment:
            lag_samples, tau_s, gyro_r, speed_r = self.estimate_alignment(df_s, df_v)
        else:
            lag_samples, tau_s, gyro_r, speed_r = 0, 0.0, 1.0, 1.0
            
        transform_info = estimate_session_transform(df_s, df_v, tau_star_samples=lag_samples)
        R_D_to_V = transform_info["R_D_to_V"]
        
        # Apply alignment slicing
        n_s = len(df_s)
        n_v = len(df_v)
        
        if lag_samples > 0:
            s_sub = df_s.iloc[lag_samples:].reset_index(drop=True)
            v_sub = df_v.iloc[:-lag_samples].reset_index(drop=True)
        elif lag_samples < 0:
            shift = abs(lag_samples)
            s_sub = df_s.iloc[:-shift].reset_index(drop=True)
            v_sub = df_v.iloc[shift:].reset_index(drop=True)
        else:
            s_sub = df_s
            v_sub = df_v
            
        N = min(len(s_sub), len(v_sub))
        s_sub = s_sub.iloc[:N]
        v_sub = v_sub.iloc[:N]
        
        # Transform IMU to vehicle body frame
        X = transform_device_to_vehicle(s_sub, R_D_to_V)
        
        # Extract targets
        vel_col = [c for c in v_sub.columns if 'velo' in c.lower() or 'speed' in c.lower()][0]
        yaw_col = [c for c in v_sub.columns if 'yaw' in c.lower()][0]
        
        v_f_ms = v_sub[vel_col].fillna(0).values / 3.6  # m/s
        omega_z_rad = v_sub[yaw_col].fillna(0).values * (np.pi / 180.0)  # rad/s
        y = np.stack([v_f_ms, omega_z_rad], axis=1).astype(np.float32)
        
        # Timestamps and reference coordinates
        time_s = np.arange(N, dtype=np.float32) * 0.100
        lat_col = [c for c in v_sub.columns if 'lat' in c.lower()][0]
        lon_col = [c for c in v_sub.columns if 'long' in c.lower() or 'lon' in c.lower()][0]
        
        ref_coords = np.stack([
            v_sub[lat_col].values,
            v_sub[lon_col].values
        ], axis=1).astype(np.float64)
        
        return {
            "session_id": session_id,
            "driver": s_info["driver"],
            "style": s_info["style"],
            "category": s_info["category_folder"],
            "X": X,
            "y": y,
            "time_s": time_s,
            "ref_coords": ref_coords,
            "tau_star_sec": tau_s,
            "transform_info": transform_info,
            "reliable": transform_info["reliable"]
        }

