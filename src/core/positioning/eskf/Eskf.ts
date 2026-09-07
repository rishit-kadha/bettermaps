/**
 * Eskf.ts
 *
 * Production 15-State Quaternion Error-State Kalman Filter (ESKF).
 * Implements the continuous-discrete error-state formulation matching
 * research/idr/navigation/eskf.py and docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md.
 *
 * State ordering (15 states):
 * - 0:3   = positionEnu (East, North, Up, meters)
 * - 3:6   = velocityEnu (v_east, v_north, v_up, m/s)
 * - 6:9   = attitudeError (dtheta_x, dtheta_y, dtheta_z in body frame, rad)
 * - 9:12  = accelBias (b_ax, b_ay, b_az in body frame, m/s^2)
 * - 12:15 = gyroBias (b_gx, b_gy, b_gz in body frame, rad/s)
 */

import {
  ESKF_DIM,
  EskfDiagnostics,
  MeasurementUpdateResult,
  MotionPrediction,
  NavigationState,
  Quaternion,
  Vector3,
  VehicleFrameImuMeasurement,
} from "./EskfTypes";
import { DEFAULT_ESKF_CONFIG, EskfFullConfig } from "./EskfConfig";
import {
  headingFromQuatDeg,
  invert1x1,
  invert2x2,
  invert3x3,
  mat3MultiplyVec,
  Matrix15,
  quatFromRotvec,
  quatMultiply,
  quatNormalize,
  quatToMatrix,
  skew,
  vec3Add,
  vec3Norm,
  vec3Scale,
  vec3Sub,
} from "./EskfMath";
import {
  createForwardVelocityMeasurement,
  createGnssPositionMeasurement,
  createGnssVelocityMeasurement,
  createNhcMeasurement,
  createSoftPolylineMeasurement,
  createYawRateMeasurement,
  EskfMeasurementModel,
} from "./EskfMeasurements";

export class Eskf {
  private state: NavigationState;
  private P: Matrix15;
  private readonly config: EskfFullConfig;

  // Diagnostics counters
  private gnssCount = 0;
  private motionCount = 0;
  private nhcCount = 0;
  private roadCount = 0;
  private routeCount = 0;
  private rejectedCount = 0;
  private lastTimestampS = 0.0;

  constructor(
    initialState?: NavigationState,
    initialCovariance?: Matrix15 | number[][],
    config?: Partial<EskfFullConfig>,
  ) {
    this.config = {
      gravityMagnitude:
        config?.gravityMagnitude ?? DEFAULT_ESKF_CONFIG.gravityMagnitude,
      noise: { ...DEFAULT_ESKF_CONFIG.noise, ...config?.noise },
      measurements: {
        ...DEFAULT_ESKF_CONFIG.measurements,
        ...config?.measurements,
      },
      timing: { ...DEFAULT_ESKF_CONFIG.timing, ...config?.timing },
    };

    if (initialState) {
      this.state = {
        positionEnu: [...initialState.positionEnu],
        velocityEnu: [...initialState.velocityEnu],
        qNb: quatNormalize([...initialState.qNb]),
        accelBias: [...initialState.accelBias],
        gyroBias: [...initialState.gyroBias],
      };
    } else {
      this.state = {
        positionEnu: [0.0, 0.0, 0.0],
        velocityEnu: [0.0, 0.0, 0.0],
        qNb: [1.0, 0.0, 0.0, 0.0],
        accelBias: [0.0, 0.0, 0.0],
        gyroBias: [0.0, 0.0, 0.0],
      };
    }

    if (initialCovariance instanceof Matrix15) {
      this.P = initialCovariance.clone();
    } else if (Array.isArray(initialCovariance)) {
      this.P = new Matrix15(initialCovariance);
    } else {
      this.P = Matrix15.identity();
    }
  }

  /**
   * Propagates nominal state and error covariance using calibrated IMU measurements.
   *
   * @param imu Vehicle-frame IMU measurement
   * @param dtS Optional explicit delta-t in seconds (uses timestamp diff if omitted)
   */
  public propagate(imu: VehicleFrameImuMeasurement, dtS?: number): void {
    let dt = dtS;
    if (dt === undefined) {
      if (this.lastTimestampS <= 0.0) {
        this.lastTimestampS = imu.timestampS;
        return;
      }
      dt = imu.timestampS - this.lastTimestampS;
    }
    this.lastTimestampS = imu.timestampS;

    // Gate time step to valid range
    if (
      dt < this.config.timing.minPropagationDtS ||
      dt > this.config.timing.maxPropagationDtS ||
      isNaN(dt)
    ) {
      return;
    }

    const s = this.state;
    const Rnb = quatToMatrix(s.qNb);

    // Bias-corrected specific force and angular velocity in body frame
    const ab: Vector3 = [
      imu.accelMps2[0] - s.accelBias[0],
      imu.accelMps2[1] - s.accelBias[1],
      imu.accelMps2[2] - s.accelBias[2],
    ];

    const wb: Vector3 = [
      imu.gyroRadps[0] - s.gyroBias[0],
      imu.gyroRadps[1] - s.gyroBias[1],
      imu.gyroRadps[2] - s.gyroBias[2],
    ];

    // Navigation-frame acceleration with local ENU gravity [0, 0, -g]
    const an: Vector3 = [
      Rnb[0][0] * ab[0] + Rnb[0][1] * ab[1] + Rnb[0][2] * ab[2],
      Rnb[1][0] * ab[0] + Rnb[1][1] * ab[1] + Rnb[1][2] * ab[2],
      Rnb[2][0] * ab[0] +
        Rnb[2][1] * ab[1] +
        Rnb[2][2] * ab[2] -
        this.config.gravityMagnitude,
    ];

    // 1. Nominal state integration
    // Position: p = p + v*dt + 0.5*a*dt^2
    s.positionEnu[0] += s.velocityEnu[0] * dt + 0.5 * an[0] * dt * dt;
    s.positionEnu[1] += s.velocityEnu[1] * dt + 0.5 * an[1] * dt * dt;
    s.positionEnu[2] += s.velocityEnu[2] * dt + 0.5 * an[2] * dt * dt;

    // Velocity: v = v + a*dt
    s.velocityEnu[0] += an[0] * dt;
    s.velocityEnu[1] += an[1] * dt;
    s.velocityEnu[2] += an[2] * dt;

    // Attitude: q = q (x) delta_q(wb * dt)
    const dtheta: Vector3 = [wb[0] * dt, wb[1] * dt, wb[2] * dt];
    const dq = quatFromRotvec(dtheta);
    s.qNb = quatNormalize(quatMultiply(s.qNb, dq));

    // 2. Continuous-time Jacobian F (15x15)
    // F[0:3, 3:6] = I_3
    // F[3:6, 6:9] = -Rnb * skew(ab)
    // F[3:6, 9:12] = -Rnb
    // F[6:9, 6:9] = -skew(wb)
    // F[6:9, 12:15] = -I_3
    const skewAb = skew(ab);
    const skewWb = skew(wb);

    // Rnb * skew(ab)
    const R_skewAb: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        R_skewAb[r][c] =
          Rnb[r][0] * skewAb[0][c] +
          Rnb[r][1] * skewAb[1][c] +
          Rnb[r][2] * skewAb[2][c];
      }
    }

    // Construct discrete state transition matrix Phi = I_15 + F * dt
    const Phi = Matrix15.identity();

    // Phi[0:3, 3:6] = I_3 * dt
    Phi.set(0, 3, dt);
    Phi.set(1, 4, dt);
    Phi.set(2, 5, dt);

    // Phi[3:6, 6:9] = -Rnb * skew(ab) * dt
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        Phi.set(3 + r, 6 + c, -R_skewAb[r][c] * dt);
      }
    }

    // Phi[3:6, 9:12] = -Rnb * dt
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        Phi.set(3 + r, 9 + c, -Rnb[r][c] * dt);
      }
    }

    // Phi[6:9, 6:9] = I_3 - skew(wb) * dt
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const delta = r === c ? 1.0 : 0.0;
        Phi.set(6 + r, 6 + c, delta - skewWb[r][c] * dt);
      }
    }

    // Phi[6:9, 12:15] = -I_3 * dt
    Phi.set(6, 12, -dt);
    Phi.set(7, 13, -dt);
    Phi.set(8, 14, -dt);

    // 3. Discrete Process Noise Covariance Qd = G * Qc * G^T * dt
    // Because G is block-diagonal with Rnb on [3:6] and I_3 elsewhere,
    // and Rnb * (sigma_a^2 I) * Rnb^T = sigma_a^2 I, Qd is strictly diagonal!
    const sa2 =
      this.config.noise.accelNoiseDensity * this.config.noise.accelNoiseDensity;
    const sg2 =
      this.config.noise.gyroNoiseDensity * this.config.noise.gyroNoiseDensity;
    const sba2 =
      this.config.noise.accelBiasRandomWalk *
      this.config.noise.accelBiasRandomWalk;
    const sbg2 =
      this.config.noise.gyroBiasRandomWalk *
      this.config.noise.gyroBiasRandomWalk;

    // Propagate covariance: P = Phi * P * Phi^T + Qd
    // We compute T = Phi * P, then P_new = T * Phi^T + Qd
    const PhiT = Phi.transpose();
    const temp = Phi.multiply(this.P);
    const Pnew = temp.multiply(PhiT);

    // Add diagonal process noise
    const qAccel = sa2 * dt;
    const qGyro = sg2 * dt;
    const qBiasA = sba2 * dt;
    const qBiasG = sbg2 * dt;

    for (let i = 0; i < 3; i++) {
      Pnew.set(3 + i, 3 + i, Pnew.get(3 + i, 3 + i) + qAccel);
      Pnew.set(6 + i, 6 + i, Pnew.get(6 + i, 6 + i) + qGyro);
      Pnew.set(9 + i, 9 + i, Pnew.get(9 + i, 9 + i) + qBiasA);
      Pnew.set(12 + i, 12 + i, Pnew.get(12 + i, 12 + i) + qBiasG);
    }

    Pnew.symmetrizeAndStabilize(1e-12);
    this.P = Pnew;
  }

  /**
   * Generalized measurement update using analytical inversion (m <= 3) and
   * Joseph-form covariance stabilization.
   */
  public update(measurement: EskfMeasurementModel): MeasurementUpdateResult {
    const m = measurement.dimension;
    const z = measurement.residual;
    const H = measurement.H;
    const R = measurement.R;

    // 1. Innovation Covariance: S = H * P * H^T + R (m x m)
    // Compute HP (m x 15)
    const HP: number[][] = [];
    for (let r = 0; r < m; r++) {
      const hpRow = new Array(ESKF_DIM).fill(0.0);
      const hRow = H[r];
      for (let c = 0; c < ESKF_DIM; c++) {
        let sum = 0.0;
        for (let k = 0; k < ESKF_DIM; k++) {
          const hk = hRow[k];
          if (hk !== 0.0) {
            sum += hk * this.P.get(k, c);
          }
        }
        hpRow[c] = sum;
      }
      HP.push(hpRow);
    }

    // Compute S = HP * H^T + R (m x m)
    const S: number[][] = [];
    for (let r = 0; r < m; r++) {
      const sRow = new Array(m).fill(0.0);
      for (let c = 0; c < m; c++) {
        let sum = R[r][c];
        const hpRow = HP[r];
        const hCol = H[c];
        for (let k = 0; k < ESKF_DIM; k++) {
          const hk = hCol[k];
          if (hk !== 0.0) {
            sum += hpRow[k] * hk;
          }
        }
        sRow[c] = sum;
      }
      S.push(sRow);
    }

    // 2. Analytical inversion of S (m x m)
    let Sinv: number[][];
    try {
      if (m === 1) {
        Sinv = [[invert1x1(S[0][0])]];
      } else if (m === 2) {
        Sinv = invert2x2(S);
      } else if (m === 3) {
        Sinv = invert3x3(S);
      } else {
        throw new Error(`Unsupported measurement dimension: ${m}`);
      }
    } catch {
      this.rejectedCount++;
      return {
        accepted: false,
        residual: z,
        innovationCovariance: S,
        rejectionReason: "Singular innovation covariance matrix",
      };
    }

    // 3. Kalman Gain: K = P * H^T * Sinv (15 x m)
    // Note: P * H^T = HP^T, so (P * H^T)[k, j] = HP[j, k]
    const K: number[][] = [];
    for (let r = 0; r < ESKF_DIM; r++) {
      const kRow = new Array(m).fill(0.0);
      for (let c = 0; c < m; c++) {
        let sum = 0.0;
        for (let j = 0; j < m; j++) {
          sum += HP[j][r] * Sinv[j][c];
        }
        kRow[c] = sum;
      }
      K.push(kRow);
    }

    // 4. Error state correction: dx = K * z (15 x 1)
    const dx = new Array(ESKF_DIM).fill(0.0);
    for (let r = 0; r < ESKF_DIM; r++) {
      let sum = 0.0;
      for (let c = 0; c < m; c++) {
        sum += K[r][c] * z[c];
      }
      dx[r] = sum;
    }

    // 5. State Injection
    this.injectErrorState(dx);

    // 6. Joseph-Form Covariance Update
    // P = (I - K*H) * P * (I - K*H)^T + K * R * K^T
    // Compute M = I_15 - K*H (15 x 15)
    const M = Matrix15.identity();
    for (let r = 0; r < ESKF_DIM; r++) {
      for (let c = 0; c < ESKF_DIM; c++) {
        let kh = 0.0;
        for (let j = 0; j < m; j++) {
          const hj = H[j][c];
          if (hj !== 0.0) {
            kh += K[r][j] * hj;
          }
        }
        M.set(r, c, M.get(r, c) - kh);
      }
    }

    // MP = M * P
    const MP = M.multiply(this.P);
    // MPMT = MP * M^T
    const MT = M.transpose();
    const MPMT = MP.multiply(MT);

    // Compute KRKT = K * R * K^T (15 x 15)
    // KR (15 x m)
    const KR: number[][] = [];
    for (let r = 0; r < ESKF_DIM; r++) {
      const krRow = new Array(m).fill(0.0);
      for (let c = 0; c < m; c++) {
        let sum = 0.0;
        for (let j = 0; j < m; j++) {
          sum += K[r][j] * R[j][c];
        }
        krRow[c] = sum;
      }
      KR.push(krRow);
    }

    // KRKT = KR * K^T
    const KRKT = Matrix15.zeros();
    for (let r = 0; r < ESKF_DIM; r++) {
      for (let c = 0; c < ESKF_DIM; c++) {
        let sum = 0.0;
        for (let j = 0; j < m; j++) {
          sum += KR[r][j] * K[c][j];
        }
        KRKT.set(r, c, sum);
      }
    }

    const Pnew = MPMT.add(KRKT);
    Pnew.symmetrizeAndStabilize(1e-12);
    this.P = Pnew;

    return {
      accepted: true,
      residual: z,
      innovationCovariance: S,
    };
  }

  /**
   * Injects the error state vector dx into the nominal navigation state.
   */
  private injectErrorState(dx: number[]): void {
    const s = this.state;

    // Position correction
    s.positionEnu[0] += dx[0];
    s.positionEnu[1] += dx[1];
    s.positionEnu[2] += dx[2];

    // Velocity correction
    s.velocityEnu[0] += dx[3];
    s.velocityEnu[1] += dx[4];
    s.velocityEnu[2] += dx[5];

    // Attitude correction: q = q (x) delta_q(dtheta)
    const dtheta: Vector3 = [dx[6], dx[7], dx[8]];
    const dq = quatFromRotvec(dtheta);
    s.qNb = quatNormalize(quatMultiply(s.qNb, dq));

    // Accel bias correction
    s.accelBias[0] += dx[9];
    s.accelBias[1] += dx[10];
    s.accelBias[2] += dx[11];

    // Gyro bias correction
    s.gyroBias[0] += dx[12];
    s.gyroBias[1] += dx[13];
    s.gyroBias[2] += dx[14];
  }

  // ==========================================
  // Convenience Update Methods
  // ==========================================

  public updateGnssPosition(
    positionEnu: Vector3,
    stdM?: number,
  ): MeasurementUpdateResult {
    const sigma = stdM ?? this.config.measurements.defaultGnssPositionStdM;
    const meas = createGnssPositionMeasurement(positionEnu, this.state, sigma);
    const res = this.update(meas);
    if (res.accepted) this.gnssCount++;
    return res;
  }

  public updateGnssVelocity(
    velocityEnu: Vector3,
    stdMps?: number,
  ): MeasurementUpdateResult {
    const sigma = stdMps ?? this.config.measurements.defaultGnssVelocityStdMps;
    const meas = createGnssVelocityMeasurement(velocityEnu, this.state, sigma);
    const res = this.update(meas);
    if (res.accepted) this.gnssCount++;
    return res;
  }

  public updateForwardVelocity(
    vFwdMps: number,
    stdMps: number,
  ): MeasurementUpdateResult {
    const meas = createForwardVelocityMeasurement(vFwdMps, stdMps, this.state);
    const res = this.update(meas);
    if (res.accepted) this.motionCount++;
    return res;
  }

  public updateYawRate(
    wPredRadps: number,
    stdRadps: number,
    measuredYawRateRadps: number,
  ): MeasurementUpdateResult {
    const meas = createYawRateMeasurement(
      wPredRadps,
      stdRadps,
      measuredYawRateRadps,
      this.state,
    );
    const res = this.update(meas);
    if (res.accepted) this.motionCount++;
    return res;
  }

  public updateMotion(
    pred: MotionPrediction,
    measuredYawRateRadps?: number,
  ): void {
    this.updateForwardVelocity(pred.forwardVelocityMps, pred.velocityStdMps);
    if (measuredYawRateRadps !== undefined) {
      this.updateYawRate(
        pred.yawRateRadps,
        pred.yawRateStdRadps,
        measuredYawRateRadps,
      );
    }
  }

  public updateNhc(
    lateralStdMps?: number,
    verticalStdMps?: number,
  ): MeasurementUpdateResult | null {
    // Gate on forward speed
    const speed = vec3Norm(this.state.velocityEnu);
    if (speed < this.config.measurements.nhcSpeedThresholdMps) {
      return null;
    }

    const latStd = lateralStdMps ?? this.config.measurements.nhcLateralStdMps;
    const vertStd =
      verticalStdMps ?? this.config.measurements.nhcVerticalStdMps;
    const meas = createNhcMeasurement(this.state, latStd, vertStd);
    const res = this.update(meas);
    if (res.accepted) this.nhcCount++;
    return res;
  }

  public updateSoftPosition(
    targetEastNorthM: [number, number],
    baseStdM?: number,
    inflationFactor?: number,
    isRoute = false,
  ): MeasurementUpdateResult {
    const base = baseStdM ?? this.config.measurements.softPolylineBaseStdM;
    const inflation =
      inflationFactor ?? this.config.measurements.softPolylineInflationFactor;

    const meas = createSoftPolylineMeasurement(
      targetEastNorthM,
      this.state,
      base,
      inflation,
    );
    const res = this.update(meas);
    if (res.accepted) {
      if (isRoute) {
        this.routeCount++;
      } else {
        this.roadCount++;
      }
    }
    return res;
  }

  public setPositionEnu(pos: Vector3): void {
    this.state.positionEnu = [pos[0], pos[1], pos[2]];
  }

  public getState(): NavigationState {
    return {
      positionEnu: [...this.state.positionEnu],
      velocityEnu: [...this.state.velocityEnu],
      qNb: [...this.state.qNb],
      accelBias: [...this.state.accelBias],
      gyroBias: [...this.state.gyroBias],
    };
  }

  public getCovariance(): Matrix15 {
    return this.P.clone();
  }

  public getHeadingDeg(): number {
    return headingFromQuatDeg(this.state.qNb);
  }

  public getDiagnostics(): EskfDiagnostics {
    const posVar = this.P.get(0, 0) + this.P.get(1, 1) + this.P.get(2, 2);
    const velVar = this.P.get(3, 3) + this.P.get(4, 4) + this.P.get(5, 5);
    const attVar = this.P.get(6, 6) + this.P.get(7, 7) + this.P.get(8, 8);

    return {
      timestampS: this.lastTimestampS,
      positionEnu: [...this.state.positionEnu],
      velocityEnu: [...this.state.velocityEnu],
      headingDeg: this.getHeadingDeg(),
      accelBias: [...this.state.accelBias],
      gyroBias: [...this.state.gyroBias],
      covarianceTrace: this.P.trace(),
      posUncertaintyM: Math.sqrt(Math.max(0, posVar)),
      velUncertaintyMps: Math.sqrt(Math.max(0, velVar)),
      attUncertaintyDeg: (Math.sqrt(Math.max(0, attVar)) * 180.0) / Math.PI,
      gnssUpdateCount: this.gnssCount,
      motionUpdateCount: this.motionCount,
      nhcUpdateCount: this.nhcCount,
      roadUpdateCount: this.roadCount,
      routeUpdateCount: this.routeCount,
      rejectedUpdatesCount: this.rejectedCount,
    };
  }

  public reset(
    state?: NavigationState,
    covariance?: Matrix15 | number[][],
  ): void {
    if (state) {
      this.state = {
        positionEnu: [...state.positionEnu],
        velocityEnu: [...state.velocityEnu],
        qNb: quatNormalize([...state.qNb]),
        accelBias: [...state.accelBias],
        gyroBias: [...state.gyroBias],
      };
    } else {
      this.state = {
        positionEnu: [0.0, 0.0, 0.0],
        velocityEnu: [0.0, 0.0, 0.0],
        qNb: [1.0, 0.0, 0.0, 0.0],
        accelBias: [0.0, 0.0, 0.0],
        gyroBias: [0.0, 0.0, 0.0],
      };
    }

    if (covariance instanceof Matrix15) {
      this.P = covariance.clone();
    } else if (Array.isArray(covariance)) {
      this.P = new Matrix15(covariance);
    } else {
      this.P = Matrix15.identity();
    }

    this.gnssCount = 0;
    this.motionCount = 0;
    this.nhcCount = 0;
    this.roadCount = 0;
    this.routeCount = 0;
    this.rejectedCount = 0;
    this.lastTimestampS = 0.0;
  }
}
