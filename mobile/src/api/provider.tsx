import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createContext, useContext, useMemo } from 'react';

import { useAppSettings } from '@/state/settings';

import { createHttpApi } from './client';
import { createMockApi } from './mock';
import type { Api } from './types';

const ApiContext = createContext<Api | null>(null);

let mockApi: Api | null = null;
const getMockApi = (): Api => (mockApi ??= createMockApi());

const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 15_000 }, mutations: { retry: 0 } },
  });

/** Provides the active Api (real or mock) and a query cache scoped to it, so switching backends never mixes data. */
export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { baseUrl, demo } = useAppSettings();
  const { api, client } = useMemo(
    () => ({ api: demo ? getMockApi() : createHttpApi(baseUrl), client: newQueryClient() }),
    [baseUrl, demo],
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
