/**
 * Shared Navigation State Types for the Presentation Layer.
 */

import { NavLocation, ProviderStatus, ProviderType } from "./location";

/**
 * Navigation Camera Tracking Modes:
 * - follow_course: Course-Up mode (camera tracks vehicle heading with 3D driving tilt)
 * - follow_north: North-Up mode (camera tracks vehicle position with 2D top-down view)
 * - free: Free-look mode (camera uncoupled from vehicle; user can pan/zoom freely)
 */
export type NavigationMode = "follow_course" | "follow_north" | "free";

/**
 * Normalized telemetry payload exposed by NavigationManager to UI components.
 */
export interface NavigationTelemetry {
  currentLocation: NavLocation | null;
  speedKmh: number;
  smoothedHeading: number;
  isHeadingReliable: boolean;
  updateFrequencyHz: number;
  mode: NavigationMode;
  providerStatus: ProviderStatus;
  providerName: string;
  providerType: ProviderType;
  isDeadReckoning: boolean;
  historyTrail: { latitude: number; longitude: number }[];
}
