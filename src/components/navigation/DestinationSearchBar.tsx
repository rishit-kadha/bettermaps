import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { navigationManager } from "../../core/state/NavigationManager";
import { RoutePoint } from "../../core/types/navigation";
import {
  fetchPlaceDetails,
  fetchPlacePredictions,
  generateSessionToken,
  PlacePrediction,
} from "../../services/google/placesService";
import { calculateRoute } from "../../services/google/routesService";
import { getMockDevelopmentRoute } from "../../services/google/mockRouteFixture";
import { useTheme } from "../../theme/ThemeContext";

interface DestinationSearchBarProps {
  currentLocation: RoutePoint | null;
  onSearchingChange?: (isSearching: boolean) => void;
}

export const DestinationSearchBar: React.FC<DestinationSearchBarProps> = ({
  currentLocation,
  onSearchingChange,
}) => {
  const { theme, mode } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const sessionTokenRef = useRef<string>(generateSessionToken());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onSearchingChange?.(isFocused);
  }, [isFocused, onSearchingChange]);

  const handleFocus = () => {
    setIsFocused(true);
    // Start a fresh session token when the user opens search
    sessionTokenRef.current = generateSessionToken();
    navigationManager.setSearching(true);
  };

  const handleClose = () => {
    setIsFocused(false);
    setQuery("");
    setPredictions([]);
    setSearchError(null);
    Keyboard.dismiss();
    navigationManager.setSearching(false);
  };

  const handleQueryChange = (text: string) => {
    setQuery(text);
    setSearchError(null);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (text.trim().length < 2) {
      setPredictions([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceTimerRef.current = setTimeout(async () => {
      const result = await fetchPlacePredictions(
        text,
        currentLocation,
        sessionTokenRef.current,
      );
      setIsLoading(false);
      if (result.error) {
        setSearchError(result.error);
        setPredictions([]);
      } else {
        setPredictions(result.predictions);
      }
    }, 380);
  };

  const handleSelectPrediction = async (prediction: PlacePrediction) => {
    Keyboard.dismiss();
    setIsLoading(true);
    setSearchError(null);

    // 1. Fetch precise destination coordinates using session token
    const detailsResult = await fetchPlaceDetails(
      prediction.placeId,
      sessionTokenRef.current,
    );

    if (!detailsResult.details) {
      setIsLoading(false);
      setSearchError(
        detailsResult.error || "Failed to retrieve place coordinates.",
      );
      return;
    }

    const { coordinate, name, address } = detailsResult.details;

    // Conclude session token
    sessionTokenRef.current = generateSessionToken();

    // 2. Validate origin
    const origin: RoutePoint = currentLocation
      ? {
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
        }
      : { latitude: 28.6139, longitude: 77.209 }; // New Delhi fallback if GPS not yet fixed

    // 3. Compute route
    const routeResult = await calculateRoute({
      origin,
      destination: coordinate,
      destinationName: name || prediction.primaryText,
      destinationAddress: address || prediction.secondaryText,
    });

    setIsLoading(false);

    if (routeResult.route) {
      handleClose();
      navigationManager.setRoutePreview(routeResult.route);
    } else {
      setSearchError(routeResult.error || "Failed to calculate route.");
    }
  };

  return (
    <View
      style={[
        styles.container,
        isFocused ? styles.containerExpanded : styles.containerCollapsed,
      ]}
      pointerEvents="box-none"
    >
      {/* Floating Search Bar */}
      <View
        style={[
          styles.searchBarCard,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
      >
        {isFocused ? (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={handleClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="arrow-back" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
        ) : (
          <View style={styles.searchIconContainer}>
            <Ionicons name="search" size={20} color={theme.accent} />
          </View>
        )}

        <TextInput
          style={[styles.input, { color: theme.textPrimary }]}
          placeholder="Where to?"
          placeholderTextColor={theme.textMuted}
          value={query}
          onChangeText={handleQueryChange}
          onFocus={handleFocus}
          returnKeyType="search"
          autoCorrect={false}
        />

        {isLoading ? (
          <ActivityIndicator
            size="small"
            color={theme.accent}
            style={styles.loader}
          />
        ) : query.length > 0 ? (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => handleQueryChange("")}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close-circle" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Autocomplete Predictions List */}
      {isFocused && (
        <View
          style={[
            styles.resultsOverlay,
            {
              backgroundColor: theme.surface,
              borderColor: theme.surfaceBorder,
            },
          ]}
        >
          {searchError && (
            <View
              style={[
                styles.errorNotice,
                {
                  backgroundColor: mode === "dark" ? "#381014" : "#FCE8E6",
                },
              ]}
            >
              <Ionicons
                name="alert-circle-outline"
                size={18}
                color={theme.danger}
              />
              <Text
                style={[
                  styles.errorNoticeText,
                  { color: mode === "dark" ? "#F87171" : "#C5221F" },
                ]}
              >
                {searchError}
              </Text>
            </View>
          )}

          {/* Explicit Development / Simulator Route Option */}
          {(navigationManager.getActiveProvider().providerType === "mock" ||
            searchError) && (
            <TouchableOpacity
              style={[
                styles.devRouteItem,
                {
                  backgroundColor: mode === "dark" ? "#261536" : "#F3E8FD",
                  borderBottomColor: mode === "dark" ? "#3B2054" : "#E9D5FF",
                },
              ]}
              onPress={() => {
                handleClose();
                navigationManager.setRoutePreview(getMockDevelopmentRoute());
              }}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.devIconCircle,
                  {
                    backgroundColor: mode === "dark" ? "#3B2054" : "#E9D5FF",
                  },
                ]}
              >
                <Ionicons name="flask-outline" size={18} color="#9334E6" />
              </View>
              <View style={styles.resultTexts}>
                <Text
                  style={[
                    styles.devRouteTitle,
                    { color: mode === "dark" ? "#C084FC" : "#6B21A8" },
                  ]}
                >
                  Load Simulator Test Route (Dev Mode)
                </Text>
                <Text
                  style={[styles.secondaryText, { color: theme.textSecondary }]}
                >
                  Connaught Place Loop (No Google API quota used)
                </Text>
              </View>
            </TouchableOpacity>
          )}

          <FlatList
            data={predictions}
            keyExtractor={(item) => item.placeId}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.resultItem,
                  { borderBottomColor: theme.surfaceBorder },
                ]}
                onPress={() => handleSelectPrediction(item)}
                activeOpacity={0.7}
              >
                <View
                  style={[
                    styles.placeIconCircle,
                    { backgroundColor: theme.surfaceSubtle },
                  ]}
                >
                  <Ionicons
                    name="location-outline"
                    size={18}
                    color={theme.textSecondary}
                  />
                </View>
                <View style={styles.resultTexts}>
                  <Text
                    style={[styles.primaryText, { color: theme.textPrimary }]}
                    numberOfLines={1}
                  >
                    {item.primaryText}
                  </Text>
                  {item.secondaryText ? (
                    <Text
                      style={[
                        styles.secondaryText,
                        { color: theme.textSecondary },
                      ]}
                      numberOfLines={1}
                    >
                      {item.secondaryText}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !isLoading && query.length >= 2 && !searchError ? (
                <View style={styles.emptyState}>
                  <Text
                    style={[styles.emptyStateText, { color: theme.textMuted }]}
                  >
                    No matching places found
                  </Text>
                </View>
              ) : null
            }
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  containerCollapsed: {},
  containerExpanded: {},
  searchBarCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    paddingHorizontal: 14,
    height: 52,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 1,
    borderColor: "#E8EAED",
  },
  searchIconContainer: {
    marginRight: 10,
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 2,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: "#202124",
    paddingVertical: 0,
  },
  loader: {
    marginLeft: 6,
  },
  resultsOverlay: {
    position: "absolute",
    top: 58,
    left: 0,
    right: 0,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    maxHeight: 380,
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    borderWidth: 1,
    borderColor: "#ECEFF1",
    overflow: "hidden",
    zIndex: 200,
  },
  resultItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#F1F3F4",
  },
  placeIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F1F3F4",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  resultTexts: {
    flex: 1,
  },
  primaryText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#202124",
  },
  secondaryText: {
    fontSize: 13,
    color: "#5F6368",
    marginTop: 2,
  },
  emptyState: {
    padding: 24,
    alignItems: "center",
  },
  emptyStateText: {
    fontSize: 14,
    color: "#70757A",
  },
  errorNotice: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FCE8E6",
    padding: 12,
    margin: 10,
    borderRadius: 8,
    gap: 8,
  },
  errorNoticeText: {
    flex: 1,
    fontSize: 12,
    color: "#C5221F",
    lineHeight: 16,
  },
  devRouteItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#F3E8FD",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E9D5FF",
  },
  devIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#E9D5FF",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  devRouteTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#6B21A8",
  },
});
