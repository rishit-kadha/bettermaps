"""
B2 Tiny 1D Dilated Causal TCN Motion Model for BetterMaps IDR.

Specifications:
- Causal 1D convolutions (zero future leakage: padding only on the left).
- Dilations: d in [1, 2, 4, 8], kernel_size k=3.
- Receptive field: 1 + 2 * (1 + 2 + 4 + 8) = 31 samples (3.1s), covering T=20 (2.0s).
- Hidden channels: 16
- Parameter count: ~5,000 parameters.
- Target latency on budget phone: < 3 ms.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import List


class CausalConv1dBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, kernel_size: int, dilation: int, dropout: float = 0.1):
        super().__init__()
        self.pad_len = (kernel_size - 1) * dilation
        self.conv1 = nn.Conv1d(in_channels, out_channels, kernel_size, dilation=dilation)
        self.relu1 = nn.ReLU()
        self.dropout1 = nn.Dropout(dropout)
        self.conv2 = nn.Conv1d(out_channels, out_channels, kernel_size, dilation=dilation)
        self.relu2 = nn.ReLU()
        self.dropout2 = nn.Dropout(dropout)
        
        self.residual = nn.Conv1d(in_channels, out_channels, 1) if in_channels != out_channels else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, C, T]
        # First conv causal pad
        out = F.pad(x, (self.pad_len, 0))
        out = self.dropout1(self.relu1(self.conv1(out)))
        # Second conv causal pad
        out = F.pad(out, (self.pad_len, 0))
        out = self.dropout2(self.relu2(self.conv2(out)))
        res = self.residual(x)
        return F.relu(out + res)


class TinyCausalTcnMotionModel(nn.Module):
    def __init__(
        self,
        in_channels: int = 6,
        hidden_channels: int = 16,
        kernel_size: int = 3,
        dilations: List[int] = [1, 2, 4, 8],
        dropout: float = 0.1
    ):
        super().__init__()
        layers = []
        c_in = in_channels
        for d in dilations:
            layers.append(CausalConv1dBlock(c_in, hidden_channels, kernel_size, d, dropout))
            c_in = hidden_channels
        self.network = nn.Sequential(*layers)
        self.head = nn.Linear(hidden_channels, 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, T, C] -> transpose to [B, C, T] for Conv1d
        x_t = x.transpose(1, 2)
        features = self.network(x_t) # [B, hidden_channels, T]
        # Extract features at final time step T
        last_feat = features[:, :, -1] # [B, hidden_channels]
        out = self.head(last_feat) # [B, 2]
        
        # Enforce non-negative forward velocity
        v_f = torch.relu(out[:, 0:1])
        omega_z = out[:, 1:2]
        return torch.cat([v_f, omega_z], dim=-1)

