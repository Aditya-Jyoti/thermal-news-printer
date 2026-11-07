import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { Chip, Icon, Text, useTheme } from 'react-native-paper';

import { useHistory, useSetRead } from '@/api/hooks';
import type { HistoryEdition, HistoryItem } from '@/api/types';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { StoryCard } from '@/components/StoryCard';
import { groupHistoryByDay, type DayGroup } from '@/lib/history';
import { layout } from '@/theme/layout';

type Row =
  | { kind: 'edition'; key: string; edition: HistoryEdition }
  | { kind: 'story'; key: string; item: HistoryItem };

interface Section {
  key: string;
  group: DayGroup;
  open: boolean;
  data: Row[];
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function HistoryScreen() {
  const theme = useTheme();
  const q = useHistory();
  const setRead = useSetRead();
  const { refetch } = q;
  const { mutate: setReadNow } = setRead;
  // Explicit user toggles; days not in here follow the default (only the most recent day is open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupHistoryByDay(q.data ?? []), [q.data]);

  const sections = useMemo<Section[]>(
    () =>
      groups.map((group, idx) => {
        const open = group.key in toggled ? toggled[group.key] : idx === 0;
        const data: Row[] = [];
        if (open) {
          for (const edition of group.editions) {
            data.push({ kind: 'edition', key: `e${edition.id}`, edition });
            for (const item of edition.items) data.push({ kind: 'story', key: `e${edition.id}-${item.position}`, item });
          }
        }
        return { key: group.key, group, open, data };
      }),
    [groups, toggled],
  );

  const toggle = useCallback((key: string, open: boolean) => setToggled((t) => ({ ...t, [key]: !open })), []);
  const onSetRead = useCallback((articleId: number, read: boolean) => setReadNow({ articleId, read }), [setReadNow]);
  const onRefresh = useCallback(() => void refetch(), [refetch]);

  if (q.isLoading) return <LoadingView />;
  if (q.isError) return <ErrorView error={q.error} onRetry={onRefresh} />;

  return (
    <SectionList
      style={{ backgroundColor: theme.colors.background }}
      sections={sections}
      keyExtractor={(r) => r.key}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={onRefresh} />}
      ListEmptyComponent={<EmptyView title="No history yet" hint="Printed editions, and stories you rolled over with Fetch new news, show up here." />}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => {
        const s = section as Section;
        const g = s.group;
        return (
          <Pressable
            onPress={() => toggle(s.key, s.open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: s.open }}
            accessibilityLabel={`${g.label}, ${g.stories} ${g.stories === 1 ? 'story' : 'stories'}`}
            style={[styles.dayHeader, { backgroundColor: theme.colors.surfaceVariant }]}
          >
            <View style={styles.dayText}>
              <Text variant="titleMedium">{g.label}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {g.stories} {g.stories === 1 ? 'story' : 'stories'}
              </Text>
            </View>
            <View style={styles.chips}>
              {g.printed > 0 ? (
                <Chip compact style={{ backgroundColor: theme.colors.primaryContainer }}>
                  Printed {g.printed}
                </Chip>
              ) : null}
              {g.notPrinted > 0 ? <Chip compact>Not printed {g.notPrinted}</Chip> : null}
            </View>
            <Icon source={s.open ? 'chevron-up' : 'chevron-down'} size={24} />
          </Pressable>
        );
      }}
      renderItem={({ item: r }) =>
        r.kind === 'edition' ? (
          <View style={styles.editionRow}>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              {timeOf(r.edition.archived_at)} · {r.edition.printed ? 'Printed' : 'Not printed'}
            </Text>
          </View>
        ) : (
          <View style={styles.story}>
            <StoryCard
              title={r.item.title ?? (r.item.tldr ?? '').slice(0, 80)}
              url={r.item.url}
              imageUrl={r.item.image_url}
              category={r.item.category ?? { id: 0, name: r.item.category_slug, color: null }}
              tldr={r.item.tldr}
              articleId={r.item.article_id}
              read={r.item.article_id != null ? r.item.read_at !== null : undefined}
              onSetRead={onSetRead}
            />
          </View>
        )
      }
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: layout.gutter, paddingBottom: layout.gutter * 2, flexGrow: 1 },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: layout.touch,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  dayText: { flex: 1, gap: 2 },
  chips: { flexDirection: 'row', gap: 6, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  editionRow: { paddingTop: 12, paddingBottom: 6, paddingHorizontal: 4 },
  story: { paddingBottom: layout.cardGap },
});
