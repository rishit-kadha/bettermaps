/**
 * OfflineRegionsModal.tsx
 *
 * Comprehensive Offline Regional Map Packs management sheet.
 *
 * Features:
 * - Direct "Download an Area" button opening interactive framing map
 * - Real-time storage accounting (KB / MB used)
 * - Source Priority Hierarchy explanation
 * - Installed regional pack inventory (Coventry, Delhi NCR, custom areas)
 * - Delete pack capability to free storage
 * - Fixed height ("88%") preventing layout collapse on Android
 */

import React, { useState } from "react";
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../theme/ThemeContext";
import { offlineRegionPackManager } from "../../adapters/road/OfflineRegionPackManager";
import { AreaDownloadModal } from "../offline/AreaDownloadModal";

interface OfflineRegionsModalProps {
  visible: boolean;
  onClose: () => void;
}

export const OfflineRegionsModal: React.FC<OfflineRegionsModalProps> = ({
  visible,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const { theme, mode } = useTheme();

  const [refreshKey, setRefreshKey] = useState(0);
  const [isAreaDownloadOpen, setIsAreaDownloadOpen] = useState(false);

  if (!visible) return null;

  const installedPacks = offlineRegionPackManager.getAllPacks();
  const totalStorageBytes = offlineRegionPackManager.getTotalStorageBytes();
  const totalStorageKb = (totalStorageBytes / 1024).toFixed(1);

  const handleDeletePack = (packId: string, packName: string) => {
    Alert.alert(
      "Delete Offline Area",
      `Are you sure you want to remove '${packName}' from your device storage?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            offlineRegionPackManager.removePack(packId);
            setRefreshKey((prev) => prev + 1);
          },
        },
      ],
    );
  };

  return (
    <>
      <Modal
        animationType="slide"
        transparent={true}
        visible={visible}
        onRequestClose={onClose}
      >
        <View style={styles.backdrop}>
          <View
            style={[
              styles.container,
              {
                backgroundColor: theme.surface,
                borderColor: theme.surfaceBorder,
                paddingTop: Math.max(insets.top, 16),
                paddingBottom: Math.max(insets.bottom, 20),
              },
            ]}
          >
            {/* Header */}
            <View
              style={[
                styles.header,
                { borderBottomColor: theme.surfaceBorder },
              ]}
            >
              <View style={styles.titleContainer}>
                <View style={styles.titleRow}>
                  <Ionicons
                    name="map"
                    size={20}
                    color={theme.accent}
                    style={styles.icon}
                  />
                  <Text style={[styles.title, { color: theme.textPrimary }]}>
                    OFFLINE MAP PACKS
                  </Text>
                </View>
                <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                  Pre-downloaded road graph packs for off-grid positioning
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={[
                  styles.closeButton,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
            >
              {/* Prominent "Download An Area" CTA Button */}
              <TouchableOpacity
                onPress={() => setIsAreaDownloadOpen(true)}
                style={[styles.downloadAreaCta, { backgroundColor: theme.accent }]}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="add-circle-outline"
                  size={20}
                  color="#FFFFFF"
                  style={{ marginRight: 8 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.downloadAreaCtaTitle}>
                    DOWNLOAD AN AREA
                  </Text>
                  <Text style={styles.downloadAreaCtaSub}>
                    Select a custom geographic area on map for offline IDR
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
              </TouchableOpacity>

              {/* Storage & Source Priority Summary Card */}
              <View
                style={[
                  styles.priorityCard,
                  {
                    backgroundColor: theme.surfaceSubtle,
                    borderColor: theme.surfaceBorder,
                  },
                ]}
              >
                <View style={styles.priorityHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.textPrimary }]}>
                    SOURCE PRIORITY HIERARCHY
                  </Text>
                  <Text style={[styles.storageBadge, { color: theme.accent }]}>
                    Total: {totalStorageKb} KB
                  </Text>
                </View>
                <Text style={[styles.priorityChain, { color: theme.textSecondary }]}>
                  1. Active RAM  →  2. Installed Offline Pack  →  3. Persistent Cache  →  4. Network  →  5. Unavailable
                </Text>
                <Text style={[styles.priorityNote, { color: theme.textMuted }]}>
                  • Edge ESKF queries verified degree-grid road tiles (stepDeg = 0.01° ≈ 1.1 km).
                  • Network source is NEVER contacted if an installed pack covers the requested tile.
                  • Google Maps visual tiles remain online-only; zero proprietary tile scraping is performed.
                </Text>
              </View>

              {/* Installed Regional Packs Section */}
              <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
                INSTALLED REGIONS ({installedPacks.length})
              </Text>

              {installedPacks.map((pack) => {
                const bounds = pack.bbox;
                const boundsText = `${bounds.minLat.toFixed(2)}°-${bounds.maxLat.toFixed(2)}°N, ${bounds.minLon.toFixed(2)}°-${bounds.maxLon.toFixed(2)}°E`;
                const sizeKb = (pack.byteSize / 1024).toFixed(1);

                return (
                  <View
                    key={pack.id}
                    style={[
                      styles.packCard,
                      {
                        backgroundColor: theme.surfaceSubtle,
                        borderColor: theme.surfaceBorder,
                      },
                    ]}
                  >
                    <View style={styles.packHeader}>
                      <View style={styles.packTitleRow}>
                        <Ionicons
                          name="checkmark-circle"
                          size={18}
                          color={theme.success}
                          style={{ marginRight: 6 }}
                        />
                        <Text
                          style={[styles.packName, { color: theme.textPrimary }]}
                        >
                          {pack.name}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.badge,
                          {
                            backgroundColor:
                              mode === "dark" ? "#1B3A24" : "#E6F4EA",
                          },
                        ]}
                      >
                        <Text
                          style={[styles.badgeText, { color: theme.success }]}
                        >
                          ACTIVE
                        </Text>
                      </View>
                    </View>

                    <View style={styles.packDetailsGrid}>
                      <View style={styles.detailCol}>
                        <Text style={[styles.detailLabel, { color: theme.textMuted }]}>
                          TILES
                        </Text>
                        <Text style={[styles.detailVal, { color: theme.textPrimary }]}>
                          {pack.tiles?.length ?? 1}
                        </Text>
                      </View>

                      <View style={styles.detailCol}>
                        <Text style={[styles.detailLabel, { color: theme.textMuted }]}>
                          STORAGE
                        </Text>
                        <Text style={[styles.detailVal, { color: theme.textPrimary }]}>
                          {sizeKb} KB
                        </Text>
                      </View>

                      <View style={styles.detailCol}>
                        <Text style={[styles.detailLabel, { color: theme.textMuted }]}>
                          SCHEME
                        </Text>
                        <Text style={[styles.detailVal, { color: theme.textPrimary }]}>
                          {pack.tileScheme ?? "deg"}
                        </Text>
                      </View>

                      <View style={styles.detailCol}>
                        <Text style={[styles.detailLabel, { color: theme.textMuted }]}>
                          VERSION
                        </Text>
                        <Text style={[styles.detailVal, { color: theme.textPrimary }]}>
                          v{pack.roadDataVersion ?? 1}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.boundsRow}>
                      <Text style={[styles.boundsLabel, { color: theme.textMuted }]}>
                        Bounds:
                      </Text>
                      <Text
                        style={[styles.boundsText, { color: theme.textSecondary }]}
                      >
                        {boundsText}
                      </Text>
                    </View>

                    <View style={styles.footerActionRow}>
                      <Text style={[styles.sourceText, { color: theme.textMuted }]}>
                        {pack.source} ({pack.license})
                      </Text>
                      {pack.id.startsWith("custom_") && (
                        <TouchableOpacity
                          onPress={() => handleDeletePack(pack.id, pack.name)}
                          style={[styles.deleteBtn, { backgroundColor: theme.dangerSurface }]}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Ionicons name="trash-outline" size={13} color={theme.danger} />
                          <Text style={[styles.deleteBtnText, { color: theme.danger }]}>
                            DELETE
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}

              {/* Additional Pre-packaged Regions Section */}
              <Text style={[styles.sectionHeader, { color: theme.textSecondary, marginTop: 16 }]}>
                ADDITIONAL PRE-PACKAGED REGIONS
              </Text>

              <View
                style={[
                  styles.packCard,
                  {
                    backgroundColor: theme.surfaceSubtle,
                    borderColor: theme.surfaceBorder,
                    opacity: 0.85,
                  },
                ]}
              >
                <View style={styles.packHeader}>
                  <View style={styles.packTitleRow}>
                    <Ionicons
                      name="cloud-download-outline"
                      size={18}
                      color={theme.accent}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={[styles.packName, { color: theme.textPrimary }]}>
                      London Inner Core (UK)
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setIsAreaDownloadOpen(true)}
                    style={[
                      styles.downloadButton,
                      { backgroundColor: theme.accent },
                    ]}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.downloadButtonText}>SELECT</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[styles.availableSub, { color: theme.textSecondary }]}>
                  Central London, Westminster, City of London • ~120 KB • 24 tiles
                </Text>
              </View>

              <View
                style={[
                  styles.packCard,
                  {
                    backgroundColor: theme.surfaceSubtle,
                    borderColor: theme.surfaceBorder,
                    opacity: 0.85,
                  },
                ]}
              >
                <View style={styles.packHeader}>
                  <View style={styles.packTitleRow}>
                    <Ionicons
                      name="cloud-download-outline"
                      size={18}
                      color={theme.accent}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={[styles.packName, { color: theme.textPrimary }]}>
                      Bengaluru Tech Corridor (India)
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setIsAreaDownloadOpen(true)}
                    style={[
                      styles.downloadButton,
                      { backgroundColor: theme.accent },
                    ]}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.downloadButtonText}>SELECT</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[styles.availableSub, { color: theme.textSecondary }]}>
                  Outer Ring Road, Electronic City, Whitefield • ~95 KB • 18 tiles
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Interactive Download Area Framing Modal */}
      <AreaDownloadModal
        visible={isAreaDownloadOpen}
        onClose={() => setIsAreaDownloadOpen(false)}
        onPackInstalled={() => {
          setRefreshKey((prev) => prev + 1);
        }}
      />
    </>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    justifyContent: "flex-end",
  },
  container: {
    width: "100%",
    height: "88%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    elevation: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  titleContainer: {
    flex: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  icon: {
    marginRight: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  subtitle: {
    fontSize: 11,
    marginTop: 2,
  },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
    marginTop: 10,
  },
  content: {
    paddingBottom: 24,
    gap: 12,
  },
  downloadAreaCta: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 12,
    elevation: 2,
  },
  downloadAreaCtaTitle: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  downloadAreaCtaSub: {
    color: "rgba(255, 255, 255, 0.85)",
    fontSize: 10,
    marginTop: 2,
  },
  priorityCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    gap: 6,
  },
  priorityHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  storageBadge: {
    fontSize: 11,
    fontWeight: "700",
  },
  priorityChain: {
    fontSize: 10,
    fontWeight: "600",
  },
  priorityNote: {
    fontSize: 9.5,
    lineHeight: 14,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginTop: 6,
  },
  packCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    gap: 6,
  },
  packHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  packTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  packName: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 9.5,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  packDetailsGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(128, 128, 128, 0.15)",
  },
  detailCol: {
    alignItems: "center",
    flex: 1,
  },
  detailLabel: {
    fontSize: 8.5,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  detailVal: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  boundsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  boundsLabel: {
    fontSize: 9.5,
    fontWeight: "600",
    marginRight: 6,
  },
  boundsText: {
    fontSize: 9.5,
    fontWeight: "500",
  },
  footerActionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 2,
  },
  sourceText: {
    fontSize: 9,
    flex: 1,
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  deleteBtnText: {
    fontSize: 9.5,
    fontWeight: "800",
  },
  downloadButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  downloadButtonText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  availableSub: {
    fontSize: 10.5,
    marginTop: 2,
  },
});
