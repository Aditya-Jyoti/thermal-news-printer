import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Surface, Text, useTheme } from 'react-native-paper';

import type { EditionStatus } from '@/api/types';

/** Human text for the pipeline phase, or null when idle. */
export function progressText(s: EditionStatus): string | null {
  if (s.phase === 'curating') return 'Curating…';
  if (s.phase === 'summarizing') return `Summarizing ${Math.min(s.done + 1, s.total)} of ${s.total}…`;
  return null;
}

/** Subtle progress row plus a clear banner (with a Settings button) when the OpenRouter key is missing. */
export function EditionStatusBar({ status }: { status: EditionStatus }) {
  const theme = useTheme();
  const router = useRouter();
  const text = progressText(status);
  return (
    <View style={styles.box}>
      {status.no_key ? (
        <Surface mode="flat" style={[styles.banner, { backgroundColor: theme.colors.errorContainer }]}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer }}>
            Add your OpenRouter key to let AI pick and summarize the stories. Until then you only get a plain newest-first selection.
          </Text>
          <Button mode="contained-tonal" onPress={() => router.push('/settings')} style={styles.bannerButton}>
            Open Settings
          </Button>
        </Surface>
      ) : null}
      {text ? (
        <View style={styles.progress}>
          <ActivityIndicator size={16} />
          <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12 },
  banner: { borderRadius: 16, padding: 16, gap: 12 },
  bannerButton: { alignSelf: 'flex-start' },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
});
