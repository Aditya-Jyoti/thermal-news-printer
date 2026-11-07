import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from './provider';
import type {
  CategoryCreate,
  Edition,
  HistoryEdition,
  CategoryUpdate,
  FeedCreate,
  FeedUpdate,
  ScheduleCreate,
  ScheduleUpdate,
  Settings,
} from './types';

export const keys = {
  categories: ['categories'] as const,
  feeds: ['feeds'] as const,
  edition: ['edition'] as const,
  prints: ['prints'] as const,
  history: ['history'] as const,
  diagnostics: ['diagnostics'] as const,
  schedules: ['schedules'] as const,
  settings: ['settings'] as const,
  models: ['models'] as const,
};

export const useCategories = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.categories, queryFn: () => api.listCategories() });
};

export const useFeeds = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.feeds, queryFn: () => api.listFeeds() });
};

/** The AI-curated upcoming edition. Kept fresh by pipeline events (see ApiProvider), not by polling. */
export const useEdition = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.edition, queryFn: () => api.getEdition(), staleTime: 60_000 });
};

/** Printed editions, newest first. */
export const usePrints = (limit = 50) => {
  const api = useApi();
  return useQuery({ queryKey: [...keys.prints, limit], queryFn: () => api.listPrints(limit, 0), staleTime: 60_000 });
};

/** Archived editions (printed or rolled over), newest first. Kept fresh by 'history' pipeline events. */
export const useHistory = (limit = 60) => {
  const api = useApi();
  return useQuery({ queryKey: [...keys.history, limit], queryFn: () => api.listHistory(limit), staleTime: 60_000 });
};

export const useDiagnostics = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.diagnostics, queryFn: () => api.getDiagnostics(), retry: false, staleTime: 5_000 });
};

export const useSchedules = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.schedules, queryFn: () => api.listSchedules() });
};

export const useBackendSettings = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.settings, queryFn: () => api.getSettings() });
};

export const useModels = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.models, queryFn: () => api.getModels(), retry: false, staleTime: 5 * 60_000 });
};

/** Mutation helper that invalidates the given query keys on success. */
function useInvalidating<V, R>(fn: (v: V) => Promise<R>, invalidate: readonly (readonly unknown[])[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useCreateCategory = () => {
  const api = useApi();
  return useInvalidating((b: CategoryCreate) => api.createCategory(b), [keys.categories]);
};
export const useUpdateCategory = () => {
  const api = useApi();
  return useInvalidating(
    (v: { id: number; body: CategoryUpdate }) => api.updateCategory(v.id, v.body),
    [keys.categories, keys.edition],
  );
};
export const useDeleteCategory = () => {
  const api = useApi();
  return useInvalidating((id: number) => api.deleteCategory(id), [keys.categories, keys.feeds, keys.edition]);
};

export const useCreateFeed = () => {
  const api = useApi();
  return useInvalidating((b: FeedCreate) => api.createFeed(b), [keys.feeds, keys.categories]);
};
export const useUpdateFeed = () => {
  const api = useApi();
  return useInvalidating(
    (v: { id: number; body: FeedUpdate }) => api.updateFeed(v.id, v.body),
    [keys.feeds, keys.categories, keys.edition],
  );
};
export const useDeleteFeed = () => {
  const api = useApi();
  return useInvalidating((id: number) => api.deleteFeed(id), [keys.feeds, keys.categories, keys.edition]);
};

export const useRefreshFeeds = () => {
  const api = useApi();
  return useInvalidating((feedId?: number | null) => api.refreshFeeds(feedId), [keys.feeds, keys.edition]);
};

/** Mark read/unread; the card flips immediately (optimistic), events refresh the lists afterwards. */
export const useSetRead = () => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { articleId: number; read: boolean }) => api.setRead(v.articleId, v.read),
    onMutate: ({ articleId, read }) => {
      const at = read ? new Date().toISOString() : null;
      qc.setQueryData<Edition>(keys.edition, (ed) =>
        ed ? { ...ed, items: ed.items.map((i) => (i.article_id === articleId ? { ...i, read_at: at } : i)) } : ed,
      );
      qc.setQueriesData<HistoryEdition[]>({ queryKey: keys.history }, (h) =>
        h?.map((e) => ({ ...e, items: e.items.map((i) => (i.article_id === articleId ? { ...i, read_at: at } : i)) })),
      );
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.edition }), qc.invalidateQueries({ queryKey: keys.history })]),
  });
};

/** "Fetch new news": archive the current edition, ingest, curate a fresh one. */
export const useFetchNews = () => {
  const api = useApi();
  return useInvalidating(() => api.fetchNews(), [keys.feeds, keys.edition, keys.history]);
};

export const useTestAiKey = () => {
  const api = useApi();
  return useInvalidating(() => api.testAiKey(), [keys.diagnostics]);
};

export const useRebuildEdition = () => {
  const api = useApi();
  return useInvalidating(() => api.rebuildEdition(), [keys.edition]);
};

export const useCreateSchedule = () => {
  const api = useApi();
  return useInvalidating((b: ScheduleCreate) => api.createSchedule(b), [keys.schedules]);
};
export const useUpdateSchedule = () => {
  const api = useApi();
  return useInvalidating((v: { id: number; body: ScheduleUpdate }) => api.updateSchedule(v.id, v.body), [keys.schedules]);
};
export const useDeleteSchedule = () => {
  const api = useApi();
  return useInvalidating((id: number) => api.deleteSchedule(id), [keys.schedules]);
};

export const usePatchSettings = () => {
  const api = useApi();
  return useInvalidating((b: Partial<Settings>) => api.patchSettings(b), [keys.settings, keys.edition]);
};

export const usePrintNow = () => {
  const api = useApi();
  return useInvalidating(() => api.printNow(), [keys.prints, keys.edition, keys.history]);
};
