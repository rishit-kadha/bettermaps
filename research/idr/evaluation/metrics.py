"""
Evaluation Metrics Module for BetterMaps IDR.

Computes:
- Velocity: RMSE (m/s, km/h), MAE (m/s), Max Error (m/s), R^2
- Yaw Rate: RMSE (rad/s, deg/s), MAE (rad/s), Max Error (deg/s), R^2, Heading Drift Rate (deg/min)
- Combined validation ranking score
"""

import numpy as np
from sklearn.metrics import r2_score
from typing import Dict, Any


def compute_metrics(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    dt: float = 0.100,
    lambda_omega: float = 1.0
) -> Dict[str, float]:
    """
    Computes comprehensive velocity and yaw rate accuracy statistics.
    y_true, y_pred: [N, 2] -> [v_forward (m/s), omega_yaw (rad/s)]
    """
    v_true = y_true[:, 0]
    v_pred = y_pred[:, 0]
    w_true = y_true[:, 1]
    w_pred = y_pred[:, 1]
    
    # 1. Velocity Metrics
    v_err = v_pred - v_true
    v_rmse_ms = float(np.sqrt(np.mean(v_err ** 2)))
    v_rmse_kmh = float(v_rmse_ms * 3.6)
    v_mae_ms = float(np.mean(np.abs(v_err)))
    v_max_ms = float(np.max(np.abs(v_err)))
    v_r2 = float(r2_score(v_true, v_pred)) if np.std(v_true) > 1e-4 else 0.0
    
    # 2. Yaw Rate Metrics
    w_err = w_pred - w_true
    w_rmse_radps = float(np.sqrt(np.mean(w_err ** 2)))
    w_rmse_degps = float(np.degrees(w_rmse_radps))
    w_mae_radps = float(np.mean(np.abs(w_err)))
    w_max_degps = float(np.degrees(np.max(np.abs(w_err))))
    w_r2 = float(r2_score(w_true, w_pred)) if np.std(w_true) > 1e-4 else 0.0
    
    # 3. Heading Drift Rate (deg/min)
    # Cumulative heading difference
    duration_s = max(1.0, len(y_true) * dt)
    duration_min = duration_s / 60.0
    heading_drift_rad = float(np.abs(np.sum(w_err * dt)))
    heading_drift_deg = float(np.degrees(heading_drift_rad))
    drift_rate_deg_per_min = float(heading_drift_deg / duration_min)
    
    # 4. Composite Loss / Score
    composite_score = float(v_rmse_ms + lambda_omega * w_rmse_radps)
    
    return {
        "v_rmse_ms": round(v_rmse_ms, 4),
        "v_rmse_kmh": round(v_rmse_kmh, 2),
        "v_mae_ms": round(v_mae_ms, 4),
        "v_max_ms": round(v_max_ms, 2),
        "v_r2": round(v_r2, 4),
        "w_rmse_radps": round(w_rmse_radps, 4),
        "w_rmse_degps": round(w_rmse_degps, 2),
        "w_mae_radps": round(w_mae_radps, 4),
        "w_max_degps": round(w_max_degps, 2),
        "w_r2": round(w_r2, 4),
        "drift_rate_deg_per_min": round(drift_rate_deg_per_min, 2),
        "composite_score": round(composite_score, 4)
    }

