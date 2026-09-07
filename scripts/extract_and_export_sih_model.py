"""
Extract weights from PyTorch checkpoint and export SIH GRU model to ONNX and JSON weights.
"""
from __future__ import annotations
import io
import json
import os
import pickle
import struct
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SIH_ARTIFACTS = REPO_ROOT / "external" / "sih_dead_reckoning" / "artifacts" / "clean_velocity_comparison"
GRU_PT_PATH = SIH_ARTIFACTS / "gru_clean_velocity.pt"
SCALERS_PATH = SIH_ARTIFACTS / "scalers.joblib"
OUTPUT_ONNX = REPO_ROOT / "assets" / "models" / "sih_gru.onnx"
OUTPUT_JSON = REPO_ROOT / "assets" / "models" / "sih_gru_weights.json"

FEATURE_MEANS = [0.044815783860300926, -0.06724548060373758, 0.18944164501314714, 4.413844272944445e-06, 0.0014875562173792766, -0.0020986324986663]
FEATURE_SCALES = [2.2225976692690628, 2.3958236620567073, 0.8902544811156624, 0.26395565131407367, 0.25048259629254094, 0.10458397316236762]
TARGET_MEAN = 14.618584326606433
TARGET_SCALE = 6.597726638937385

def extract_weights_and_export():
    import numpy as np
    import torch
    import torch.nn as nn
    import onnx

    print("Loading PyTorch checkpoint:", GRU_PT_PATH)
    checkpoint = torch.load(GRU_PT_PATH, map_location="cpu", weights_only=False)
    state_dict = checkpoint["state_dict"]
    parameters = checkpoint.get("parameters", {"hidden_size": 64, "layers": 2, "dropout": 0.2})
    print("Checkpoint parameters:", parameters)
    print("State dict keys:", list(state_dict.keys()))

    # Build the exact PyTorch GruRegressor matching training definition
    class SihGruModel(nn.Module):
        def __init__(self, n_channels=6, hidden_size=64, num_layers=2, dropout=0.0):
            super().__init__()
            self.gru = nn.GRU(
                n_channels,
                hidden_size,
                num_layers=num_layers,
                batch_first=True,
                dropout=dropout if num_layers > 1 else 0.0,
            )
            self.head = nn.Sequential(
                nn.Linear(hidden_size, 32),
                nn.ReLU(),
                nn.Dropout(dropout),
                nn.Linear(32, 1),
            )

        def forward(self, sequence: torch.Tensor) -> torch.Tensor:
            _, hidden = self.gru(sequence)
            # Take last layer's hidden state: shape [batch, hidden_size]
            encoded = hidden[-1]
            return self.head(encoded).squeeze(-1)

    model = SihGruModel(
        n_channels=6,
        hidden_size=parameters.get("hidden_size", 64),
        num_layers=parameters.get("layers", 2),
        dropout=0.0, # zero dropout for inference
    )
    # Filter state dict for head (map head.0 -> head.0, head.3 -> head.3)
    clean_sd = {}
    for k, v in state_dict.items():
        clean_sd[k] = v
    model.load_state_dict(clean_sd)
    model.eval()

    # Wrap model with pre-normalization and post-denormalization for complete edge deployment
    class SihEndToEndModel(nn.Module):
        def __init__(self, core_model: nn.Module):
            super().__init__()
            self.core = core_model
            self.register_buffer("feat_mean", torch.tensor(FEATURE_MEANS, dtype=torch.float32))
            self.register_buffer("feat_scale", torch.tensor(FEATURE_SCALES, dtype=torch.float32))
            self.register_buffer("target_mean", torch.tensor([TARGET_MEAN], dtype=torch.float32))
            self.register_buffer("target_scale", torch.tensor([TARGET_SCALE], dtype=torch.float32))

        def forward(self, imu_window: torch.Tensor) -> torch.Tensor:
            # imu_window: [batch, 50, 6]
            norm_x = (imu_window - self.feat_mean) / self.feat_scale
            norm_vel = self.core(norm_x) # [batch]
            vel_mps = torch.clamp(norm_vel * self.target_scale + self.target_mean, min=0.0)
            return vel_mps.unsqueeze(-1) # [batch, 1]

    e2e_model = SihEndToEndModel(model)
    e2e_model.eval()

    # Export to ONNX
    OUTPUT_ONNX.parent.mkdir(parents=True, exist_ok=True)
    dummy_input = torch.randn(1, 50, 6, dtype=torch.float32)
    print("Exporting ONNX model to:", OUTPUT_ONNX)
    torch.onnx.export(
        e2e_model,
        dummy_input,
        str(OUTPUT_ONNX),
        input_names=["imu_window"],
        output_names=["forward_velocity"],
        dynamic_axes={
            "imu_window": {0: "batch"},
            "forward_velocity": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print("Validating ONNX model with onnx.checker...")
    onnx_proto = onnx.load(str(OUTPUT_ONNX))
    onnx.checker.check_model(onnx_proto)
    print("ONNX export successfully verified!")

    # Export exact JSON weights for Embedded Neural Engine (zero-dependency fallback on phone)
    json_weights = {
        "metadata": {
            "model_name": "sih_gru_clean_velocity",
            "source": "https://github.com/bhavikk10/sih_dead_reckoning-",
            "window_size": 50,
            "sample_period_ms": 100,
            "n_channels": 6,
            "hidden_size": 64,
            "num_layers": 2,
            "feature_means": FEATURE_MEANS,
            "feature_scales": FEATURE_SCALES,
            "target_mean": TARGET_MEAN,
            "target_scale": TARGET_SCALE,
        },
        "weights": {
            k: v.cpu().detach().numpy().tolist()
            for k, v in clean_sd.items()
        }
    }
    OUTPUT_JSON.write_text(json.dumps(json_weights, indent=2), encoding="utf-8")
    print("Exported JSON weights to:", OUTPUT_JSON, f"({OUTPUT_JSON.stat().st_size} bytes)")

if __name__ == "__main__":
    extract_weights_and_export()
