import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Divider, List, Snackbar } from 'react-native-paper';

import { useBackendSettings, usePatchSettings, usePrintNow } from '@/api/hooks';
import { isNotImplemented } from '@/api/errors';
import { ConnectionSettings } from '@/components/ConnectionSettings';
import { PrinterSettings } from '@/components/PrinterSettings';
import { PrintingSettings } from '@/components/PrintingSettings';
import { ScheduleList } from '@/components/ScheduleList';
import { SchedulerStatus } from '@/components/SchedulerStatus';
import { errorMessage } from '@/lib/format';
import { useAppSettings } from '@/state/settings';

export default function SettingsScreen() {
  const printNow = usePrintNow();
  const { mode } = useAppSettings();
  const [toast, setToast] = useState<string | null>(null);

  const onPrint = () =>
    printNow.mutate(undefined, {
      onSuccess: (r) => setToast(r.status === 'printed' ? `Printed ${r.items.length} items` : `Print ${r.status}`),
      onError: (e) =>
        setToast(isNotImplemented(e) ? 'Printing is not available on the backend yet (Phase 3).' : errorMessage(e)),
    });

  const onError = (e: unknown) => setToast(errorMessage(e));

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.print}>
          <Button mode="contained" icon="printer" loading={printNow.isPending} disabled={printNow.isPending} onPress={onPrint}>
            Print now
          </Button>
        </View>

        <List.Subheader>Print schedule</List.Subheader>
        <SchedulerStatus />
        <ScheduleList onError={onError} />
        <Divider style={styles.div} />

        <List.Subheader>Printing</List.Subheader>
        <PrintingSettings onError={onError} onSaved={() => setToast('Saved')} />
        <Divider style={styles.div} />

        {mode === 'device' && (
          <>
            <List.Subheader>Printer</List.Subheader>
            <DevicePrinter onError={onError} onSaved={() => setToast('Printer saved')} />
            <Divider style={styles.div} />
          </>
        )}

        <List.Subheader>Data source</List.Subheader>
        <ConnectionSettings onMessage={setToast} />
      </ScrollView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={4000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingBottom: 48 },
  print: { padding: 16 },
  div: { marginVertical: 12 },
});

/** Printer pairing for on-device mode: persists the chosen BLE id as Settings.printer_address. */
function DevicePrinter({ onError, onSaved }: { onError: (e: unknown) => void; onSaved: () => void }) {
  const settings = useBackendSettings();
  const patch = usePatchSettings();
  return (
    <PrinterSettings
      selectedId={settings.data?.printer_address ?? null}
      onSelect={(id) => patch.mutate({ printer_address: id }, { onSuccess: onSaved, onError })}
    />
  );
}
