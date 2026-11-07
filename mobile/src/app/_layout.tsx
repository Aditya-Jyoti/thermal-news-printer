import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from 'react-native-paper';

import { ApiProvider } from '@/api/provider';
import { AppSettingsProvider } from '@/state/settings';
import { AppThemeProvider } from '@/theme';

function Navigator() {
  const theme = useTheme();
  const scheme = useColorScheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.onSurface,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="article/[id]" options={{ title: 'Article' }} />
        <Stack.Screen name="print/[id]" options={{ title: 'Print' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppSettingsProvider>
          <AppThemeProvider>
            <ApiProvider>
              <Navigator />
            </ApiProvider>
          </AppThemeProvider>
        </AppSettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
