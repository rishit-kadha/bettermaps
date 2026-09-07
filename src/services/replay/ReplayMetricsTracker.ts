/**
 * ReplayMetricsTracker
 *
 * Real-time quantitative evaluation of dead-reckoning trajectory accuracy.
 *
 * ARCHITECTURAL PRINCIPLE & RESEARCH INTEGRITY:
 * 1. Computes instantaneous distance error e_pos(t) = dist(p_IDR, p_ref) in meters.
 * 2. Evaluates milestone checkpoint errors (5s, 10s, 20s, 30s, 60s) strictly
 *    based on ELAPSED REPLAY TIME, not sample count.
 * 3. Does not call reference GPS "ground truth" unless explicitly established.
 * 4. Logs summary statistics: mean, median, max, final, and drift %.
 */

import { haversineDistance } from "../../core/positioning/coordinates";
import { MilestoneErrors } from "./types";

export interface MetricSnapshot {
  instantaneousErrorMeters: number;
  cumulativeDistanceTraveledM: number;
  driftPercent: number | null;
  meanErrorMeters: number;
  maxErrorMeters: number;
  milestoneErrors: MilestoneErrors;
  milestoneDrifts: MilestoneErrors;
}

export class ReplayMetricsTracker {
  private instantaneousError = 0.0;
  private cumulativeDistanceTraveled = 0.0;
  private lastRefCoordinate: { latitude: number; longitude: number } | null =
    null;

  // History for summary stats
  private errorSamples: number[] = [];
  private outageErrorSamples: number[] = [];
  private postRecoveryErrorSamples: number[] = [];
  private maxError = 0.0;
  private maxOutageError = 0.0;

  // Outage primary tracking
  private endpointError = 0.0;
  private outageDistanceTraveled = 0.0;

  // Recovery tracking
  private errorBeforeRecovery = 0.0;
  private errorFirstFixAfterOutage: number | null = null;
  private recoveryMilestones = {
    at1s: null as number | null,
    at2s: null as number | null,
    at5s: null as number | null,
  };
  private timeToUnder10m: number | null = null;
  private timeToUnder5m: number | null = null;
  private timeToUnder2m: number | null = null;

  // GNSS delivery audit counters
  private gnssDeliveredBeforeOutage = 0;
  private gnssDeliveredDuringOutage = 0;
  private gnssDeliveredAfterOutage = 0;

  // Outage state
  private isCurrentlyInOutage = false;
  private outageStartTimeMs: number | null = null;
  private outageEndTimeMs: number | null = null;
  private milestoneErrors: MilestoneErrors = {
    at5s: null,
    at10s: null,
    at20s: null,
    at30s: null,
    at60s: null,
  };
  private milestoneDrifts: MilestoneErrors = {
    at5s: null,
    at10s: null,
    at20s: null,
    at30s: null,
    at60s: null,
  };

  public reset(): void {
    this.isCurrentlyInOutage = false;
    this.instantaneousError = 0.0;
    this.cumulativeDistanceTraveled = 0.0;
    this.lastRefCoordinate = null;
    this.errorSamples = [];
    this.outageErrorSamples = [];
    this.postRecoveryErrorSamples = [];
    this.maxError = 0.0;
    this.maxOutageError = 0.0;
    this.endpointError = 0.0;
    this.outageDistanceTraveled = 0.0;
    this.errorBeforeRecovery = 0.0;
    this.errorFirstFixAfterOutage = null;
    this.recoveryMilestones = {
      at1s: null,
      at2s: null,
      at5s: null,
    };
    this.timeToUnder10m = null;
    this.timeToUnder5m = null;
    this.timeToUnder2m = null;
    this.gnssDeliveredBeforeOutage = 0;
    this.gnssDeliveredDuringOutage = 0;
    this.gnssDeliveredAfterOutage = 0;
    this.outageStartTimeMs = null;
    this.outageEndTimeMs = null;
    this.milestoneErrors = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
    this.milestoneDrifts = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
  }

  public notifyOutageStarted(currentTimeMs: number): void {
    this.isCurrentlyInOutage = true;
    this.outageStartTimeMs = currentTimeMs;
    this.outageEndTimeMs = null;
    this.outageDistanceTraveled = 0.0;
    this.endpointError = 0.0;
    this.milestoneErrors = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
    this.milestoneDrifts = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
  }

  public notifyOutageEnded(currentTimeMs: number): void {
    this.isCurrentlyInOutage = false;
    this.outageEndTimeMs = currentTimeMs;
    this.errorBeforeRecovery = this.endpointError;
  }

  public recordGnssDelivered(isOutage: boolean): void {
    if (isOutage) {
      this.gnssDeliveredDuringOutage++;
    } else if (this.outageEndTimeMs !== null) {
      this.gnssDeliveredAfterOutage++;
    } else {
      this.gnssDeliveredBeforeOutage++;
    }
  }

  /**
   * Update metrics with incoming reference and estimated coordinates.
   */
  public update(
    refLat: number,
    refLon: number,
    estLat: number,
    estLon: number,
    replayElapsedMs: number,
    isOutage: boolean,
  ): MetricSnapshot {
    // 1. Accumulate reference distance traveled
    if (this.lastRefCoordinate) {
      const stepDist = haversineDistance(
        this.lastRefCoordinate.latitude,
        this.lastRefCoordinate.longitude,
        refLat,
        refLon,
      );
      this.cumulativeDistanceTraveled += stepDist;
      if (isOutage) {
        this.outageDistanceTraveled += stepDist;
      }
    }
    this.lastRefCoordinate = { latitude: refLat, longitude: refLon };

    // 2. Compute instantaneous position error
    this.instantaneousError = haversineDistance(refLat, refLon, estLat, estLon);
    this.errorSamples.push(this.instantaneousError);
    if (this.instantaneousError > this.maxError) {
      this.maxError = this.instantaneousError;
    }

    if (isOutage) {
      this.outageErrorSamples.push(this.instantaneousError);
      this.endpointError = this.instantaneousError;
      if (this.instantaneousError > this.maxOutageError) {
        this.maxOutageError = this.instantaneousError;
      }
    } else if (this.outageEndTimeMs !== null) {
      this.postRecoveryErrorSamples.push(this.instantaneousError);

      if (this.errorFirstFixAfterOutage === null) {
        this.errorFirstFixAfterOutage = this.instantaneousError;
      }

      const recElapsedSec = (replayElapsedMs - this.outageEndTimeMs) / 1000.0;
      if (this.recoveryMilestones.at1s === null && recElapsedSec >= 1.0) {
        this.recoveryMilestones.at1s =
          Math.round(this.instantaneousError * 10) / 10;
      }
      if (this.recoveryMilestones.at2s === null && recElapsedSec >= 2.0) {
        this.recoveryMilestones.at2s =
          Math.round(this.instantaneousError * 10) / 10;
      }
      if (this.recoveryMilestones.at5s === null && recElapsedSec >= 5.0) {
        this.recoveryMilestones.at5s =
          Math.round(this.instantaneousError * 10) / 10;
      }

      if (this.timeToUnder10m === null && this.instantaneousError < 10.0) {
        this.timeToUnder10m = Math.round(recElapsedSec * 10) / 10;
      }
      if (this.timeToUnder5m === null && this.instantaneousError < 5.0) {
        this.timeToUnder5m = Math.round(recElapsedSec * 10) / 10;
      }
      if (this.timeToUnder2m === null && this.instantaneousError < 2.0) {
        this.timeToUnder2m = Math.round(recElapsedSec * 10) / 10;
      }
    }

    this.isCurrentlyInOutage = isOutage;

    // 3. Compute SIH drift percentage strictly during GNSS outage
    // SIH Drift % = (position drift during GNSS-denied period) / (distance travelled during GNSS-denied period) * 100
    let driftPercent: number | null = null;
    if (isOutage) {
      if (this.outageDistanceTraveled >= 5.0) {
        driftPercent = (this.instantaneousError / this.outageDistanceTraveled) * 100.0;
      }
    }

    // 4. Milestone Checkpoints based on elapsed outage time
    const elapsedSec =
      isOutage && this.outageStartTimeMs !== null
        ? (replayElapsedMs - this.outageStartTimeMs) / 1000.0
        : replayElapsedMs / 1000.0;

    // Denominator is the reference distance traveled from outage start through that milestone
    const calcDrift = (err: number) => {
      return isOutage && this.outageDistanceTraveled >= 5.0
        ? Math.round((err / this.outageDistanceTraveled) * 1000) / 10
        : null;
    };

    if (isOutage) {
      if (this.milestoneErrors.at5s === null && elapsedSec >= 5.0) {
        this.milestoneErrors.at5s = Math.round(this.instantaneousError * 10) / 10;
        this.milestoneDrifts.at5s = calcDrift(this.instantaneousError);
      }
      if (this.milestoneErrors.at10s === null && elapsedSec >= 10.0) {
        this.milestoneErrors.at10s =
          Math.round(this.instantaneousError * 10) / 10;
        this.milestoneDrifts.at10s = calcDrift(this.instantaneousError);
      }
      if (this.milestoneErrors.at20s === null && elapsedSec >= 20.0) {
        this.milestoneErrors.at20s =
          Math.round(this.instantaneousError * 10) / 10;
        this.milestoneDrifts.at20s = calcDrift(this.instantaneousError);
      }
      if (this.milestoneErrors.at30s === null && elapsedSec >= 30.0) {
        this.milestoneErrors.at30s =
          Math.round(this.instantaneousError * 10) / 10;
        this.milestoneDrifts.at30s = calcDrift(this.instantaneousError);
      }
      if (this.milestoneErrors.at60s === null && elapsedSec >= 60.0) {
        this.milestoneErrors.at60s =
          Math.round(this.instantaneousError * 10) / 10;
        this.milestoneDrifts.at60s = calcDrift(this.instantaneousError);
      }
    }

    const meanError =
      this.errorSamples.reduce((a, b) => a + b, 0) / this.errorSamples.length;

    return {
      instantaneousErrorMeters: this.instantaneousError,
      cumulativeDistanceTraveledM: this.cumulativeDistanceTraveled,
      driftPercent,
      meanErrorMeters: meanError,
      maxErrorMeters: this.maxError,
      milestoneErrors: { ...this.milestoneErrors },
      milestoneDrifts: { ...this.milestoneDrifts },
    };
  }

  public getSnapshot(): MetricSnapshot {
    const meanError =
      this.errorSamples.length > 0
        ? this.errorSamples.reduce((a, b) => a + b, 0) /
          this.errorSamples.length
        : 0.0;

    const driftPercent =
      this.isCurrentlyInOutage && this.outageDistanceTraveled >= 5.0
        ? (this.instantaneousError / this.outageDistanceTraveled) * 100.0
        : null;

    return {
      instantaneousErrorMeters: this.instantaneousError,
      cumulativeDistanceTraveledM: this.cumulativeDistanceTraveled,
      driftPercent,
      meanErrorMeters: meanError,
      maxErrorMeters: this.maxError,
      milestoneErrors: { ...this.milestoneErrors },
      milestoneDrifts: { ...this.milestoneDrifts },
    };
  }

  public getDetailedReport() {
    const calcStats = (arr: number[]) => {
      if (arr.length === 0)
        return { mean: 0, median: 0, p90: 0, p95: 0, max: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const median = sorted[Math.floor(sorted.length * 0.5)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const max = sorted[sorted.length - 1];
      return { mean, median, p90, p95, max };
    };

    const overall = calcStats(this.errorSamples);
    const outage = calcStats(this.outageErrorSamples);
    const post = calcStats(this.postRecoveryErrorSamples);

    const outDist = this.outageDistanceTraveled;
    const endpointDriftPercent =
      outDist >= 5.0
        ? Math.round((this.endpointError / outDist) * 100 * 100) / 100
        : null;
    const maxDriftPercent =
      outDist >= 5.0
        ? Math.round((outage.max / outDist) * 100 * 100) / 100
        : null;

    return {
      meanErrorMeters: Math.round(overall.mean * 100) / 100,
      medianErrorMeters: Math.round(overall.median * 100) / 100,
      p90ErrorMeters: Math.round(overall.p90 * 100) / 100,
      p95ErrorMeters: Math.round(overall.p95 * 100) / 100,
      maxErrorMeters: Math.round(overall.max * 100) / 100,

      // Outage Primary Metrics
      endpointErrorMeters: Math.round(this.endpointError * 100) / 100,
      outageMeanErrorMeters: Math.round(outage.mean * 100) / 100,
      outageMedianErrorMeters: Math.round(outage.median * 100) / 100,
      outageP90ErrorMeters: Math.round(outage.p90 * 100) / 100,
      outageP95ErrorMeters: Math.round(outage.p95 * 100) / 100,
      outageMaxErrorMeters: Math.round(outage.max * 100) / 100,
      outageDistanceMeters: Math.round(outDist * 100) / 100,

      // Dual Drift Metrics
      endpointDriftPercent: endpointDriftPercent ?? 0.0,
      maxDriftPercent: maxDriftPercent ?? 0.0,
      under10pctEndpointDrift:
        endpointDriftPercent !== null ? endpointDriftPercent < 10.0 : false,
      under10pctMaxDrift:
        maxDriftPercent !== null ? maxDriftPercent < 10.0 : false,

      // Recovery Metrics
      errorBeforeRecoveryMeters: Math.round(this.endpointError * 100) / 100,
      errorFirstFixAfterOutageMeters:
        this.errorFirstFixAfterOutage !== null
          ? Math.round(this.errorFirstFixAfterOutage * 100) / 100
          : null,
      recoveryMilestones: { ...this.recoveryMilestones },
      timeToUnder10mSec: this.timeToUnder10m,
      timeToUnder5mSec: this.timeToUnder5m,
      timeToUnder2mSec: this.timeToUnder2m,
      postRecoveryErrorMeters: Math.round(post.mean * 100) / 100,

      // Audit Counters
      gnssDeliveredBeforeOutage: this.gnssDeliveredBeforeOutage,
      gnssDeliveredDuringOutage: this.gnssDeliveredDuringOutage,
      gnssDeliveredAfterOutage: this.gnssDeliveredAfterOutage,
      outageValid: this.gnssDeliveredDuringOutage === 0,
      milestoneErrors: { ...this.milestoneErrors },
    };
  }
}
