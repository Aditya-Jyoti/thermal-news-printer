import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, Surface, Text, useTheme } from 'react-native-paper';
import RenderHtml from 'react-native-render-html';

import { useArticle } from '@/api/hooks';
import { CategoryTag } from '@/components/CategoryTag';
import { ErrorView, LoadingView } from '@/components/common';
import { formatDateTime } from '@/lib/format';

export default function ArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const q = useArticle(Number(id));

  const tagsStyles = useMemo(
    () => ({
      body: { color: theme.colors.onSurface, fontSize: 16, lineHeight: 24 },
      a: { color: theme.colors.primary },
      h1: { color: theme.colors.onSurface },
      h2: { color: theme.colors.onSurface },
      h3: { color: theme.colors.onSurface },
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.outline,
        paddingLeft: 12,
        marginLeft: 0,
        color: theme.colors.onSurfaceVariant,
      },
    }),
    [theme],
  );

  if (q.isLoading) return <LoadingView />;
  if (q.isError || !q.data) return <ErrorView error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const meta = [a.author, a.published_at ? formatDateTime(a.published_at) : null].filter(Boolean).join(' - ');

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen options={{ title: a.category.name }} />
      {a.image_url ? <Image source={{ uri: a.image_url }} style={styles.image} contentFit="cover" /> : null}
      <View style={styles.body}>
        <CategoryTag category={a.category} />
        <Text variant="headlineSmall">{a.title}</Text>
        {meta ? (
          <Text variant="bodySmall" style={styles.meta}>
            {meta}
          </Text>
        ) : null}

        {a.tldr ? (
          <Surface elevation={0} style={[styles.tldr, { backgroundColor: theme.colors.primaryContainer }]}>
            <Text variant="labelLarge" style={{ color: theme.colors.onPrimaryContainer }}>
              TL;DR
            </Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onPrimaryContainer }}>
              {a.tldr}
            </Text>
          </Surface>
        ) : null}

        {a.content_html ? (
          <RenderHtml
            contentWidth={width - 32}
            source={{ html: a.content_html }}
            tagsStyles={tagsStyles}
            baseStyle={{ color: theme.colors.onSurface }}
            enableExperimentalMarginCollapsing
          />
        ) : a.content_text ? (
          <Text variant="bodyLarge">{a.content_text}</Text>
        ) : (
          <Text variant="bodyMedium" style={styles.meta}>
            No full text in the feed. Use the Open original button.
          </Text>
        )}

        <Button mode="contained-tonal" icon="open-in-new" onPress={() => Linking.openURL(a.url)}>
          Open original
        </Button>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32 },
  image: { width: '100%', height: 220 },
  body: { padding: 16, gap: 12 },
  meta: { opacity: 0.7 },
  tldr: { padding: 16, borderRadius: 16, gap: 4 },
});
