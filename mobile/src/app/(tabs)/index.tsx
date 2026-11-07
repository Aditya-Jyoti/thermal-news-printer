import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, IconButton, Menu, Snackbar, useTheme } from 'react-native-paper';

import { useArticles, useCategories, useProcessAi, useRefreshFeeds } from '@/api/hooks';
import { ArticleCard } from '@/components/ArticleCard';
import { CategoryTag } from '@/components/CategoryTag';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { errorMessage } from '@/lib/format';

export default function FeedScreen() {
  const router = useRouter();
  const theme = useTheme();
  const qc = useQueryClient();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const categories = useCategories();
  const articles = useArticles(categoryId);
  const refresh = useRefreshFeeds();
  const process = useProcessAi();
  const [menu, setMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  // Summaries arrive in the background: refetch shortly after a refresh, then poll while any are missing.
  const pollUntil = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const hasPending = (articles.data?.items ?? []).some((a) => a.tldr === null && a.is_political !== true);
  const refetchArticles = articles.refetch;
  useEffect(() => {
    if (!focused || !hasPending) return;
    const id = setInterval(() => {
      if (Date.now() < pollUntil.current) void refetchArticles();
    }, 6000);
    return () => clearInterval(id);
  }, [focused, hasPending, refetchArticles]);

  const schedulePolling = useCallback(() => {
    pollUntil.current = Date.now() + 60_000;
    timers.current.forEach(clearTimeout);
    timers.current = [5000, 15000].map((ms) => setTimeout(() => void qc.invalidateQueries({ queryKey: ['articles'] }), ms));
  }, [qc]);

  const onSummarize = useCallback(async () => {
    setMenu(false);
    try {
      const r = await process.mutateAsync(undefined);
      setToast(
        r.skipped_no_key
          ? 'Add OPENROUTER_API_KEY on the backend'
          : `Summarized ${r.summarized}, flagged political ${r.flagged_political}, failed ${r.failed}`,
      );
    } catch (e) {
      setToast(`Summarize failed: ${errorMessage(e)}`);
    }
  }, [process]);

  const onRefresh = useCallback(async () => {
    try {
      const r = await refresh.mutateAsync(undefined);
      setToast(`${r.new_articles} new, ${r.skipped_duplicates} duplicates skipped`);
      schedulePolling();
    } catch (e) {
      setToast(`Refresh failed: ${errorMessage(e)}`);
      await qc.invalidateQueries({ queryKey: ['articles'] });
    }
  }, [refresh, qc, schedulePolling]);

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <View style={styles.top}>
        <ScrollView horizontal style={styles.flex} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          <Chip selected={categoryId === null} showSelectedOverlay onPress={() => setCategoryId(null)}>
            All
          </Chip>
          {(categories.data ?? []).map((c) => (
            <CategoryTag key={c.id} category={c} selected={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
          ))}
        </ScrollView>
        <Menu
          visible={menu}
          onDismiss={() => setMenu(false)}
          anchor={<IconButton icon="dots-vertical" disabled={process.isPending} onPress={() => setMenu(true)} />}
        >
          <Menu.Item leadingIcon="text-short" title={process.isPending ? 'Summarizing…' : 'Summarize now'} onPress={onSummarize} />
        </Menu>
      </View>

      {articles.isLoading ? (
        <LoadingView />
      ) : articles.isError ? (
        <ErrorView error={articles.error} onRetry={() => articles.refetch()} />
      ) : (
        <FlatList
          data={articles.data?.items ?? []}
          keyExtractor={(a) => String(a.id)}
          renderItem={({ item }) => (
            <ArticleCard article={item} onPress={() => router.push({ pathname: '/article/[id]', params: { id: String(item.id) } })} />
          )}
          ListEmptyComponent={<EmptyView title="No articles yet" hint="Pull down to fetch your feeds." />}
          refreshControl={<RefreshControl refreshing={refresh.isPending} onRefresh={onRefresh} />}
          contentContainerStyle={styles.list}
        />
      )}
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={3500}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center' },
  filters: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: 'center' },
  list: { paddingBottom: 24, flexGrow: 1 },
});
