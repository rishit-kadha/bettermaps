/**
 * ProbabilisticRoadConstraint.ts
 *
 * Probabilistic soft road network constraint engine.
 * Consumes hypotheses from MultiCandidateRoadMatcher and injects confident
 * road projections into the 15-state ESKF via formal Kalman updates.
 *
 * Replaces hard snaps with Bayesian observation updates:
 * z = p_road_proj - p_nom
 * H = [I_2, 0_{2x13}]
 * R = (sigma_base^2 + (kappa * d_perp)^2) * I_2
 */

import { Eskf } from "../eskf/Eskf";
import { Wgs84Coordinate } from "../coordinates";
import { MultiCandidateRoadMatcher } from "../../navigation/road/MultiCandidateRoadMatcher";
import { RoadCandidate } from "../../navigation/road/RoadTypes";

export interface RoadConstraintConfig {
  /** Base standard deviation in meters (sigma_base) */
  baseStdMeters: number;
  /** Covariance inflation slope with cross-track distance (kappa) */
  inflationFactor: number;
  /** Maximum cross-track distance before constraint gates off (meters) */
  maxCrossTrackMeters: number;
}

export const DEFAULT_ROAD_CONSTRAINT_CONFIG: RoadConstraintConfig = {
  baseStdMeters: 8.0,
  inflationFactor: 0.5,
  maxCrossTrackMeters: 35.0,
};

export interface RoadConstraintEvaluationResult {
  applied: boolean;
  matchedCandidate?: RoadCandidate;
  rejectionReason?: string;
}

export class ProbabilisticRoadConstraint {
  private readonly matcher: MultiCandidateRoadMatcher;
  private readonly config: RoadConstraintConfig;
  private isEnabled = true;
  private appliedUpdateCount = 0;

  constructor(
    matcher: MultiCandidateRoadMatcher,
    config?: Partial<RoadConstraintConfig>,
  ) {
    this.matcher = matcher;
    this.config = { ...DEFAULT_ROAD_CONSTRAINT_CONFIG, ...config };
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public getAppliedUpdateCount(): number {
    return this.appliedUpdateCount;
  }

  public reset(): void {
    this.appliedUpdateCount = 0;
    this.matcher.reset();
  }

  /**
   * Evaluates nearby road network candidates and applies a soft Kalman update
   * if a high-confidence, unambiguous road candidate exists.
   */
  public evaluateAndApply(
    eskf: Eskf,
    originWgs: Wgs84Coordinate,
  ): RoadConstraintEvaluationResult {
    if (!this.isEnabled) {
      return { applied: false, rejectionReason: "Road constraint disabled" };
    }

    const state = eskf.getState();
    const currEnu: [number, number] = [
      state.positionEnu[0],
      state.positionEnu[1],
    ];
    const headingDeg = eskf.getHeadingDeg();

    const candidate = this.matcher.match(currEnu, headingDeg, originWgs);
    if (!candidate) {
      return {
        applied: false,
        rejectionReason:
          "No unambiguous road candidate passed confidence and margin thresholds",
      };
    }

    if (candidate.crossTrackDistanceMeters > this.config.maxCrossTrackMeters) {
      return {
        applied: false,
        matchedCandidate: candidate,
        rejectionReason: `Cross-track distance ${candidate.crossTrackDistanceMeters.toFixed(1)}m exceeds limit ${this.config.maxCrossTrackMeters}m`,
      };
    }

    // Apply soft Kalman update
    eskf.updateSoftPosition(
      candidate.projectedEnu,
      this.config.baseStdMeters,
      this.config.inflationFactor,
      false, // isRoute = false (road network update)
    );
    this.appliedUpdateCount++;

    return {
      applied: true,
      matchedCandidate: candidate,
    };
  }
}
