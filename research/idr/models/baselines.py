"""
Classical Baseline Estimators for BetterMaps IDR.

Implements:
- B0.1: Global Mean Predictor (predicts mean of training targets).
- B0.2: Persistence / Last-Known Value Predictor.
- B0.3: Ridge Regression on causal sliding window summary statistics
        (mean, std, min, max, last of the 6 IMU channels -> 30 features).
"""

import numpy as np
from sklearn.linear_model import Ridge
from typing import Dict, Any, Optional, Tuple


class MeanBaseline:
    """B0.1: Constant predictor returning the training set mean for [v_f, omega_z]."""

    def __init__(self):
        self.mean_target = np.zeros(2, dtype=np.float32)

    def fit(self, y_train: np.ndarray) -> "MeanBaseline":
        self.mean_target = np.mean(y_train, axis=0).astype(np.float32)
        return self

    def predict(self, X_windows: np.ndarray) -> np.ndarray:
        N = len(X_windows)
        return np.tile(self.mean_target, (N, 1))


class PersistenceBaseline:
    """
    B0.2: Persistence / zero-order hold predictor.
    Predicts zero yaw rate and uses integrated longitudinal acceleration from the window.
    """

    def __init__(self, dt: float = 0.100):
        self.dt = dt

    def fit(self, y_train: np.ndarray) -> "PersistenceBaseline":
        return self

    def predict(self, X_windows: np.ndarray) -> np.ndarray:
        """
        X_windows: [N, T, 6]
        Channels: 0: a_long, 1: a_lat, 2: a_vert, 3: omega_yaw, 4: omega_pitch, 5: omega_roll
        Predicts:
            omega_z = last omega_yaw in window
            v_f = clip(integrated a_long in window, 0, 45 m/s)
        """
        N = len(X_windows)
        preds = np.zeros((N, 2), dtype=np.float32)
        # Last omega_yaw sample
        preds[:, 1] = X_windows[:, -1, 3]
        # Sum of a_long * dt
        v_est = np.maximum(0.0, np.sum(X_windows[:, :, 0] * self.dt, axis=1))
        preds[:, 0] = np.clip(v_est, 0.0, 40.0)
        return preds


class RidgeBaseline:
    """
    B0.3: Linear Ridge Regression on causal window summary statistics.
    Extracts 30 features: [mean, std, min, max, last] across the 6 IMU channels.
    """

    def __init__(self, alpha: float = 1.0):
        self.alpha = alpha
        self.model_v = Ridge(alpha=alpha)
        self.model_omega = Ridge(alpha=alpha)

    def _extract_features(self, X_windows: np.ndarray) -> np.ndarray:
        # X_windows: [N, T, 6]
        f_mean = np.mean(X_windows, axis=1) # [N, 6]
        f_std = np.std(X_windows, axis=1)   # [N, 6]
        f_min = np.min(X_windows, axis=1)   # [N, 6]
        f_max = np.max(X_windows, axis=1)   # [N, 6]
        f_last = X_windows[:, -1, :]        # [N, 6]
        return np.concatenate([f_mean, f_std, f_min, f_max, f_last], axis=1) # [N, 30]

    def fit(self, X_windows: np.ndarray, y_train: np.ndarray) -> "RidgeBaseline":
        feats = self._extract_features(X_windows)
        self.model_v.fit(feats, y_train[:, 0])
        self.model_omega.fit(feats, y_train[:, 1])
        return self

    def predict(self, X_windows: np.ndarray) -> np.ndarray:
        feats = self._extract_features(X_windows)
        v_pred = np.maximum(0.0, self.model_v.predict(feats))
        omega_pred = self.model_omega.predict(feats)
        return np.stack([v_pred, omega_pred], axis=1).astype(np.float32)

