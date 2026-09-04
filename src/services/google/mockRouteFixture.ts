/**
 * Explicit Mock/Development Route Fixture
 *
 * Provides a verified urban road route for offline development and acceptance testing.
 * Strictly gated behind explicit development/simulator mode — never invoked silently in production.
 */

import { buildRouteGeometry } from "../../core/navigation/routeGeometry";
import {
  ActiveRoute,
  RoutePoint,
  RouteStep,
} from "../../core/types/navigation";

// Real street route around Connaught Place Outer Circle, New Delhi
const SIMULATOR_WAYPOINTS: RoutePoint[] = [
  { latitude: 28.6315, longitude: 77.2167 }, // Connaught Place Radial 1
  { latitude: 28.6322, longitude: 77.2174 },
  { latitude: 28.6331, longitude: 77.2185 },
  { latitude: 28.6342, longitude: 77.2198 }, // Barakhamba Road intersection
  { latitude: 28.6355, longitude: 77.2205 },
  { latitude: 28.6368, longitude: 77.2212 }, // Kasturba Gandhi Marg
  { latitude: 28.6375, longitude: 77.2225 },
  { latitude: 28.6372, longitude: 77.2241 }, // Outer Circle East
  { latitude: 28.636, longitude: 77.2255 },
  { latitude: 28.6345, longitude: 77.226 }, // Sansad Marg turn
  { latitude: 28.633, longitude: 77.2252 },
  { latitude: 28.6318, longitude: 77.2238 },
  { latitude: 28.6312, longitude: 77.222 },
  { latitude: 28.631, longitude: 77.2195 },
  { latitude: 28.6315, longitude: 77.2167 }, // Arrival at starting loop
];

export function getMockDevelopmentRoute(): ActiveRoute {
  const geometry = buildRouteGeometry(SIMULATOR_WAYPOINTS);

  const steps: RouteStep[] = [
    {
      stepIndex: 0,
      instruction: "Head east on Connaught Circus",
      maneuverType: "straight",
      distanceMeters: 450,
      durationSeconds: 45,
      startPoint: SIMULATOR_WAYPOINTS[0],
      endPoint: SIMULATOR_WAYPOINTS[3],
      startDistanceAlongRoute: 0,
      endDistanceAlongRoute: 450,
    },
    {
      stepIndex: 1,
      instruction: "Turn slight left toward Barakhamba Road",
      maneuverType: "turn-slight-left",
      distanceMeters: 550,
      durationSeconds: 60,
      startPoint: SIMULATOR_WAYPOINTS[3],
      endPoint: SIMULATOR_WAYPOINTS[7],
      startDistanceAlongRoute: 450,
      endDistanceAlongRoute: 1000,
    },
    {
      stepIndex: 2,
      instruction: "Continue onto Outer Circle East",
      maneuverType: "straight",
      distanceMeters: 600,
      durationSeconds: 70,
      startPoint: SIMULATOR_WAYPOINTS[7],
      endPoint: SIMULATOR_WAYPOINTS[11],
      startDistanceAlongRoute: 1000,
      endDistanceAlongRoute: 1600,
    },
    {
      stepIndex: 3,
      instruction: "You will arrive at Connaught Place Loop",
      maneuverType: "arrive",
      distanceMeters: geometry.totalLengthMeters - 1600,
      durationSeconds: 50,
      startPoint: SIMULATOR_WAYPOINTS[11],
      endPoint: SIMULATOR_WAYPOINTS[SIMULATOR_WAYPOINTS.length - 1],
      startDistanceAlongRoute: 1600,
      endDistanceAlongRoute: geometry.totalLengthMeters,
    },
  ];

  return {
    metadata: {
      id: "mock_cp_loop",
      destinationName: "Connaught Place Inner Circle",
      destinationAddress: "Connaught Place, New Delhi, Delhi 110001",
      destinationCoordinate:
        SIMULATOR_WAYPOINTS[SIMULATOR_WAYPOINTS.length - 1],
      totalDistanceMeters: geometry.totalLengthMeters,
      totalDurationSeconds: 225,
      bounds: {
        southwest: { latitude: 28.6305, longitude: 77.2155 },
        northeast: { latitude: 28.6385, longitude: 77.227 },
      },
      isMockRoute: true,
    },
    geometry,
    steps,
  };
}
