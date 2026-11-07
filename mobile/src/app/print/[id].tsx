import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Card, Text } from 'react-native-paper';

import { useCategories, usePrint } from '@/api/hooks';
import { ErrorView, LoadingView } from '@/components/common';
import { useCategoryColor } from '@/components/CategoryTag';
import { StatusChip } from '@/components/StatusChip';
import { formatDateTime } from '@/lib/format';


export default function PrintDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const q = usePrint(Number(id));
  const cats = useCategories();
  const colorOf = useCategoryColor();

  if (q.isLoading) return <LoadingView />;
  if (q.isError || !q.data) return <ErrorView error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;

  return (
    <FlatList
      data={[...p.items].sort((a, b) => a.position - b.position)}
      keyExtractor={(i) => String(i.position)}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text variant="titleLarge">{formatDateTime(p.created_at)}</Text>
          <View style={styles.row}>
            <StatusChip status={p.status} />
            <Text variant="bodyMedium">{p.trigger === 'schedule' ? 'Scheduled' : 'Manual'}</Text>
          </View>
          {p.error ? <Text variant="bodyMedium">{p.error}</Text> : null}
        </View>
      }
      renderItem={({ item }) => {
        const cat = cats.data?.find((c) => c.slug === item.category_slug);
        const color = cat ? colorOf(cat) : undefined;
        return (
          <Card
            disabled={item.article_id === null}
            onPress={() => item.article_id !== null && router.push({ pathname: '/article/[id]', params: { id: String(item.article_id) } })}
          >
            <Card.Content style={styles.content}>
              <Text variant="labelLarge" style={{ color }}>
                #{item.category_slug}
              </Text>
              <Text variant="bodyLarge">{item.tldr}</Text>
              {item.article_id === null ? (
                <Text variant="bodySmall" style={styles.dim}>
                  Original article no longer available
                </Text>
              ) : null}
            </Card.Content>
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  header: { gap: 6, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  content: { gap: 4 },
  dim: { opacity: 0.6 },
});
