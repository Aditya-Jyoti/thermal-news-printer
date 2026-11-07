import * as SecureStore from 'expo-secure-store';

const KEY = 'openrouter_api_key';

/** OpenRouter API key storage (expo-secure-store). The key is never logged. */
export async function getApiKey(): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export async function setApiKey(key: string): Promise<void> {
  const k = key.trim();
  if (!k) {
    await clearApiKey();
    return;
  }
  await SecureStore.setItemAsync(KEY, k);
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null;
}
