import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, Snackbar, useTheme } from 'react-native-paper';

import { useArticles, useCategories, useRefreshFeeds } from '@/api/hooks';
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

  const onRefresh = useCallback(async () => {
    try {
      const r = await refresh.mutateAsync(undefined);
      setToast(`${r.new_articles} new, ${r.skipped_duplicates} duplicates skipped`);
    } catch (e) {
      setToast(`Refresh failed: ${errorMessage(e)}`);
      await qc.invalidateQueries({ queryKey: ['articles'] });
    }
  }, [refresh, qc]);

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          <Chip selected={categoryId === null} showSelectedOverlay onPress={() => setCategoryId(null)}>
            All
          </Chip>
          {(categories.data ?? []).map((c) => (
            <CategoryTag key={c.id} category={c} selected={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
          ))}
        </ScrollView>
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
  filters: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: 'center' },
  list: { paddingBottom: 24, flexGrow: 1 },
});
