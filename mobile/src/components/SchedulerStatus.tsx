import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Button, Card, Text, useTheme } from 'react-native-paper';

import { useSchedules } from '@/api/hooks';
import { computeNext } from '@/scheduler/arm';
import { getNative, hasNotificationPermission, requestNotificationPermission } from '@/scheduler/native';

interface Warning {
  key: string;
  text: string;
  action: string;
  onPress: () => void | Promise<void>;
}

interface Health {
  exact: boolean;
  batteryOk: boolean;
  notifOk: boolean;
}

/** "today 08:00" / "tomorrow 08:00" / "Mon 08:00". */
export function formatNext(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Android-only card in Settings: next scheduled print, permission warnings with fix buttons, and a test run. */
export function SchedulerStatus() {
  const native = getNative();
  const theme = useTheme();
  const qc = useQueryClient();
  const schedules = useSchedules();
  const [health, setHealth] = useState<Health | null>(null);
  const [started, setStarted] = useState(false);

  const refresh = useCallback(() => {
    if (!native) return;
    void hasNotificationPermission().then((notifOk) =>
      setHealth({ exact: native.canScheduleExactAlarms(), batteryOk: native.isIgnoringBatteryOptimizations(), notifOk }),
    );
  }, [native]);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  if (!native) return null;

  const next = computeNext(schedules.data ?? []);
  const warn: Warning[] = [
    health && !health.exact && {
      key: 'exact',
      text: 'Exact alarms are not allowed, so prints may run late or be skipped. Allow "Alarms & reminders" for this app.',
      action: 'Allow',
      onPress: () => native.openExactAlarmSettings(),
    },
    health && !health.notifOk && {
      key: 'notif',
      text: 'Notifications are off. Printing still works, but you will not see its progress.',
      action: 'Allow',
      onPress: async () => {
        if (!(await requestNotificationPermission())) native.openAppSettings();
        refresh();
      },
    },
    health && !health.batteryOk && {
      key: 'battery',
      text: 'Battery optimisation is on, which can stop the app from waking on schedule. Set battery to "Unrestricted" (on OnePlus also enable Auto launch in the app settings).',
      action: 'Fix',
      onPress: () => native.requestIgnoreBatteryOptimizations(),
    },
  ].filter((w): w is Warning => !!w);

  return (
    <Card mode="outlined" style={styles.card}>
      <Card.Content style={styles.content}>
        <Text variant="titleMedium">Scheduled printing</Text>
        <Text variant="bodyMedium">
          {next ? `Next print: ${formatNext(next.at)}` : 'No upcoming print. Add or enable a print time.'}
        </Text>
        {warn.map((w) => (
          <View key={w.key} style={styles.warn}>
            <Text variant="bodySmall" style={[styles.warnText, { color: theme.colors.error }]}>
              {w.text}
            </Text>
            <Button compact mode="text" onPress={() => void w.onPress()}>
              {w.action}
            </Button>
          </View>
        ))}
        <Button
          mode="outlined"
          icon="play-circle-outline"
          style={styles.test}
          onPress={() => {
            native.runNow();
            setStarted(true);
            // History gains a new entry when the run finishes.
            setTimeout(() => void qc.invalidateQueries({ queryKey: ['prints'] }), 60_000);
          }}
        >
          Run schedule now (test)
        </Button>
        {started && (
          <Text variant="bodySmall">Started in the background. Watch the notification; closing the app is fine.</Text>
        )}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginBottom: 8 },
  content: { gap: 6 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  warnText: { flex: 1 },
  test: { alignSelf: 'flex-start', marginTop: 6 },
});
