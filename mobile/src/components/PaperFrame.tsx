import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';

/** Dark "desk" backdrop with a drop shadow so white thermal paper reads clearly in any theme. */
export function PaperFrame({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.desk, { backgroundColor: theme.colors.surfaceVariant }]}>
      <View style={styles.paper}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  desk: { alignItems: 'center', paddingVertical: 24, minHeight: '100%' },
  paper: {
    backgroundColor: '#FFFFFF',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
});
