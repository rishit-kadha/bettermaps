"""ML boundary. The ESKF consumes MotionPrediction and never imports PyTorch."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol, Optional
import numpy as np

@dataclass(frozen=True)
class MotionInputWindow:
    measurements: np.ndarray  # [T, 6], vehicle body: a_x,a_y,a_z,w_z,w_y,w_x
    frame: str
    timestamp_start_s: float
    timestamp_end_s: float
    def __post_init__(self):
        if self.measurements.ndim != 2 or self.measurements.shape[1] != 6: raise ValueError("expected [T,6]")
        if self.timestamp_end_s < self.timestamp_start_s: raise ValueError("non-causal time window")

@dataclass(frozen=True)
class MotionPrediction:
    timestamp_s: float
    forward_velocity_mps: float
    yaw_rate_radps: float
    velocity_std_mps: float
    yaw_rate_std_radps: float
    confidence: float

class MotionPredictor(Protocol):
    def predict(self, window: MotionInputWindow) -> MotionPrediction: ...

class TorchMotionAdapter:
    """Optional runtime adapter for legacy .pt models; supports 2 or 4 output heads."""
    def __init__(self, model, mean: np.ndarray, std: np.ndarray, fallback_std=(1.5, .15)):
        self.model, self.mean, self.std = model, np.asarray(mean), np.asarray(std)
        self.fallback_std = fallback_std
        self.model.eval()
    def predict(self, window: MotionInputWindow) -> MotionPrediction:
        import torch
        x = (window.measurements-self.mean)/np.maximum(self.std, 1e-6)
        with torch.no_grad():
            output = self.model(torch.tensor(x[None], dtype=torch.float32))
        if isinstance(output, tuple): mu, logvar = output; values=mu[0].cpu().numpy(); sigma=np.exp(.5*logvar[0].cpu().numpy())
        else: values=output[0].cpu().numpy(); sigma=np.asarray(self.fallback_std) # configured, not learned
        return MotionPrediction(window.timestamp_end_s, float(values[0]), float(values[1]), float(sigma[0]), float(sigma[1]), 1.0)
