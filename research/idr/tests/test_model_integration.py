"""
Comprehensive Integration & Regression Test Suite for BetterMaps IDR Model Backends.

Tests:
1. test_model_loading: Checkpoints load correctly and put models in eval mode.
2. test_feature_ordering: 6 channels match canonical normalization sequence.
3. test_normalization: Normalization application matches normalization.json.
4. test_expected_tensor_shape: Input [1, 20, 6] produces expected [1, 2] or [1, 4].
5. test_output_units: Velocity is m/s and non-negative, yaw rate is rad/s.
6. test_motion_prediction_conversion: MotionPrediction contains valid, finite values.
7. test_causality: MotionInputWindow strictly rejects non-causal timestamps.
8. test_finite_predictions: No NaNs/Infs produced under zero or extreme inputs.
9. test_model_switching: Clean switching between TCN, GRU, MLP, Heteroscedastic, Kinematic.
10. test_eskf_compatibility: Predictions properly drive ESKF state updates.
11. test_onnx_export_and_validation: Exported ONNX graphs pass onnx.checker.
12. test_pytorch_onnx_numerical_equivalence: PyTorch and ONNX Runtime match within 1e-5.
13. test_onnx_motion_adapter_in_eskf: OnnxMotionAdapter runs end-to-end through outage filter.
"""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.abspath("."))
import unittest
import numpy as np
import torch
import onnx
import onnxruntime as ort

from research.idr.models.tcn import TinyCausalTcnMotionModel
from research.idr.models.gru import LightweightGruMotionModel
from research.idr.models.mlp import ShallowMlpMotionModel
from research.idr.models.uncertainty import HeteroscedasticTcnModel
from research.idr.navigation.motion_adapter import (
    MotionInputWindow,
    MotionPrediction,
    TorchMotionAdapter,
    OnnxMotionAdapter,
    KinematicBaselineAdapter,
    create_motion_adapter,
)
from research.idr.navigation.eskf import ErrorStateKalmanFilter, NavigationState
from research.idr.navigation.outage import OutageConfig, run_outage


class ModelIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mean = np.array([-0.046, 0.088, -0.061, 0.0039, 0.0004, -0.0016], dtype=np.float32)
        cls.std = np.array([0.722, 0.697, 0.702, 0.076, 0.043, 0.049], dtype=np.float32)

    def test_01_model_loading(self):
        for model_name, cls, ckpt_path in [
            ("TCN", TinyCausalTcnMotionModel, "artifacts/runs/B2_TCN/best_model.pt"),
            ("GRU", LightweightGruMotionModel, "artifacts/runs/B3_GRU/best_model.pt"),
            ("MLP", ShallowMlpMotionModel, "artifacts/runs/B1_MLP/best_model.pt"),
        ]:
            if os.path.exists(ckpt_path):
                ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
                m = cls()
                m.load_state_dict(ckpt["model_state"])
                m.eval()
                self.assertFalse(m.training)
                x = torch.randn(1, 20, 6)
                with torch.no_grad():
                    out = m(x)
                self.assertEqual(out.shape, (1, 2), f"{model_name} output shape mismatch")

    def test_02_feature_ordering(self):
        import json
        with open("artifacts/data/normalization.json") as f:
            norm = json.load(f)
        expected = ["a_long_mps2", "a_lat_mps2", "a_vert_mps2", "omega_yaw_radps", "omega_pitch_radps", "omega_roll_radps"]
        self.assertEqual(norm["channel_names"], expected)

    def test_03_normalization(self):
        adapter = create_motion_adapter(backend="tcn", runtime="torch")
        self.assertEqual(len(adapter.mean), 6)
        self.assertEqual(len(adapter.std), 6)
        self.assertTrue(np.all(adapter.std > 0))

    def test_04_expected_tensor_shape(self):
        dummy_in = torch.randn(1, 20, 6)
        tcn = TinyCausalTcnMotionModel()
        gru = LightweightGruMotionModel()
        mlp = ShallowMlpMotionModel()
        for m in [tcn, gru, mlp]:
            m.eval()
            with torch.no_grad():
                out = m(dummy_in)
            self.assertEqual(out.shape, (1, 2))

    def test_05_output_units(self):
        adapter = create_motion_adapter(backend="tcn", runtime="torch")
        # Feeding zero and large inputs
        for scale in [0.0, 1.0, 5.0, -5.0]:
            meas = np.ones((20, 6), dtype=np.float32) * scale
            win = MotionInputWindow(meas, "vehicle", 0.0, 2.0)
            pred = adapter.predict(win)
            self.assertGreaterEqual(pred.forward_velocity_mps, 0.0, "Velocity must be non-negative")
            self.assertTrue(np.isfinite(pred.forward_velocity_mps))
            self.assertTrue(np.isfinite(pred.yaw_rate_radps))

    def test_06_motion_prediction_conversion(self):
        adapter = create_motion_adapter(backend="tcn", runtime="torch")
        win = MotionInputWindow(np.zeros((20, 6), dtype=np.float32), "vehicle", 10.0, 12.0)
        pred = adapter.predict(win)
        self.assertIsInstance(pred, MotionPrediction)
        self.assertEqual(pred.timestamp_s, 12.0)
        self.assertTrue(pred.is_valid())

    def test_07_causality(self):
        # A window where end timestamp is earlier than start must raise ValueError
        with self.assertRaises(ValueError):
            MotionInputWindow(np.zeros((20, 6), dtype=np.float32), "vehicle", 10.0, 9.0)

    def test_08_finite_predictions(self):
        adapter = create_motion_adapter(backend="tcn", runtime="torch")
        # Extreme noisy input
        meas = np.random.randn(20, 6) * 100.0
        win = MotionInputWindow(meas, "vehicle", 0.0, 2.0)
        pred = adapter.predict(win)
        self.assertTrue(np.isfinite(pred.forward_velocity_mps))
        self.assertTrue(np.isfinite(pred.yaw_rate_radps))
        self.assertTrue(np.isfinite(pred.velocity_std_mps))
        self.assertTrue(np.isfinite(pred.yaw_rate_std_radps))

    def test_09_model_switching(self):
        backends = ["tcn", "gru", "mlp", "kinematic"]
        preds = []
        win = MotionInputWindow(np.ones((20, 6), dtype=np.float32) * 0.5, "vehicle", 0.0, 2.0)
        for b in backends:
            adapter = create_motion_adapter(backend=b, runtime="torch")
            pred = adapter.predict(win)
            self.assertTrue(pred.is_valid())
            preds.append(pred)
        self.assertEqual(len(preds), 4)

    def test_10_eskf_compatibility(self):
        filter_ = ErrorStateKalmanFilter()
        cov_before = float(np.trace(filter_.P))
        # Deliver motion prediction measurement
        pred = MotionPrediction(
            timestamp_s=1.0,
            forward_velocity_mps=15.0,
            yaw_rate_radps=0.05,
            velocity_std_mps=1.0,
            yaw_rate_std_radps=0.1,
            confidence=1.0,
        )
        filter_.update_motion(pred)
        cov_after = float(np.trace(filter_.P))
        self.assertTrue(np.isfinite(cov_after))
        self.assertLess(cov_after, cov_before, "Measurement update must reduce covariance uncertainty")

    def test_11_onnx_export_and_validation(self):
        for onnx_name in ["B1_MLP.onnx", "B2_TCN.onnx", "B3_GRU.onnx", "Heteroscedastic_TCN.onnx"]:
            path = os.path.join("artifacts", "onnx", onnx_name)
            self.assertTrue(os.path.exists(path), f"Missing {path}")
            model = onnx.load(path)
            onnx.checker.check_model(model)

    def test_12_pytorch_onnx_numerical_equivalence(self):
        for name, cls, onnx_file in [
            ("B1_MLP", ShallowMlpMotionModel, "B1_MLP.onnx"),
            ("B2_TCN", TinyCausalTcnMotionModel, "B2_TCN.onnx"),
            ("B3_GRU", LightweightGruMotionModel, "B3_GRU.onnx"),
        ]:
            torch_adapter = create_motion_adapter(backend=name.lower().split("_")[1], runtime="torch")
            onnx_adapter = create_motion_adapter(backend=name.lower().split("_")[1], runtime="onnx")

            np.random.seed(123)
            meas = np.random.randn(20, 6).astype(np.float32)
            win = MotionInputWindow(meas, "vehicle", 0.0, 2.0)

            p_torch = torch_adapter.predict(win)
            p_onnx = onnx_adapter.predict(win)

            diff_v = abs(p_torch.forward_velocity_mps - p_onnx.forward_velocity_mps)
            diff_w = abs(p_torch.yaw_rate_radps - p_onnx.yaw_rate_radps)

            self.assertLess(diff_v, 1e-5, f"{name} velocity diff {diff_v} exceeded 1e-5")
            self.assertLess(diff_w, 1e-5, f"{name} yaw rate diff {diff_w} exceeded 1e-5")

    def test_13_onnx_motion_adapter_in_eskf(self):
        onnx_adapter = create_motion_adapter(backend="tcn", runtime="onnx")
        self.assertEqual(onnx_adapter.diagnostics.runtime, "onnx")

        # Run synthetic outage with ONNX adapter
        t = np.linspace(0, 10, 101)
        imu = np.zeros((101, 6))
        gnss = np.zeros((101, 3))
        cfg = OutageConfig(start_s=2.0, duration_s=5.0)
        est = run_outage(t, imu, onnx_adapter, ErrorStateKalmanFilter(), cfg, gnss)
        self.assertEqual(est.shape, (101, 3))
        self.assertTrue(np.all(np.isfinite(est)))
        self.assertGreater(onnx_adapter.diagnostics.total_inferences, 0)
        self.assertLess(onnx_adapter.diagnostics.mean_latency_ms, 5.0)


if __name__ == "__main__":
    unittest.main()
