import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Menu, TextInput } from 'react-native-paper';

import type { ModelOption } from '@/api/types';

interface Props {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /** null when GET /models failed: falls back to free text. */
  options: ModelOption[] | null;
  allowNone?: boolean;
}

export function ModelPicker({ label, value, onChange, options, allowNone }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(
    () => value !== null && value !== '' && !(options?.some((o) => o.id === value) ?? false),
  );

  if (options === null) {
    return (
      <TextInput
        label={`${label} (OpenRouter id)`}
        value={value ?? ''}
        onChangeText={(t) => onChange(t.trim() === '' && allowNone ? null : t)}
        autoCapitalize="none"
        autoCorrect={false}
        mode="outlined"
      />
    );
  }

  const shown = custom ? 'Custom…' : value === null ? 'None' : (options.find((o) => o.id === value)?.label ?? value);
  const pick = (v: string | null) => {
    setOpen(false);
    setCustom(false);
    onChange(v);
  };

  return (
    <View style={styles.box}>
      <Menu
        visible={open}
        onDismiss={() => setOpen(false)}
        anchor={
          <Button mode="outlined" icon="chevron-down" contentStyle={styles.btn} onPress={() => setOpen(true)}>
            {`${label}: ${shown}`}
          </Button>
        }
      >
        {allowNone && <Menu.Item title="None" onPress={() => pick(null)} />}
        {options.map((o) => (
          <Menu.Item key={o.id} title={o.label} onPress={() => pick(o.id)} />
        ))}
        <Menu.Item
          title="Custom…"
          onPress={() => {
            setOpen(false);
            setCustom(true);
          }}
        />
      </Menu>
      {custom && (
        <TextInput
          label="OpenRouter model id"
          value={value ?? ''}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          mode="outlined"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  btn: { flexDirection: 'row-reverse', justifyContent: 'space-between' },
});
