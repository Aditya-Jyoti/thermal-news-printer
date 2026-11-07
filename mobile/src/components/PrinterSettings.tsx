import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Portal, ProgressBar, Snackbar, Text } from 'react-native-paper';

import type { PrinterInfo } from '@/device/contracts';
import { createPrinterDriver, makeTestBitmap } from '@/printer';

interface Props {
  selectedId: string | null;
  onSelect(id: string, name: string): void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PrinterSettings({ selectedId, onSelect }: Props) {
  const driver = useMemo(() => createPrinterDriver(), []);
  const [found, setFound] = useState<PrinterInfo[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const busy = useRef(false);

  const scan = async () => {
    if (busy.current) return;
    busy.current = true;
    setScanning(true);
    try {
      if (!(await driver.ensurePermissions())) {
        setSnack('Bluetooth permission denied. Enable it in system settings.');
        return;
      }
      setFound(await driver.scan(8000));
      setScanned(true);
    } catch (e) {
      setSnack(msg(e));
    } finally {
      setScanning(false);
      busy.current = false;
    }
  };

  const printTest = async () => {
    if (busy.current) return;
    busy.current = true;
    setProgress(0);
    try {
      if (!(await driver.ensurePermissions())) {
        setSnack('Bluetooth permission denied. Enable it in system settings.');
        return;
      }
      await driver.print(makeTestBitmap(), {
        deviceId: selectedId ?? undefined,
        onProgress: (p) => setProgress(p.totalBytes ? p.sentBytes / p.totalBytes : 0),
      });
      setSnack('Test page sent to the printer.');
    } catch (e) {
      setSnack(msg(e));
    } finally {
      setProgress(null);
      busy.current = false;
    }
  };

  const selectedLabel = selectedId ? (selectedName ?? found.find((p) => p.id === selectedId)?.name ?? 'Saved printer') : null;

  return (
    <View style={styles.box}>
      <Text variant="titleMedium">Printer</Text>
      <Text variant="bodyMedium">{selectedId ? `${selectedLabel} (${selectedId})` : 'No printer selected'}</Text>

      <View style={styles.row}>
        <Button mode="contained-tonal" icon="bluetooth-search" onPress={scan} loading={scanning} disabled={scanning || progress !== null}>
          {scanning ? 'Scanning...' : 'Scan'}
        </Button>
        <Button mode="contained" icon="printer" onPress={printTest} disabled={scanning || progress !== null || !selectedId}>
          Print test page
        </Button>
      </View>

      {progress !== null ? <ProgressBar progress={progress} style={styles.progress} /> : null}

      {scanned && !found.length ? <Text variant="bodyMedium">No printers found. Make sure it is on and nearby.</Text> : null}
      {found.map((p) => (
        <List.Item
          key={p.id}
          title={p.name}
          description={`${p.id}${p.rssi != null ? `  |  ${p.rssi} dBm` : ''}`}
          left={(props) => <List.Icon {...props} icon={p.id === selectedId ? 'radiobox-marked' : 'radiobox-blank'} />}
          onPress={() => {
            setSelectedName(p.name);
            onSelect(p.id, p.name);
          }}
        />
      ))}

      <Portal>
        <Snackbar visible={snack !== null} onDismiss={() => setSnack(null)} duration={5000}>
          {snack ?? ''}
        </Snackbar>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  progress: { height: 6, borderRadius: 3 },
});
