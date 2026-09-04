import { AppTheme } from "./types";

export const darkTheme: AppTheme = {
  mode: "dark",
  isDark: true,

  // Backgrounds & Surfaces
  background: "#0D1117",
  surface: "#161B22",
  surfaceElevated: "#21262D",
  surfaceSubtle: "#0D1117",
  surfaceBorder: "#30363D",
  surfaceBorderSubtle: "#21262D",

  // Text Hierarchy
  textPrimary: "#F0F6FC",
  textSecondary: "#8B949E",
  textMuted: "#6E7681",

  // Brand & Accent
  accent: "#388BFD",
  accentPressed: "#1F6FEB",
  accentSurface: "rgba(56, 139, 253, 0.15)",
  accentText: "#58A6FF",

  // Semantic States
  success: "#3FB950",
  successSurface: "rgba(63, 185, 80, 0.15)",
  successText: "#56D364",

  warning: "#D29922",
  warningSurface: "rgba(210, 153, 34, 0.15)",
  warningText: "#E3B341",

  danger: "#F85149",
  dangerSurface: "rgba(248, 81, 73, 0.15)",
  dangerText: "#FF7B72",

  // Map Controls & Floating Buttons
  mapControlBackground: "#21262D",
  mapControlBorder: "#30363D",
  mapControlIcon: "#C9D1D9",
  mapControlActiveBackground: "#1F6FEB",
  mapControlActiveIcon: "#FFFFFF",

  // Map Overlays & Polylines
  routePolylineCore: "#388BFD",
  routePolylineBorder: "#0D419D",
  historyTrailColor: "rgba(56, 139, 253, 0.45)",

  // Modals & Shadows
  modalBackdrop: "rgba(0, 0, 0, 0.75)",
  shadowColor: "#000000",
};

export const lightTheme: AppTheme = {
  mode: "light",
  isDark: false,

  // Backgrounds & Surfaces
  background: "#F8F9FA",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfaceSubtle: "#F1F3F4",
  surfaceBorder: "#DADCE0",
  surfaceBorderSubtle: "#E8EAED",

  // Text Hierarchy
  textPrimary: "#202124",
  textSecondary: "#5F6368",
  textMuted: "#80868B",

  // Brand & Accent
  accent: "#1A73E8",
  accentPressed: "#185ABC",
  accentSurface: "rgba(26, 115, 232, 0.10)",
  accentText: "#174EA6",

  // Semantic States
  success: "#137333",
  successSurface: "rgba(19, 115, 51, 0.10)",
  successText: "#0D652D",

  warning: "#E37400",
  warningSurface: "rgba(227, 116, 0, 0.12)",
  warningText: "#B06000",

  danger: "#D93025",
  dangerSurface: "rgba(217, 48, 37, 0.10)",
  dangerText: "#C5221F",

  // Map Controls & Floating Buttons
  mapControlBackground: "#FFFFFF",
  mapControlBorder: "#DADCE0",
  mapControlIcon: "#3C4043",
  mapControlActiveBackground: "#1A73E8",
  mapControlActiveIcon: "#FFFFFF",

  // Map Overlays & Polylines
  routePolylineCore: "#1A73E8",
  routePolylineBorder: "#174EA6",
  historyTrailColor: "rgba(26, 115, 232, 0.40)",

  // Modals & Shadows
  modalBackdrop: "rgba(0, 0, 0, 0.55)",
  shadowColor: "#000000",
};
