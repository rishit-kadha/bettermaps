"""
ML boundary. The ESKF consumes MotionPrediction and never imports PyTorch or ONNX directly.

Provides:
- MotionInputWindow: Causal temporal window of 6-channel IMU readings
- MotionPrediction: Output struct (velocity, yaw rate, standard deviations, confidence)
- MotionPredictor: Unified Protocol for all estimators
- TorchMotionAdapter: Runtime adapter for PyTorch models (TCN, GRU, MLP, Heteroscedastic)
- OnnxMotionAdapter: Edge deployment runtime adapter using ONNX Runtime
- KinematicBaselineAdapter: Classical strapdown INS baseline
- create_motion_adapter: Factory selecting backend and runtime cleanly
"""
from __future__ import annotations
import os
import time
import json
from dataclasses import dataclass, field
from typing import Protocol, Optional, Tuple, Any, Dict, Union
import numpy as np

DEFAULT_FALLBACK_STD = (1.5, 0.15)


@dataclass(frozen=True)
class MotionInputWindow:
    measurements: np.ndarray  # [T, 6], vehicle body: a_x, a_y, a_z, w_z, w_y, w_x
    frame: str
    timestamp_start_s: float
    timestamp_end_s: float

    def __post_init__(self):
        if self.measurements.ndim != 2 or self.measurements.shape[1] != 6:
            raise ValueError(f"expected measurements shape [T, 6], got {self.measurements.shape}")
        if self.timestamp_end_s < self.timestamp_start_s:
            raise ValueError(f"non-causal time window: end ({self.timestamp_end_s}) < start ({self.timestamp_start_s})")


@dataclass(frozen=True)
class MotionPrediction:
    timestamp_s: float
    forward_velocity_mps: float
    yaw_rate_radps: float
    velocity_std_mps: float
    yaw_rate_std_radps: float
    confidence: float

    def is_valid(self) -> bool:
        return (
            np.isfinite(self.forward_velocity_mps)
            and np.isfinite(self.yaw_rate_radps)
            and np.isfinite(self.velocity_std_mps)
            and np.isfinite(self.yaw_rate_std_radps)
            and self.forward_velocity_mps >= 0.0
            and self.velocity_std_mps > 0.0
            and self.yaw_rate_std_radps > 0.0
        )


@dataclass
class InferenceDiagnostics:
    backend_name: str
    runtime: str
    total_inferences: int = 0
    dropped_inferences: int = 0
    total_latency_ms: float = 0.0
    last_latency_ms: float = 0.0
    last_prediction: Optional[MotionPrediction] = None

    @property
    def mean_latency_ms(self) -> float:
        return (self.total_latency_ms / self.total_inferences) if self.total_inferences > 0 else 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "backend_name": self.backend_name,
            "runtime": self.runtime,
            "total_inferences": self.total_inferences,
            "dropped_inferences": self.dropped_inferences,
            "last_latency_ms": round(self.last_latency_ms, 3),
            "mean_latency_ms": round(self.mean_latency_ms, 3),
            "last_prediction": {
                "v_mps": round(self.last_prediction.forward_velocity_mps, 2),
                "yaw_radps": round(self.last_prediction.yaw_rate_radps, 4),
            } if self.last_prediction else None,
        }


class MotionPredictor(Protocol):
    def predict(self, window: MotionInputWindow) -> MotionPrediction: ...
    @property
    def diagnostics(self) -> InferenceDiagnostics: ...


class TorchMotionAdapter:
    """Runtime adapter for PyTorch models (.pt checkpoints)."""
    def __init__(
        self,
        model: Any,
        mean: np.ndarray,
        std: np.ndarray,
        fallback_std: Tuple[float, float] = DEFAULT_FALLBACK_STD,
        name: str = "PyTorch_Model",
    ):
        self.model = model
        self.mean = np.asarray(mean, dtype=np.float32)
        self.std = np.asarray(std, dtype=np.float32)
        self.fallback_std = fallback_std
        self.model.eval()
        self._diagnostics = InferenceDiagnostics(backend_name=name, runtime="torch")

    @property
    def diagnostics(self) -> InferenceDiagnostics:
        return self._diagnostics

    def predict(self, window: MotionInputWindow) -> MotionPrediction:
        import torch

        t0 = time.perf_counter()
        # Causal slice: take last 20 samples if window > 20
        raw_x = window.measurements
        if len(raw_x) >= 20:
            raw_x = raw_x[-20:]
        elif len(raw_x) < 20:
            # Left-pad with first available sample to achieve length 20
            pad_len = 20 - len(raw_x)
            pad_samples = np.repeat(raw_x[:1], pad_len, axis=0)
            raw_x = np.vstack([pad_samples, raw_x])

        x_norm = (raw_x - self.mean) / np.maximum(self.std, 1e-6)
        x_tensor = torch.tensor(x_norm[None], dtype=torch.float32)

        with torch.no_grad():
            output = self.model(x_tensor)

        if isinstance(output, tuple):
            mu, logvar = output
            values = mu[0].cpu().numpy()
            sigma = np.exp(0.5 * logvar[0].cpu().numpy())
        else:
            values = output[0].cpu().numpy()
            sigma = np.asarray(self.fallback_std)

        # Enforce non-negative velocity
        v_f = float(max(0.0, values[0]))
        omega_z = float(values[1])
        v_std = float(max(1e-3, sigma[0]))
        omega_std = float(max(1e-4, sigma[1]))

        dt_ms = (time.perf_counter() - t0) * 1000.0
        self._diagnostics.total_inferences += 1
        self._diagnostics.total_latency_ms += dt_ms
        self._diagnostics.last_latency_ms = dt_ms

        pred = MotionPrediction(
            timestamp_s=window.timestamp_end_s,
            forward_velocity_mps=v_f,
            yaw_rate_radps=omega_z,
            velocity_std_mps=v_std,
            yaw_rate_std_radps=omega_std,
            confidence=1.0,
        )

        if not pred.is_valid():
            self._diagnostics.dropped_inferences += 1
        self._diagnostics.last_prediction = pred
        return pred


class OnnxMotionAdapter:
    """High-performance edge runtime adapter using ONNX Runtime."""
    def __init__(
        self,
        onnx_path_or_session: Union[str, Any],
        mean: np.ndarray,
        std: np.ndarray,
        fallback_std: Tuple[float, float] = DEFAULT_FALLBACK_STD,
        name: str = "ONNX_Model",
    ):
        import onnxruntime as ort

        if isinstance(onnx_path_or_session, str):
            self.session = ort.InferenceSession(
                onnx_path_or_session,
                providers=["CPUExecutionProvider"],
            )
            self.model_path = onnx_path_or_session
        else:
            self.session = onnx_path_or_session
            self.model_path = "InferenceSession"

        self.input_name = self.session.get_inputs()[0].name
        self.mean = np.asarray(mean, dtype=np.float32)
        self.std = np.asarray(std, dtype=np.float32)
        self.fallback_std = fallback_std
        self._diagnostics = InferenceDiagnostics(backend_name=name, runtime="onnx")

    @property
    def diagnostics(self) -> InferenceDiagnostics:
        return self._diagnostics

    def predict(self, window: MotionInputWindow) -> MotionPrediction:
        t0 = time.perf_counter()

        raw_x = window.measurements
        if len(raw_x) >= 20:
            raw_x = raw_x[-20:]
        elif len(raw_x) < 20:
            pad_len = 20 - len(raw_x)
            pad_samples = np.repeat(raw_x[:1], pad_len, axis=0)
            raw_x = np.vstack([pad_samples, raw_x])

        x_norm = ((raw_x - self.mean) / np.maximum(self.std, 1e-6)).astype(np.float32)
        x_in = x_norm[None]  # [1, 20, 6]

        ort_out = self.session.run(None, {self.input_name: x_in})[0]  # [1, 2] or [1, 4]

        if ort_out.shape[1] == 4:
            v_f = float(max(0.0, ort_out[0, 0]))
            omega_z = float(ort_out[0, 1])
            v_std = float(max(1e-3, np.exp(0.5 * ort_out[0, 2])))
            omega_std = float(max(1e-4, np.exp(0.5 * ort_out[0, 3])))
        else:
            v_f = float(max(0.0, ort_out[0, 0]))
            omega_z = float(ort_out[0, 1])
            v_std = float(self.fallback_std[0])
            omega_std = float(self.fallback_std[1])

        dt_ms = (time.perf_counter() - t0) * 1000.0
        self._diagnostics.total_inferences += 1
        self._diagnostics.total_latency_ms += dt_ms
        self._diagnostics.last_latency_ms = dt_ms

        pred = MotionPrediction(
            timestamp_s=window.timestamp_end_s,
            forward_velocity_mps=v_f,
            yaw_rate_radps=omega_z,
            velocity_std_mps=v_std,
            yaw_rate_std_radps=omega_std,
            confidence=1.0,
        )

        if not pred.is_valid():
            self._diagnostics.dropped_inferences += 1
        self._diagnostics.last_prediction = pred
        return pred


class KinematicBaselineAdapter:
    """Classical strapdown dead-reckoning baseline adapter."""
    def __init__(self, fallback_std: Tuple[float, float] = (2.0, 0.2), name: str = "Kinematic_Baseline"):
        self.current_velocity = 0.0
        self.last_timestamp = None
        self.fallback_std = fallback_std
        self._diagnostics = InferenceDiagnostics(backend_name=name, runtime="kinematic")

    @property
    def diagnostics(self) -> InferenceDiagnostics:
        return self._diagnostics

    def reset(self):
        self.current_velocity = 0.0
        self.last_timestamp = None

    def prime_state(self, speed_mps: float):
        self.current_velocity = max(0.0, speed_mps)

    def predict(self, window: MotionInputWindow) -> MotionPrediction:
        t0 = time.perf_counter()
        latest = window.measurements[-1]
        t = window.timestamp_end_s

        dt = 0.1
        if self.last_timestamp is not None and t > self.last_timestamp:
            dt = min(0.5, t - self.last_timestamp)
        self.last_timestamp = t

        a_forward = latest[0]  # a_long
        omega_z = latest[3]    # omega_yaw

        # Simple ZUPT detection
        if len(window.measurements) >= 5:
            recent_accel = np.max(np.abs(window.measurements[-5:, 0]))
            recent_gyro = np.max(np.abs(window.measurements[-5:, 3]))
            if recent_accel < 0.25 and recent_gyro < 0.05:
                self.current_velocity = 0.0
            else:
                self.current_velocity = max(0.0, (self.current_velocity + a_forward * dt) * (1.0 - 0.015 * dt))
        else:
            self.current_velocity = max(0.0, self.current_velocity + a_forward * dt)

        dt_ms = (time.perf_counter() - t0) * 1000.0
        self._diagnostics.total_inferences += 1
        self._diagnostics.total_latency_ms += dt_ms
        self._diagnostics.last_latency_ms = dt_ms

        pred = MotionPrediction(
            timestamp_s=t,
            forward_velocity_mps=self.current_velocity,
            yaw_rate_radps=float(omega_z),
            velocity_std_mps=float(self.fallback_std[0]),
            yaw_rate_std_radps=float(self.fallback_std[1]),
            confidence=0.8,
        )
        self._diagnostics.last_prediction = pred
        return pred


def create_motion_adapter(
    backend: Optional[str] = None,
    runtime: Optional[str] = None,
    checkpoint_path: Optional[str] = None,
    onnx_path: Optional[str] = None,
    normalization_path: str = "artifacts/data/normalization.json",
    fallback_std: Tuple[float, float] = DEFAULT_FALLBACK_STD,
) -> MotionPredictor:
    """
    Unified Factory for motion predictors.
    
    Supported backends:
    - 'tcn' / 'existing_tcn': Tiny Causal TCN (default)
    - 'gru': Lightweight GRU
    - 'mlp': Shallow MLP
    - 'heteroscedastic' / 'uncertainty': Heteroscedastic TCN
    - 'kinematic': Classical INS baseline
    
    Supported runtimes:
    - 'torch': PyTorch execution
    - 'onnx': ONNX Runtime execution
    """
    backend = (backend or os.environ.get("IDR_MODEL_BACKEND", "tcn")).lower()
    runtime = (runtime or os.environ.get("IDR_MODEL_RUNTIME", "torch")).lower()

    if backend == "kinematic":
        return KinematicBaselineAdapter(fallback_std=fallback_std)

    with open(normalization_path) as f:
        norm = json.load(f)
    mean = np.array(norm["mean"], dtype=np.float32)
    std = np.array(norm["std"], dtype=np.float32)

    # ONNX Runtime path
    if runtime == "onnx":
        if onnx_path is None:
            name_map = {
                "tcn": "B2_TCN.onnx",
                "existing_tcn": "B2_TCN.onnx",
                "gru": "B3_GRU.onnx",
                "mlp": "B1_MLP.onnx",
                "heteroscedastic": "Heteroscedastic_TCN.onnx",
                "uncertainty": "Heteroscedastic_TCN.onnx",
            }
            fname = name_map.get(backend, "B2_TCN.onnx")
            onnx_path = os.path.join("artifacts", "onnx", fname)

        if not os.path.exists(onnx_path):
            raise FileNotFoundError(f"ONNX model file not found: {onnx_path}. Run research/idr/export_onnx.py first.")

        return OnnxMotionAdapter(
            onnx_path_or_session=onnx_path,
            mean=mean,
            std=std,
            fallback_std=fallback_std,
            name=f"ONNX_{backend.upper()}",
        )

    # PyTorch path
    import torch
    from research.idr.models.tcn import TinyCausalTcnMotionModel
    from research.idr.models.gru import LightweightGruMotionModel
    from research.idr.models.mlp import ShallowMlpMotionModel
    from research.idr.models.uncertainty import HeteroscedasticTcnModel

    cls_map = {
        "tcn": (TinyCausalTcnMotionModel, "artifacts/runs/B2_TCN/best_model.pt"),
        "existing_tcn": (TinyCausalTcnMotionModel, "artifacts/runs/B2_TCN/best_model.pt"),
        "gru": (LightweightGruMotionModel, "artifacts/runs/B3_GRU/best_model.pt"),
        "mlp": (ShallowMlpMotionModel, "artifacts/runs/B1_MLP/best_model.pt"),
        "heteroscedastic": (HeteroscedasticTcnModel, "artifacts/runs/B2_TCN/best_model.pt"),
        "uncertainty": (HeteroscedasticTcnModel, "artifacts/runs/B2_TCN/best_model.pt"),
    }

    if backend not in cls_map:
        raise ValueError(f"Unknown model backend: {backend}. Choices: {list(cls_map.keys()) + ['kinematic']}")

    model_cls, default_ckpt = cls_map[backend]
    ckpt_file = checkpoint_path or default_ckpt

    model = model_cls()
    if os.path.exists(ckpt_file):
        ckpt = torch.load(ckpt_file, map_location="cpu", weights_only=False)
        state_dict = ckpt["model_state"]
        model_dict = model.state_dict()
        compatible_dict = {k: v for k, v in state_dict.items() if k in model_dict and v.shape == model_dict[k].shape}
        model_dict.update(compatible_dict)
        model.load_state_dict(model_dict)

    model.eval()
    return TorchMotionAdapter(
        model=model,
        mean=mean,
        std=std,
        fallback_std=fallback_std,
        name=f"Torch_{backend.upper()}",
    )
