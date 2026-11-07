import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Button, Snackbar, Text, useTheme } from 'react-native-paper';

import { useEdition, useFetchNews, useRefreshFeeds, useSetRead } from '@/api/hooks';
import type { EditionItem } from '@/api/types';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { EditionStatusBar, progressText } from '@/components/EditionStatusBar';
import { StoryCard } from '@/components/StoryCard';
import { errorMessage, timeAgo } from '@/lib/format';
import { layout } from '@/theme/layout';

// One automatic light refresh per app session, after the first paint.
let autoRefreshed = false;

export default function FeedScreen() {
  const theme = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const edition = useEdition();
  const refresh = useRefreshFeeds();
  const fetchNews = useFetchNews();
  const setRead = useSetRead();
  const { mutate: refreshNow } = refresh;
  const { mutate: setReadNow } = setRead;

  useEffect(() => {
    if (autoRefreshed) return;
    const timer = setTimeout(() => {
      autoRefreshed = true;
      refreshNow(undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [refreshNow]);

  /** Pull-to-refresh: a light "check for updates" that keeps the current edition. */
  const onRefresh = useCallback(async () => {
    try {
      const r = await refresh.mutateAsync(undefined);
      setToast(r.new_articles > 0 ? `${r.new_articles} new articles found` : 'Already up to date');
    } catch (e) {
      setToast(`Refresh failed: ${errorMessage(e)}`);
    }
  }, [refresh]);

  /** Explicit roll-over: current stories go to History, then a fresh edition is curated. */
  const onFetchNew = useCallback(async () => {
    try {
      const r = await fetchNews.mutateAsync(undefined);
      setToast(`Moved the previous stories to History. ${r.ingest.new_articles} new articles fetched.`);
    } catch (e) {
      setToast(`Fetch failed: ${errorMessage(e)}`);
    }
  }, [fetchNews]);

  const onSetRead = useCallback((articleId: number, read: boolean) => setReadNow({ articleId, read }), [setReadNow]);

  const items = useMemo(() => edition.data?.items ?? [], [edition.data]);
  const target = edition.data?.target ?? items.length;
  const unread = useMemo(() => items.filter((i) => i.read_at === null).length, [items]);
  const status = edition.data?.status;
  const busyText = status ? progressText(status) : null;
  const idle = status?.phase === 'idle';

  const renderItem = useCallback(
    ({ item: e }: { item: EditionItem }) => (
      <StoryCard
        title={e.title}
        url={e.url}
        imageUrl={e.image_url}
        category={e.category}
        tldr={e.tldr}
        pendingText={idle ? 'Summary unavailable. Will retry.' : 'Summarizing…'}
        meta={timeAgo(e.published_at)}
        position={e.position}
        articleId={e.article_id}
        read={e.read_at !== null}
        onSetRead={onSetRead}
      />
    ),
    [idle, onSetRead],
  );

  const header = useMemo(() => {
    const short = items.length > 0 && items.length < target;
    return (
      <View style={styles.header}>
        <Button
          mode="contained-tonal"
          icon="newspaper-plus"
          loading={fetchNews.isPending}
          disabled={fetchNews.isPending}
          onPress={onFetchNew}
          contentStyle={styles.fetchContent}
        >
          Fetch new news
        </Button>
        {status ? <EditionStatusBar status={status} /> : null}
        <View style={styles.summary}>
          <Text variant="titleMedium">
            {items.length === 0 ? 'Next edition' : `${items.length} of ${target} stories`}
            {items.length > 0 ? ` · ${unread} unread` : ''}
          </Text>
          {short ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {items.length} of {target} — not enough fresh stories within your category limits.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }, [fetchNews.isPending, onFetchNew, status, items.length, target, unread, theme.colors.onSurfaceVariant]);

  if (edition.isLoading) return <LoadingView />;
  if (edition.isError) return <ErrorView error={edition.error} onRetry={() => edition.refetch()} />;

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={items}
        keyExtractor={(e) => String(e.article_id)}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.empty}>
            <EmptyView
              title={busyText ?? 'Nothing queued yet'}
              hint={busyText ? undefined : 'Tap "Fetch new news" and the AI will pick the best stories.'}
            />
          </View>
        }
        ItemSeparatorComponent={Separator}
        refreshControl={<RefreshControl refreshing={refresh.isPending} onRefresh={onRefresh} />}
        contentContainerStyle={styles.list}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={7}
        removeClippedSubviews
      />
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={4000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const Separator = () => <View style={styles.separator} />;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: layout.gutter, paddingBottom: layout.gutter * 2, flexGrow: 1 },
  header: { paddingTop: 12, paddingBottom: 12, gap: 12 },
  fetchContent: { minHeight: layout.touch },
  summary: { gap: 2 },
  empty: { paddingVertical: 24 },
  separator: { height: layout.cardGap },
});
