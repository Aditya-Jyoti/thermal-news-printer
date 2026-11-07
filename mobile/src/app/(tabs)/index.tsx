import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { IconButton, Snackbar, Text, useTheme } from 'react-native-paper';

import { useCategories, useEdition, usePrints, useRefreshFeeds, useRebuildEdition } from '@/api/hooks';
import type { Category, EditionItem, PrintItem } from '@/api/types';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { EditionStatusBar, progressText } from '@/components/EditionStatusBar';
import { StoryCard } from '@/components/StoryCard';
import { errorMessage, formatDateTime, timeAgo } from '@/lib/format';
import { layout } from '@/theme/layout';

type Row =
  | { kind: 'next'; item: EditionItem }
  | { kind: 'printed'; item: PrintItem; category: Category | null };

interface Section {
  key: string;
  title: string;
  next: boolean;
  data: Row[];
}

// One automatic refresh per app session, after the first paint.
let autoRefreshed = false;

export default function FeedScreen() {
  const theme = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const edition = useEdition();
  const prints = usePrints(4);
  const categories = useCategories();
  const refresh = useRefreshFeeds();
  const rebuild = useRebuildEdition();
  const { mutate: refreshNow } = refresh;

  useEffect(() => {
    if (autoRefreshed) return;
    // After first paint: let the list render before any network / parsing work starts.
    const timer = setTimeout(() => {
      autoRefreshed = true;
      refreshNow(undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [refreshNow]);

  const onRefresh = useCallback(async () => {
    try {
      const r = await refresh.mutateAsync(undefined);
      setToast(r.new_articles > 0 ? `${r.new_articles} new articles fetched` : 'Already up to date');
    } catch (e) {
      setToast(`Refresh failed: ${errorMessage(e)}`);
    }
  }, [refresh]);

  const onRecurate = useCallback(() => rebuild.mutate(undefined, { onError: (e) => setToast(errorMessage(e)) }), [rebuild]);

  const sections = useMemo<Section[]>(() => {
    const bySlug = new Map<string, Category>((categories.data ?? []).map((c) => [c.slug, c]));
    const items = edition.data?.items ?? [];
    const out: Section[] = [
      {
        key: 'next',
        title: `Next edition · ${items.length} ${items.length === 1 ? 'story' : 'stories'}`,
        next: true,
        data: items.map((item) => ({ kind: 'next', item })),
      },
    ];
    for (const p of prints.data?.items ?? []) {
      if (p.status !== 'printed') continue;
      out.push({
        key: `print-${p.id}`,
        title: `Printed ${formatDateTime(p.created_at)}`,
        next: false,
        data: p.items.map((item) => ({ kind: 'printed', item, category: bySlug.get(item.category_slug) ?? null })),
      });
    }
    return out;
  }, [edition.data, prints.data, categories.data]);

  const status = edition.data?.status;
  const busyText = status ? progressText(status) : null;

  const renderItem = useCallback(({ item: row }: { item: Row }) => {
    if (row.kind === 'next') {
      const e = row.item;
      return (
        <StoryCard
          title={e.title}
          url={e.url}
          imageUrl={e.image_url}
          category={e.category}
          tldr={e.tldr}
          pendingText={status?.phase === 'idle' ? 'Summary unavailable. Will retry.' : 'Summarizing…'}
          meta={timeAgo(e.published_at)}
          position={e.position}
        />
      );
    }
    const p = row.item;
    return (
      <StoryCard
        title={p.title ?? p.tldr.slice(0, 80)}
        url={p.url ?? null}
        imageUrl={p.image_url ?? null}
        category={row.category ?? { id: 0, name: p.category_slug, color: null }}
        tldr={p.tldr}
      />
    );
  }, [status?.phase]);

  const header = useCallback(
    (s: Section) => (
      <View style={[styles.sectionHeader, { backgroundColor: theme.colors.background }]}>
        <Text variant="titleMedium" style={styles.sectionTitle}>
          {s.title}
        </Text>
        {s.next ? (
          <IconButton
            icon="auto-fix"
            accessibilityLabel="Re-curate the next edition"
            disabled={rebuild.isPending || status?.phase !== 'idle'}
            onPress={onRecurate}
          />
        ) : null}
      </View>
    ),
    [theme.colors.background, rebuild.isPending, status?.phase, onRecurate],
  );

  if (edition.isLoading) return <LoadingView />;
  if (edition.isError) return <ErrorView error={edition.error} onRetry={() => edition.refetch()} />;

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <SectionList
        sections={sections}
        keyExtractor={(row) => (row.kind === 'next' ? `n${row.item.article_id}` : `p${row.item.position}-${row.item.article_id ?? row.item.tldr.length}`)}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => header(section as Section)}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 && (section as Section).next ? (
            <View style={styles.empty}>
              <EmptyView
                title={busyText ?? 'Nothing queued yet'}
                hint={busyText ? undefined : 'Pull down to fetch your feeds. The AI will pick the best stories.'}
              />
            </View>
          ) : null
        }
        ListHeaderComponent={status ? <EditionStatusBar status={status} /> : undefined}
        ListHeaderComponentStyle={styles.listHeader}
        ItemSeparatorComponent={Separator}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refresh.isPending} onRefresh={onRefresh} />}
        contentContainerStyle={styles.list}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={7}
        removeClippedSubviews
      />
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={3500}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const Separator = () => <View style={styles.separator} />;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: layout.gutter, paddingBottom: layout.gutter * 2, flexGrow: 1 },
  listHeader: { paddingTop: 8 },
  empty: { paddingVertical: 24 },
  separator: { height: layout.cardGap },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: layout.touch, marginTop: 16 },
  sectionTitle: { flex: 1 },
});
