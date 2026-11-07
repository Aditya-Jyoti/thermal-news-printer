import { useMaterial3Theme } from '@pchmn/expo-material3-theme';
import React, { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider, type MD3Theme } from 'react-native-paper';

/** Used when the device cannot supply wallpaper colors (iOS, Android < 12). */
export const FALLBACK_SOURCE_COLOR = '#5B6B8C';

export interface Themes {
  light: MD3Theme;
  dark: MD3Theme;
}

export function useAppThemes(): Themes {
  const { theme } = useMaterial3Theme({ fallbackSourceColor: FALLBACK_SOURCE_COLOR });
  return useMemo(
    () => ({
      light: { ...MD3LightTheme, colors: { ...MD3LightTheme.colors, ...theme.light } },
      dark: { ...MD3DarkTheme, colors: { ...MD3DarkTheme.colors, ...theme.dark } },
    }),
    [theme],
  );
}

/** Material You (dynamic wallpaper colors on Android 12+), following the system light/dark scheme. */
export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const themes = useAppThemes();
  const paper = scheme === 'dark' ? themes.dark : themes.light;
  return <PaperProvider theme={paper}>{children}</PaperProvider>;
}

/** Tag/category palette derived from the dynamic theme, for categories with no explicit color. */
export function paletteFor(theme: MD3Theme): string[] {
  const c = theme.colors;
  return [c.primary, c.tertiary, c.secondary, c.error, c.inversePrimary];
}

export const CATEGORY_SWATCHES = ['#E8590C', '#1C7ED6', '#AE3EC9', '#2F9E44', '#F59F00', '#E03131', '#0CA678', '#495057'];
