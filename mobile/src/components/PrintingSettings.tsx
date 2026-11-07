import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, IconButton, Text, TextInput } from 'react-native-paper';

import { useBackendSettings, useModels, usePatchSettings } from '@/api/hooks';
import type { Settings } from '@/api/types';

import { ErrorView, LoadingView } from './common';
import { ModelPicker } from './ModelPicker';
import { useAppSettings } from '@/state/settings';

interface Handlers {
  onError: (e: unknown) => void;
  onSaved: () => void;
}

export function PrintingSettings(h: Handlers) {
  const q = useBackendSettings();
  if (q.isLoading) return <LoadingView />;
  if (q.isError || !q.data) return <ErrorView error={q.error} onRetry={() => q.refetch()} />;
  // key: re-init the form when the server copy changes (e.g. after save or backend switch)
  return <PrintingForm key={JSON.stringify(q.data)} saved={q.data} {...h} />;
}

function PrintingForm({ saved, onError, onSaved }: Handlers & { saved: Settings }) {
  const patch = usePatchSettings();
  const models = useModels();
  const [max, setMax] = useState(saved.max_items_total);
  const [model, setModel] = useState(saved.model);
  const [fallback, setFallback] = useState<string | null>(saved.fallback_model);
  const { mode } = useAppSettings(); // printer id is managed by PrinterSettings in on-device mode
  const [printer, setPrinter] = useState(saved.printer_address ?? '');

  const dirty = max !== saved.max_items_total || model.trim() !== saved.model || (fallback?.trim() || null) !== saved.fallback_model || (mode === 'remote' && (printer.trim() || null) !== saved.printer_address);

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Text variant="bodyLarge" style={styles.grow}>
          Max items per print
        </Text>
        <IconButton mode="contained-tonal" icon="minus" size={18} disabled={max <= 1} onPress={() => setMax(max - 1)} />
        <Text variant="titleMedium" style={styles.value}>
          {max}
        </Text>
        <IconButton mode="contained-tonal" icon="plus" size={18} disabled={max >= 30} onPress={() => setMax(max + 1)} />
      </View>
      {models.isLoading ? (
        <LoadingView />
      ) : (
        <>
          <ModelPicker label="Summarization model" value={model} onChange={(v) => setModel(v ?? '')} options={models.isError ? null : (models.data ?? null)} />
          <ModelPicker label="Fallback model" value={fallback} onChange={setFallback} options={models.isError ? null : (models.data ?? null)} allowNone />
        </>
      )}
      {mode === 'remote' && (
        <TextInput
          label="Printer BLE address"
          placeholder="AA:BB:CC:DD:EE:FF"
          value={printer}
          onChangeText={setPrinter}
          autoCapitalize="characters"
          autoCorrect={false}
          mode="outlined"
        />
      )}
      <Button
        mode="contained"
        disabled={!dirty || model.trim().length === 0 || patch.isPending}
        loading={patch.isPending}
        onPress={() =>
          patch.mutate(
            { max_items_total: max, model: model.trim(), fallback_model: fallback?.trim() || null, ...(mode === 'remote' ? { printer_address: printer.trim() || null } : {}) },
            { onSuccess: onSaved, onError },
          )
        }
      >
        Save printing settings
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
  value: { minWidth: 28, textAlign: 'center' },
});
