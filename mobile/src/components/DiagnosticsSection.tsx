import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import { useDiagnostics, useTestAiKey } from '@/api/hooks';
import type { PipelineStage } from '@/api/types';
import { STAGE_LABEL } from '@/core/diagnostics';
import { errorMessage } from '@/lib/format';
import { layout } from '@/theme/layout';

const hostOf = (url: string) => url.replace(/^https?:\/\//, '').split('/')[0];

const STAGES: PipelineStage[] = ['ingest', 'curate', 'summarize', 'render', 'print'];

/** Last error per pipeline stage, article/edition counts and a one-tap OpenRouter key test. */
export function DiagnosticsSection() {
  const theme = useTheme();
  const diag = useDiagnostics();
  const test = useTestAiKey();
  const d = diag.data;
  const muted = { color: theme.colors.onSurfaceVariant };

  return (
    <View style={styles.box}>
      {diag.isError ? <Text style={muted}>Diagnostics are not available here: {errorMessage(diag.error)}</Text> : null}
      {d ? (
        <>
          <Text variant="bodyMedium" style={muted}>
            {d.counts.articles} articles · {d.counts.candidates} candidates in window · edition {d.counts.edition_size} · summarized{' '}
            {d.counts.summarized}
          </Text>
          {d.window_days !== undefined ? (
            <Text variant="bodySmall" style={muted}>
              Max story age: {d.window_days === null ? 'no limit' : `${d.window_days} days`}
            </Text>
          ) : null}
          {(d.categories ?? []).map((c) => (
            <Text key={c.slug} variant="bodySmall" style={muted}>
              #{c.slug}: {c.fetched} fetched · {c.eligible} eligible · {c.in_edition} in edition
            </Text>
          ))}
          {(d.feeds ?? []).map((f) => (
            <View key={f.id}>
              <Text variant="bodySmall" numberOfLines={1} style={f.last_error || f.stale ? { color: theme.colors.error } : muted}>
                {f.title || hostOf(f.url)} (#{f.category_slug}){f.enabled ? '' : ' · disabled'}{f.stale ? ' · STALE' : ''}
              </Text>
              <Text variant="bodySmall" style={muted}>
                {f.fresh_items} fresh · {f.total_items} total · fetched {f.last_fetched_at ? new Date(f.last_fetched_at).toLocaleString() : 'never'}
                {f.last_error ? ` · ${f.last_error.slice(0, 80)}` : ''}
              </Text>
            </View>
          ))}
          {(d.hints ?? []).map((h) => (
            <Text key={h} variant="bodySmall" style={{ color: theme.colors.tertiary }}>
              {h}
            </Text>
          ))}
          {STAGES.map((s) => {
            const e = d.last_errors[s];
            return (
              <List.Item
                key={s}
                title={STAGE_LABEL[s]}
                description={e ? `${e.message}\n${new Date(e.at).toLocaleString()}` : 'OK, no recent error'}
                descriptionNumberOfLines={5}
                descriptionStyle={e ? { color: theme.colors.error } : undefined}
                left={(p) => <List.Icon {...p} icon={e ? 'alert-circle-outline' : 'check-circle-outline'} />}
                style={styles.item}
              />
            );
          })}
        </>
      ) : null}
      <Button mode="contained-tonal" icon="key-chain" loading={test.isPending} disabled={test.isPending} onPress={() => test.mutate(undefined)}>
        Test OpenRouter key
      </Button>
      {test.isError ? <Text style={{ color: theme.colors.error }}>{errorMessage(test.error)}</Text> : null}
      {test.data ? (
        <View style={styles.results}>
          <Text variant="titleSmall" style={{ color: test.data.ok ? theme.colors.primary : theme.colors.error }}>
            {test.data.ok ? 'Key works' : 'Test failed'}
          </Text>
          {test.data.results.map((r) => (
            <Text key={r.model} variant="bodySmall" style={r.ok ? muted : { color: theme.colors.error }}>
              {r.model}: {r.ok ? 'OK' : `${r.status ? `HTTP ${r.status} – ` : ''}${r.message}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: layout.gutter, gap: 8 },
  item: { paddingHorizontal: 0 },
  results: { gap: 2 },
});
