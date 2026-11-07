import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text, useTheme } from 'react-native-paper';

import { errorMessage } from '@/lib/format';

export function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function LoadingView() {
  return (
    <Centered>
      <ActivityIndicator />
    </Centered>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const theme = useTheme();
  return (
    <Centered>
      <Text variant="titleMedium" style={{ color: theme.colors.error }}>
        Something went wrong
      </Text>
      <Text variant="bodyMedium" style={styles.msg}>
        {errorMessage(error)}
      </Text>
      {onRetry ? (
        <Button mode="contained-tonal" onPress={onRetry}>
          Retry
        </Button>
      ) : null}
    </Centered>
  );
}

export function EmptyView({ title, hint }: { title: string; hint?: string }) {
  return (
    <Centered>
      <Text variant="titleMedium">{title}</Text>
      {hint ? (
        <Text variant="bodyMedium" style={styles.msg}>
          {hint}
        </Text>
      ) : null}
    </Centered>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  msg: { textAlign: 'center', opacity: 0.8, marginBottom: 8 },
});
