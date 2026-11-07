import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, SegmentedButtons, Text, TextInput } from 'react-native-paper';

import { useApi } from '@/api/provider';
import { errorMessage } from '@/lib/format';
import { useAppSettings, type DataMode } from '@/state/settings';

import { ApiKeySettings } from './ApiKeySettings';

const HINTS: Record<DataMode, string> = {
  device: 'Everything runs on this phone: feeds, AI summaries, receipt and printing.',
  remote: 'Use a separate termal-news-printer backend over HTTP.',
  demo: 'Offline sample data; nothing is fetched or printed.',
};

export function ConnectionSettings({ onMessage }: { onMessage: (m: string) => void }) {
  const { baseUrl, mode, setBaseUrl, setMode } = useAppSettings();
  const api = useApi();
  const [url, setUrl] = useState(baseUrl);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      await api.health();
      onMessage('Backend reachable');
    } catch (e) {
      onMessage(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <View>
      <View style={styles.box}>
        <SegmentedButtons
          value={mode}
          onValueChange={(v) => setMode(v as DataMode)}
          buttons={[
            { value: 'device', label: 'On device', icon: 'cellphone' },
            { value: 'remote', label: 'Remote', icon: 'server-network' },
            { value: 'demo', label: 'Demo', icon: 'flask-outline' },
          ]}
        />
        <Text variant="bodySmall" style={styles.hint}>
          {HINTS[mode]}
        </Text>
      </View>
      {mode === 'remote' && (
        <View style={styles.box}>
          <TextInput
            label="Backend URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            mode="outlined"
          />
          <View style={styles.buttons}>
            <Button mode="contained-tonal" disabled={url.trim() === baseUrl} onPress={() => setBaseUrl(url)}>
              Save URL
            </Button>
            <Button mode="outlined" loading={testing} disabled={testing} onPress={test}>
              Test connection
            </Button>
          </View>
        </View>
      )}
      {mode === 'device' && <ApiKeySettings onMessage={onMessage} />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  hint: { opacity: 0.7 },
  buttons: { flexDirection: 'row', gap: 8 },
});
