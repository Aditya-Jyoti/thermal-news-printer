import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Card, Text } from 'react-native-paper';

import { usePrints } from '@/api/hooks';
import { EmptyView, ErrorView, LoadingView } from '@/components/common';
import { StatusChip } from '@/components/StatusChip';
import { formatDateTime } from '@/lib/format';

export default function HistoryScreen() {
  const router = useRouter();
  const q = usePrints();

  if (q.isLoading) return <LoadingView />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => q.refetch()} />;

  return (
    <FlatList
      data={q.data?.items ?? []}
      keyExtractor={(p) => String(p.id)}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
      ListEmptyComponent={<EmptyView title="No prints yet" hint="Printed editions will show up here." />}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Card style={styles.card} onPress={() => router.push({ pathname: '/print/[id]', params: { id: String(item.id) } })}>
          <Card.Content style={styles.content}>
            <View style={styles.row}>
              <Text variant="titleMedium">{formatDateTime(item.created_at)}</Text>
              <StatusChip status={item.status} />
            </View>
            <Text variant="bodyMedium" style={styles.meta}>
              {item.trigger === 'schedule' ? 'Scheduled' : 'Manual'} - {item.items.length} {item.items.length === 1 ? 'item' : 'items'}
            </Text>
            {item.error ? <Text variant="bodySmall">{item.error}</Text> : null}
          </Card.Content>
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12, flexGrow: 1 },
  card: {},
  content: { gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  meta: { opacity: 0.7 },
});
