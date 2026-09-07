/**
 * EskfMath.ts
 *
 * Mathematically rigorous linear algebra, 3D geometry, and quaternion operations
 * for the 15-State Quaternion Error-State Kalman Filter.
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. Zero external linear algebra dependencies (completely portable across React Native, Node, and Web).
 * 2. Closed-form analytical inversions for small measurement matrices (1x1, 2x2, 3x3).
 * 3. High-performance flat Float64Array storage for the 15x15 covariance matrix.
 * 4. Numerically stabilized quaternion updates and Joseph-form covariance updates.
 */

import { Quaternion, Vector3, ESKF_DIM } from "./EskfTypes";

// ==========================================
// 1. Vector3 Operations
// ==========================================

export function vec3Add(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(v: Vector3, s: number): Vector3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function vec3Dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3NormSq(v: Vector3): number {
  return v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
}

export function vec3Norm(v: Vector3): number {
  return Math.sqrt(vec3NormSq(v));
}

export function vec3Cross(a: Vector3, b: Vector3): Vector3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Computes 3x3 skew-symmetric cross-product matrix [v]_x:
 * [  0, -z,  y ]
 * [  z,  0, -x ]
 * [ -y,  x,  0 ]
 */
export function skew(v: Vector3): number[][] {
  const [x, y, z] = v;
  return [
    [0.0, -z, y],
    [z, 0.0, -x],
    [-y, x, 0.0],
  ];
}

// ==========================================
// 2. Quaternion Operations (Scalar First)
// ==========================================

export function quatNormalize(q: Quaternion): Quaternion {
  const [w, x, y, z] = q;
  const n = Math.sqrt(w * w + x * x + y * y + z * z);
  if (n < 1e-12) {
    throw new Error("Cannot normalize zero-norm quaternion");
  }
  return [w / n, x / n, y / n, z / n];
}

/**
 * Hamilton product of two scalar-first quaternions: a (x) b
 */
export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/**
 * Constructs a scalar-first unit quaternion from a 3D rotation vector.
 */
export function quatFromRotvec(r: Vector3): Quaternion {
  const angle = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  if (angle < 1e-10) {
    return quatNormalize([1.0, 0.5 * r[0], 0.5 * r[1], 0.5 * r[2]]);
  }
  const halfAngle = angle / 2.0;
  const sinFactor = Math.sin(halfAngle) / angle;
  return [
    Math.cos(halfAngle),
    r[0] * sinFactor,
    r[1] * sinFactor,
    r[2] * sinFactor,
  ];
}

/**
 * Converts a unit quaternion q_nb into a 3x3 Direction Cosine Matrix R_nb.
 * Rotates vectors from body frame to navigation frame: v_n = R_nb * v_b.
 */
export function quatToMatrix(q: Quaternion): number[][] {
  const [w, x, y, z] = quatNormalize(q);
  return [
    [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
    [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
    [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
  ];
}

/**
 * Extracts yaw heading in degrees (clockwise from North, 0 to 360) from q_nb.
 * Local ENU: East = +X, North = +Y, Up = +Z.
 * Vehicle forward axis = +X_b.
 * Body +X_b in ENU = R_nb[:, 0] = [dx_east, dy_north, dz_up].
 * Heading is clockwise from North (+Y): angle = atan2(dx_east, dy_north).
 */
export function headingFromQuatDeg(q: Quaternion): number {
  const R = quatToMatrix(q);
  const dx = R[0][0]; // East component of forward vector
  const dy = R[1][0]; // North component of forward vector
  let heading = (Math.atan2(dx, dy) * 180.0) / Math.PI;
  if (heading < 0) heading += 360.0;
  return heading;
}

// ==========================================
// 3. 3x3 Matrix Operations
// ==========================================

export function mat3Transpose(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function mat3MultiplyVec(m: number[][], v: Vector3): Vector3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function mat3Multiply(a: number[][], b: number[][]): number[][] {
  const res: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      res[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return res;
}

// ==========================================
// 4. Closed-Form Small Matrix Inversions
// ==========================================

/**
 * Inverts a 1x1 matrix (scalar reciprocal).
 */
export function invert1x1(s: number): number {
  if (Math.abs(s) < 1e-12) {
    throw new Error("Singular 1x1 matrix");
  }
  return 1.0 / s;
}

/**
 * Inverts a 2x2 symmetric / positive-definite matrix via Cramer's rule.
 */
export function invert2x2(s: number[][]): number[][] {
  const a = s[0][0];
  const b = s[0][1];
  const c = s[1][0];
  const d = s[1][1];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    throw new Error("Singular 2x2 matrix");
  }
  const invDet = 1.0 / det;
  return [
    [d * invDet, -b * invDet],
    [-c * invDet, a * invDet],
  ];
}

/**
 * Inverts a 3x3 symmetric / positive-definite matrix via analytical cofactor matrix.
 */
export function invert3x3(m: number[][]): number[][] {
  const a = m[0][0],
    b = m[0][1],
    c = m[0][2];
  const d = m[1][0],
    e = m[1][1],
    f = m[1][2];
  const g = m[2][0],
    h = m[2][1],
    k = m[2][2];

  const A = e * k - f * h;
  const B = -(d * k - f * g);
  const C = d * h - e * g;

  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    throw new Error("Singular 3x3 matrix");
  }

  const invDet = 1.0 / det;

  const D = -(b * k - c * h);
  const E = a * k - c * g;
  const F = -(a * h - b * g);

  const G = b * f - c * e;
  const H_cf = -(a * f - c * d);
  const K = a * e - b * d;

  return [
    [A * invDet, D * invDet, G * invDet],
    [B * invDet, E * invDet, H_cf * invDet],
    [C * invDet, F * invDet, K * invDet],
  ];
}

// ==========================================
// 5. 15x15 Matrix Operations (Flat Float64Array)
// ==========================================

export class Matrix15 {
  public data: Float64Array;

  constructor(initial?: Float64Array | number[][]) {
    if (initial instanceof Float64Array) {
      this.data = new Float64Array(initial);
    } else if (Array.isArray(initial)) {
      this.data = new Float64Array(ESKF_DIM * ESKF_DIM);
      for (let r = 0; r < ESKF_DIM; r++) {
        for (let c = 0; c < ESKF_DIM; c++) {
          this.data[r * ESKF_DIM + c] = initial[r][c];
        }
      }
    } else {
      this.data = new Float64Array(ESKF_DIM * ESKF_DIM);
    }
  }

  public static identity(): Matrix15 {
    const m = new Matrix15();
    for (let i = 0; i < ESKF_DIM; i++) {
      m.data[i * ESKF_DIM + i] = 1.0;
    }
    return m;
  }

  public static zeros(): Matrix15 {
    return new Matrix15();
  }

  public static fromDiag(diag: number[]): Matrix15 {
    const m = new Matrix15();
    for (let i = 0; i < Math.min(ESKF_DIM, diag.length); i++) {
      m.data[i * ESKF_DIM + i] = diag[i];
    }
    return m;
  }

  public get(r: number, c: number): number {
    return this.data[r * ESKF_DIM + c];
  }

  public set(r: number, c: number, val: number): void {
    this.data[r * ESKF_DIM + c] = val;
  }

  public clone(): Matrix15 {
    return new Matrix15(this.data);
  }

  public add(other: Matrix15): Matrix15 {
    const res = new Matrix15();
    for (let i = 0; i < this.data.length; i++) {
      res.data[i] = this.data[i] + other.data[i];
    }
    return res;
  }

  public multiply(other: Matrix15): Matrix15 {
    const res = new Matrix15();
    const a = this.data;
    const b = other.data;
    const out = res.data;

    for (let r = 0; r < ESKF_DIM; r++) {
      const rOffset = r * ESKF_DIM;
      for (let c = 0; c < ESKF_DIM; c++) {
        let sum = 0.0;
        for (let k = 0; k < ESKF_DIM; k++) {
          sum += a[rOffset + k] * b[k * ESKF_DIM + c];
        }
        out[rOffset + c] = sum;
      }
    }
    return res;
  }

  public transpose(): Matrix15 {
    const res = new Matrix15();
    for (let r = 0; r < ESKF_DIM; r++) {
      for (let c = 0; c < ESKF_DIM; c++) {
        res.data[c * ESKF_DIM + r] = this.data[r * ESKF_DIM + c];
      }
    }
    return res;
  }

  public trace(): number {
    let tr = 0.0;
    for (let i = 0; i < ESKF_DIM; i++) {
      tr += this.data[i * ESKF_DIM + i];
    }
    return tr;
  }

  /**
   * Enforces numerical symmetry P = 0.5 * (P + P^T)
   * and clamps diagonal variance to floor (>= 1e-12).
   */
  public symmetrizeAndStabilize(diagFloor = 1e-12): void {
    const d = this.data;
    for (let r = 0; r < ESKF_DIM; r++) {
      // Stabilize diagonal
      const diagIdx = r * ESKF_DIM + r;
      if (d[diagIdx] < diagFloor || isNaN(d[diagIdx])) {
        d[diagIdx] = diagFloor;
      }

      for (let c = r + 1; c < ESKF_DIM; c++) {
        const idxRC = r * ESKF_DIM + c;
        const idxCR = c * ESKF_DIM + r;
        const avg = 0.5 * (d[idxRC] + d[idxCR]);
        d[idxRC] = avg;
        d[idxCR] = avg;
      }
    }

    // Enforce correlation bound |P_ij| <= 0.999 * sqrt(P_ii * P_jj)
    for (let r = 0; r < ESKF_DIM; r++) {
      const varR = d[r * ESKF_DIM + r];
      for (let c = r + 1; c < ESKF_DIM; c++) {
        const varC = d[c * ESKF_DIM + c];
        const maxCov = 0.999 * Math.sqrt(varR * varC);
        const idxRC = r * ESKF_DIM + c;
        const idxCR = c * ESKF_DIM + r;
        if (Math.abs(d[idxRC]) > maxCov) {
          const clamped = Math.sign(d[idxRC]) * maxCov;
          d[idxRC] = clamped;
          d[idxCR] = clamped;
        }
      }
    }
  }
}
