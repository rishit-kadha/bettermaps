"""
Causal M-session GNSS outage evaluation; V is metrics-only after preprocessing.

Supports:
- Single-model evaluation with --model-backend (tcn, gru, mlp, heteroscedastic, kinematic)
- Dual runtime support with --model-runtime (torch, onnx)
- Controlled apples-to-apples multi-model comparison with --compare-all
- Outage durations: 5s, 10s, 20s, 30s, 60s
- Reports velocity error, yaw-rate error, horizontal position RMSE, MAE, and max error
"""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.abspath("."))
import argparse
import json
import numpy as np
import pandas as pd

from research.idr.navigation.coordinates import wgs84_to_enu
from research.idr.navigation.eskf import ErrorStateKalmanFilter
from research.idr.navigation.motion_adapter import (
    create_motion_adapter,
    MotionInputWindow,
)
from research.idr.navigation.outage import OutageConfig, run_outage
from research.idr.preprocessing.orientation import (
    estimate_session_transform,
    transform_device_to_vehicle,
)


def column(df, token):
    return next(c for c in df.columns if token.lower() in c.lower())


def repair_timestamp_resets(raw_ms):
    """Keep sample order, adding nominal 100 ms across a phone logger reset."""
    raw = np.asarray(raw_ms, float)
    fixed = np.empty_like(raw)
    fixed[0] = raw[0]
    offset = 0.0
    for i in range(1, len(raw)):
        candidate = raw[i] + offset
        if candidate <= fixed[i - 1]:
            offset = fixed[i - 1] + 100.0 - raw[i]
            candidate = raw[i] + offset
        fixed[i] = candidate
    return fixed


def state_at_outage_start(t, gnss_enu, speed_kmh, start_s):
    """S-only GNSS hand-off: position, course and speed from history ending at start."""
    k = max(1, int(np.searchsorted(t, start_s, side="right") - 1))
    back = max(0, k - 20)
    dp = gnss_enu[k] - gnss_enu[back]
    dt = max(float(t[k] - t[back]), 0.1)
    horizontal = dp[:2]
    distance = float(np.linalg.norm(horizontal))
    if distance > 1.0:
        direction = horizontal / distance
        speed = max(float(speed_kmh[k]) / 3.6, distance / dt)
    else:
        direction = np.array([1.0, 0.0])
        speed = max(0.0, float(speed_kmh[k]) / 3.6)
    return (
        gnss_enu[k],
        np.array([direction[0] * speed, direction[1] * speed, 0.0]),
        float(np.arctan2(direction[1], direction[0])),
    )


def evaluate_single_model(
    backend: str,
    runtime: str,
    t: np.ndarray,
    imu: np.ndarray,
    gnss: np.ndarray,
    speed: np.ndarray,
    ref: np.ndarray,
    v_ref_speed_mps: np.ndarray,
    v_ref_yaw_radps: np.ndarray,
    outages: list[float],
    calibration_seconds: float,
    include_nhc: bool,
    checkpoint: str = None,
    normalization: str = "artifacts/data/normalization.json",
) -> list[dict]:
    predictor = create_motion_adapter(
        backend=backend,
        runtime=runtime,
        checkpoint_path=checkpoint,
        normalization_path=normalization,
    )

    methods = [(f"{backend}_{runtime}_eskf", False)] + ([(f"{backend}_{runtime}_eskf_nhc", True)] if include_nhc else [])
    records = []

    for dur in outages:
        start = max(calibration_seconds + 2.0, t[20])
        end = start + dur
        keep = t <= end
        p0, v0, h0 = state_at_outage_start(t, gnss, speed, start)

        for name, nhc in methods:
            config = OutageConfig(
                start_s=start,
                duration_s=dur,
                use_nhc=nhc,
                initial_position_enu=p0,
                initial_velocity_enu_mps=v0,
                initial_heading_enu_rad=h0,
            )
            # Fresh ESKF per run
            eskf = ErrorStateKalmanFilter()
            est = run_outage(t[keep], imu[keep], predictor, eskf, config, gnss[keep])

            m = (t[keep] >= start) & (t[keep] < end)
            err_pos = np.linalg.norm(est[m, :2] - ref[keep][m, :2], axis=1)

            # Evaluate direct motion predictions during outage
            v_errs, w_errs = [], []
            t_slice = t[keep][m]
            imu_slice = imu[keep][m]
            v_gt_slice = v_ref_speed_mps[keep][m]
            w_gt_slice = v_ref_yaw_radps[keep][m]

            for idx in range(len(t_slice)):
                cur_t = t_slice[idx]
                w_start = max(0.0, cur_t - 2.0)
                # Causal window
                w_mask = (t[keep] <= cur_t) & (t[keep] >= w_start)
                if np.sum(w_mask) >= 1:
                    win = MotionInputWindow(imu[keep][w_mask], "vehicle", w_start, cur_t)
                    pred = predictor.predict(win)
                    v_errs.append(pred.forward_velocity_mps - v_gt_slice[idx])
                    w_errs.append(pred.yaw_rate_radps - w_gt_slice[idx])

            v_errs = np.array(v_errs) if v_errs else np.zeros(1)
            w_errs = np.array(w_errs) if w_errs else np.zeros(1)

            records.append(dict(
                model=backend,
                runtime=runtime,
                method="ml_eskf" if not nhc else "ml_eskf_nhc",
                outage_duration_s=dur,
                samples=int(m.sum()),
                horizontal_rmse_m=float(np.sqrt(np.mean(err_pos**2))),
                horizontal_mae_m=float(np.mean(err_pos)),
                max_position_error_m=float(np.max(err_pos)),
                velocity_rmse_kmh=float(np.sqrt(np.mean(v_errs**2)) * 3.6),
                velocity_mae_kmh=float(np.mean(np.abs(v_errs)) * 3.6),
                yaw_rate_rmse_degps=float(np.sqrt(np.mean(w_errs**2)) * 180.0 / np.pi),
                mean_latency_ms=round(predictor.diagnostics.mean_latency_ms, 3),
            ))

    return records


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--s", required=True)
    p.add_argument("--v", required=True)
    p.add_argument("--model-backend", default="tcn", choices=["tcn", "existing_tcn", "gru", "mlp", "heteroscedastic", "kinematic"])
    p.add_argument("--model-runtime", default="torch", choices=["torch", "onnx"])
    p.add_argument("--checkpoint", default=None)
    p.add_argument("--normalization", default="artifacts/data/normalization.json")
    p.add_argument("--outages", default="5,10,20,30,60")
    p.add_argument("--calibration-seconds", type=float, default=30.0)
    p.add_argument("--output", default="artifacts/data/navigation_outage_summary.csv")
    p.add_argument("--include-nhc", action="store_true", help="Evaluate NHC too; disabled by default until mounting calibration is validated.")
    p.add_argument("--compare-all", action="store_true", help="Run controlled apples-to-apples comparison across all candidate models.")
    a = p.parse_args()

    s = pd.read_csv(a.s, encoding="latin1")
    v = pd.read_csv(a.v, encoding="latin1")
    s.columns = s.columns.str.strip()
    v.columns = v.columns.str.strip()
    n = min(len(s), len(v))
    s, v = s.iloc[:n].reset_index(drop=True), v.iloc[:n].reset_index(drop=True)

    raw_time = s[column(s, "TIME SINCE START")].to_numpy(float)
    t = (repair_timestamp_resets(raw_time) - raw_time[0]) / 1000.0

    cal = min(n, max(200, int(a.calibration_seconds * 10)))
    R = estimate_session_transform(s.iloc[:cal], v.iloc[:cal])["R_D_to_V"]
    imu = transform_device_to_vehicle(s, R)

    # Reference coordinates and ground-truth velocities for metric evaluation ONLY
    s_lat = s[column(s, "GPS LATITUDE")].to_numpy(float)
    s_lon = s[column(s, "GPS LONGITUDE")].to_numpy(float)
    origin = (s_lat[0], s_lon[0])
    gnss = np.array([wgs84_to_enu(x, y, *origin) for x, y in zip(s_lat, s_lon)])
    speed = s[column(s, "GPS SPEED")].to_numpy(float)

    v_lat = v[column(v, "Latitude")].to_numpy(float)
    v_lon = v[column(v, "Longitude")].to_numpy(float)
    ref = np.array([wgs84_to_enu(x, y, *origin) for x, y in zip(v_lat, v_lon)])

    v_speed_kmh = v[column(v, "Velocity")].to_numpy(float)
    v_ref_speed_mps = v_speed_kmh / 3.6
    v_yaw_degps = v[column(v, "Yaw Rate")].to_numpy(float)
    v_ref_yaw_radps = v_yaw_degps * (np.pi / 180.0)

    outage_list = [float(x.strip()) for x in a.outages.split(",") if x.strip()]

    if a.compare_all:
        print("=" * 105)
        print("BETTERMAPS IDR ? CONTROLLED MULTI-MODEL OFFLINE COMPARISON (M SESSION)")
        print("=" * 105)

        model_candidates = [
            ("tcn", "torch"),
            ("tcn", "onnx"),
            ("gru", "torch"),
            ("gru", "onnx"),
            ("mlp", "torch"),
            ("mlp", "onnx"),
            ("kinematic", "torch"),
        ]

        all_records = []
        for backend, runtime in model_candidates:
            print(f"Running evaluation: backend={backend}, runtime={runtime}...")
            recs = evaluate_single_model(
                backend=backend,
                runtime=runtime,
                t=t,
                imu=imu,
                gnss=gnss,
                speed=speed,
                ref=ref,
                v_ref_speed_mps=v_ref_speed_mps,
                v_ref_yaw_radps=v_ref_yaw_radps,
                outages=outage_list,
                calibration_seconds=a.calibration_seconds,
                include_nhc=a.include_nhc,
                normalization=a.normalization,
            )
            all_records.extend(recs)

        out_df = pd.DataFrame(all_records)
        cmp_path = "artifacts/data/controlled_model_comparison.csv"
        out_df.to_csv(cmp_path, index=False)
        print("\n" + out_df.to_string(index=False))
        print(f"\nWrote full comparison to {cmp_path}")

        # Also write standard summary for TCN torch for backward-compatibility
        tcn_records = [r for r in all_records if r["model"] == "tcn" and r["runtime"] == "torch"]
        legacy_df = pd.DataFrame([
            dict(
                method=r["method"],
                outage_duration_s=r["outage_duration_s"],
                samples=r["samples"],
                horizontal_rmse_m=r["horizontal_rmse_m"],
                horizontal_mae_m=r["horizontal_mae_m"],
                max_position_error_m=r["max_position_error_m"],
            )
            for r in tcn_records
        ])
        legacy_df.to_csv(a.output, index=False)
        print(f"Wrote standard TCN summary to {a.output}")
    else:
        records = evaluate_single_model(
            backend=a.model_backend,
            runtime=a.model_runtime,
            t=t,
            imu=imu,
            gnss=gnss,
            speed=speed,
            ref=ref,
            v_ref_speed_mps=v_ref_speed_mps,
            v_ref_yaw_radps=v_ref_yaw_radps,
            outages=outage_list,
            calibration_seconds=a.calibration_seconds,
            include_nhc=a.include_nhc,
            checkpoint=a.checkpoint,
            normalization=a.normalization,
        )
        legacy_records = [
            dict(
                method=r["method"],
                outage_duration_s=r["outage_duration_s"],
                samples=r["samples"],
                horizontal_rmse_m=r["horizontal_rmse_m"],
                horizontal_mae_m=r["horizontal_mae_m"],
                max_position_error_m=r["max_position_error_m"],
            )
            for r in records
        ]
        out_df = pd.DataFrame(legacy_records)
        out_df.to_csv(a.output, index=False)
        print(out_df.to_string(index=False))
        print(f"Wrote {a.output}")


if __name__ == "__main__":
    main()
