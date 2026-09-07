/**
 * SessionPickerModal.tsx
 *
 * Bottom Sheet / Modal for selecting IO-VNBD benchmark test drive sessions.
 * Sourced directly from the canonical FixtureRegistry.
 *
 * Complies with BetterMaps design language:
 * - Semantic theme tokens (dark & light mode support)
 * - Safe area inset handling
 * - Clean typography hierarchy
 * - Minimum >= 52dp touch targets
 * - Clear active selection state
 */

import React from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme/ThemeContext";
import {
  getAvailableSessions,
  normalizeSessionId,
  SessionMetadata,
} from "../../services/replay/FixtureRegistry";

interface SessionPickerModalProps {
  visible: boolean;
  currentSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
}

export const SessionPickerModal: React.FC<SessionPickerModalProps> = ({
  visible,
  currentSessionId,
  onSelectSession,
  onClose,
}) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const sessions = React.useMemo(() => getAvailableSessions(), []);
  const normalizedCurrentId = normalizeSessionId(currentSessionId);

  const renderSessionCard = (item: SessionMetadata) => {
    const isSelected = item.id === normalizedCurrentId;
    return (
      <TouchableOpacity
        key={item.id}
        style={[
          styles.sessionRow,
          {
            backgroundColor: isSelected
              ? theme.accentSurface
              : theme.surfaceSubtle,
            borderColor: isSelected
              ? theme.accent
              : theme.surfaceBorderSubtle,
          },
        ]}
        onPress={() => {
          onSelectSession(item.id);
          onClose();
        }}
        activeOpacity={0.7}
        accessibilityLabel={`Select session ${item.label}`}
      >
        <View style={styles.sessionLeft}>
          <Text
            style={[
              styles.sessionLabel,
              {
                color: isSelected ? theme.accentText : theme.textPrimary,
                fontWeight: isSelected ? "700" : "500",
              },
            ]}
          >
            {item.label}
          </Text>
        </View>

        {/* Right Selection Indicator */}
        <View style={styles.sessionRight}>
          {isSelected ? (
            <Ionicons
              name="checkmark-circle"
              size={22}
              color={theme.accent}
            />
          ) : (
            <Ionicons
              name="chevron-forward"
              size={18}
              color={theme.textMuted}
            />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View
          style={[
            styles.backdrop,
            { backgroundColor: isDark ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.4)" },
          ]}
        >
          <TouchableWithoutFeedback>
            <View
              style={[
                styles.sheetContainer,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.surfaceBorder,
                  paddingBottom: Math.max(insets.bottom, 16) + 8,
                },
              ]}
            >
              {/* Drag Handle Indicator */}
              <View style={styles.handleRow}>
                <View
                  style={[
                    styles.handleBar,
                    { backgroundColor: theme.surfaceBorder },
                  ]}
                />
              </View>

              {/* Header */}
              <View
                style={[
                  styles.header,
                  { borderBottomColor: theme.surfaceBorderSubtle },
                ]}
              >
                <View style={styles.headerTitleGroup}>
                  <Text style={[styles.subHeader, { color: theme.accentText }]}>
                    TEST DRIVE REPLAY
                  </Text>
                  <Text
                    style={[styles.headerTitle, { color: theme.textPrimary }]}
                  >
                    Select Session
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={onClose}
                  style={[
                    styles.closeBtn,
                    { backgroundColor: theme.surfaceSubtle },
                  ]}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Close session picker"
                >
                  <Ionicons name="close" size={18} color={theme.textPrimary} />
                </TouchableOpacity>
              </View>

              {/* Unified Session List */}
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={true}
              >
                {sessions.map(renderSessionCard)}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: "72%",
    elevation: 20,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
  },
  handleRow: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 4,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitleGroup: {
    flex: 1,
  },
  subHeader: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "800",
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  list: {
    paddingHorizontal: 14,
  },
  listContent: {
    paddingTop: 10,
    paddingBottom: 16,
  },
  sessionRow: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sessionLeft: {
    flex: 1,
    marginRight: 10,
    justifyContent: "center",
  },
  sessionLabel: {
    fontSize: 15,
    letterSpacing: 0.2,
  },
  sessionRight: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
  },
});