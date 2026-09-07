/**
 * EskfMeasurements.ts
 *
 * Explicit observation models, measurement residuals, and Jacobians for the
 * 15-State Quaternion Mobile ESKF.
 * Follows the derived equations in docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md.
 */

import { NavigationState, Vector3, ESKF_DIM } from "./EskfTypes";
import { quatToMatrix, mat3Transpose, mat3MultiplyVec } from "./EskfMath";

export interface EskfMeasurementModel {
  /** Measurement dimension m (1, 2, or 3) */
  dimension: number;
  /** Innovation residual vector z = y_meas - h(x_nom) */
  residual: number[];
  /** Measurement Jacobian matrix H (m x 15) */
  H: number[][];
  /** Measurement noise covariance matrix R (m x m) */
  R: number[][];
  /** Optional human-readable measurement tag */
  tag: string;
}

/**
 * 1. GNSS Position Measurement (m = 3)
 * Model: p_gnss = p_nom + delta_p + v_gnss
 * z = p_gnss - p_nom
 * H[:, 0:3] = I_3
 */
export function createGnssPositionMeasurement(
  sampleEnu: Vector3,
  nomState: NavigationState,
  stdM: number,
): EskfMeasurementModel {
  const residual: number[] = [
    sampleEnu[0] - nomState.positionEnu[0],
    sampleEnu[1] - nomState.positionEnu[1],
    sampleEnu[2] - nomState.positionEnu[2],
  ];

  const H: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row = new Array(ESKF_DIM).fill(0.0);
    row[r] = 1.0;
    H.push(row);
  }

  const varVal = stdM * stdM;
  const R: number[][] = [
    [varVal, 0.0, 0.0],
    [0.0, varVal, 0.0],
    [0.0, 0.0, varVal],
  ];

  return { dimension: 3, residual, H, R, tag: "GNSS_POS" };
}

/**
 * 2. GNSS Velocity Measurement (m = 3)
 * Model: v_gnss = v_nom + delta_v + v_vel
 * z = v_gnss - v_nom
 * H[:, 3:6] = I_3
 */
export function createGnssVelocityMeasurement(
  sampleVelEnu: Vector3,
  nomState: NavigationState,
  stdMps: number,
): EskfMeasurementModel {
  const residual: number[] = [
    sampleVelEnu[0] - nomState.velocityEnu[0],
    sampleVelEnu[1] - nomState.velocityEnu[1],
    sampleVelEnu[2] - nomState.velocityEnu[2],
  ];

  const H: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row = new Array(ESKF_DIM).fill(0.0);
    row[3 + r] = 1.0;
    H.push(row);
  }

  const varVal = stdMps * stdMps;
  const R: number[][] = [
    [varVal, 0.0, 0.0],
    [0.0, varVal, 0.0],
    [0.0, 0.0, varVal],
  ];

  return { dimension: 3, residual, H, R, tag: "GNSS_VEL" };
}

/**
 * 3. Learned Forward Velocity Measurement (m = 1)
 * Derived in docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md:
 * v_fwd = e_x^T * R_bn * v_n
 * z_v = v_pred - v_b[0]
 * H_v[0, 3:6] = R_bn[0, :]
 * H_v[0, 6:9] = (-[v_b]_x)[0, :] = [0, v_b[2], -v_b[1]]
 */
export function createForwardVelocityMeasurement(
  predVelocityMps: number,
  predStdMps: number,
  nomState: NavigationState,
): EskfMeasurementModel {
  const Rnb = quatToMatrix(nomState.qNb);
  const Rbn = mat3Transpose(Rnb);
  const vb = mat3MultiplyVec(Rbn, nomState.velocityEnu);

  const residual = [predVelocityMps - vb[0]];

  const H_row = new Array(ESKF_DIM).fill(0.0);
  // Velocity Jacobian: R_bn[0, :]
  H_row[3] = Rbn[0][0];
  H_row[4] = Rbn[0][1];
  H_row[5] = Rbn[0][2];

  // Attitude Jacobian: (-[vb]_x)[0, :] = [0, vb[2], -vb[1]]
  H_row[6] = 0.0;
  H_row[7] = vb[2];
  H_row[8] = -vb[1];

  const R = [[Math.max(1e-4, predStdMps * predStdMps)]];

  return { dimension: 1, residual, H: [H_row], R, tag: "ML_FWD_VEL" };
}

/**
 * 4. Gyroscope Yaw Rate Bias Calibration Model (m = 1)
 * z_w = w_pred - (w_meas_z - b_gz)
 * H[0, 14] = -1.0
 */
export function createYawRateMeasurement(
  predYawRateRadps: number,
  predStdRadps: number,
  measuredYawRateRadps: number,
  nomState: NavigationState,
): EskfMeasurementModel {
  const residual = [
    predYawRateRadps - (measuredYawRateRadps - nomState.gyroBias[2]),
  ];

  const H_row = new Array(ESKF_DIM).fill(0.0);
  H_row[14] = -1.0; // Gyro Z bias sensitivity

  const R = [[Math.max(1e-6, predStdRadps * predStdRadps)]];

  return { dimension: 1, residual, H: [H_row], R, tag: "ML_YAW_RATE" };
}

/**
 * 5. Non-Holonomic Constraints (NHC) (m = 2)
 * For ground vehicles: v_b[1] ≈ 0 (lateral), v_b[2] ≈ 0 (vertical)
 * z = -v_b[1:3]
 * H[0, 3:6] = R_bn[1, :], H[0, 6:9] = [-vb[2], 0, vb[0]]
 * H[1, 3:6] = R_bn[2, :], H[1, 6:9] = [vb[1], -vb[0], 0]
 */
export function createNhcMeasurement(
  nomState: NavigationState,
  lateralStdMps = 0.35,
  verticalStdMps = 0.2,
): EskfMeasurementModel {
  const Rnb = quatToMatrix(nomState.qNb);
  const Rbn = mat3Transpose(Rnb);
  const vb = mat3MultiplyVec(Rbn, nomState.velocityEnu);

  const residual = [-vb[1], -vb[2]];

  const H0 = new Array(ESKF_DIM).fill(0.0);
  const H1 = new Array(ESKF_DIM).fill(0.0);

  // Lateral velocity row (v_b[1])
  H0[3] = Rbn[1][0];
  H0[4] = Rbn[1][1];
  H0[5] = Rbn[1][2];
  H0[6] = -vb[2];
  H0[7] = 0.0;
  H0[8] = vb[0];

  // Vertical velocity row (v_b[2])
  H1[3] = Rbn[2][0];
  H1[4] = Rbn[2][1];
  H1[5] = Rbn[2][2];
  H1[6] = vb[1];
  H1[7] = -vb[0];
  H1[8] = 0.0;

  const R: number[][] = [
    [lateralStdMps * lateralStdMps, 0.0],
    [0.0, verticalStdMps * verticalStdMps],
  ];

  return { dimension: 2, residual, H: [H0, H1], R, tag: "NHC" };
}

/**
 * 6. Soft Road / Route Position Constraint (m = 2)
 * z = [target_E - p_nom_E, target_N - p_nom_N]
 * H[:, 0:2] = I_2
 * R = (baseStd^2 + (inflation * dist)^2) * I_2
 */
export function createSoftPolylineMeasurement(
  targetEastNorthM: [number, number],
  nomState: NavigationState,
  baseStdM = 8.0,
  inflationFactor = 0.5,
): EskfMeasurementModel {
  const residual = [
    targetEastNorthM[0] - nomState.positionEnu[0],
    targetEastNorthM[1] - nomState.positionEnu[1],
  ];

  const H0 = new Array(ESKF_DIM).fill(0.0);
  H0[0] = 1.0;
  const H1 = new Array(ESKF_DIM).fill(0.0);
  H1[1] = 1.0;

  const dist = Math.hypot(residual[0], residual[1]);
  const effectiveStd = Math.sqrt(
    baseStdM * baseStdM + Math.pow(dist * inflationFactor, 2),
  );
  const varVal = effectiveStd * effectiveStd;

  const R: number[][] = [
    [varVal, 0.0],
    [0.0, varVal],
  ];

  return { dimension: 2, residual, H: [H0, H1], R, tag: "SOFT_POLYLINE" };
}
