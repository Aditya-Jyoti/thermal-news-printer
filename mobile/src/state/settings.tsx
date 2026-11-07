import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const DEFAULT_BASE_URL = 'http://localhost:8000';
const KEY = 'tnp.appSettings.v1';

interface Stored {
  baseUrl: string;
  demo: boolean;
}

interface Ctx extends Stored {
  setBaseUrl: (url: string) => void;
  setDemo: (demo: boolean) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

/** Local (on-device) app settings: backend URL and the demo-data toggle. */
export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Stored>({ baseUrl: DEFAULT_BASE_URL, demo: false });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!raw) return;
        const p = JSON.parse(raw) as Partial<Stored>;
        setState((s) => ({
          baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : s.baseUrl,
          demo: typeof p.demo === 'boolean' ? p.demo : s.demo,
        }));
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  const persist = useCallback((next: Stored) => {
    setState(next);
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      setBaseUrl: (baseUrl) => persist({ ...state, baseUrl: baseUrl.trim() || DEFAULT_BASE_URL }),
      setDemo: (demo) => persist({ ...state, demo }),
    }),
    [state, persist],
  );

  if (!ready) return null;
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error('useAppSettings outside AppSettingsProvider');
  return c;
}
