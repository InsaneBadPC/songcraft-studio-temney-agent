import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { colorScheme as nativewindColorScheme, vars } from "nativewind";

import { SchemeColors, type ColorScheme } from "@/constants/theme";

type ThemeContextValue = {
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SongCraft Studio je vždy tmavý, nezávisle na systému.
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>("dark");

  const applyScheme = useCallback((scheme: ColorScheme) => {
    nativewindColorScheme.set(scheme);
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.dataset.theme = scheme;
      const palette = SchemeColors[scheme];
      Object.entries(palette).forEach(([token, value]) => {
        root.style.setProperty(`--color-${token}`, value);
      });
    }
  }, []);

  const setColorScheme = useCallback(
    (scheme: ColorScheme) => {
      setColorSchemeState(scheme);
      applyScheme(scheme);
    },
    [applyScheme],
  );

  useEffect(() => {
    applyScheme(colorScheme);
  }, [applyScheme, colorScheme]);

  // Všechny tokeny, ne jen 9 - jinak jsou třídy jako bg-accent tiše prázdné.
  const themeVariables = useMemo(() => {
    const palette = SchemeColors[colorScheme];
    const flat: Record<string, string> = {};
    Object.entries(palette).forEach(([token, value]) => {
      flat[`color-${token}`] = value;
    });
    return vars(flat);
  }, [colorScheme]);

  const value = useMemo(
    () => ({
      colorScheme,
      setColorScheme,
    }),
    [colorScheme, setColorScheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <View style={[{ flex: 1 }, themeVariables]}>{children}</View>
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useThemeContext must be used within ThemeProvider");
  }
  return ctx;
}