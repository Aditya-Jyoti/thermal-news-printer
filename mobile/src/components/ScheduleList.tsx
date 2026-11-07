import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, IconButton, List, Switch } from 'react-native-paper';

import { useCreateSchedule, useDeleteSchedule, useSchedules, useUpdateSchedule } from '@/api/hooks';
import type { Schedule } from '@/api/types';
import { confirmDestructive } from '@/lib/confirm';
import { describeCron } from '@/lib/cron';
import { requestNotificationPermission } from '@/scheduler/native';

import { EmptyView, ErrorView, LoadingView } from './common';
import { ScheduleDialog } from './ScheduleDialog';
import { layout } from '@/theme/layout';

type Dlg = { mode: 'create' } | { mode: 'edit'; schedule: Schedule } | null;

export function ScheduleList({ onError }: { onError: (e: unknown) => void }) {
  const q = useSchedules();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const del = useDeleteSchedule();
  const [dlg, setDlg] = useState<Dlg>(null);

  return (
    <View>
      {q.isLoading ? (
        <LoadingView />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyView title="No schedules" hint="Add a time to print automatically." />
      ) : (
        (q.data ?? []).map((s) => (
          <List.Item
            key={s.id}
            title={s.label || describeCron(s.cron)}
            description={s.label ? describeCron(s.cron) : undefined}
            onPress={() => setDlg({ mode: 'edit', schedule: s })}
            right={() => (
              <View style={styles.right}>
                <Switch value={s.enabled} onValueChange={(enabled) =>
                    update.mutate(
                      { id: s.id, body: { enabled } },
                      { onError, onSuccess: () => enabled && void requestNotificationPermission() },
                    )
                  } />
                <IconButton
                  icon="trash-can-outline"
                  size={24}
                  style={styles.touch}
                  accessibilityLabel="Delete schedule"
                  onPress={() => confirmDestructive('Delete schedule?', describeCron(s.cron), 'Delete', () => del.mutate(s.id, { onError }))}
                />
              </View>
            )}
          />
        ))
      )}
      <Button icon="plus" onPress={() => setDlg({ mode: 'create' })} style={styles.add}>
        Add print time
      </Button>

      <ScheduleDialog
        visible={dlg !== null}
        schedule={dlg?.mode === 'edit' ? dlg.schedule : undefined}
        busy={create.isPending || update.isPending}
        onDismiss={() => setDlg(null)}
        onSubmit={(v) => {
          const done = {
            onSuccess: () => {
              setDlg(null);
              void requestNotificationPermission(); // Android 13+: needed to show scheduled-print progress
            },
            onError,
          };
          if (dlg?.mode === 'edit') update.mutate({ id: dlg.schedule.id, body: v }, done);
          else create.mutate({ ...v, enabled: true }, done);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center' },
  touch: { width: layout.touch, height: layout.touch, margin: 0 },
  add: { alignSelf: 'flex-start', marginHorizontal: 16, marginTop: 4 },
});
