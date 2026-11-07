import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import type { ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ color, size }: { color: ColorValue; size: number }) => (
    <MaterialCommunityIcons name={icon} color={color as string} size={size} />
  ),
});

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
        tabBarStyle: { backgroundColor: theme.colors.elevation.level2, borderTopWidth: 0 },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Tabs.Screen name="index" options={tab('Feed', 'newspaper-variant-outline')} />
      <Tabs.Screen name="preview" options={tab('Preview', 'receipt-text-outline')} />
      <Tabs.Screen name="history" options={tab('History', 'history')} />
      <Tabs.Screen name="sources" options={tab('Sources', 'rss')} />
      <Tabs.Screen name="settings" options={tab('Settings', 'cog-outline')} />
    </Tabs>
  );
}
