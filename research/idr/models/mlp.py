"""
B1 Shallow MLP Motion Model for BetterMaps IDR.

Input: Flattened causal sliding window [B, window_size * 6] = [B, 120]
Architecture: Linear(120 -> 64) -> ReLU -> Dropout(0.1) -> Linear(64 -> 32) -> ReLU -> Linear(32 -> 2)
Outputs: [v_forward (m/s), omega_yaw (rad/s)]
"""

import torch
import torch.nn as nn
from typing import Tuple


class ShallowMlpMotionModel(nn.Module):
    def __init__(self, window_size: int = 20, in_channels: int = 6, dropout: float = 0.1):
        super().__init__()
        in_features = window_size * in_channels
        self.net = nn.Sequential(
            nn.Linear(in_features, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, 2)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, T, C] -> flatten to [B, T * C]
        B = x.shape[0]
        x_flat = x.reshape(B, -1)
        out = self.net(x_flat)
        # Enforce non-negative forward speed
        v_f = torch.relu(out[:, 0:1])
        omega_z = out[:, 1:2]
        return torch.cat([v_f, omega_z], dim=-1)

