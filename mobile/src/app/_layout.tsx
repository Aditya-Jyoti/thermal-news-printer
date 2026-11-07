import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, Text, useTheme } from 'react-native-paper';

import { ApiProvider } from '@/api/provider';
import { getDb } from '@/core/db';
import { registerDevice } from '@/device/contracts';
import { stubDevice } from '@/device/stubs';
import { AppSettingsProvider } from '@/state/settings';
import { AppThemeProvider } from '@/theme';

// Orchestrator: swap stubDevice for { render, printer } from src/render and src/printer.
registerDevice(stubDevice);

/** Opens + migrates + seeds the on-device database before rendering the app. */
function DatabaseGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    getDb().then(
      () => setState('ready'),
      () => setState('error'),
    );
  }, []);
  // Demo/remote modes don't need the database, so a failed open still lets the app render.
  if (state === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 12 }}>Preparing your news...</Text>
      </View>
    );
  }
  return <>{children}</>;
}

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
            <DatabaseGate>
              <ApiProvider>
                <Navigator />
              </ApiProvider>
            </DatabaseGate>
          </AppThemeProvider>
        </AppSettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
