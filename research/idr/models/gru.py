"""
B3 Lightweight GRU Motion Model for BetterMaps IDR.

Specifications:
- 1-layer GRU with 32 hidden units.
- Operates on causal sequence [B, T=20, 6].
- Parameter count: ~3,900 parameters.
- Target latency on budget phone: < 2 ms.
"""

import torch
import torch.nn as nn


class LightweightGruMotionModel(nn.Module):
    def __init__(self, in_channels: int = 6, hidden_size: int = 32, dropout: float = 0.0):
        super().__init__()
        self.gru = nn.GRU(
            input_size=in_channels,
            hidden_size=hidden_size,
            num_layers=1,
            batch_first=True
        )
        self.head = nn.Linear(hidden_size, 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, T, C]
        _, h_n = self.gru(x) # h_n: [1, B, hidden_size]
        last_hidden = h_n.squeeze(0) # [B, hidden_size]
        out = self.head(last_hidden) # [B, 2]
        
        # Enforce non-negative forward velocity
        v_f = torch.relu(out[:, 0:1])
        omega_z = out[:, 1:2]
        return torch.cat([v_f, omega_z], dim=-1)

