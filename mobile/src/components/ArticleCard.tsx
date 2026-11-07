import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, Text } from 'react-native-paper';

import type { ArticleSummary } from '@/api/types';
import { timeAgo } from '@/lib/format';

import { CategoryTag } from './CategoryTag';

export function ArticleCard({ article, onPress }: { article: ArticleSummary; onPress: () => void }) {
  const meta = [article.author, timeAgo(article.published_at)].filter(Boolean).join(' - ');
  return (
    <Card mode="elevated" style={styles.card} onPress={onPress}>
      {article.image_url ? (
        <Image source={{ uri: article.image_url }} style={styles.image} contentFit="cover" transition={150} />
      ) : null}
      <Card.Content style={styles.content}>
        <View style={styles.row}>
          <CategoryTag category={article.category} compact />
          {article.printed_at ? (
            <Text variant="labelSmall" style={styles.printed}>
              Printed
            </Text>
          ) : null}
        </View>
        <Text variant="titleMedium">{article.title}</Text>
        {meta ? (
          <Text variant="bodySmall" style={styles.meta}>
            {meta}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6, overflow: 'hidden' },
  image: { height: 160, width: '100%' },
  content: { paddingTop: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  meta: { opacity: 0.7 },
  printed: { opacity: 0.6 },
});
