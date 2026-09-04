"""
Feature Normalization, Causal Window Generation, and Dataset QA for BetterMaps IDR.

Implements:
- FeatureNormalizer fitted strictly on Train split (mean, std, min, max).
- artifacts/data/normalization.json serialization.
- Causal sliding window generation: X_k in [t_{k-T+1}, t_k], y_k = y(t_k).
- Target distribution analysis -> artifacts/eda/target_distributions.png.
- PyTorch Dataset wrapper for streaming / batching.
"""

import os
import json
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import torch
from torch.utils.data import Dataset
from typing import Dict, List, Tuple, Optional, Any

from research.idr.data.loader import IovnbdLoader


class FeatureNormalizer:
    """Standardizes 6-channel Vehicle Frame inputs using strictly Train statistics."""

    def __init__(self):
        self.mean: Optional[np.ndarray] = None
        self.std: Optional[np.ndarray] = None
        self.min_val: Optional[np.ndarray] = None
        self.max_val: Optional[np.ndarray] = None
        self.channel_names = [
            "a_long_mps2",
            "a_lat_mps2",
            "a_vert_mps2",
            "omega_yaw_radps",
            "omega_pitch_radps",
            "omega_roll_radps"
        ]

    def fit(self, train_arrays: List[np.ndarray]) -> "FeatureNormalizer":
        """Calculates global mean, std, min, max across all training sessions."""
        all_X = np.concatenate(train_arrays, axis=0) # [N_total, 6]
        self.mean = np.mean(all_X, axis=0).astype(np.float32)
        self.std = np.std(all_X, axis=0).astype(np.float32)
        # Prevent division by zero
        self.std = np.where(self.std < 1e-4, 1.0, self.std)
        self.min_val = np.min(all_X, axis=0).astype(np.float32)
        self.max_val = np.max(all_X, axis=0).astype(np.float32)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        """Standardizes X: (X - mean) / std."""
        if self.mean is None or self.std is None:
            raise ValueError("Normalizer has not been fitted.")
        return ((X - self.mean) / self.std).astype(np.float32)

    def inverse_transform(self, X_norm: np.ndarray) -> np.ndarray:
        """Restores physical units."""
        if self.mean is None or self.std is None:
            raise ValueError("Normalizer has not been fitted.")
        return (X_norm * self.std + self.mean).astype(np.float32)

    def save(self, filepath: str) -> None:
        """Saves parameters to JSON."""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        data = {
            "channel_names": self.channel_names,
            "mean": self.mean.tolist(),
            "std": self.std.tolist(),
            "min": self.min_val.tolist(),
            "max": self.max_val.tolist()
        }
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Saved feature normalization parameters to {filepath}")

    @classmethod
    def load(cls, filepath: str) -> "FeatureNormalizer":
        """Loads parameters from JSON."""
        with open(filepath, "r") as f:
            data = json.load(f)
        norm = cls()
        norm.mean = np.array(data["mean"], dtype=np.float32)
        norm.std = np.array(data["std"], dtype=np.float32)
        norm.min_val = np.array(data["min"], dtype=np.float32)
        norm.max_val = np.array(data["max"], dtype=np.float32)
        return norm


class IdrWindowDataset(Dataset):
    """
    PyTorch Dataset of causal sliding windows.
    Each sample returns:
        X_window: Tensor of shape [window_size, 6]
        y_target: Tensor of shape [2] -> [v_forward (m/s), omega_yaw (rad/s)]
    """

    def __init__(
        self,
        sessions_data: List[Dict[str, Any]],
        normalizer: Optional[FeatureNormalizer] = None,
        window_size: int = 20,
        stride: int = 1,
        subsample_factor: int = 1
    ):
        self.window_size = window_size
        self.stride = stride
        self.windows: List[Tuple[int, int]] = [] # (session_idx, end_idx)
        self.sessions = []

        for s_idx, s in enumerate(sessions_data):
            X = s["X"]
            y = s["y"]
            if normalizer is not None:
                X = normalizer.transform(X)
                
            self.sessions.append({
                "session_id": s["session_id"],
                "X": torch.from_numpy(X.astype(np.float32)),
                "y": torch.from_numpy(y.astype(np.float32)),
                "time_s": s["time_s"]
            })
            
            # Form causal windows
            N = len(X)
            # Window covers [end_idx - window_size + 1, end_idx + 1]
            indices = list(range(window_size - 1, N, stride))
            if subsample_factor > 1:
                indices = indices[::subsample_factor]
                
            for end_idx in indices:
                self.windows.append((s_idx, end_idx))

    def __len__(self) -> int:
        return len(self.windows)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        s_idx, end_idx = self.windows[idx]
        sess = self.sessions[s_idx]
        start_idx = end_idx - self.window_size + 1
        
        # Causal window: [window_size, 6]
        X_window = sess["X"][start_idx : end_idx + 1]
        # Target at current timestamp t_k: [2]
        y_target = sess["y"][end_idx]
        
        return X_window, y_target


def generate_target_qa_plot(
    train_sessions_data: List[Dict[str, Any]],
    val_sessions_data: List[Dict[str, Any]],
    test_sessions_data: List[Dict[str, Any]],
    output_png: str = "artifacts/eda/target_distributions.png"
) -> None:
    """Generates distribution QA plots for forward velocity and yaw rate across splits."""
    os.makedirs(os.path.dirname(output_png), exist_ok=True)
    
    fig, axes = plt.subplots(2, 3, figsize=(16, 9))
    splits = [
        ("Train", train_sessions_data, "#1f77b4"),
        ("Validation", val_sessions_data, "#ff7f0e"),
        ("Test", test_sessions_data, "#2ca02c")
    ]
    
    for col_idx, (name, s_list, color) in enumerate(splits):
        all_y = np.concatenate([s["y"] for s in s_list], axis=0) # [N, 2]
        v_f = all_y[:, 0] * 3.6  # m/s -> km/h for intuitive display
        omega_z = np.degrees(all_y[:, 1])  # rad/s -> deg/s
        
        # Row 0: Velocity
        ax_v = axes[0, col_idx]
        ax_v.hist(v_f, bins=60, range=(0, 120), density=True, color=color, alpha=0.7, edgecolor='black', linewidth=0.5)
        ax_v.set_title(f"{name} Split: Forward Speed (km/h)\n(N={len(v_f):,}, Mean={v_f.mean():.1f}, Max={v_f.max():.1f})", fontsize=11)
        ax_v.set_xlabel("Speed (km/h)", fontsize=10)
        ax_v.set_ylabel("Density", fontsize=10)
        ax_v.grid(True, alpha=0.3)
        
        # Row 1: Yaw Rate
        ax_w = axes[1, col_idx]
        ax_w.hist(omega_z, bins=60, range=(-40, 40), density=True, color=color, alpha=0.7, edgecolor='black', linewidth=0.5)
        ax_w.set_title(f"{name} Split: Yaw Rate (deg/s)\n(Std={omega_z.std():.2f}, Max={abs(omega_z).max():.1f})", fontsize=11)
        ax_w.set_xlabel("Yaw Rate (deg/s)", fontsize=10)
        ax_w.set_ylabel("Density", fontsize=10)
        ax_w.grid(True, alpha=0.3)
        
    plt.suptitle("BetterMaps IDR Target Distributions Across Clean Session Splits", fontsize=14, fontweight='bold', y=0.98)
    plt.tight_layout()
    plt.savefig(output_png, dpi=150)
    plt.close()
    print(f"Saved target distribution QA plot to {output_png}")


def run_causality_test() -> bool:
    """Verifies that windows are strictly causal (zero future leakage)."""
    # Create synthetic session with sequential numbers
    N = 100
    t = np.arange(N, dtype=np.float32)
    X = np.stack([t, t*2, t*3, t*4, t*5, t*6], axis=1)
    y = np.stack([t, t*10], axis=1)
    
    mock_session = [{
        "session_id": "MOCK",
        "X": X,
        "y": y,
        "time_s": t * 0.1
    }]
    
    dataset = IdrWindowDataset(mock_session, window_size=20, stride=1)
    
    for i in range(len(dataset)):
        X_w, y_t = dataset[i]
        # Current time step index
        curr_t = y_t[0].item()
        # All window timestamps must be <= curr_t
        w_t = X_w[:, 0].numpy()
        assert np.all(w_t <= curr_t), f"Causality violation! Future timestamp {w_t[w_t > curr_t]} > {curr_t}"
        assert w_t[-1] == curr_t, f"Window end mismatch: {w_t[-1]} != {curr_t}"
        assert len(w_t) == 20, f"Window length mismatch: {len(w_t)}"
        assert np.all(np.diff(w_t) == 1.0), "Window elements not contiguous!"
        
    print("Causality unit test PASSED: Strict causal guarantee verified.")
    return True


if __name__ == "__main__":
    run_causality_test()

