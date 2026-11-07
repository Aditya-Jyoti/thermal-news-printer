import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, IconButton, Text, useTheme } from 'react-native-paper';

import type { Category } from '@/api/types';
import { openArticle } from '@/lib/openArticle';

import { CategoryTag } from './CategoryTag';

export const IMAGE_HEIGHT = 160;

export interface StoryCardProps {
  title: string;
  url: string | null;
  imageUrl: string | null;
  category: Pick<Category, 'id' | 'name' | 'color'> | null;
  tldr: string | null;
  /** Shown instead of the TL;DR while it is missing. */
  pendingText?: string | null;
  meta?: string;
  /** 1-based position in the print order, shown as a small badge. */
  position?: number;
  /** Enables the read/unread UI when set (null/undefined article ids have no read state). */
  articleId?: number | null;
  read?: boolean;
  onSetRead?: (articleId: number, read: boolean) => void;
}

/** One story: image (if any), category pill, title and TL;DR. Tapping opens the original article. */
export const StoryCard = React.memo(function StoryCard({ title, url, imageUrl, category, tldr, pendingText, meta, position, articleId, read, onSetRead }: StoryCardProps) {
  const theme = useTheme();
  const readable = articleId != null && read !== undefined && !!onSetRead;
  const open = React.useCallback(() => {
    void openArticle(url, { toolbar: theme.colors.surface, controls: theme.colors.primary });
    if (readable && !read) onSetRead!(articleId!, true); // opening the original marks it read
  }, [url, theme.colors.surface, theme.colors.primary, readable, read, onSetRead, articleId]);
  return (
    <Card mode="elevated" style={styles.card} onPress={url ? open : undefined} accessibilityRole="link" accessibilityLabel={title}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={imageUrl}
          transition={120}
        />
      ) : null}
      <Card.Content style={styles.content}>
        <View style={styles.row}>
          {category ? <CategoryTag category={category} compact /> : <View />}
          <View style={styles.actions}>
            {position ? (
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                #{position}
              </Text>
            ) : null}
            {readable ? (
              <IconButton
                icon={read ? 'email-open-outline' : 'email-outline'}
                size={20}
                style={styles.readButton}
                accessibilityLabel={read ? 'Mark as unread' : 'Mark as read'}
                onPress={() => onSetRead!(articleId!, !read)}
              />
            ) : null}
          </View>
        </View>
        <View style={styles.titleRow}>
          {readable && !read ? <View style={[styles.dot, { backgroundColor: theme.colors.primary }]} accessibilityLabel="Unread" /> : null}
          <Text variant="titleMedium" style={[styles.title, readable && !read ? styles.unread : null]}>
            {title}
          </Text>
        </View>
        {tldr ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {tldr}
          </Text>
        ) : pendingText ? (
          <Text variant="bodyMedium" style={[styles.pending, { color: theme.colors.onSurfaceVariant }]}>
            {pendingText}
          </Text>
        ) : null}
        {meta ? (
          <Text variant="labelMedium" style={{ color: theme.colors.outline }}>
            {meta}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );
});

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
  image: { height: IMAGE_HEIGHT, width: '100%' },
  content: { paddingVertical: 16, paddingHorizontal: 16, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  pending: { fontStyle: 'italic' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  readButton: { margin: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1 },
  unread: { fontWeight: '700' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
