"""
generate_eskf_golden_vector.py

Self-contained, pure-Python golden vector generator for the 15-state ESKF.
Implements the exact mathematical specification from docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md
and research/idr/navigation/eskf.py using Python standard library (math, json).
Requires ZERO external packages (no numpy/scipy required).

Outputs: tests/golden/eskf_golden_vector.json
"""
from __future__ import annotations
import json
import math
import os

# ==========================================
# 1. 3D Vector & Quaternion Operations
# ==========================================

def vec3_add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def vec3_sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def vec3_norm(v):
    return math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])

def skew(v):
    x, y, z = v
    return [
        [0.0, -z, y],
        [z, 0.0, -x],
        [-y, x, 0.0]
    ]

def quat_normalize(q):
    w, x, y, z = q
    n = math.sqrt(w*w + x*x + y*y + z*z)
    if n < 1e-12:
        raise ValueError("zero quaternion norm")
    return [w/n, x/n, y/n, z/n]

def quat_multiply(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [
        aw*bw - ax*bx - ay*by - az*bz,
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw
    ]

def quat_from_rotvec(r):
    angle = math.sqrt(r[0]*r[0] + r[1]*r[1] + r[2]*r[2])
    if angle < 1e-10:
        return quat_normalize([1.0, 0.5*r[0], 0.5*r[1], 0.5*r[2]])
    half = angle / 2.0
    s = math.sin(half) / angle
    return [math.cos(half), r[0]*s, r[1]*s, r[2]*s]

def quat_to_matrix(q):
    w, x, y, z = quat_normalize(q)
    return [
        [1.0 - 2.0*(y*y + z*z), 2.0*(x*y - z*w), 2.0*(x*z + y*w)],
        [2.0*(x*y + z*w), 1.0 - 2.0*(x*x + z*z), 2.0*(y*z - x*w)],
        [2.0*(x*z - y*w), 2.0*(y*z + x*w), 1.0 - 2.0*(x*x + y*y)]
    ]

def mat3_transpose(m):
    return [
        [m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]]
    ]

def mat3_vec_mul(m, v):
    return [
        m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
        m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
        m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2]
    ]

def mat3_mul(a, b):
    res = [[0.0]*3 for _ in range(3)]
    for r in range(3):
        for c in range(3):
            res[r][c] = a[r][0]*b[0][c] + a[r][1]*b[1][c] + a[r][2]*b[2][c]
    return res

# ==========================================
# 2. General Matrix Inversion & Multiplication
# ==========================================

def invert1x1(s):
    if abs(s) < 1e-12:
        raise ZeroDivisionError("singular 1x1")
    return 1.0 / s

def invert2x2(m):
    a, b = m[0][0], m[0][1]
    c, d = m[1][0], m[1][1]
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ZeroDivisionError("singular 2x2")
    inv_det = 1.0 / det
    return [
        [d * inv_det, -b * inv_det],
        [-c * inv_det, a * inv_det]
    ]

def invert3x3(m):
    a, b, c = m[0][0], m[0][1], m[0][2]
    d, e, f = m[1][0], m[1][1], m[1][2]
    g, h, k = m[2][0], m[2][1], m[2][2]

    A = e*k - f*h
    B = -(d*k - f*g)
    C = d*h - e*g

    det = a*A + b*B + c*C
    if abs(det) < 1e-12:
        raise ZeroDivisionError("singular 3x3")
    inv_det = 1.0 / det

    D = -(b*k - c*h)
    E = a*k - c*g
    F = -(a*h - b*g)
    G = b*f - c*e
    H = -(a*f - c*d)
    K = a*e - b*d

    return [
        [A*inv_det, D*inv_det, G*inv_det],
        [B*inv_det, E*inv_det, H*inv_det],
        [C*inv_det, F*inv_det, K*inv_det]
    ]

def mat_mul(a, b):
    rows_a = len(a)
    cols_a = len(a[0])
    cols_b = len(b[0])
    res = [[0.0]*cols_b for _ in range(rows_a)]
    for r in range(rows_a):
        for c in range(cols_b):
            s = 0.0
            for k in range(cols_a):
                s += a[r][k] * b[k][c]
            res[r][c] = s
    return res

def mat_transpose(m):
    rows = len(m)
    cols = len(m[0])
    return [[m[r][c] for r in range(rows)] for c in range(cols)]

def mat_add(a, b):
    rows = len(a)
    cols = len(a[0])
    return [[a[r][c] + b[r][c] for c in range(cols)] for r in range(rows)]

# ==========================================
# 3. Pure Python 15-State ESKF
# ==========================================

class PurePythonEskf:
    def __init__(self, init_pos, init_vel, init_q, init_ba, init_bg, init_cov_diag):
        self.p = list(init_pos)
        self.v = list(init_vel)
        self.q = quat_normalize(list(init_q))
        self.ba = list(init_ba)
        self.bg = list(init_bg)

        # 15x15 covariance
        self.P = [[0.0]*15 for _ in range(15)]
        for i in range(15):
            self.P[i][i] = float(init_cov_diag[i])

        self.gravity = [0.0, 0.0, -9.80665]
        self.accel_noise = 0.35
        self.gyro_noise = 0.03
        self.accel_bias_rw = 0.01
        self.gyro_bias_rw = 0.002

    def propagate(self, accel_b, gyro_b, dt):
        Rnb = quat_to_matrix(self.q)
        ab = [accel_b[0] - self.ba[0], accel_b[1] - self.ba[1], accel_b[2] - self.ba[2]]
        wb = [gyro_b[0] - self.bg[0], gyro_b[1] - self.bg[1], gyro_b[2] - self.bg[2]]

        # Acceleration in ENU: an = Rnb * ab + gravity
        Rnb_ab = mat3_vec_mul(Rnb, ab)
        an = [Rnb_ab[0] + self.gravity[0], Rnb_ab[1] + self.gravity[1], Rnb_ab[2] + self.gravity[2]]

        # 1. Nominal state integration
        for i in range(3):
            self.p[i] += self.v[i] * dt + 0.5 * an[i] * dt * dt
            self.v[i] += an[i] * dt

        dq = quat_from_rotvec([wb[0]*dt, wb[1]*dt, wb[2]*dt])
        self.q = quat_normalize(quat_multiply(self.q, dq))

        # 2. Discrete Transition Phi = I_15 + F * dt
        Phi = [[1.0 if r == c else 0.0 for c in range(15)] for r in range(15)]

        # Phi[0:3, 3:6] = I_3 * dt
        for i in range(3):
            Phi[i][3 + i] = dt

        # Phi[3:6, 6:9] = -Rnb * skew(ab) * dt
        R_skewAb = mat3_mul(Rnb, skew(ab))
        for r in range(3):
            for c in range(3):
                Phi[3 + r][6 + c] = -R_skewAb[r][c] * dt

        # Phi[3:6, 9:12] = -Rnb * dt
        for r in range(3):
            for c in range(3):
                Phi[3 + r][9 + c] = -Rnb[r][c] * dt

        # Phi[6:9, 6:9] = I_3 - skew(wb) * dt
        skewW = skew(wb)
        for r in range(3):
            for c in range(3):
                delta = 1.0 if r == c else 0.0
                Phi[6 + r][6 + c] = delta - skewW[r][c] * dt

        # Phi[6:9, 12:15] = -I_3 * dt
        for i in range(3):
            Phi[6 + i][12 + i] = -dt

        # 3. Covariance Propagation: P = Phi * P * Phi^T + Qd
        PhiT = mat_transpose(Phi)
        T = mat_mul(Phi, self.P)
        P_new = mat_mul(T, PhiT)

        # Process noise Qd
        qa = (self.accel_noise ** 2) * dt
        qg = (self.gyro_noise ** 2) * dt
        qba = (self.accel_bias_rw ** 2) * dt
        qbg = (self.gyro_bias_rw ** 2) * dt

        for i in range(3):
            P_new[3 + i][3 + i] += qa
            P_new[6 + i][6 + i] += qg
            P_new[9 + i][9 + i] += qba
            P_new[12 + i][12 + i] += qbg

        # Symmetrize & Stabilize
        for r in range(15):
            P_new[r][r] = max(P_new[r][r], 1e-12)
            for c in range(r + 1, 15):
                avg = 0.5 * (P_new[r][c] + P_new[c][r])
                P_new[r][c] = avg
                P_new[c][r] = avg

        self.P = P_new

    def update(self, residual, H, R):
        m = len(residual)
        # Innovation covariance S = H * P * H^T + R (m x m)
        HP = mat_mul(H, self.P)
        HT = mat_transpose(H)
        HPH = mat_mul(HP, HT)
        S = mat_add(HPH, R)

        # Analytical inverse
        if m == 1:
            Sinv = [[invert1x1(S[0][0])]]
        elif m == 2:
            Sinv = invert2x2(S)
        elif m == 3:
            Sinv = invert3x3(S)
        else:
            raise ValueError(f"unsupported dimension {m}")

        # Kalman gain K = P * H^T * Sinv (15 x m)
        PHT = mat_mul(self.P, HT)
        K = mat_mul(PHT, Sinv)

        # Error state dx = K * residual (15 x 1)
        dx = [0.0] * 15
        for r in range(15):
            s = 0.0
            for j in range(m):
                s += K[r][j] * residual[j]
            dx[r] = s

        # State Injection
        for i in range(3):
            self.p[i] += dx[i]
            self.v[i] += dx[3 + i]
        dq = quat_from_rotvec([dx[6], dx[7], dx[8]])
        self.q = quat_normalize(quat_multiply(self.q, dq))
        for i in range(3):
            self.ba[i] += dx[9 + i]
            self.bg[i] += dx[12 + i]

        # Joseph-form covariance update: P = (I - KH)*P*(I - KH)^T + K*R*K^T
        I15 = [[1.0 if r == c else 0.0 for c in range(15)] for r in range(15)]
        KH = mat_mul(K, H)
        M = [[I15[r][c] - KH[r][c] for c in range(15)] for r in range(15)]
        MT = mat_transpose(M)
        MP = mat_mul(M, self.P)
        MPMT = mat_mul(MP, MT)

        KT = mat_transpose(K)
        KR = mat_mul(K, R)
        KRKT = mat_mul(KR, KT)

        P_new = mat_add(MPMT, KRKT)

        # Symmetrize & Stabilize
        for r in range(15):
            P_new[r][r] = max(P_new[r][r], 1e-12)
            for c in range(r + 1, 15):
                avg = 0.5 * (P_new[r][c] + P_new[c][r])
                P_new[r][c] = avg
                P_new[c][r] = avg

        self.P = P_new

    def update_gnss_pos(self, pos_enu, std_m):
        residual = [pos_enu[0] - self.p[0], pos_enu[1] - self.p[1], pos_enu[2] - self.p[2]]
        H = [[0.0]*15 for _ in range(3)]
        for i in range(3):
            H[i][i] = 1.0
        var = std_m * std_m
        R = [[var if r == c else 0.0 for c in range(3)] for r in range(3)]
        self.update(residual, H, R)

    def update_motion(self, fwd_vel, yaw_rate, vel_std, yaw_std, measured_yaw):
        Rnb = quat_to_matrix(self.q)
        Rbn = mat3_transpose(Rnb)
        vb = mat3_vec_mul(Rbn, self.v)

        # 1. Forward velocity update
        res_v = [fwd_vel - vb[0]]
        Hv = [[0.0]*15]
        Hv[0][3] = Rbn[0][0]
        Hv[0][4] = Rbn[0][1]
        Hv[0][5] = Rbn[0][2]
        Hv[0][6] = 0.0
        Hv[0][7] = vb[2]
        Hv[0][8] = -vb[1]
        Rv = [[vel_std * vel_std]]
        self.update(res_v, Hv, Rv)

        # 2. Yaw rate update
        res_w = [yaw_rate - (measured_yaw - self.bg[2])]
        Hw = [[0.0]*15]
        Hw[0][14] = -1.0
        Rw = [[yaw_std * yaw_std]]
        self.update(res_w, Hw, Rw)

    def update_nhc(self, lat_std, vert_std):
        Rnb = quat_to_matrix(self.q)
        Rbn = mat3_transpose(Rnb)
        vb = mat3_vec_mul(Rbn, self.v)

        residual = [-vb[1], -vb[2]]
        H = [[0.0]*15 for _ in range(2)]

        # Row 0: lateral v_b[1]
        H[0][3] = Rbn[1][0]
        H[0][4] = Rbn[1][1]
        H[0][5] = Rbn[1][2]
        H[0][6] = -vb[2]
        H[0][7] = 0.0
        H[0][8] = vb[0]

        # Row 1: vertical v_b[2]
        H[1][3] = Rbn[2][0]
        H[1][4] = Rbn[2][1]
        H[1][5] = Rbn[2][2]
        H[1][6] = vb[1]
        H[1][7] = -vb[0]
        H[1][8] = 0.0

        R = [
            [lat_std*lat_std, 0.0],
            [0.0, vert_std*vert_std]
        ]
        self.update(residual, H, R)

    def update_soft_position(self, target, cov):
        residual = [target[0] - self.p[0], target[1] - self.p[1]]
        H = [[0.0]*15 for _ in range(2)]
        H[0][0] = 1.0
        H[1][1] = 1.0
        self.update(residual, H, cov)

    def update_gnss_pos_vel(self, pos, std_m, vel, vel_std):
        self.update_gnss_pos(pos, std_m)
        res_v = [vel[0] - self.v[0], vel[1] - self.v[1], vel[2] - self.v[2]]
        H = [[0.0]*15 for _ in range(3)]
        for i in range(3):
            H[i][3 + i] = 1.0
        var = vel_std * vel_std
        R = [[var if r == c else 0.0 for c in range(3)] for r in range(3)]
        self.update(res_v, H, R)


def run_golden_sequence():
    init_pos = [10.0, -5.0, 0.5]
    init_vel = [1.5, 0.5, 0.0]
    init_q = [1.0, 0.0, 0.0, 0.0]
    init_ba = [0.02, -0.01, 0.005]
    init_bg = [0.001, 0.002, -0.003]

    init_cov_diag = [
        9.0, 9.0, 25.0,        # pos
        1.0, 1.0, 0.25,        # vel
        0.01, 0.01, 0.02,      # att
        0.005, 0.005, 0.005,   # ba
        0.0005, 0.0005, 0.0005 # bg
    ]

    eskf = PurePythonEskf(init_pos, init_vel, init_q, init_ba, init_bg, init_cov_diag)

    steps_data = []

    for step in range(50):
        action_data = {"step": step}
        t = step * 0.1
        fwd_acc = 0.5 * math.cos(0.2 * t)
        lat_acc = 0.1 * math.sin(0.3 * t)
        vert_acc = 9.80665
        accel_b = [fwd_acc, lat_acc, vert_acc]
        gyro_b = [0.01 * math.sin(0.1 * t), 0.005, 0.04 * math.cos(0.15 * t)]
        dt = 0.1

        eskf.propagate(accel_b, gyro_b, dt)
        action_data["propagate"] = {
            "accel": accel_b,
            "gyro": gyro_b,
            "dt": dt,
        }

        if step == 10 or step == 45:
            gnss_pos = [eskf.p[0] + 0.2, eskf.p[1] - 0.3, eskf.p[2] + 0.1]
            std_m = 3.5
            eskf.update_gnss_pos(gnss_pos, std_m)
            action_data["update_gnss_pos"] = {
                "pos": gnss_pos,
                "std_m": std_m,
            }

        if step == 20:
            speed = math.hypot(eskf.v[0], eskf.v[1])
            eskf.update_motion(speed, gyro_b[2], 0.4, 0.03, gyro_b[2])
            action_data["update_motion"] = {
                "fwd_vel": speed,
                "yaw_rate": gyro_b[2],
                "vel_std": 0.4,
                "yaw_std": 0.03,
                "measured_yaw": gyro_b[2],
            }

        if step % 5 == 0 and step > 15:
            eskf.update_nhc(0.35, 0.20)
            action_data["update_nhc"] = {
                "lat_std": 0.35,
                "vert_std": 0.20,
            }

        if step == 30:
            target = [eskf.p[0] + 0.8, eskf.p[1] - 0.5]
            var = 8.0**2 + (1.0 * 0.5)**2
            cov = [[var, 0.0], [0.0, var]]
            eskf.update_soft_position(target, cov)
            action_data["update_soft_position"] = {
                "target": target,
                "cov": cov,
            }

        if step == 48:
            gnss_pos = [eskf.p[0] + 0.1, eskf.p[1] + 0.1, 0.0]
            gnss_vel = [eskf.v[0] - 0.05, eskf.v[1] + 0.05, 0.0]
            eskf.update_gnss_pos_vel(gnss_pos, 2.0, gnss_vel, 0.8)
            action_data["update_gnss_pos_vel"] = {
                "pos": gnss_pos,
                "std_m": 2.0,
                "vel": gnss_vel,
                "vel_std": 0.8,
            }

        cov_diag = [eskf.P[i][i] for i in range(15)]
        cov_trace = sum(cov_diag)

        action_data["expected_state"] = {
            "positionEnu": list(eskf.p),
            "velocityEnu": list(eskf.v),
            "qNb": list(eskf.q),
            "accelBias": list(eskf.ba),
            "gyroBias": list(eskf.bg),
        }
        action_data["expected_cov_diag"] = cov_diag
        action_data["expected_cov_trace"] = cov_trace

        steps_data.append(action_data)

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo_root, "tests", "golden")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "eskf_golden_vector.json")

    golden_payload = {
        "metadata": {
            "generator": "scripts/generate_eskf_golden_vector.py",
            "specification": "docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md",
            "num_steps": len(steps_data),
            "tolerances": {
                "position_max_err_m": 0.05,
                "velocity_max_err_mps": 0.02,
                "attitude_max_err": 1e-4,
                "bias_max_err": 1e-4,
                "cov_diag_relative_err": 0.005,
            }
        },
        "initial_state": {
            "positionEnu": init_pos,
            "velocityEnu": init_vel,
            "qNb": init_q,
            "accelBias": init_ba,
            "gyroBias": init_bg,
        },
        "initial_cov_diag": init_cov_diag,
        "steps": steps_data,
    }

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(golden_payload, f, indent=2)

    print(f"Successfully generated golden vectors: {out_file}")
    print(f"Total steps: {len(steps_data)}")


if __name__ == "__main__":
    run_golden_sequence()

