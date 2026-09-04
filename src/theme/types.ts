/**
 * types.ts
 *
 * Centralized semantic theme types for BetterMaps.
 * Defines semantic roles for daylight (light) and automotive night (dark) modes.
 */

export type AppThemeMode = "dark" | "light";

export interface AppTheme {
  mode: AppThemeMode;
  isDark: boolean;

  // Backgrounds & Surfaces
  background: string; // Main background behind overlays
  surface: string; // Base card and container surface
  surfaceElevated: string; // Elevated cards, floating action buttons, modals
  surfaceSubtle: string; // Inset boxes, list item backgrounds, stat grids
  surfaceBorder: string; // Outer borders distinguishing floating cards from map
  surfaceBorderSubtle: string; // Inner dividers, table borders

  // Text Hierarchy
  textPrimary: string; // Headings, main numbers, active titles
  textSecondary: string; // Subtitles, metadata, units, secondary labels
  textMuted: string; // Hints, inactive labels, timestamps

  // Brand & Accent
  accent: string; // Navigation blue
  accentPressed: string; // Active / pressed state
  accentSurface: string; // Subtle tint for active badges
  accentText: string; // High contrast text on accentSurface

  // Semantic States
  success: string; // GNSS fix, fastest route
  successSurface: string; // Green badge background
  successText: string;

  warning: string; // Acquiring GNSS, degraded status
  warningSurface: string;
  warningText: string;

  danger: string; // GNSS blocked outage, stop rec, errors
  dangerSurface: string;
  dangerText: string;

  // Map Controls & Floating Buttons
  mapControlBackground: string;
  mapControlBorder: string;
  mapControlIcon: string;
  mapControlActiveBackground: string;
  mapControlActiveIcon: string;

  // Map Overlays & Polylines
  routePolylineCore: string;
  routePolylineBorder: string;
  historyTrailColor: string;

  // Modals & Shadows
  modalBackdrop: string;
  shadowColor: string;
}
