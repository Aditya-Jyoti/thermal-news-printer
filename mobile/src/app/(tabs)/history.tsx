import React, { useCallback, useMemo } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

import { useCategories, usePrints } from '@/api/hooks';
import type { Category, PrintItem, PrintStatus } from '@/api/types';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { StatusChip } from '@/components/StatusChip';
import { StoryCard } from '@/components/StoryCard';
import { formatDateTime } from '@/lib/format';
import { layout } from '@/theme/layout';

interface Row {
  item: PrintItem;
  category: Category | null;
}
interface Section {
  key: string;
  title: string;
  status: PrintStatus;
  subtitle: string;
  data: Row[];
}

export default function HistoryScreen() {
  const theme = useTheme();
  const q = usePrints(50);
  const categories = useCategories();
  const { refetch } = q;

  const sections = useMemo<Section[]>(() => {
    const bySlug = new Map((categories.data ?? []).map((c) => [c.slug, c]));
    return (q.data?.items ?? []).map((p) => ({
      key: String(p.id),
      title: formatDateTime(p.created_at),
      status: p.status,
      subtitle: [p.trigger === 'schedule' ? 'Scheduled' : 'Manual', `${p.items.length} ${p.items.length === 1 ? 'story' : 'stories'}`, p.error]
        .filter(Boolean)
        .join(' · '),
      data: p.items.map((item) => ({ item, category: bySlug.get(item.category_slug) ?? null })),
    }));
  }, [q.data, categories.data]);

  const onRefresh = useCallback(() => void refetch(), [refetch]);

  if (q.isLoading) return <LoadingView />;
  if (q.isError) return <ErrorView error={q.error} onRetry={onRefresh} />;

  return (
    <SectionList
      style={{ backgroundColor: theme.colors.background }}
      sections={sections}
      keyExtractor={(r) => `${r.item.position}-${r.item.article_id ?? r.item.tldr.length}`}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={onRefresh} />}
      ListEmptyComponent={<EmptyView title="No prints yet" hint="Printed editions will show up here." />}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      ItemSeparatorComponent={Separator}
      renderSectionHeader={({ section }) => {
        const s = section as Section;
        return (
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text variant="titleMedium">{s.title}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {s.subtitle}
              </Text>
            </View>
            <StatusChip status={s.status} />
          </View>
        );
      }}
      renderItem={({ item: r }) => (
        <StoryCard
          title={r.item.title ?? r.item.tldr.slice(0, 80)}
          url={r.item.url ?? null}
          imageUrl={r.item.image_url ?? null}
          category={r.category ?? { id: 0, name: r.item.category_slug, color: null }}
          tldr={r.item.tldr}
        />
      )}
      initialNumToRender={5}
      maxToRenderPerBatch={5}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const Separator = () => <View style={styles.separator} />;

const styles = StyleSheet.create({
  list: { paddingHorizontal: layout.gutter, paddingBottom: layout.gutter * 2, flexGrow: 1 },
  separator: { height: layout.cardGap },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: layout.touch, marginTop: 16, marginBottom: 8 },
  headerText: { flex: 1, gap: 2 },
});
