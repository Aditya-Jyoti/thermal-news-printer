import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Dialog, HelperText, Portal, TextInput, useTheme } from 'react-native-paper';

import type { Category } from '@/api/types';
import { CATEGORY_SWATCHES } from '@/theme';

interface Props {
  visible: boolean;
  /** Category being edited; undefined = create. */
  category?: Category;
  onDismiss: () => void;
  onSubmit: (v: { name: string; color: string | null }) => void;
  busy?: boolean;
}

/** Mounts the form fresh on each open so state initializes from props. */
export function CategoryDialog(props: Props) {
  return props.visible ? <CategoryForm {...props} /> : null;
}

function CategoryForm({ visible, category, onDismiss, onSubmit, busy }: Props) {
  const theme = useTheme();
  const [name, setName] = useState(category?.name ?? '');
  const [color, setColor] = useState<string | null>(category?.color ?? null);

  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 40;

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>{category ? 'Edit category' : 'New category'}</Dialog.Title>
        <Dialog.Content>
          <TextInput label="Name" value={name} onChangeText={setName} maxLength={40} autoFocus mode="outlined" />
          <HelperText type="info" visible>
            {trimmed ? `Printed as #${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '')}` : 'Used as the printed #tag'}
          </HelperText>
          <View style={styles.swatches}>
            <Pressable
              onPress={() => setColor(null)}
              accessibilityLabel="Automatic color"
              style={[styles.swatch, { backgroundColor: theme.colors.surfaceVariant, borderColor: color === null ? theme.colors.primary : 'transparent' }]}
            >
              <HelperText type="info" style={styles.auto}>
                A
              </HelperText>
            </Pressable>
            {CATEGORY_SWATCHES.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                accessibilityLabel={`Color ${c}`}
                style={[styles.swatch, { backgroundColor: c, borderColor: color === c ? theme.colors.onSurface : 'transparent' }]}
              />
            ))}
          </View>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button disabled={invalid || busy} loading={busy} onPress={() => onSubmit({ name: trimmed, color })}>
            Save
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  auto: { padding: 0, margin: 0, height: 20 },
});
