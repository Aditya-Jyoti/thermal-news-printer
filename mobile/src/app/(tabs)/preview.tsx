import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

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
  const { mode } = useAppSettings();
  const { width } = useWindowDimensions();
  const [nonce, setNonce] = useState(() => Date.now());
  const [ratio, setRatio] = useState<number | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);

  const paperWidth = Math.min(PAPER_WIDTH, width - GUTTER);
  const scale = paperWidth / PAPER_WIDTH;

  // The real renderer output when available; null means "no renderer": show the in-app mock instead.
  const image = useQuery({
    queryKey: ['preview-image', nonce, mode],
    queryFn: () => api.previewImage(),
    retry: false,
    gcTime: 0,
  });
  const digest = useDigestPreview();

  const refresh = () => {
    setImgError(null);
    setRatio(null);
    setNonce(Date.now());
    void digest.refetch();
  };

  const mock = (notice: boolean) => {
    if (digest.isLoading) return <LoadingView />;
    if (digest.isError) return <ErrorView error={digest.error} onRetry={refresh} />;
    return (
      <View>
        {notice && (
          <Text variant="bodySmall" style={styles.notice}>
            Renderer not available yet — showing approximation
          </Text>
        )}
        {(digest.data ?? []).length === 0 ? (
          <EmptyView title="Nothing new to print" hint="Refresh feeds from the Feed tab." />
        ) : (
          <PaperFrame>
            <ReceiptMock items={digest.data ?? []} scale={scale} />
          </PaperFrame>
        )}
      </View>
    );
  };

  let body: React.ReactNode;
  if (image.isLoading) body = <LoadingView />;
  else if (image.isError) body = <ErrorView error={image.error} onRetry={refresh} />;
  else if (!image.data) body = mock(mode !== 'demo');
  else if (imgError) body = <ErrorView error={imgError} onRetry={refresh} />;
  else
    body = (
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
    );

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
  notice: { textAlign: 'center', opacity: 0.7, paddingHorizontal: 16, paddingBottom: 8 },
  scroll: { flexGrow: 1 },
});
