import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { FAB, Snackbar } from 'react-native-paper';

import {
  useCategories,
  useCreateCategory,
  useCreateFeed,
  useDeleteCategory,
  useDeleteFeed,
  useFeeds,
  useUpdateCategory,
  useUpdateFeed,
} from '@/api/hooks';
import type { Category, Feed } from '@/api/types';
import { CategoryDialog } from '@/components/CategoryDialog';
import { CategorySection } from '@/components/CategorySection';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { FeedDialog } from '@/components/FeedDialog';
import { confirmDestructive } from '@/lib/confirm';
import { errorMessage } from '@/lib/format';

type CatDialog = { mode: 'create' } | { mode: 'edit'; category: Category } | null;
type FeedDlg = { mode: 'create'; categoryId?: number } | { mode: 'edit'; feed: Feed } | null;

export default function SourcesScreen() {
  const categories = useCategories();
  const feeds = useFeeds();
  const createCat = useCreateCategory();
  const updateCat = useUpdateCategory();
  const deleteCat = useDeleteCategory();
  const createFeed = useCreateFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();

  const [catDialog, setCatDialog] = useState<CatDialog>(null);
  const [feedDialog, setFeedDialog] = useState<FeedDlg>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fail = (e: unknown) => setToast(errorMessage(e));

  if (categories.isLoading || feeds.isLoading) return <LoadingView />;
  if (categories.isError || feeds.isError) {
    return (
      <ErrorView
        error={categories.error ?? feeds.error}
        onRetry={() => {
          void categories.refetch();
          void feeds.refetch();
        }}
      />
    );
  }

  const cats = categories.data ?? [];
  const allFeeds = feeds.data ?? [];

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={categories.isRefetching || feeds.isRefetching}
            onRefresh={() => {
              void categories.refetch();
              void feeds.refetch();
            }}
          />
        }
      >
        {cats.length === 0 ? <EmptyView title="No categories" hint="Create a category, then add RSS feeds to it." /> : null}
        {cats.map((c) => (
          <CategorySection
            key={c.id}
            category={c}
            feeds={allFeeds.filter((f) => f.category_id === c.id)}
            onEditCategory={() => setCatDialog({ mode: 'edit', category: c })}
            onDeleteCategory={() =>
              confirmDestructive(
                `Delete "${c.name}"?`,
                `This also removes its ${c.feed_count} feed(s) and their articles.`,
                'Delete',
                () => deleteCat.mutate(c.id, { onError: fail }),
              )
            }
            onChangeLimit={(n) => updateCat.mutate({ id: c.id, body: { print_limit: n } }, { onError: fail })}
            onAddFeed={() => setFeedDialog({ mode: 'create', categoryId: c.id })}
            onEditFeed={(feed) => setFeedDialog({ mode: 'edit', feed })}
            onToggleFeed={(f, enabled) => updateFeed.mutate({ id: f.id, body: { enabled } }, { onError: fail })}
            onDeleteFeed={(f) =>
              confirmDestructive('Remove feed?', f.title || f.url, 'Remove', () => deleteFeed.mutate(f.id, { onError: fail }))
            }
          />
        ))}
      </ScrollView>

      <FAB icon="shape-plus-outline" label="Category" style={styles.fab} onPress={() => setCatDialog({ mode: 'create' })} />

      <CategoryDialog
        visible={catDialog !== null}
        category={catDialog?.mode === 'edit' ? catDialog.category : undefined}
        busy={createCat.isPending || updateCat.isPending}
        onDismiss={() => setCatDialog(null)}
        onSubmit={({ name, color }) => {
          const done = { onSuccess: () => setCatDialog(null), onError: fail };
          if (catDialog?.mode === 'edit') updateCat.mutate({ id: catDialog.category.id, body: { name, color } }, done);
          else createCat.mutate({ name, color }, done);
        }}
      />
      <FeedDialog
        visible={feedDialog !== null}
        categories={cats}
        feed={feedDialog?.mode === 'edit' ? feedDialog.feed : undefined}
        defaultCategoryId={feedDialog?.mode === 'create' ? feedDialog.categoryId : undefined}
        busy={createFeed.isPending || updateFeed.isPending}
        onDismiss={() => setFeedDialog(null)}
        onSubmit={(v) => {
          const done = { onSuccess: () => setFeedDialog(null), onError: fail };
          if (feedDialog?.mode === 'edit') updateFeed.mutate({ id: feedDialog.feed.id, body: v }, done);
          else createFeed.mutate(v, done);
        }}
      />

      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={4000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 96 },
  fab: { position: 'absolute', right: 16, bottom: 16 },
});
