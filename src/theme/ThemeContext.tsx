import React, { createContext, useContext, useState } from "react";
import { darkTheme, lightTheme } from "./colors";
import { AppTheme, AppThemeMode } from "./types";

interface ThemeContextType {
  theme: AppTheme;
  mode: AppThemeMode;
  isDark: boolean;
  setMode: (mode: AppThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: darkTheme,
  mode: "dark",
  isDark: true,
  setMode: () => {},
  toggleTheme: () => {},
});

export const ThemeProvider: React.FC<{
  children: React.ReactNode;
  initialMode?: AppThemeMode;
}> = ({ children, initialMode = "dark" }) => {
  const [mode, setMode] = useState<AppThemeMode>(initialMode);

  const toggleTheme = () => {
    setMode((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const theme = mode === "dark" ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        mode,
        isDark: mode === "dark",
        setMode,
        toggleTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => useContext(ThemeContext);

export * from "./types";
export * from "./colors";
export * from "./mapStyles";
