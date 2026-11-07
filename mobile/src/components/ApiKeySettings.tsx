import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, HelperText, TextInput } from 'react-native-paper';

import { clearApiKey, hasApiKey, setApiKey } from '@/core/secrets';
import { errorMessage } from '@/lib/format';

/** OpenRouter API key entry (stored in expo-secure-store). A saved key is never shown again. */
export function ApiKeySettings({ onMessage }: { onMessage: (m: string) => void }) {
  const [saved, setSaved] = useState(false);
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    hasApiKey().then(setSaved, () => setSaved(false));
  }, []);

  const save = async () => {
    try {
      await setApiKey(value);
      setSaved(value.trim() !== '');
      setValue('');
      setVisible(false);
      onMessage('Key saved');
    } catch (e) {
      onMessage(errorMessage(e));
    }
  };

  const clear = async () => {
    try {
      await clearApiKey();
      setSaved(false);
      setValue('');
      onMessage('Key removed');
    } catch (e) {
      onMessage(errorMessage(e));
    }
  };

  return (
    <View style={styles.box}>
      <TextInput
        label="OpenRouter API key"
        placeholder={saved ? 'Key saved' : 'sk-or-...'}
        value={value}
        onChangeText={setValue}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        mode="outlined"
        right={<TextInput.Icon icon={visible ? 'eye-off' : 'eye'} onPress={() => setVisible((v) => !v)} />}
      />
      <HelperText type="info" visible>
        {saved ? 'Key saved. Enter a new key to replace it.' : 'Needed for AI summaries. Stored only on this phone.'}
      </HelperText>
      <View style={styles.buttons}>
        <Button mode="contained-tonal" disabled={value.trim() === ''} onPress={save}>
          Save key
        </Button>
        <Button mode="outlined" disabled={!saved} onPress={clear}>
          Clear key
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 16, paddingBottom: 8 },
  buttons: { flexDirection: 'row', gap: 8 },
});
