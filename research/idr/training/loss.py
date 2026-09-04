"""
Loss Functions for BetterMaps IDR Training.

Implements:
- WeightedCompositeLoss: L = MSE(v_f) + lambda_omega * MSE(omega_z)
  Default lambda_omega = 1.0, swept over {0.1, 0.25, 0.5, 1.0, 2.0, 4.0} on Validation split.
"""

import torch
import torch.nn as nn
from typing import Tuple


class WeightedMotionLoss(nn.Module):
    """
    Composite deterministic loss:
        L = MSE(v_forward) + lambda_omega * MSE(omega_yaw)
    """

    def __init__(self, lambda_omega: float = 1.0):
        super().__init__()
        self.lambda_omega = lambda_omega
        self.mse = nn.MSELoss()

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        loss_v = self.mse(pred[:, 0], target[:, 0])
        loss_w = self.mse(pred[:, 1], target[:, 1])
        return loss_v + self.lambda_omega * loss_w

    def forward_components(self, pred: torch.Tensor, target: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        loss_v = self.mse(pred[:, 0], target[:, 0])
        loss_w = self.mse(pred[:, 1], target[:, 1])
        total = loss_v + self.lambda_omega * loss_w
        return total, loss_v, loss_w
