import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createContext, useContext, useMemo } from 'react';

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
    defaultOptions: { queries: { retry: 1, staleTime: 15_000 }, mutations: { retry: 0 } },
  });

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
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApi(): Api {
  const a = useContext(ApiContext);
  if (!a) throw new Error('useApi outside ApiProvider');
  return a;
}
