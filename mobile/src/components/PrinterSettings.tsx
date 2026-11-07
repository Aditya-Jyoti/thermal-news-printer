import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Portal, ProgressBar, SegmentedButtons, Snackbar, Text } from 'react-native-paper';

import type { PrinterInfo, ReceiptBitmap } from '@/device/contracts';
import {
  DARKNESS_LEVELS,
  DEFAULT_DARKNESS,
  createPrinterDriver,
  getDarkness,
  makeTestBitmap,
  setDarkness,
  type DarknessLevel,
} from '@/printer';
import { withDarknessPattern } from '@/printer/testPattern';
import { renderReceipt, sampleItems } from '@/render';

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
  const [darkness, setLevel] = useState<DarknessLevel>(DEFAULT_DARKNESS);

  useEffect(() => {
    let alive = true;
    getDarkness().then((l) => {
      if (alive) setLevel(l);
    });
    return () => {
      alive = false;
    };
  }, []);

  const changeDarkness = (v: string) => {
    const l = v as DarknessLevel;
    if (!DARKNESS_LEVELS.includes(l)) return;
    setLevel(l);
    void setDarkness(l);
  };

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

  const printJob = async (makeBitmap: () => ReceiptBitmap | Promise<ReceiptBitmap>, done: string) => {
    if (busy.current) return;
    busy.current = true;
    setProgress(0);
    try {
      if (!(await driver.ensurePermissions())) {
        setSnack('Bluetooth permission denied. Enable it in system settings.');
        return;
      }
      await driver.print(await makeBitmap(), {
        deviceId: selectedId ?? undefined,
        onProgress: (p) => {
          // The driver reports per chunk (hundreds of times): only re-render on whole-percent changes.
          const next = p.totalBytes ? Math.round((p.sentBytes / p.totalBytes) * 100) / 100 : 0;
          setProgress((prev) => (prev === next ? prev : next));
        },
      });
      setSnack(done);
    } catch (e) {
      setSnack(msg(e));
    } finally {
      setProgress(null);
      busy.current = false;
    }
  };

  const printTest = () => printJob(makeTestBitmap, 'Test page sent to the printer.');
  const printSample = () =>
    printJob(async () => {
      await setDarkness(darkness); // render + driver read the level shown on screen
      const r = await renderReceipt(sampleItems().slice(0, 1), {
        editionDate: new Date(),
        editionName: `Darkness: ${darkness}`,
      });
      return withDarknessPattern(r.bitmap);
    }, 'Darkness sample sent to the printer.');

  const selectedLabel = selectedId ? (selectedName ?? found.find((p) => p.id === selectedId)?.name ?? 'Saved printer') : null;

  return (
    <View style={styles.box}>
      <Text variant="titleMedium">Printer</Text>
      <Text variant="bodyMedium">{selectedId ? `${selectedLabel} (${selectedId})` : 'No printer selected'}</Text>

      <View style={styles.row}>
        <Button mode="contained-tonal" icon="bluetooth" onPress={scan} loading={scanning} disabled={scanning || progress !== null}>
          {scanning ? 'Scanning...' : 'Scan'}
        </Button>
        <Button mode="contained" icon="printer" onPress={printTest} disabled={scanning || progress !== null || !selectedId}>
          Print test page
        </Button>
      </View>

      <Text variant="titleSmall">Print darkness</Text>
      <SegmentedButtons
        value={darkness}
        onValueChange={changeDarkness}
        buttons={[
          { value: 'light', label: 'Light' },
          { value: 'normal', label: 'Normal' },
          { value: 'dark', label: 'Dark' },
          { value: 'darkest', label: 'Darkest' },
        ]}
      />
      <Button mode="outlined" icon="printer-check" onPress={printSample} disabled={scanning || progress !== null || !selectedId}>
        Print darkness sample
      </Button>

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
  box: { gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  progress: { height: 6, borderRadius: 3 },
});
