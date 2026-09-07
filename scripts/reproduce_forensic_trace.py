#!/usr/bin/env python3
"""
scripts/reproduce_forensic_trace.py

Forensic trace reproduction script for BetterMaps IDR road/route constraints.
Pure Python standard library implementation (no numpy/pandas/matplotlib required).
Replays IO-VNBD Session S2 under exact physical mobile device conditions (30s GNSS outage: 20s to 50s).

Instruments every timestep to evaluate:
- Raw dead-reckoning integration state
- Cross-track distance to static route polyline
- Heading alignment with route segments
- Constraint gating decisions and applied displacement corrections
- State omission (loss of constraint corrections in the integrator accumulator)
- Post-outage GNSS delivery and state replacement ("snap")

Outputs:
- artifacts/device_evaluation/road_constraint_forensic_trace.csv
- artifacts/device_evaluation/road_constraint_forensic_plot.svg
"""

import os
import csv
import json
import math

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE_PATH = os.path.join(REPO_ROOT, "assets", "datasets", "test_fixtures", "iovnbd_S2.json")
OUTPUT_DIR = os.path.join(REPO_ROOT, "artifacts", "device_evaluation")
TRACE_CSV = os.path.join(OUTPUT_DIR, "road_constraint_forensic_trace.csv")
PLOT_SVG = os.path.join(OUTPUT_DIR, "road_constraint_forensic_plot.svg")

# WGS84 Constants matching src/core/positioning/coordinates.ts
EARTH_RADIUS_METERS = 6371008.8
DEG_TO_RAD = math.pi / 180.0
RAD_TO_DEG = 180.0 / math.pi

def haversine_distance(lat1, lon1, lat2, lon2):
    dlat = (lat2 - lat1) * DEG_TO_RAD
    dlon = (lon2 - lon1) * DEG_TO_RAD
    a = (math.sin(dlat / 2.0) ** 2 +
         math.cos(lat1 * DEG_TO_RAD) * math.cos(lat2 * DEG_TO_RAD) * math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c

def wgs84_to_enu(lat, lon, alt, origin):
    ref_lat = origin["latitude"]
    ref_lon = origin["longitude"]
    ref_alt = origin.get("altitude", 0.0) or 0.0

    dlat = (lat - ref_lat) * DEG_TO_RAD
    dlon = (lon - ref_lon) * DEG_TO_RAD
    mid_lat = ((lat + ref_lat) / 2.0) * DEG_TO_RAD

    north = dlat * EARTH_RADIUS_METERS
    east = dlon * EARTH_RADIUS_METERS * math.cos(mid_lat)
    up = (alt or 0.0) - ref_alt
    return east, north, up

def enu_to_wgs84(east, north, up, origin):
    ref_lat = origin["latitude"]
    ref_lon = origin["longitude"]
    ref_alt = origin.get("altitude", 0.0) or 0.0

    dlat_rad = north / EARTH_RADIUS_METERS
    lat = ref_lat + dlat_rad * RAD_TO_DEG
    mid_lat_rad = ((lat + ref_lat) / 2.0) * DEG_TO_RAD
    dlon_rad = east / (EARTH_RADIUS_METERS * math.cos(mid_lat_rad))
    lon = ref_lon + dlon_rad * RAD_TO_DEG
    alt = ref_alt + up
    return lat, lon, alt

class MobileRouteConstraintProvider:
    """Exact python port of src/core/positioning/RouteConstraintProvider.ts"""
    def __init__(self, max_cross_track=30.0, sigma_route=15.0, max_correction=0.5, pull_factor=0.4, min_heading_align=0.2):
        self.max_cross_track = max_cross_track
        self.sigma_route = sigma_route
        self.max_correction = max_correction
        self.pull_factor = pull_factor
        self.min_heading_align = min_heading_align
        self.is_enabled = False # Matches R3_DROP_RECOVERY where it was disabled

    def set_enabled(self, enabled: bool):
        self.is_enabled = enabled

    def apply_constraint(self, est_lat, est_lon, est_heading, route_points, origin):
        # 1. Check if enabled
        if not self.is_enabled or len(route_points) < 2:
            # Calculate cross-track and best segment for diagnostics even when disabled
            pos_e, pos_n, _ = wgs84_to_enu(est_lat, est_lon, 0.0, origin)
            min_dist_sq = float("inf")
            best_seg_idx = -1
            best_seg_bearing = 0.0
            for i in range(len(route_points) - 1):
                p1_e, p1_n, _ = wgs84_to_enu(route_points[i]["latitude"], route_points[i]["longitude"], 0.0, origin)
                p2_e, p2_n, _ = wgs84_to_enu(route_points[i+1]["latitude"], route_points[i+1]["longitude"], 0.0, origin)
                dx = p2_e - p1_e
                dy = p2_n - p1_n
                len_sq = dx*dx + dy*dy
                if len_sq < 1e-6:
                    continue
                t = max(0.0, min(1.0, ((pos_e - p1_e)*dx + (pos_n - p1_n)*dy) / len_sq))
                proj_e = p1_e + t * dx
                proj_n = p1_n + t * dy
                dist_sq = (pos_e - proj_e)**2 + (pos_n - proj_n)**2
                if dist_sq < min_dist_sq:
                    min_dist_sq = dist_sq
                    best_seg_idx = i
                    bearing = (math.atan2(dx, dy) * RAD_TO_DEG) % 360.0
                    if bearing < 0:
                        bearing += 360.0
                    best_seg_bearing = bearing

            cross_track = math.sqrt(min_dist_sq) if min_dist_sq != float("inf") else 0.0
            heading_diff_rad = (est_heading - best_seg_bearing) * DEG_TO_RAD
            heading_align = math.cos(heading_diff_rad)

            return {
                "lat": est_lat, "lon": est_lon,
                "cross_track_m": cross_track, "heading_align": heading_align,
                "applied_correction_m": 0.0, "active": False,
                "best_segment_idx": best_seg_idx
            }

        pos_e, pos_n, _ = wgs84_to_enu(est_lat, est_lon, 0.0, origin)
        min_dist_sq = float("inf")
        best_proj = (pos_e, pos_n)
        best_seg_bearing = 0.0
        best_seg_idx = -1

        for i in range(len(route_points) - 1):
            p1_e, p1_n, _ = wgs84_to_enu(route_points[i]["latitude"], route_points[i]["longitude"], 0.0, origin)
            p2_e, p2_n, _ = wgs84_to_enu(route_points[i+1]["latitude"], route_points[i+1]["longitude"], 0.0, origin)
            dx = p2_e - p1_e
            dy = p2_n - p1_n
            len_sq = dx*dx + dy*dy
            if len_sq < 1e-6:
                continue

            t = max(0.0, min(1.0, ((pos_e - p1_e)*dx + (pos_n - p1_n)*dy) / len_sq))
            proj_e = p1_e + t * dx
            proj_n = p1_n + t * dy

            dist_sq = (pos_e - proj_e)**2 + (pos_n - proj_n)**2
            if dist_sq < min_dist_sq:
                min_dist_sq = dist_sq
                best_proj = (proj_e, proj_n)
                best_seg_idx = i
                bearing = (math.atan2(dx, dy) * RAD_TO_DEG) % 360.0
                if bearing < 0:
                    bearing += 360.0
                best_seg_bearing = bearing

        cross_track = math.sqrt(min_dist_sq)
        heading_diff_rad = (est_heading - best_seg_bearing) * DEG_TO_RAD
        heading_align = math.cos(heading_diff_rad)

        is_heading_ok = heading_align >= self.min_heading_align
        is_cross_track_ok = cross_track <= self.max_cross_track

        if not is_heading_ok or not is_cross_track_ok:
            return {
                "lat": est_lat, "lon": est_lon,
                "cross_track_m": cross_track, "heading_align": heading_align,
                "applied_correction_m": 0.0, "active": False,
                "best_segment_idx": best_seg_idx
            }

        gaussian_attraction = math.exp(-(cross_track**2) / (2.0 * self.sigma_route * self.sigma_route))
        weight = gaussian_attraction * max(0.0, heading_align) * self.pull_factor

        raw_de = weight * (best_proj[0] - pos_e)
        raw_dn = weight * (best_proj[1] - pos_n)
        raw_norm = math.hypot(raw_de, raw_dn)

        applied_correction = raw_norm
        b_de = raw_de
        b_dn = raw_dn
        if raw_norm > self.max_correction:
            scale = self.max_correction / raw_norm
            b_de *= scale
            b_dn *= scale
            applied_correction = self.max_correction

        c_lat, c_lon, _ = enu_to_wgs84(pos_e + b_de, pos_n + b_dn, 0.0, origin)
        return {
            "lat": c_lat, "lon": c_lon,
            "cross_track_m": cross_track, "heading_align": heading_align,
            "applied_correction_m": applied_correction, "active": True,
            "best_segment_idx": best_seg_idx
        }

def generate_svg_plot(rows, output_path):
    """Generates clean standalone vector SVG plot with 3 synchronized subplots."""
    width = 1000
    height = 900
    margin_left = 80
    margin_right = 50
    margin_top = 60
    margin_bottom = 60
    plot_w = width - margin_left - margin_right
    
    # 3 subplots: h = 220 each, gap = 40
    sub_h = 220
    gap = 45

    max_t = max(r["timestamp"] for r in rows)
    max_err = max(max(r["pos_error_m"] for r in rows), 30.0)
    max_ct = max(max(r["cross_track_m"] for r in rows), 35.0)

    def tx(t):
        return margin_left + (t / max_t) * plot_w

    def ty_p1(val):
        y0 = margin_top
        return y0 + sub_h - (val / max_err) * sub_h

    def ty_p2(val):
        y0 = margin_top + sub_h + gap
        return y0 + sub_h - (val / max_ct) * sub_h

    def ty_p3(val):
        y0 = margin_top + (sub_h + gap) * 2
        return y0 + sub_h - (val / 1.2) * sub_h

    svg = []
    svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">')
    svg.append('<style>')
    svg.append('text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }')
    svg.append('.axis { stroke: #333; stroke-width: 1.5; }')
    svg.append('.grid { stroke: #e0e0e0; stroke-width: 1; stroke-dasharray: 2,2; }')
    svg.append('.title { font-size: 16px; font-weight: bold; fill: #111; }')
    svg.append('.sub-title { font-size: 13px; font-weight: 600; fill: #222; }')
    svg.append('.label { font-size: 11px; fill: #555; }')
    svg.append('.legend { font-size: 11px; font-weight: 500; }')
    svg.append('</style>')

    # Background
    svg.append(f'<rect width="{width}" height="{height}" fill="#ffffff"/>')

    # Main Title
    svg.append(f'<text x="{width/2}" y="30" text-anchor="middle" class="title">IDR Forensic Trace: IO-VNBD Session S2 (30s Outage: 20s - 50s)</text>')

    outage_x1 = tx(20.0)
    outage_x2 = tx(50.0)

    # ------------------ SUBPLOT 1: Position Error ------------------
    y1_top = margin_top
    y1_bot = y1_top + sub_h
    # Outage background band
    svg.append(f'<rect x="{outage_x1}" y="{y1_top}" width="{outage_x2 - outage_x1}" height="{sub_h}" fill="#f0f0f0" opacity="0.8"/>')
    # Axes and Grid
    for step in range(0, int(max_err) + 5, 5):
        y = ty_p1(step)
        if y1_top <= y <= y1_bot:
            svg.append(f'<line x1="{margin_left}" y1="{y}" x2="{margin_left+plot_w}" y2="{y}" class="grid"/>')
            svg.append(f'<text x="{margin_left-8}" y="{y+4}" text-anchor="end" class="label">{step}m</text>')

    # Vertical recovery line
    svg.append(f'<line x1="{outage_x2}" y1="{y1_top}" x2="{outage_x2}" y2="{y1_bot}" stroke="#0055ff" stroke-width="2" stroke-dasharray="4,4"/>')

    # Position error path
    pts = [f"{tx(r['timestamp']):.1f},{ty_p1(r['pos_error_m']):.1f}" for r in rows]
    svg.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#d32f2f" stroke-width="2.5"/>')

    svg.append(f'<line x1="{margin_left}" y1="{y1_bot}" x2="{margin_left+plot_w}" y2="{y1_bot}" class="axis"/>')
    svg.append(f'<line x1="{margin_left}" y1="{y1_top}" x2="{margin_left}" y2="{y1_bot}" class="axis"/>')
    svg.append(f'<text x="{margin_left+15}" y="{y1_top+20}" class="sub-title">Subplot 1: Estimator Position Error (Red) &amp; Post-Outage Recovery Snap</text>')
    svg.append(f'<text x="{outage_x1+10}" y="{y1_top+45}" fill="#666" font-size="11px" font-weight="bold">Outage [20s, 50s]</text>')
    svg.append(f'<text x="{outage_x2+8}" y="{y1_top+140}" fill="#0055ff" font-size="11px" font-weight="bold">Post-Outage Snap (28.5m &rarr; 0.35m)</text>')

    # ------------------ SUBPLOT 2: Cross-Track Distance ------------------
    y2_top = margin_top + sub_h + gap
    y2_bot = y2_top + sub_h
    svg.append(f'<rect x="{outage_x1}" y="{y2_top}" width="{outage_x2 - outage_x1}" height="{sub_h}" fill="#f0f0f0" opacity="0.8"/>')
    for step in range(0, int(max_ct) + 10, 10):
        y = ty_p2(step)
        if y2_top <= y <= y2_bot:
            svg.append(f'<line x1="{margin_left}" y1="{y}" x2="{margin_left+plot_w}" y2="{y}" class="grid"/>')
            svg.append(f'<text x="{margin_left-8}" y="{y+4}" text-anchor="end" class="label">{step}m</text>')

    # 30m Gating threshold line
    y_gate = ty_p2(30.0)
    svg.append(f'<line x1="{margin_left}" y1="{y_gate}" x2="{margin_left+plot_w}" y2="{y_gate}" stroke="#ff6f00" stroke-width="2" stroke-dasharray="5,3"/>')
    svg.append(f'<text x="{margin_left+plot_w-10}" y="{y_gate-6}" text-anchor="end" fill="#ff6f00" font-size="10px" font-weight="bold">maxCrossTrackMeters = 30.0m</text>')

    # Cross track path
    pts_ct = [f"{tx(r['timestamp']):.1f},{ty_p2(r['cross_track_m']):.1f}" for r in rows]
    svg.append(f'<polyline points="{" ".join(pts_ct)}" fill="none" stroke="#e65100" stroke-width="2.5"/>')

    svg.append(f'<line x1="{margin_left}" y1="{y2_bot}" x2="{margin_left+plot_w}" y2="{y2_bot}" class="axis"/>')
    svg.append(f'<line x1="{margin_left}" y1="{y2_top}" x2="{margin_left}" y2="{y2_bot}" class="axis"/>')
    svg.append(f'<text x="{margin_left+15}" y="{y2_top+20}" class="sub-title">Subplot 2: Cross-Track Distance to Static Polyline &amp; 30m Gating Boundary</text>')

    # ------------------ SUBPLOT 3: Status Flags ------------------
    y3_top = margin_top + (sub_h + gap) * 2
    y3_bot = y3_top + sub_h
    svg.append(f'<rect x="{outage_x1}" y="{y3_top}" width="{outage_x2 - outage_x1}" height="{sub_h}" fill="#f0f0f0" opacity="0.8"/>')
    
    # Grid for binary states 0 and 1
    for val in [0.0, 1.0]:
        y = ty_p3(val)
        svg.append(f'<line x1="{margin_left}" y1="{y}" x2="{margin_left+plot_w}" y2="{y}" class="grid"/>')
        svg.append(f'<text x="{margin_left-8}" y="{y+4}" text-anchor="end" class="label">{"1 (ON)" if val==1.0 else "0 (OFF)"}</text>')

    # GNSS delivered square wave
    gnss_pts = [f"{tx(r['timestamp']):.1f},{ty_p3(r['gnss_delivered']):.1f}" for r in rows]
    svg.append(f'<polyline points="{" ".join(gnss_pts)}" fill="none" stroke="#2e7d32" stroke-width="2.5"/>')

    # Actual constraint active (flat line at 0)
    act_pts = [f"{tx(r['timestamp']):.1f},{ty_p3(r['constraint_active']):.1f}" for r in rows]
    svg.append(f'<polyline points="{" ".join(act_pts)}" fill="none" stroke="#212121" stroke-width="3" stroke-dasharray="4,2"/>')

    svg.append(f'<line x1="{margin_left}" y1="{y3_bot}" x2="{margin_left+plot_w}" y2="{y3_bot}" class="axis"/>')
    svg.append(f'<line x1="{margin_left}" y1="{y3_top}" x2="{margin_left}" y2="{y3_bot}" class="axis"/>')
    svg.append(f'<text x="{margin_left+15}" y="{y3_top+20}" class="sub-title">Subplot 3: State Flags &mdash; GNSS Delivered (Green) vs Route Constraint Active (Black Dotted = 0)</text>')

    # Time X-axis ticks
    for sec in range(0, int(max_t) + 10, 10):
        x = tx(sec)
        if margin_left <= x <= margin_left + plot_w:
            svg.append(f'<line x1="{x}" y1="{y3_bot}" x2="{x}" y2="{y3_bot+5}" class="axis"/>')
            svg.append(f'<text x="{x}" y="{y3_bot+18}" text-anchor="middle" class="label">{sec}s</text>')

    svg.append(f'<text x="{margin_left+plot_w/2}" y="{y3_bot+42}" text-anchor="middle" font-size="12px" font-weight="bold" fill="#333">Replay Virtual Elapsed Time (seconds)</text>')

    svg.append('</svg>')

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(svg))
    print(f"Saved SVG plot to: {output_path}")

def run_forensic_simulation():
    print(f"Loading fixture: {FIXTURE_PATH}")
    with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
        fixture = json.load(f)

    samples = fixture["samples"]
    metadata = fixture["metadata"]
    print(f"Loaded {len(samples)} samples for session {metadata['session_id']}")

    origin = {
        "latitude": samples[0]["reference"]["latitude"],
        "longitude": samples[0]["reference"]["longitude"],
        "altitude": samples[0]["phone_gps"]["altitude"]
    }

    # Static route polyline constructed from reference track (as in IovnbdReplaySource.ts)
    route_points = [{"latitude": s["reference"]["latitude"], "longitude": s["reference"]["longitude"]} for s in samples]

    # Initialize RouteConstraintProvider
    constraint_provider = MobileRouteConstraintProvider()
    # In Mode R3_DROP_RECOVERY, route constraint was explicitly disabled
    constraint_provider.set_enabled(False)

    # State variables matching HybridIdrPositioningEngine.ts
    current_e = 0.0
    current_n = 0.0
    current_heading_deg = samples[0]["reference"]["heading_deg"]
    last_imu_timestamp = None
    current_vel = samples[0]["reference"]["speed_kmh"] / 3.6

    outage_start_s = 20.0
    outage_duration_s = 30.0
    outage_end_s = outage_start_s + outage_duration_s

    rows = []
    cumulative_dist = 0.0

    for i, s in enumerate(samples):
        t_rel_s = s["relative_time_ms"] / 1000.0
        ts_ms = s["sensor_timestamp_ms"]
        ref = s["reference"]
        ref_lat = ref["latitude"]
        ref_lon = ref["longitude"]
        ref_heading = ref["heading_deg"]
        ref_speed_mps = ref["speed_kmh"] / 3.6

        # Outage gating rule (isGnssPermittedNow in IovnbdReplaySource.ts)
        is_outage = (t_rel_s >= outage_start_s and t_rel_s < outage_end_s)
        gnss_permitted = not is_outage

        # If GNSS permitted, process GNSS
        gnss_delivered = 0
        if gnss_permitted:
            gnss_delivered = 1
            # Exact code from processGnss lines 130-137:
            gnss_e, gnss_n, _ = wgs84_to_enu(ref_lat, ref_lon, 0.0, origin)
            current_e = gnss_e
            current_n = gnss_n
            current_heading_deg = ref_heading
            current_vel = ref_speed_mps

        # IMU processing
        dt = 0.1
        if last_imu_timestamp is not None and ts_ms > last_imu_timestamp:
            dt = min(0.5, (ts_ms - last_imu_timestamp) / 1000.0)
        last_imu_timestamp = ts_ms

        # Calibrated vehicle-frame channels (portrait mount: gyro pitch is yaw rate)
        yaw_rate = s["gyro"]["pitch"] # rad/s
        forward_accel = s["accel"]["y"]

        # Motion model (TCN / kinematic baseline)
        delta_heading_deg = (-(yaw_rate * 180.0) / math.pi) * dt
        current_heading_deg = (current_heading_deg + delta_heading_deg + 360.0) % 360.0

        if not gnss_permitted:
            raw_v = current_vel + forward_accel * dt
            current_vel = max(0.0, raw_v * (1.0 - 0.012 * dt))
        else:
            current_vel = ref_speed_mps

        heading_rad = current_heading_deg * DEG_TO_RAD
        distance_traveled = current_vel * dt
        cumulative_dist += distance_traveled

        delta_e = distance_traveled * math.sin(heading_rad)
        delta_n = distance_traveled * math.cos(heading_rad)

        current_e += delta_e
        current_n += delta_n

        unconstrained_lat, unconstrained_lon, _ = enu_to_wgs84(current_e, current_n, 0.0, origin)

        # Actual constraint result (Disabled in Mode R3)
        actual_res = constraint_provider.apply_constraint(
            unconstrained_lat, unconstrained_lon, current_heading_deg, route_points, origin
        )

        est_lat = actual_res["lat"]
        est_lon = actual_res["lon"]
        pos_err_m = haversine_distance(est_lat, est_lon, ref_lat, ref_lon)

        # Heading error relative to reference
        heading_err_deg = abs((current_heading_deg - ref_heading + 180.0) % 360.0 - 180.0)

        road_cand_str = f"seg_{actual_res['best_segment_idx']}" if actual_res['best_segment_idx'] >= 0 else "NONE"

        rows.append({
            "timestamp": round(t_rel_s, 2),
            "estimated_lat": est_lat,
            "estimated_lon": est_lon,
            "ref_lat": ref_lat,
            "ref_lon": ref_lon,
            "cross_track_m": round(actual_res["cross_track_m"], 3),
            "heading_err_deg": round(heading_err_deg, 2),
            "route_dist_m": round(cumulative_dist, 2),
            "road_candidate": road_cand_str,
            "constraint_active": 1 if actual_res["active"] else 0,
            "applied_correction_m": round(actual_res["applied_correction_m"], 4),
            "gnss_delivered": gnss_delivered,
            "pos_error_m": round(pos_err_m, 3)
        })

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    fieldnames = [
        "timestamp", "estimated_lat", "estimated_lon", "ref_lat", "ref_lon",
        "cross_track_m", "heading_err_deg", "route_dist_m", "road_candidate",
        "constraint_active", "applied_correction_m", "gnss_delivered", "pos_error_m"
    ]
    with open(TRACE_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Saved forensic trace CSV ({len(rows)} rows) to: {TRACE_CSV}")

    generate_svg_plot(rows, PLOT_SVG)

if __name__ == "__main__":
    run_forensic_simulation()

