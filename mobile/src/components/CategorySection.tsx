import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Divider, IconButton, List, Surface, Switch, Text, useTheme } from 'react-native-paper';

import type { Category, Feed } from '@/api/types';
import { timeAgo } from '@/lib/format';

import { CategoryTag } from './CategoryTag';

interface Props {
  category: Category;
  feeds: Feed[];
  onEditCategory: () => void;
  onDeleteCategory: () => void;
  onChangeLimit: (limit: number) => void;
  onAddFeed: () => void;
  onEditFeed: (f: Feed) => void;
  onToggleFeed: (f: Feed, enabled: boolean) => void;
  onDeleteFeed: (f: Feed) => void;
}

/** One category: header (tag, limit stepper, actions) followed by its feeds. */
export function CategorySection(p: Props) {
  const theme = useTheme();
  const { category: c } = p;
  return (
    <Surface elevation={1} style={styles.section}>
      <View style={styles.header}>
        <CategoryTag category={c} />
        <View style={styles.actions}>
          <IconButton icon="pencil-outline" size={20} onPress={p.onEditCategory} accessibilityLabel="Edit category" />
          <IconButton icon="trash-can-outline" size={20} onPress={p.onDeleteCategory} accessibilityLabel="Delete category" />
        </View>
      </View>

      <View style={styles.limitRow}>
        <Text variant="bodyMedium" style={styles.limitLabel}>
          Max per print
        </Text>
        <IconButton
          mode="contained-tonal"
          icon="minus"
          size={18}
          disabled={c.print_limit <= 0}
          onPress={() => p.onChangeLimit(c.print_limit - 1)}
          accessibilityLabel="Decrease limit"
        />
        <Text variant="titleMedium" style={styles.limitValue}>
          {c.print_limit}
        </Text>
        <IconButton
          mode="contained-tonal"
          icon="plus"
          size={18}
          disabled={c.print_limit >= 20}
          onPress={() => p.onChangeLimit(c.print_limit + 1)}
          accessibilityLabel="Increase limit"
        />
      </View>
      <Divider />

      {p.feeds.length === 0 ? (
        <Text variant="bodySmall" style={styles.empty}>
          No feeds in this category.
        </Text>
      ) : (
        p.feeds.map((f) => (
          <List.Item
            key={f.id}
            title={f.title || f.url}
            titleNumberOfLines={1}
            description={() => (
              <View>
                <Text variant="bodySmall" numberOfLines={1} style={styles.dim}>
                  {f.url}
                </Text>
                {f.last_error ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.error }} numberOfLines={2}>
                    {f.last_error}
                  </Text>
                ) : f.last_fetched_at ? (
                  <Text variant="bodySmall" style={styles.dim}>
                    Fetched {timeAgo(f.last_fetched_at)}
                  </Text>
                ) : null}
              </View>
            )}
            onPress={() => p.onEditFeed(f)}
            right={() => (
              <View style={styles.feedActions}>
                <Switch value={f.enabled} onValueChange={(v) => p.onToggleFeed(f, v)} />
                <IconButton icon="trash-can-outline" size={20} onPress={() => p.onDeleteFeed(f)} accessibilityLabel="Delete feed" />
              </View>
            )}
          />
        ))
      )}
      <Button icon="plus" onPress={p.onAddFeed} style={styles.add}>
        Add feed
      </Button>
    </Surface>
  );
}

const styles = StyleSheet.create({
  section: { borderRadius: 16, overflow: 'hidden', marginBottom: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingTop: 8 },
  actions: { flexDirection: 'row' },
  limitRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingBottom: 4 },
  limitLabel: { flex: 1 },
  limitValue: { minWidth: 28, textAlign: 'center' },
  feedActions: { flexDirection: 'row', alignItems: 'center' },
  dim: { opacity: 0.7 },
  empty: { padding: 16, opacity: 0.7 },
  add: { alignSelf: 'flex-start', marginVertical: 4 },
});
