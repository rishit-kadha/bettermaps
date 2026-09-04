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
  driftPercent: number;
  meanErrorMeters: number;
  maxErrorMeters: number;
  milestoneErrors: MilestoneErrors;
}

export class ReplayMetricsTracker {
  private instantaneousError = 0.0;
  private cumulativeDistanceTraveled = 0.0;
  private lastRefCoordinate: { latitude: number; longitude: number } | null =
    null;

  // History for summary stats
  private errorSamples: number[] = [];
  private maxError = 0.0;

  // Outage milestone tracking based on elapsed outage time
  private outageStartTimeMs: number | null = null;
  private milestoneErrors: MilestoneErrors = {
    at5s: null,
    at10s: null,
    at20s: null,
    at30s: null,
    at60s: null,
  };

  public reset(): void {
    this.instantaneousError = 0.0;
    this.cumulativeDistanceTraveled = 0.0;
    this.lastRefCoordinate = null;
    this.errorSamples = [];
    this.maxError = 0.0;
    this.outageStartTimeMs = null;
    this.milestoneErrors = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
  }

  public notifyOutageStarted(currentTimeMs: number): void {
    this.outageStartTimeMs = currentTimeMs;
    this.milestoneErrors = {
      at5s: null,
      at10s: null,
      at20s: null,
      at30s: null,
      at60s: null,
    };
  }

  public notifyOutageEnded(): void {
    this.outageStartTimeMs = null;
  }

  /**
   * Update metrics with incoming reference and estimated coordinates.
   *
   * @param refLat Reference GPS latitude
   * @param refLon Reference GPS longitude
   * @param estLat Estimated IDR latitude
   * @param estLon Estimated IDR longitude
   * @param replayElapsedMs Elapsed replay time in milliseconds
   * @param isOutage Whether GNSS is currently denied to the estimator
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
    }
    this.lastRefCoordinate = { latitude: refLat, longitude: refLon };

    // 2. Compute instantaneous position error
    this.instantaneousError = haversineDistance(refLat, refLon, estLat, estLon);
    this.errorSamples.push(this.instantaneousError);
    if (this.instantaneousError > this.maxError) {
      this.maxError = this.instantaneousError;
    }

    // 3. Compute drift percentage relative to distance traveled
    const driftPercent =
      this.cumulativeDistanceTraveled > 10.0
        ? (this.instantaneousError / this.cumulativeDistanceTraveled) * 100.0
        : 0.0;

    // 4. Milestone Checkpoints based on elapsed time
    // If during outage, measure from outage start; otherwise measure from replay start
    const elapsedSec =
      isOutage && this.outageStartTimeMs !== null
        ? (replayElapsedMs - this.outageStartTimeMs) / 1000.0
        : replayElapsedMs / 1000.0;

    if (this.milestoneErrors.at5s === null && elapsedSec >= 5.0) {
      this.milestoneErrors.at5s = Math.round(this.instantaneousError * 10) / 10;
    }
    if (this.milestoneErrors.at10s === null && elapsedSec >= 10.0) {
      this.milestoneErrors.at10s =
        Math.round(this.instantaneousError * 10) / 10;
    }
    if (this.milestoneErrors.at20s === null && elapsedSec >= 20.0) {
      this.milestoneErrors.at20s =
        Math.round(this.instantaneousError * 10) / 10;
    }
    if (this.milestoneErrors.at30s === null && elapsedSec >= 30.0) {
      this.milestoneErrors.at30s =
        Math.round(this.instantaneousError * 10) / 10;
    }
    if (this.milestoneErrors.at60s === null && elapsedSec >= 60.0) {
      this.milestoneErrors.at60s =
        Math.round(this.instantaneousError * 10) / 10;
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
    };
  }

  public getSnapshot(): MetricSnapshot {
    const meanError =
      this.errorSamples.length > 0
        ? this.errorSamples.reduce((a, b) => a + b, 0) /
          this.errorSamples.length
        : 0.0;

    const driftPercent =
      this.cumulativeDistanceTraveled > 10.0
        ? (this.instantaneousError / this.cumulativeDistanceTraveled) * 100.0
        : 0.0;

    return {
      instantaneousErrorMeters: this.instantaneousError,
      cumulativeDistanceTraveledM: this.cumulativeDistanceTraveled,
      driftPercent,
      meanErrorMeters: meanError,
      maxErrorMeters: this.maxError,
      milestoneErrors: { ...this.milestoneErrors },
    };
  }
}
