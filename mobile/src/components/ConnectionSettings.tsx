import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Switch, TextInput } from 'react-native-paper';

import { useApi } from '@/api/provider';
import { errorMessage } from '@/lib/format';
import { useAppSettings } from '@/state/settings';

export function ConnectionSettings({ onMessage }: { onMessage: (m: string) => void }) {
  const { baseUrl, demo, setBaseUrl, setDemo } = useAppSettings();
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
      <List.Item
        title="Use demo data"
        description="Offline mock data; no backend needed"
        right={() => <Switch value={demo} onValueChange={setDemo} />}
      />
      <View style={styles.box}>
        <TextInput
          label="Backend URL"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          mode="outlined"
          disabled={demo}
        />
        <View style={styles.buttons}>
          <Button mode="contained-tonal" disabled={demo || url.trim() === baseUrl} onPress={() => setBaseUrl(url)}>
            Save URL
          </Button>
          <Button mode="outlined" loading={testing} disabled={testing} onPress={test}>
            Test connection
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  buttons: { flexDirection: 'row', gap: 8 },
});
