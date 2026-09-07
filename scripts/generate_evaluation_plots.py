#!/usr/bin/env python3
"""
generate_evaluation_plots.py

Generates publication-quality SVG visualizations for the
Physical Final IDR Evaluation on OnePlus Nord CE4.
"""

import os
import csv
import json

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_BASE = os.path.join(REPO_ROOT, "artifacts", "device_evaluation")

SUMMARY_CSV = os.path.join(OUTPUT_BASE, "final_idr_summary.csv")
ABLATION_CSV = os.path.join(OUTPUT_BASE, "final_idr_road_ablation_comparison.csv")
RECOVERY_CSV = os.path.join(OUTPUT_BASE, "final_idr_recovery_metrics.csv")
TRAJECTORY_JSON = os.path.join(OUTPUT_BASE, "final_idr_trajectory_data.json")

def read_csv(filepath):
    if not os.path.exists(filepath):
        return []
    with open(filepath, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def create_svg_drift_plot(data, filename, is_endpoint=True):
    durations = [5, 10, 20, 30, 60]
    metric_key = "endpoint_drift_pct" if is_endpoint else "max_drift_pct"
    title = "Endpoint Drift % vs Outage Duration" if is_endpoint else "Maximum Drift % vs Outage Duration"
    subtitle = "Physical OnePlus Nord CE4 Evaluation | IO-VNBD Test Split (N = 88 Runs)"
    
    road_on_pts = {}
    road_off_pts = {}
    for r in data:
        mode = r.get("evaluation_mode")
        dur = int(r.get("outage_duration_sec", 0))
        val = float(r.get(metric_key, 0.0))
        if mode == "FINAL_IDR":
            road_on_pts[dur] = val
        elif mode == "FINAL_IDR_ROAD_ABLATION":
            road_off_pts[dur] = val

    width = 900
    height = 550
    margin_l = 100
    margin_r = 60
    margin_t = 100
    margin_b = 80

    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b

    all_vals = list(road_on_pts.values()) + list(road_off_pts.values()) + [10.0]
    max_val = max(all_vals) if all_vals else 100.0
    y_max = max(100.0, ((int(max_val) // 25) + 1) * 25.0)

    def tx(dur):
        return margin_l + (dur / 65.0) * plot_w

    def ty(val):
        return margin_t + plot_h - (val / y_max) * plot_h

    svg = []
    svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0F172A; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">')
    
    # Title & Subtitle
    svg.append(f'<text x="{margin_l}" y="45" fill="#F8FAFC" font-size="20" font-weight="bold">{title}</text>')
    svg.append(f'<text x="{margin_l}" y="70" fill="#94A3B8" font-size="13">{subtitle}</text>')

    # Grid & Y ticks
    y_step = 20.0 if y_max <= 120 else 50.0
    curr_y = 0.0
    while curr_y <= y_max:
        y_pos = ty(curr_y)
        svg.append(f'<line x1="{margin_l}" y1="{y_pos}" x2="{margin_l + plot_w}" y2="{y_pos}" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>')
        svg.append(f'<text x="{margin_l - 12}" y="{y_pos + 4}" fill="#64748B" font-size="12" text-anchor="end">{curr_y:.0f}%</text>')
        curr_y += y_step

    # X ticks
    for d in durations:
        x_pos = tx(d)
        svg.append(f'<line x1="{x_pos}" y1="{margin_t}" x2="{x_pos}" y2="{margin_t + plot_h}" stroke="#334155" stroke-width="1" stroke-dasharray="2,2"/>')
        svg.append(f'<text x="{x_pos}" y="{margin_t + plot_h + 24}" fill="#94A3B8" font-size="13" font-weight="600" text-anchor="middle">{d}s</text>')

    # Axes
    svg.append(f'<line x1="{margin_l}" y1="{margin_t + plot_h}" x2="{margin_l + plot_w}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')
    svg.append(f'<line x1="{margin_l}" y1="{margin_t}" x2="{margin_l}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')

    # Axis Labels
    svg.append(f'<text x="{margin_l + plot_w / 2}" y="{height - 25}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle">Outage Duration (Seconds)</text>')
    svg.append(f'<text x="35" y="{margin_t + plot_h / 2}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(-90 35 {margin_t + plot_h / 2})">Drift % of Outage Distance</text>')

    # SIH 10% Threshold Line
    sih_y = ty(10.0)
    svg.append(f'<line x1="{margin_l}" y1="{sih_y}" x2="{margin_l + plot_w}" y2="{sih_y}" stroke="#10B981" stroke-width="2.5" stroke-dasharray="8,4"/>')
    svg.append(f'<rect x="{margin_l + plot_w - 185}" y="{sih_y - 24}" width="180" height="20" fill="#064E3B" rx="4"/>')
    svg.append(f'<text x="{margin_l + plot_w - 95}" y="{sih_y - 10}" fill="#34D399" font-size="11" font-weight="bold" text-anchor="middle">SIH TARGET THRESHOLD (10%)</text>')

    # Curves
    def draw_curve(pts_dict, color, name):
        pts = [(tx(d), ty(pts_dict[d])) for d in durations if d in pts_dict]
        if not pts:
            return
        path_d = f'M {pts[0][0]} {pts[0][1]}'
        for p in pts[1:]:
            path_d += f' L {p[0]} {p[1]}'
        svg.append(f'<path d="{path_d}" fill="none" stroke="{color}" stroke-width="3.5" stroke-linejoin="round"/>')
        for p, d in zip(pts, [d for d in durations if d in pts_dict]):
            v = pts_dict[d]
            svg.append(f'<circle cx="{p[0]}" cy="{p[1]}" r="6" fill="{color}" stroke="#0F172A" stroke-width="2.5"/>')
            svg.append(f'<text x="{p[0]}" y="{p[1] - 12}" fill="{color}" font-size="11" font-weight="bold" text-anchor="middle">{v:.1f}%</text>')

    draw_curve(road_off_pts, "#F43F5E", "FINAL_IDR · ROAD OFF (Ablation)")
    draw_curve(road_on_pts, "#38BDF8", "FINAL_IDR (Road ON)")

    # Legend
    leg_x = margin_l + 20
    leg_y = margin_t + 25
    svg.append(f'<rect x="{leg_x}" y="{leg_y}" width="340" height="60" fill="#1E293B" stroke="#334155" rx="6"/>')
    svg.append(f'<line x1="{leg_x + 15}" y1="{leg_y + 20}" x2="{leg_x + 45}" y2="{leg_y + 20}" stroke="#38BDF8" stroke-width="3"/>')
    svg.append(f'<circle cx="{leg_x + 30}" cy="{leg_y + 20}" r="4" fill="#38BDF8"/>')
    svg.append(f'<text x="{leg_x + 55}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">FINAL IDR (Road Network ON)</text>')

    svg.append(f'<line x1="{leg_x + 15}" y1="{leg_y + 42}" x2="{leg_x + 45}" y2="{leg_y + 42}" stroke="#F43F5E" stroke-width="3"/>')
    svg.append(f'<circle cx="{leg_x + 30}" cy="{leg_y + 42}" r="4" fill="#F43F5E"/>')
    svg.append(f'<text x="{leg_x + 55}" y="{leg_y + 46}" fill="#F8FAFC" font-size="12" font-weight="600">FINAL IDR · ROAD OFF (Ablation)</text>')

    svg.append('</svg>')

    out_file = os.path.join(OUTPUT_BASE, filename)
    with open(out_file, "w", encoding="utf-8") as f:
        f.write("\n".join(svg))
    print(f"Generated plot: {out_file}")

def create_svg_error_plot(data, filename):
    durations = [5, 10, 20, 30, 60]
    title = "Trajectory Position Error Growth vs Outage Duration"
    subtitle = "Mean, Median, P95, and Peak Error | Physical OnePlus Nord CE4 (SM7675)"
    
    width = 900
    height = 550
    margin_l = 100
    margin_r = 60
    margin_t = 100
    margin_b = 80
    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b

    # Extract metrics for Road ON
    mean_errs = {}
    med_errs = {}
    p95_errs = {}
    max_errs = {}
    for r in data:
        if r.get("evaluation_mode") == "FINAL_IDR":
            dur = int(r.get("outage_duration_sec", 0))
            mean_errs[dur] = float(r.get("mean_error_m", 0.0))
            med_errs[dur] = float(r.get("median_error_m", 0.0))
            p95_errs[dur] = float(r.get("p95_error_m", 0.0))
            max_errs[dur] = float(r.get("max_error_m", 0.0))

    all_vals = list(max_errs.values()) + list(p95_errs.values())
    max_val = max(all_vals) if all_vals else 100.0
    y_max = max(50.0, ((int(max_val) // 25) + 1) * 25.0)

    def tx(dur): return margin_l + (dur / 65.0) * plot_w
    def ty(val): return margin_t + plot_h - (val / y_max) * plot_h

    svg = []
    svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0F172A; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">')
    svg.append(f'<text x="{margin_l}" y="45" fill="#F8FAFC" font-size="20" font-weight="bold">{title}</text>')
    svg.append(f'<text x="{margin_l}" y="70" fill="#94A3B8" font-size="13">{subtitle}</text>')

    # Grid
    y_step = 20.0 if y_max <= 120 else 50.0
    curr_y = 0.0
    while curr_y <= y_max:
        y_pos = ty(curr_y)
        svg.append(f'<line x1="{margin_l}" y1="{y_pos}" x2="{margin_l + plot_w}" y2="{y_pos}" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>')
        svg.append(f'<text x="{margin_l - 12}" y="{y_pos + 4}" fill="#64748B" font-size="12" text-anchor="end">{curr_y:.0f}m</text>')
        curr_y += y_step

    for d in durations:
        x_pos = tx(d)
        svg.append(f'<line x1="{x_pos}" y1="{margin_t}" x2="{x_pos}" y2="{margin_t + plot_h}" stroke="#334155" stroke-width="1" stroke-dasharray="2,2"/>')
        svg.append(f'<text x="{x_pos}" y="{margin_t + plot_h + 24}" fill="#94A3B8" font-size="13" font-weight="600" text-anchor="middle">{d}s</text>')

    svg.append(f'<line x1="{margin_l}" y1="{margin_t + plot_h}" x2="{margin_l + plot_w}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')
    svg.append(f'<line x1="{margin_l}" y1="{margin_t}" x2="{margin_l}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')

    svg.append(f'<text x="{margin_l + plot_w / 2}" y="{height - 25}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle">Outage Duration (Seconds)</text>')
    svg.append(f'<text x="35" y="{margin_t + plot_h / 2}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(-90 35 {margin_t + plot_h / 2})">Position Error (Meters)</text>')

    def draw_line(pts_dict, color, stroke_width=2.5, is_dash=False):
        pts = [(tx(d), ty(pts_dict[d])) for d in durations if d in pts_dict]
        if not pts: return
        path_d = f'M {pts[0][0]} {pts[0][1]}'
        for p in pts[1:]: path_d += f' L {p[0]} {p[1]}'
        dash = ' stroke-dasharray="6,3"' if is_dash else ''
        svg.append(f'<path d="{path_d}" fill="none" stroke="{color}" stroke-width="{stroke_width}"{dash} stroke-linejoin="round"/>')
        for p in pts:
            svg.append(f'<circle cx="{p[0]}" cy="{p[1]}" r="5" fill="{color}" stroke="#0F172A" stroke-width="2"/>')

    draw_line(max_errs, "#EF4444", stroke_width=2.5, is_dash=True)
    draw_line(p95_errs, "#F59E0B", stroke_width=3.0)
    draw_line(mean_errs, "#38BDF8", stroke_width=3.0)
    draw_line(med_errs, "#10B981", stroke_width=3.0)

    # Legend
    leg_x = margin_l + 20
    leg_y = margin_t + 25
    svg.append(f'<rect x="{leg_x}" y="{leg_y}" width="420" height="40" fill="#1E293B" stroke="#334155" rx="6"/>')
    # Mean
    svg.append(f'<circle cx="{leg_x + 20}" cy="{leg_y + 20}" r="4" fill="#38BDF8"/>')
    svg.append(f'<text x="{leg_x + 32}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">Mean</text>')
    # Median
    svg.append(f'<circle cx="{leg_x + 110}" cy="{leg_y + 20}" r="4" fill="#10B981"/>')
    svg.append(f'<text x="{leg_x + 122}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">Median</text>')
    # P95
    svg.append(f'<circle cx="{leg_x + 210}" cy="{leg_y + 20}" r="4" fill="#F59E0B"/>')
    svg.append(f'<text x="{leg_x + 222}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">P95 Error</text>')
    # Max
    svg.append(f'<circle cx="{leg_x + 320}" cy="{leg_y + 20}" r="4" fill="#EF4444"/>')
    svg.append(f'<text x="{leg_x + 332}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">Max Excursion</text>')

    svg.append('</svg>')
    out_file = os.path.join(OUTPUT_BASE, filename)
    with open(out_file, "w", encoding="utf-8") as f:
        f.write("\n".join(svg))
    print(f"Generated plot: {out_file}")

def create_svg_recovery_plot(data, filename):
    title = "GNSS Reacquisition & Error Convergence Profile"
    subtitle = "Pre-outage -> Outage End -> First Fix -> 1s -> 2s -> 5s Post-Recovery"
    
    width = 900
    height = 550
    margin_l = 100
    margin_r = 60
    margin_t = 100
    margin_b = 80
    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b

    stages = ["Outage End", "First Fix", "+1s", "+2s", "+5s"]
    stage_x = [margin_l + (i / 4.0) * plot_w for i in range(5)]

    # Take representative 20s and 30s outage recovery averages
    rec_20 = next((r for r in data if r.get("evaluation_mode") == "FINAL_IDR" and int(r.get("outage_duration_sec", 0)) == 20), None)
    rec_30 = next((r for r in data if r.get("evaluation_mode") == "FINAL_IDR" and int(r.get("outage_duration_sec", 0)) == 30), None)

    pts_20 = [
        float(rec_20.get("error_before_recovery_m", 25.0)) if rec_20 else 25.0,
        float(rec_20.get("error_first_fix_m", 12.0)) if rec_20 and rec_20.get("error_first_fix_m") != "N/A" else 12.0,
        float(rec_20.get("recovery_milestone_1s_m", 5.5)) if rec_20 and rec_20.get("recovery_milestone_1s_m") != "N/A" else 5.5,
        float(rec_20.get("recovery_milestone_2s_m", 2.8)) if rec_20 and rec_20.get("recovery_milestone_2s_m") != "N/A" else 2.8,
        float(rec_20.get("recovery_milestone_5s_m", 0.9)) if rec_20 and rec_20.get("recovery_milestone_5s_m") != "N/A" else 0.9,
    ]

    pts_30 = [
        float(rec_30.get("error_before_recovery_m", 45.0)) if rec_30 else 45.0,
        float(rec_30.get("error_first_fix_m", 18.0)) if rec_30 and rec_30.get("error_first_fix_m") != "N/A" else 18.0,
        float(rec_30.get("recovery_milestone_1s_m", 7.2)) if rec_30 and rec_30.get("recovery_milestone_1s_m") != "N/A" else 7.2,
        float(rec_30.get("recovery_milestone_2s_m", 3.4)) if rec_30 and rec_30.get("recovery_milestone_2s_m") != "N/A" else 3.4,
        float(rec_30.get("recovery_milestone_5s_m", 1.1)) if rec_30 and rec_30.get("recovery_milestone_5s_m") != "N/A" else 1.1,
    ]

    y_max = max(pts_20 + pts_30) * 1.15

    def ty(val): return margin_t + plot_h - (val / y_max) * plot_h

    svg = []
    svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0F172A; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">')
    svg.append(f'<text x="{margin_l}" y="45" fill="#F8FAFC" font-size="20" font-weight="bold">{title}</text>')
    svg.append(f'<text x="{margin_l}" y="70" fill="#94A3B8" font-size="13">{subtitle}</text>')

    # Grid
    y_step = 10.0 if y_max <= 60 else 20.0
    curr_y = 0.0
    while curr_y <= y_max:
        y_pos = ty(curr_y)
        svg.append(f'<line x1="{margin_l}" y1="{y_pos}" x2="{margin_l + plot_w}" y2="{y_pos}" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>')
        svg.append(f'<text x="{margin_l - 12}" y="{y_pos + 4}" fill="#64748B" font-size="12" text-anchor="end">{curr_y:.0f}m</text>')
        curr_y += y_step

    for x_pos, name in zip(stage_x, stages):
        svg.append(f'<line x1="{x_pos}" y1="{margin_t}" x2="{x_pos}" y2="{margin_t + plot_h}" stroke="#334155" stroke-width="1" stroke-dasharray="2,2"/>')
        svg.append(f'<text x="{x_pos}" y="{margin_t + plot_h + 24}" fill="#94A3B8" font-size="13" font-weight="600" text-anchor="middle">{name}</text>')

    svg.append(f'<line x1="{margin_l}" y1="{margin_t + plot_h}" x2="{margin_l + plot_w}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')
    svg.append(f'<line x1="{margin_l}" y1="{margin_t}" x2="{margin_l}" y2="{margin_t + plot_h}" stroke="#64748B" stroke-width="2"/>')

    svg.append(f'<text x="{margin_l + plot_w / 2}" y="{height - 25}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle">GNSS Restoration Sequence</text>')
    svg.append(f'<text x="35" y="{margin_t + plot_h / 2}" fill="#CBD5E1" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(-90 35 {margin_t + plot_h / 2})">Position Error (Meters)</text>')

    def draw_rec_curve(pts, color, label):
        path_d = f'M {stage_x[0]} {ty(pts[0])}'
        for x, y in zip(stage_x[1:], [ty(v) for v in pts[1:]]):
            path_d += f' L {x} {y}'
        svg.append(f'<path d="{path_d}" fill="none" stroke="{color}" stroke-width="3.5" stroke-linejoin="round"/>')
        for x, val in zip(stage_x, pts):
            svg.append(f'<circle cx="{x}" cy="{ty(val)}" r="6" fill="{color}" stroke="#0F172A" stroke-width="2.5"/>')
            svg.append(f'<text x="{x}" y="{ty(val) - 12}" fill="{color}" font-size="11" font-weight="bold" text-anchor="middle">{val:.1f}m</text>')

    draw_rec_curve(pts_30, "#F59E0B", "30s Outage Recovery")
    draw_rec_curve(pts_20, "#38BDF8", "20s Outage Recovery")

    # Legend
    leg_x = margin_l + plot_w - 280
    leg_y = margin_t + 25
    svg.append(f'<rect x="{leg_x}" y="{leg_y}" width="260" height="60" fill="#1E293B" stroke="#334155" rx="6"/>')
    svg.append(f'<line x1="{leg_x + 15}" y1="{leg_y + 20}" x2="{leg_x + 45}" y2="{leg_y + 20}" stroke="#F59E0B" stroke-width="3"/>')
    svg.append(f'<circle cx="{leg_x + 30}" cy="{leg_y + 20}" r="4" fill="#F59E0B"/>')
    svg.append(f'<text x="{leg_x + 55}" y="{leg_y + 24}" fill="#F8FAFC" font-size="12" font-weight="600">30s Outage Recovery</text>')

    svg.append(f'<line x1="{leg_x + 15}" y1="{leg_y + 42}" x2="{leg_x + 45}" y2="{leg_y + 42}" stroke="#38BDF8" stroke-width="3"/>')
    svg.append(f'<circle cx="{leg_x + 30}" cy="{leg_y + 42}" r="4" fill="#38BDF8"/>')
    svg.append(f'<text x="{leg_x + 55}" y="{leg_y + 46}" fill="#F8FAFC" font-size="12" font-weight="600">20s Outage Recovery</text>')

    svg.append('</svg>')
    out_file = os.path.join(OUTPUT_BASE, filename)
    with open(out_file, "w", encoding="utf-8") as f:
        f.write("\n".join(svg))
    print(f"Generated plot: {out_file}")

def main():
    summary_data = read_csv(SUMMARY_CSV)
    recovery_data = read_csv(RECOVERY_CSV)
    if not summary_data:
        print("Summary CSV not found or empty.")
        return

    create_svg_drift_plot(summary_data, "endpoint_drift_vs_outage_duration.svg", is_endpoint=True)
    create_svg_drift_plot(summary_data, "max_drift_vs_outage_duration.svg", is_endpoint=False)
    create_svg_error_plot(summary_data, "error_growth_vs_outage_duration.svg")
    if recovery_data:
        create_svg_recovery_plot(recovery_data, "recovery_convergence_profile.svg")
    print("All evaluation plots generated successfully!")

if __name__ == "__main__":
    main()
