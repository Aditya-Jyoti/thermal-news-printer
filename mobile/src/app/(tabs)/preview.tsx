import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

import { isNotImplemented } from '@/api/errors';
import { useDigestPreview } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { PaperFrame } from '@/components/PaperFrame';
import { PAPER_WIDTH, ReceiptMock } from '@/components/ReceiptMock';
import { errorMessage } from '@/lib/format';
import { useAppSettings } from '@/state/settings';

const GUTTER = 32;

export default function PreviewScreen() {
  const api = useApi();
  const { demo } = useAppSettings();
  const { width } = useWindowDimensions();
  const [nonce, setNonce] = useState(() => Date.now());
  const [ratio, setRatio] = useState<number | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);

  const paperWidth = Math.min(PAPER_WIDTH, width - GUTTER);
  const scale = paperWidth / PAPER_WIDTH;

  // Probe the renderer first so a 501 gives a friendly message rather than a broken image.
  const probe = useQuery({
    queryKey: ['preview-probe', nonce],
    queryFn: () => api.checkPreview(),
    enabled: !demo,
    retry: false,
  });
  const digest = useDigestPreview();

  const refresh = () => {
    setImgError(null);
    setRatio(null);
    setNonce(Date.now());
    void digest.refetch();
  };

  let body: React.ReactNode;
  if (demo) {
    if (digest.isLoading) body = <LoadingView />;
    else if (digest.isError) body = <ErrorView error={digest.error} onRetry={refresh} />;
    else if ((digest.data ?? []).length === 0) body = <EmptyView title="Nothing new to print" hint="Refresh feeds from the Feed tab." />;
    else
      body = (
        <PaperFrame>
          <ReceiptMock items={digest.data ?? []} scale={scale} />
        </PaperFrame>
      );
  } else if (probe.isLoading) {
    body = <LoadingView />;
  } else if (probe.isError) {
    body = isNotImplemented(probe.error) ? (
      <EmptyView title="Renderer not available yet" hint="The backend has not implemented the print renderer. Enable demo data in Settings to see a placeholder layout." />
    ) : (
      <ErrorView error={probe.error} onRetry={refresh} />
    );
  } else if (imgError) {
    body = <ErrorView error={imgError} onRetry={refresh} />;
  } else {
    const uri = api.previewUrl(nonce);
    body = (
      <PaperFrame>
        <Image
          source={{ uri: uri ?? undefined }}
          cachePolicy="none"
          contentFit="fill"
          style={{ width: paperWidth, aspectRatio: ratio ?? 384 / 600 }}
          onLoad={(e) => setRatio(e.source.width / e.source.height)}
          onError={(e) => setImgError(errorMessage(e.error))}
        />
      </PaperFrame>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.toolbar}>
        <Text variant="bodyMedium" style={styles.hint}>
          Exactly as it will print: {PAPER_WIDTH}px wide, 1-bit.
        </Text>
        <Button mode="contained-tonal" icon="refresh" onPress={refresh}>
          Refresh
        </Button>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 },
  hint: { flex: 1, opacity: 0.8 },
  scroll: { flexGrow: 1 },
});
