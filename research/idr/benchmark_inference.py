"""
Comprehensive CPU Inference & Edge Readiness Benchmark for BetterMaps IDR.

Evaluates:
- Parameter counts & model file sizes
- Single-window inference latency (mean, median, p95, p99 across 1000 iterations)
- PyTorch vs ONNX Runtime performance
- Computational load at 10 Hz target sampling frequency
- Peak memory delta
"""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.abspath("."))
import time
import tracemalloc
import numpy as np
import torch

from research.idr.navigation.motion_adapter import (
    MotionInputWindow,
    create_motion_adapter,
)


def benchmark_adapter(adapter, num_iterations: int = 1000, warmup: int = 100):
    dummy_meas = np.random.randn(20, 6).astype(np.float32)
    win = MotionInputWindow(dummy_meas, "vehicle", 0.0, 2.0)

    # Warmup
    for _ in range(warmup):
        _ = adapter.predict(win)

    # Timed runs
    latencies_ms = []
    tracemalloc.start()
    t_start = time.perf_counter()

    for _ in range(num_iterations):
        t0 = time.perf_counter()
        _ = adapter.predict(win)
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    total_time_s = time.perf_counter() - t_start
    current, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    latencies_ms = np.array(latencies_ms)
    mean_lat = float(np.mean(latencies_ms))
    med_lat = float(np.median(latencies_ms))
    p95_lat = float(np.percentile(latencies_ms, 95))
    p99_lat = float(np.percentile(latencies_ms, 99))
    load_10hz_pct = (mean_lat / 100.0) * 100.0  # 100ms budget per 10Hz step

    return {
        "mean_ms": mean_lat,
        "median_ms": med_lat,
        "p95_ms": p95_lat,
        "p99_ms": p99_lat,
        "load_10hz_pct": load_10hz_pct,
        "peak_mem_kb": peak_mem / 1024.0,
    }


def main():
    print("=" * 95)
    print("BETTERMAPS IDR ? CPU INFERENCE & EDGE DEPLOYMENT BENCHMARK (1000 ITERATIONS)")
    print("=" * 95)

    configs = [
        ("Kinematic_Baseline", "kinematic", "torch", 0, "-", "-"),
        ("B1_MLP (PyTorch)", "mlp", "torch", 9890, "artifacts/runs/B1_MLP/best_model.pt", "-"),
        ("B1_MLP (ONNX)", "mlp", "onnx", 9890, "-", "artifacts/onnx/B1_MLP.onnx"),
        ("B2_TCN (PyTorch)", "tcn", "torch", 5938, "artifacts/runs/B2_TCN/best_model.pt", "-"),
        ("B2_TCN (ONNX)", "tcn", "onnx", 5938, "-", "artifacts/onnx/B2_TCN.onnx"),
        ("B3_GRU (PyTorch)", "gru", "torch", 3906, "artifacts/runs/B3_GRU/best_model.pt", "-"),
        ("B3_GRU (ONNX)", "gru", "onnx", 3906, "-", "artifacts/onnx/B3_GRU.onnx"),
        ("Hetero_TCN (PyTorch)", "heteroscedastic", "torch", 5972, "artifacts/runs/B2_TCN/best_model.pt", "-"),
        ("Hetero_TCN (ONNX)", "heteroscedastic", "onnx", 5972, "-", "artifacts/onnx/Heteroscedastic_TCN.onnx"),
    ]

    rows = []
    for label, backend, runtime, params, ckpt_file, onnx_file in configs:
        adapter = create_motion_adapter(backend=backend, runtime=runtime)
        bench = benchmark_adapter(adapter, num_iterations=1000, warmup=100)

        file_size_kb = 0.0
        if ckpt_file != "-" and os.path.exists(ckpt_file):
            file_size_kb = os.path.getsize(ckpt_file) / 1024.0
        elif onnx_file != "-" and os.path.exists(onnx_file):
            file_size_kb = os.path.getsize(onnx_file) / 1024.0

        rows.append({
            "name": label,
            "runtime": runtime.upper(),
            "params": params,
            "size_kb": file_size_kb,
            "mean_ms": bench["mean_ms"],
            "median_ms": bench["median_ms"],
            "p95_ms": bench["p95_ms"],
            "load_pct": bench["load_10hz_pct"],
            "mem_kb": bench["peak_mem_kb"],
        })

    print(f"{'Model Configuration':<24} | {'Runtime':<7} | {'Params':<7} | {'Size':<9} | {'Mean (ms)':<9} | {'Median':<8} | {'p95':<8} | {'10Hz Load':<9} | {'Peak RAM'}")
    print("-" * 115)
    for r in rows:
        size_str = f"{r['size_kb']:.1f} KB" if r['size_kb'] > 0 else "-"
        print(
            f"{r['name']:<24} | {r['runtime']:<7} | {r['params']:<7} | {size_str:<9} | "
            f"{r['mean_ms']:<9.3f} | {r['median_ms']:<8.3f} | {r['p95_ms']:<8.3f} | {r['load_pct']:<8.2f}% | {r['mem_kb']:<6.1f} KB"
        )
    print("=" * 115)


if __name__ == "__main__":
    main()
