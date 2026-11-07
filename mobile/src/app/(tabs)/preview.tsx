import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';

import { useEdition } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { EditionStatusBar, progressText } from '@/components/EditionStatusBar';
import { PaperFrame } from '@/components/PaperFrame';
import { PAPER_WIDTH, ReceiptMock } from '@/components/ReceiptMock';
import { errorMessage } from '@/lib/format';
import { previewModel } from '@/lib/previewModel';
import { useAppSettings } from '@/state/settings';
import { layout } from '@/theme/layout';

export default function PreviewScreen() {
  const api = useApi();
  const theme = useTheme();
  const { mode } = useAppSettings();
  const { width } = useWindowDimensions();
  const [ratio, setRatio] = useState<number | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const edition = useEdition();

  const paperWidth = Math.min(PAPER_WIDTH, width - layout.gutter * 2);
  const scale = paperWidth / PAPER_WIDTH;

  // Exactly the persisted edition: summarized stories are rendered for real, the rest become placeholders.
  const status = edition.data?.status;
  const idle = status?.phase === 'idle';
  const { ready: digest, pending } = useMemo(() => previewModel(edition.data?.items ?? [], idle ?? false), [edition.data, idle]);
  // The query key is the edition's content, so the (expensive) render only re-runs when it really changed.
  const signature = digest.map((d) => `${d.article_id}:${d.tldr.length}`).join(',');

  const image = useQuery({
    queryKey: ['preview-image', mode, signature],
    queryFn: () => api.previewImage(),
    enabled: !!edition.data && idle && digest.length > 0,
    retry: false,
    staleTime: Infinity,
    gcTime: 60_000,
  });

  const refresh = () => {
    setImgError(null);
    setRatio(null);
    void edition.refetch();
    void image.refetch();
  };

  const busy = status ? progressText(status) : null;
  const mock = (notice: boolean) => (
    <View>
      {notice && !busy && (
        <Text variant="bodySmall" style={styles.notice}>
          Renderer not available, showing approximation
        </Text>
      )}
      <PaperFrame>
        <ReceiptMock items={digest} scale={scale} />
      </PaperFrame>
    </View>
  );

  const pendingBlock =
    pending.length > 0 ? (
      <View>
        <Text variant="bodySmall" style={styles.notice}>
          {pending.length} {pending.length === 1 ? 'story is' : 'stories are'} still waiting for a summary and not in the print yet.
        </Text>
        <PaperFrame>
          <ReceiptMock items={pending} scale={scale} />
        </PaperFrame>
      </View>
    ) : null;

  let body: React.ReactNode;
  if (edition.isLoading) body = <LoadingView />;
  else if (edition.isError) body = <ErrorView error={edition.error} onRetry={refresh} />;
  else if (digest.length === 0 && pending.length === 0)
    body = (
      <EmptyView
        title={busy ?? 'Nothing to preview yet'}
        hint={busy ? undefined : 'The next edition is empty. Tap "Fetch new news" on the Feed tab to fetch and curate stories.'}
      />
    );
  else if (digest.length === 0)
    // Nothing summarized: say so explicitly (progress or the error shown above), never a blank pane.
    body = (
      <View>
        <Text variant="bodyMedium" style={styles.notice}>
          {busy ?? (status?.last_error ? 'No summaries yet because of the error above.' : 'No summaries yet. They are retried on the next refresh.')}
        </Text>
        {pendingBlock}
      </View>
    );
  else if (!idle || image.isLoading || image.isFetching)
    body = (
      <View>
        {mock(false)}
        {pendingBlock}
      </View>
    );
  else if (image.isError) body = <ErrorView error={image.error} onRetry={refresh} />;
  else if (!image.data)
    body = (
      <View>
        {mock(mode !== 'demo')}
        {pendingBlock}
      </View>
    );
  else if (imgError) body = <ErrorView error={imgError} onRetry={refresh} />;
  else
    body = (
      <View>
        <PaperFrame>
          <Image
            source={{ uri: image.data.uri }}
            cachePolicy="none"
            contentFit="fill"
            style={{ width: paperWidth, aspectRatio: ratio ?? 384 / 600 }}
            onLoad={(e) => setRatio(e.source.width / e.source.height)}
            onError={(e) => setImgError(errorMessage(e.error))}
          />
        </PaperFrame>
        {pendingBlock}
      </View>
    );

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <View style={styles.toolbar}>
        <Text variant="bodyMedium" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
          {digest.length} {digest.length === 1 ? 'story' : 'stories'}{pending.length ? ` (+${pending.length} pending)` : ''} · exactly as it will print ({PAPER_WIDTH}px, 1-bit)
        </Text>
        <Button mode="contained-tonal" icon="refresh" onPress={refresh} contentStyle={styles.buttonContent}>
          Refresh
        </Button>
      </View>
      {status ? (
        <View style={styles.status}>
          <EditionStatusBar status={status} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: layout.gutter, paddingVertical: 12, gap: 12 },
  hint: { flex: 1 },
  buttonContent: { minHeight: layout.touch - 8 },
  status: { paddingHorizontal: layout.gutter, paddingBottom: 12 },
  notice: { textAlign: 'center', opacity: 0.7, paddingHorizontal: layout.gutter, paddingBottom: 8 },
  scroll: { flexGrow: 1, paddingBottom: layout.gutter * 2 },
});
