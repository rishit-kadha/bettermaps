"""
Reproducible ONNX Exporter & Equivalence Verifier for BetterMaps IDR.

Exports:
- B1_MLP: Shallow MLP -> artifacts/onnx/B1_MLP.onnx (output: [B, 2])
- B2_TCN: Tiny Causal TCN -> artifacts/onnx/B2_TCN.onnx (output: [B, 2])
- B3_GRU: Lightweight GRU -> artifacts/onnx/B3_GRU.onnx (output: [B, 2])
- Heteroscedastic_TCN: TCN with uncertainty -> artifacts/onnx/Heteroscedastic_TCN.onnx (output: [B, 4])

Validates:
- ONNX graph validity via onnx.checker
- PyTorch vs ONNX Runtime numerical equivalence (atol < 1e-5)
"""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.abspath("."))
import argparse
import numpy as np
import torch
import torch.nn as nn
import onnx
import onnxruntime as ort

from research.idr.models.mlp import ShallowMlpMotionModel
from research.idr.models.tcn import TinyCausalTcnMotionModel
from research.idr.models.gru import LightweightGruMotionModel
from research.idr.models.uncertainty import HeteroscedasticTcnModel


class HeteroscedasticExportWrapper(nn.Module):
    """Wraps HeteroscedasticTcnModel so that it outputs a single concatenated [B, 4] tensor."""
    def __init__(self, model: HeteroscedasticTcnModel):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mu, log_var = self.model(x)
        return torch.cat([mu, log_var], dim=-1)


def export_model_to_onnx(
    model: nn.Module,
    output_onnx_path: str,
    input_shape: tuple = (1, 20, 6),
    output_names: list[str] = None,
    opset_version: int = 17,
) -> None:
    model.eval()
    dummy_input = torch.randn(*input_shape, dtype=torch.float32)
    os.makedirs(os.path.dirname(output_onnx_path), exist_ok=True)

    torch.onnx.export(
        model,
        dummy_input,
        output_onnx_path,
        input_names=["imu_window"],
        output_names=output_names or ["motion_prediction"],
        dynamic_axes={
            "imu_window": {0: "batch"},
            (output_names[0] if output_names else "motion_prediction"): {0: "batch"},
        },
        opset_version=opset_version,
        dynamo=False,
    )

    # Validate ONNX graph
    onnx_model = onnx.load(output_onnx_path)
    onnx.checker.check_model(onnx_model)


def verify_numerical_equivalence(
    torch_model: nn.Module,
    onnx_path: str,
    num_samples: int = 100,
    atol: float = 1e-5,
) -> dict:
    torch_model.eval()
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    max_diff = 0.0
    mean_diffs = []

    np.random.seed(42)
    torch.manual_seed(42)

    for _ in range(num_samples):
        x = torch.randn(1, 20, 6, dtype=torch.float32)
        with torch.no_grad():
            torch_out = torch_model(x).cpu().numpy()

        ort_out = session.run(None, {"imu_window": x.numpy()})[0]

        diff = np.abs(torch_out - ort_out)
        cur_max = float(np.max(diff))
        cur_mean = float(np.mean(diff))

        if cur_max > max_diff:
            max_diff = cur_max
        mean_diffs.append(cur_mean)

    passed = max_diff <= atol
    return {
        "passed": passed,
        "max_diff": max_diff,
        "mean_diff": float(np.mean(mean_diffs)),
        "samples_tested": num_samples,
        "atol": atol,
    }


def main():
    parser = argparse.ArgumentParser(description="Export IDR models to ONNX and verify equivalence.")
    parser.add_argument("--output-dir", default="artifacts/onnx", help="Directory to save exported ONNX models")
    parser.add_argument("--runs-dir", default="artifacts/runs", help="Directory containing PyTorch checkpoints")
    parser.add_argument("--atol", type=float, default=1e-5, help="Tolerance for numerical validation")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    models_to_export = [
        {
            "name": "B1_MLP",
            "model_cls": ShallowMlpMotionModel,
            "ckpt_path": os.path.join(args.runs_dir, "B1_MLP", "best_model.pt"),
            "onnx_path": os.path.join(args.output_dir, "B1_MLP.onnx"),
            "wrapper": None,
            "output_names": ["motion_prediction"],
        },
        {
            "name": "B2_TCN",
            "model_cls": TinyCausalTcnMotionModel,
            "ckpt_path": os.path.join(args.runs_dir, "B2_TCN", "best_model.pt"),
            "onnx_path": os.path.join(args.output_dir, "B2_TCN.onnx"),
            "wrapper": None,
            "output_names": ["motion_prediction"],
        },
        {
            "name": "B3_GRU",
            "model_cls": LightweightGruMotionModel,
            "ckpt_path": os.path.join(args.runs_dir, "B3_GRU", "best_model.pt"),
            "onnx_path": os.path.join(args.output_dir, "B3_GRU.onnx"),
            "wrapper": None,
            "output_names": ["motion_prediction"],
        },
        {
            "name": "Heteroscedastic_TCN",
            "model_cls": HeteroscedasticTcnModel,
            "ckpt_path": os.path.join(args.runs_dir, "B2_TCN", "best_model.pt"),  # Uses B2 backbone weights
            "onnx_path": os.path.join(args.output_dir, "Heteroscedastic_TCN.onnx"),
            "wrapper": HeteroscedasticExportWrapper,
            "output_names": ["heteroscedastic_prediction"],
        },
    ]

    results = []

    print("=" * 80)
    print("BETTERMAPS IDR ? ONNX EXPORT & NUMERICAL VERIFICATION")
    print("=" * 80)

    for item in models_to_export:
        name = item["name"]
        print(f"\nProcessing {name}...")

        # Construct and load model
        raw_model = item["model_cls"]()
        if os.path.exists(item["ckpt_path"]):
            ckpt = torch.load(item["ckpt_path"], map_location="cpu", weights_only=False)
            state_dict = ckpt["model_state"]
            # Filter compatible keys for heteroscedastic wrapper if needed
            model_dict = raw_model.state_dict()
            compatible_dict = {k: v for k, v in state_dict.items() if k in model_dict and v.shape == model_dict[k].shape}
            model_dict.update(compatible_dict)
            raw_model.load_state_dict(model_dict)
            print(f"  Loaded checkpoint from {item['ckpt_path']} ({len(compatible_dict)} keys matched)")
        else:
            print(f"  Warning: Checkpoint {item['ckpt_path']} not found, using initialized weights")

        model_for_export = item["wrapper"](raw_model) if item["wrapper"] else raw_model
        model_for_export.eval()

        # Count parameters
        param_count = sum(p.numel() for p in raw_model.parameters())

        # Export to ONNX
        export_model_to_onnx(
            model_for_export,
            item["onnx_path"],
            input_shape=(1, 20, 6),
            output_names=item["output_names"],
            opset_version=17,
        )
        onnx_size_kb = os.path.getsize(item["onnx_path"]) / 1024.0
        print(f"  Exported ONNX to {item['onnx_path']} ({onnx_size_kb:.1f} KB)")

        # Verify numerical equivalence
        eq = verify_numerical_equivalence(
            model_for_export,
            item["onnx_path"],
            num_samples=100,
            atol=args.atol,
        )

        status_str = "PASS" if eq["passed"] else "FAIL"
        print(f"  Numerical Equivalence: {status_str} (Max Diff: {eq['max_diff']:.2e}, Mean Diff: {eq['mean_diff']:.2e})")

        results.append({
            "model": name,
            "params": param_count,
            "onnx_file": os.path.basename(item["onnx_path"]),
            "onnx_size_kb": onnx_size_kb,
            "max_diff": eq["max_diff"],
            "mean_diff": eq["mean_diff"],
            "status": status_str,
        })

    print("\n" + "=" * 80)
    print(f"{'Model':<20} | {'Params':<8} | {'ONNX Size':<10} | {'Max Diff':<12} | {'Mean Diff':<12} | {'Status'}")
    print("-" * 80)
    for r in results:
        print(f"{r['model']:<20} | {r['params']:<8} | {r['onnx_size_kb']:<7.1f} KB | {r['max_diff']:<12.2e} | {r['mean_diff']:<12.2e} | {r['status']}")
    print("=" * 80)

    # Assert all passed
    failed = [r["model"] for r in results if r["status"] != "PASS"]
    if failed:
        raise RuntimeError(f"ONNX equivalence verification failed for models: {failed}")
    print("\nALL ONNX MODELS SUCCESSFULLY EXPORTED AND VERIFIED.")


if __name__ == "__main__":
    main()
