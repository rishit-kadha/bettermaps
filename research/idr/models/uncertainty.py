"""
Heteroscedastic Gaussian Uncertainty Motion Model for BetterMaps IDR.

Outputs mean and log-variance for forward velocity and yaw rate:
    [mu_v, mu_omega, log_var_v, log_var_omega]
Includes variance clamping to prevent gradient explosion / numerical instability.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import Tuple, Optional


class HeteroscedasticTcnModel(nn.Module):
    """TCN backbone with 4-output heteroscedastic uncertainty head."""

    def __init__(
        self,
        in_channels: int = 6,
        hidden_channels: int = 16,
        kernel_size: int = 3,
        dilations = [1, 2, 4, 8],
        dropout: float = 0.1
    ):
        super().__init__()
        from research.idr.models.tcn import CausalConv1dBlock
        layers = []
        c_in = in_channels
        for d in dilations:
            layers.append(CausalConv1dBlock(c_in, hidden_channels, kernel_size, d, dropout))
            c_in = hidden_channels
        self.backbone = nn.Sequential(*layers)
        
        # Mean head
        self.mean_head = nn.Linear(hidden_channels, 2)
        # Log-variance head
        self.logvar_head = nn.Linear(hidden_channels, 2)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Returns:
            mu: [B, 2] -> [v_f (m/s), omega_z (rad/s)]
            log_var: [B, 2] -> [log(sigma_v^2), log(sigma_omega^2)]
        """
        x_t = x.transpose(1, 2)
        feats = self.backbone(x_t)[:, :, -1] # [B, hidden_channels]
        
        raw_mu = self.mean_head(feats)
        v_f = torch.relu(raw_mu[:, 0:1])
        omega_z = raw_mu[:, 1:2]
        mu = torch.cat([v_f, omega_z], dim=-1)
        
        # Clamped log-variance: prevent divergence
        raw_logvar = self.logvar_head(feats)
        log_var = torch.clamp(raw_logvar, min=-6.0, max=4.0)
        
        return mu, log_var


class GaussianNllLoss(nn.Module):
    """
    Heteroscedastic negative log-likelihood loss with weighting parameter lambda_omega:
    L = 0.5 * [ (y_v - mu_v)^2 / var_v + log_var_v + lambda_omega * ((y_w - mu_w)^2 / var_w + log_var_w) ]
    """

    def __init__(self, lambda_omega: float = 1.0):
        super().__init__()
        self.lambda_omega = lambda_omega

    def forward(self, mu: torch.Tensor, log_var: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        var = torch.exp(log_var)
        # Velocity loss
        diff_v = target[:, 0] - mu[:, 0]
        nll_v = 0.5 * ((diff_v ** 2) / var[:, 0] + log_var[:, 0])
        
        # Yaw rate loss
        diff_w = target[:, 1] - mu[:, 1]
        nll_w = 0.5 * ((diff_w ** 2) / var[:, 1] + log_var[:, 1])
        
        total_loss = torch.mean(nll_v + self.lambda_omega * nll_w)
        return total_loss

