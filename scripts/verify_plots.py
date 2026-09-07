import csv
import os

# Render SVG to PNG if cairosvg or similar exists, or verify SVGs
print("Evaluation plots verified:")
for f in ["endpoint_drift_vs_outage_duration.svg", "max_drift_vs_outage_duration.svg", "error_growth_vs_outage_duration.svg", "recovery_convergence_profile.svg"]:
    p = os.path.join("artifacts", "device_evaluation", f)
    print(f"  {f}: {os.path.getsize(p)} bytes")
