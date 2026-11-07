import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, HelperText, Portal, Switch, Text, TextInput } from 'react-native-paper';

import type { Category, Feed } from '@/api/types';

import { CategoryTag } from './CategoryTag';

interface Props {
  visible: boolean;
  categories: Category[];
  /** Feed being edited; undefined = create. */
  feed?: Feed;
  /** Preselected category for new feeds. */
  defaultCategoryId?: number;
  onDismiss: () => void;
  onSubmit: (v: { url: string; title: string | null; category_id: number; enabled: boolean }) => void;
  busy?: boolean;
}

/** Mounts the form fresh on each open so state initializes from props. */
export function FeedDialog(props: Props) {
  return props.visible ? <FeedForm {...props} /> : null;
}

function FeedForm({ visible, categories, feed, defaultCategoryId, onDismiss, onSubmit, busy }: Props) {
  const [url, setUrl] = useState(feed?.url ?? '');
  const [title, setTitle] = useState(feed?.title ?? '');
  const [categoryId, setCategoryId] = useState<number | null>(feed?.category_id ?? defaultCategoryId ?? categories[0]?.id ?? null);
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);

  const trimmed = url.trim();
  const urlOk = /^https?:\/\/\S+$/i.test(trimmed);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>{feed ? 'Edit feed' : 'Add feed'}</Dialog.Title>
        <Dialog.ScrollArea style={styles.scroll}>
          <View style={styles.form}>
            <TextInput
              label="Feed URL"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              mode="outlined"
              error={trimmed.length > 0 && !urlOk}
            />
            <HelperText type="error" visible={trimmed.length > 0 && !urlOk}>
              Must start with http:// or https://
            </HelperText>
            <TextInput label="Title (optional)" value={title} onChangeText={setTitle} mode="outlined" />
            <Text variant="labelLarge" style={styles.label}>
              Category
            </Text>
            <View style={styles.chips}>
              {categories.map((c) => (
                <CategoryTag key={c.id} category={c} selected={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
              ))}
            </View>
            <View style={styles.switchRow}>
              <Text variant="bodyLarge">Enabled</Text>
              <Switch value={enabled} onValueChange={setEnabled} />
            </View>
          </View>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button
            disabled={!urlOk || categoryId === null || busy}
            loading={busy}
            onPress={() => categoryId !== null && onSubmit({ url: trimmed, title: title.trim() || null, category_id: categoryId, enabled })}
          >
            Save
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 420, paddingHorizontal: 0 },
  form: { paddingHorizontal: 24, paddingVertical: 8 },
  label: { marginTop: 8, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
});
