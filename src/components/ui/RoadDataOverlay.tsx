import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RoadDataManagerDiagnostics } from "../../core/navigation/road/RoadDataManager";

interface RoadDataOverlayProps {
  roadDiagnostics: RoadDataManagerDiagnostics | null | undefined;
  roadUpdateCount: number;
  routeUpdateCount: number;
  showRoadCoverage: boolean;
  onToggleRoadCoverage: () => void;
  visible: boolean;
}

type BadgeColor = {
  bg: string;
  text: string;
  label: string;
};

function getCoverageBadge(
  state: RoadDataManagerDiagnostics["coverageState"] | undefined
): BadgeColor {
  switch (state) {
    case "COMPLETE":
      return { bg: "#1b8a4a", text: "#ffffff", label: "COMPLETE" };
    case "FETCHING":
      return { bg: "#b8860b", text: "#ffffff", label: "FETCHING" };
    case "PARTIAL":
      return { bg: "#c0581a", text: "#ffffff", label: "PARTIAL" };
    case "OFFLINE":
      return { bg: "#b91c1c", text: "#ffffff", label: "OFFLINE" };
    case "UNAVAILABLE":
    default:
      return { bg: "#4b5563", text: "#ffffff", label: "UNAVAILABLE" };
  }
}

export const RoadDataOverlay: React.FC<RoadDataOverlayProps> = ({
  roadDiagnostics,
  roadUpdateCount,
  routeUpdateCount,
  showRoadCoverage,
  onToggleRoadCoverage,
  visible,
}) => {
  if (!visible) return null;

  const badge = getCoverageBadge(roadDiagnostics?.coverageState);

  return (
    <View style={styles.container} pointerEvents="auto">
      {/* Title row */}
      <View style={styles.titleRow}>
        <View style={styles.devBadge}>
          <Text style={styles.devBadgeText}>DEV</Text>
        </View>
        <Text style={styles.title}>ROAD-DATA COVERAGE</Text>
      </View>

      {/* Mode + Coverage state */}
      <View style={styles.row}>
        <Text style={styles.label}>Mode:</Text>
        <Text style={styles.value}>{roadDiagnostics?.mode ?? "—"}</Text>
        <View style={[styles.stateBadge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.stateBadgeText, { color: badge.text }]}>
            {badge.label}
          </Text>
        </View>
      </View>

      {/* Tile counts */}
      <View style={styles.row}>
        <Text style={styles.label}>Loaded:</Text>
        <Text style={styles.value}>
          {roadDiagnostics?.loadedTileCount ?? 0} tiles
        </Text>
        <Text style={styles.label}>{"  "}Pending:</Text>
        <Text style={styles.value}>
          {roadDiagnostics?.pendingTileCount ?? 0}
        </Text>
      </View>

      {/* Cache counts */}
      <View style={styles.row}>
        <Text style={styles.label}>Cache hits:</Text>
        <Text style={styles.value}>{roadDiagnostics?.cacheHitCount ?? 0}</Text>
        <Text style={styles.label}>{"  "}Misses:</Text>
        <Text style={styles.value}>{roadDiagnostics?.cacheMissCount ?? 0}</Text>
      </View>

      {/* Engine update counts */}
      <View style={styles.row}>
        <Text style={styles.label}>Road updates:</Text>
        <Text style={styles.value}>{roadUpdateCount}</Text>
        <Text style={styles.label}>{"  "}Route:</Text>
        <Text style={styles.value}>{routeUpdateCount}</Text>
      </View>

      {/* Road layer toggle */}
      <TouchableOpacity
        style={[
          styles.toggleButton,
          showRoadCoverage && styles.toggleButtonActive,
        ]}
        onPress={onToggleRoadCoverage}
        activeOpacity={0.7}
      >
        <Text style={styles.toggleButtonText}>
          {showRoadCoverage ? "▼ Road Layer ON" : "▲ Road Layer OFF"}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 8,
    bottom: 100,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    borderRadius: 8,
    padding: 8,
    minWidth: 210,
    zIndex: 200,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 5,
  },
  devBadge: {
    backgroundColor: "#f97316",
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginRight: 5,
  },
  devBadgeText: {
    color: "#ffffff",
    fontSize: 8,
    fontWeight: "bold",
    letterSpacing: 0.5,
  },
  title: {
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "bold",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 3,
    flexWrap: "wrap",
  },
  label: {
    color: "#9ca3af",
    fontSize: 10,
  },
  value: {
    color: "#ffffff",
    fontSize: 10,
    marginLeft: 3,
  },
  stateBadge: {
    marginLeft: 6,
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  stateBadgeText: {
    fontSize: 8,
    fontWeight: "bold",
    letterSpacing: 0.3,
  },
  toggleButton: {
    marginTop: 5,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 5,
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  toggleButtonActive: {
    backgroundColor: "rgba(0, 200, 100, 0.25)",
  },
  toggleButtonText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "600",
  },
});
