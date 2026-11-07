import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const DEFAULT_BASE_URL = 'http://localhost:8000';
const KEY = 'tnp.appSettings.v1';

/** device = everything on the phone (default); remote = a TNP backend over HTTP; demo = in-memory mock data. */
export type DataMode = 'device' | 'remote' | 'demo';
const MODES: DataMode[] = ['device', 'remote', 'demo'];

interface Stored {
  baseUrl: string;
  mode: DataMode;
}

interface Ctx extends Stored {
  setBaseUrl: (url: string) => void;
  setMode: (mode: DataMode) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

/** Migrate the persisted blob: the legacy `demo: true` flag becomes mode 'demo'. */
export function parseStored(raw: string | null, fallback: Stored): Stored {
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as Partial<Stored> & { demo?: unknown };
    const mode: DataMode = MODES.includes(p.mode as DataMode)
      ? (p.mode as DataMode)
      : p.demo === true
        ? 'demo'
        : fallback.mode;
    return { baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : fallback.baseUrl, mode };
  } catch {
    return fallback;
  }
}

/** Local (on-device) app settings: data source mode and backend URL. */
export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Stored>({ baseUrl: DEFAULT_BASE_URL, mode: 'device' });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => setState((s) => parseStored(raw, s)))
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
      setMode: (mode) => persist({ ...state, mode }),
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
