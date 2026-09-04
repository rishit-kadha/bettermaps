/**
 * Google Routes Platform Service
 *
 * Calls the Google Routes API (or Directions API) to calculate the primary driving route,
 * decodes the high-precision polyline, and builds the mathematically rigorous ActiveRoute.
 *
 * ARCHITECTURAL RULE:
 * Does NOT generate fake straight-line routes silently. If the API is unavailable,
 * it returns a structured error so the UI displays a clear diagnostic notice.
 */

import {
  buildRouteGeometry,
  haversineDistance,
} from "../../core/navigation/routeGeometry";
import {
  ActiveRoute,
  ManeuverType,
  RouteGeometry,
  RoutePoint,
  RouteStep,
} from "../../core/types/navigation";
import { decodeGooglePolyline } from "./polylineDecoder";

function getApiKey(): string {
  return (
    process.env.EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    ""
  ).trim();
}

function getRequestHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask":
      "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps,routes.viewport",
    "X-Android-Package": "com.sih.bettermaps",
    "X-Android-Cert": "5E8F16062EA3CD2C4A0D547876BAA6F38CABF625",
  };
}

export interface RouteRequestParams {
  origin: RoutePoint;
  destination: RoutePoint;
  destinationName: string;
  destinationAddress: string;
}

export interface RouteResponse {
  route: ActiveRoute | null;
  error?: string;
}

/**
 * Computes a real driving route using the Google Routes API v2.
 */
export async function calculateRoute(
  params: RouteRequestParams,
): Promise<RouteResponse> {
  const { origin, destination, destinationName, destinationAddress } = params;
  const apiKey = getApiKey();

  if (!apiKey) {
    return {
      route: null,
      error: "Google Maps / Routes API key is not configured in .env",
    };
  }

  // 1. Try Google Routes API v2 (Modern Google Platform Standard)
  try {
    const url = "https://routes.googleapis.com/directions/v2:computeRoutes";
    const body = {
      origin: {
        location: {
          latLng: {
            latitude: origin.latitude,
            longitude: origin.longitude,
          },
        },
      },
      destination: {
        location: {
          latLng: {
            latitude: destination.latitude,
            longitude: destination.longitude,
          },
        },
      },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
      languageCode: "en-US",
      units: "METRIC",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (data.routes && data.routes.length > 0) {
      const gRoute = data.routes[0];
      const encodedPolyline = gRoute.polyline?.encodedPolyline || "";
      const points = decodeGooglePolyline(encodedPolyline);

      if (points.length >= 2) {
        const geometry = buildRouteGeometry(points);
        const totalDistanceMeters =
          gRoute.distanceMeters || geometry.totalLengthMeters;

        // Parse duration (formatted like "1234s")
        let totalDurationSeconds = 600;
        if (typeof gRoute.duration === "string") {
          const parsedSec = parseInt(gRoute.duration.replace("s", ""), 10);
          if (!isNaN(parsedSec)) totalDurationSeconds = parsedSec;
        }

        // Build steps with along-track distances
        const steps = parseRoutesApiSteps(
          gRoute.legs?.[0]?.steps || [],
          geometry,
        );

        const bounds = gRoute.viewport
          ? {
              southwest: {
                latitude: gRoute.viewport.low.latitude,
                longitude: gRoute.viewport.low.longitude,
              },
              northeast: {
                latitude: gRoute.viewport.high.latitude,
                longitude: gRoute.viewport.high.longitude,
              },
            }
          : computeBoundingBox(points);

        return {
          route: {
            metadata: {
              id: `route_${Date.now()}`,
              destinationName,
              destinationAddress,
              destinationCoordinate: destination,
              totalDistanceMeters,
              totalDurationSeconds,
              bounds,
            },
            geometry,
            steps,
          },
        };
      }
    }

    if (data.error) {
      // If Routes API v2 has an issue, attempt fallback to Directions API before erroring
      console.warn(
        "Routes API returned error, trying Directions API:",
        data.error.message,
      );
      return await calculateDirectionsApiFallback(params);
    }
  } catch (err: any) {
    console.warn("Routes API network attempt failed:", err.message);
    return await calculateDirectionsApiFallback(params);
  }

  return await calculateDirectionsApiFallback(params);
}

/**
 * Fallback to Google Directions API (web service) in case the Cloud project enabled
 * Directions API rather than Routes API.
 */
async function calculateDirectionsApiFallback(
  params: RouteRequestParams,
): Promise<RouteResponse> {
  const { origin, destination, destinationName, destinationAddress } = params;
  const apiKey = getApiKey();

  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&mode=driving&key=${apiKey}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Android-Package": "com.sih.bettermaps",
        "X-Android-Cert": "5E8F16062EA3CD2C4A0D547876BAA6F38CABF625",
      },
    });

    const data = await response.json();

    if (data.status === "OK" && data.routes && data.routes.length > 0) {
      const gRoute = data.routes[0];
      const leg = gRoute.legs?.[0];
      const encodedPolyline = gRoute.overview_polyline?.points || "";
      const points = decodeGooglePolyline(encodedPolyline);

      if (points.length >= 2) {
        const geometry = buildRouteGeometry(points);
        const totalDistanceMeters =
          leg?.distance?.value || geometry.totalLengthMeters;
        const totalDurationSeconds = leg?.duration?.value || 600;

        const steps = parseDirectionsApiSteps(leg?.steps || [], geometry);
        const bounds = gRoute.bounds
          ? {
              southwest: {
                latitude: gRoute.bounds.southwest.lat,
                longitude: gRoute.bounds.southwest.lng,
              },
              northeast: {
                latitude: gRoute.bounds.northeast.lat,
                longitude: gRoute.bounds.northeast.lng,
              },
            }
          : computeBoundingBox(points);

        return {
          route: {
            metadata: {
              id: `route_${Date.now()}`,
              destinationName,
              destinationAddress,
              destinationCoordinate: destination,
              totalDistanceMeters,
              totalDurationSeconds,
              bounds,
            },
            geometry,
            steps,
          },
        };
      }
    }

    const errorMsg =
      data.error_message ||
      data.status ||
      "Unable to calculate driving route between selected points.";

    return {
      route: null,
      error: `Google Routes/Directions Error: ${errorMsg}. Please ensure 'Routes API' or 'Directions API' is enabled in Google Cloud Console.`,
    };
  } catch (err: any) {
    return {
      route: null,
      error: `Network error connecting to Google Routing Service: ${err.message}`,
    };
  }
}

function parseRoutesApiSteps(
  rawSteps: any[],
  geometry: RouteGeometry,
): RouteStep[] {
  const steps: RouteStep[] = [];
  let currentAlongTrack = 0;

  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    const dist = s.distanceMeters || 100;
    const durStr = s.staticDuration || "30s";
    const durSec = parseInt(durStr.replace("s", ""), 10) || 30;

    const startLoc: RoutePoint = {
      latitude: s.startLocation?.latLng?.latitude ?? 0,
      longitude: s.startLocation?.latLng?.longitude ?? 0,
    };
    const endLoc: RoutePoint = {
      latitude: s.endLocation?.latLng?.latitude ?? 0,
      longitude: s.endLocation?.latLng?.longitude ?? 0,
    };

    const instruction =
      s.navigationInstruction?.instructions ||
      cleanHtmlInstructions(s.htmlInstructions || "") ||
      `Proceed for ${Math.round(dist)} m`;

    const maneuverType = mapManeuver(s.navigationInstruction?.maneuver);

    const startDist = currentAlongTrack;
    currentAlongTrack += dist;
    const endDist = Math.min(geometry.totalLengthMeters, currentAlongTrack);

    steps.push({
      stepIndex: i,
      instruction,
      maneuverType,
      distanceMeters: dist,
      durationSeconds: durSec,
      startPoint: startLoc,
      endPoint: endLoc,
      startDistanceAlongRoute: startDist,
      endDistanceAlongRoute: endDist,
    });
  }

  // Fallback single step if no detailed steps returned
  if (steps.length === 0 && geometry.points.length >= 2) {
    steps.push({
      stepIndex: 0,
      instruction: "Drive to destination",
      maneuverType: "straight",
      distanceMeters: geometry.totalLengthMeters,
      durationSeconds: 300,
      startPoint: geometry.points[0],
      endPoint: geometry.points[geometry.points.length - 1],
      startDistanceAlongRoute: 0,
      endDistanceAlongRoute: geometry.totalLengthMeters,
    });
  }

  return steps;
}

function parseDirectionsApiSteps(
  rawSteps: any[],
  geometry: RouteGeometry,
): RouteStep[] {
  const steps: RouteStep[] = [];
  let currentAlongTrack = 0;

  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    const dist = s.distance?.value || 100;
    const durSec = s.duration?.value || 30;

    const startLoc: RoutePoint = {
      latitude: s.start_location?.lat,
      longitude: s.start_location?.lng,
    };
    const endLoc: RoutePoint = {
      latitude: s.end_location?.lat,
      longitude: s.end_location?.lng,
    };

    const instruction = cleanHtmlInstructions(
      s.html_instructions || `Proceed ${dist} m`,
    );
    const maneuverType = mapManeuver(s.maneuver);

    const startDist = currentAlongTrack;
    currentAlongTrack += dist;
    const endDist = Math.min(geometry.totalLengthMeters, currentAlongTrack);

    steps.push({
      stepIndex: i,
      instruction,
      maneuverType,
      distanceMeters: dist,
      durationSeconds: durSec,
      startPoint: startLoc,
      endPoint: endLoc,
      startDistanceAlongRoute: startDist,
      endDistanceAlongRoute: endDist,
    });
  }

  return steps;
}

function cleanHtmlInstructions(html: string): string {
  if (!html) return "Continue along the route";
  return html
    .replace(/<div[^>]*>/gi, " - ")
    .replace(/<\/div>/gi, "")
    .replace(/<b>/gi, "")
    .replace(/<\/b>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapManeuver(raw?: string): ManeuverType {
  if (!raw) return "straight";
  const m = raw.toLowerCase().replace(/_/g, "-");
  if (m.includes("turn-left")) return "turn-left";
  if (m.includes("turn-right")) return "turn-right";
  if (m.includes("slight-left")) return "turn-slight-left";
  if (m.includes("slight-right")) return "turn-slight-right";
  if (m.includes("sharp-left")) return "turn-sharp-left";
  if (m.includes("sharp-right")) return "turn-sharp-right";
  if (m.includes("uturn") || m.includes("u-turn")) return "uturn";
  if (m.includes("fork")) return "fork";
  if (m.includes("ramp")) return "ramp";
  if (m.includes("roundabout")) return "roundabout";
  if (m.includes("depart")) return "depart";
  if (m.includes("arrive")) return "arrive";
  return "straight";
}

function computeBoundingBox(points: RoutePoint[]): {
  southwest: RoutePoint;
  northeast: RoutePoint;
} {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }

  return {
    southwest: { latitude: minLat, longitude: minLng },
    northeast: { latitude: maxLat, longitude: maxLng },
  };
}
