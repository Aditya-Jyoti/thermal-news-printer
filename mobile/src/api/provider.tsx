import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';

import { subscribe } from '@/core/events';
import { useAppSettings } from '@/state/settings';

import { createHttpApi } from './client';
import { createLocalApi } from './local';
import { createMockApi } from './mock';
import type { Api } from './types';

const ApiContext = createContext<Api | null>(null);

let mockApi: Api | null = null;
const getMockApi = (): Api => (mockApi ??= createMockApi());

let localApi: Api | null = null;
const getLocalApi = (): Api => (localApi ??= createLocalApi());

const newQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false },
      mutations: { retry: 0 },
    },
  });

/**
 * Pipeline progress (curating / summarizing / printed) arrives as core events; invalidate the matching
 * queries (trailing-throttled) instead of polling.
 */
function PipelineEvents() {
  const qc = useQueryClient();
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const flush = () => {
      timer.current = null;
      for (const key of pending.current) void qc.invalidateQueries({ queryKey: [key] });
      pending.current.clear();
    };
    const off = subscribe((e) => {
      pending.current.add(e === 'feeds' ? 'feeds' : e);
      if (!timer.current) timer.current = setTimeout(flush, 300);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [qc]);
  return null;
}

/** Provides the active Api (on-device, remote or mock) and a query cache scoped to it, so switching backends never mixes data. */
export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { baseUrl, mode } = useAppSettings();
  const { api, client } = useMemo(
    () => ({
      api: mode === 'demo' ? getMockApi() : mode === 'remote' ? createHttpApi(baseUrl) : getLocalApi(),
      client: newQueryClient(),
    }),
    [baseUrl, mode],
  );
  return (
    <QueryClientProvider client={client}>
      <ApiContext.Provider value={api}>
        <PipelineEvents />
        {children}
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApi(): Api {
  const a = useContext(ApiContext);
  if (!a) throw new Error('useApi outside ApiProvider');
  return a;
}
