import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from './provider';
import type {
  CategoryCreate,
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
  articles: ['articles'] as const,
  article: (id: number) => ['article', id] as const,
  prints: ['prints'] as const,
  print: (id: number) => ['print', id] as const,
  schedules: ['schedules'] as const,
  settings: ['settings'] as const,
  digest: ['digest'] as const,
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

export const useArticles = (categoryId: number | null) => {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.articles, categoryId],
    queryFn: () => api.listArticles({ category_id: categoryId, limit: 50 }),
  });
};

export const useArticle = (id: number) => {
  const api = useApi();
  return useQuery({ queryKey: keys.article(id), queryFn: () => api.getArticle(id) });
};

export const usePrints = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.prints, queryFn: () => api.listPrints(50, 0) });
};

export const usePrint = (id: number) => {
  const api = useApi();
  return useQuery({ queryKey: keys.print(id), queryFn: () => api.getPrint(id) });
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

export const useDigestPreview = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.digest, queryFn: () => api.digestPreview() });
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
    [keys.categories, keys.articles, keys.digest],
  );
};
export const useDeleteCategory = () => {
  const api = useApi();
  return useInvalidating((id: number) => api.deleteCategory(id), [keys.categories, keys.feeds, keys.articles, keys.digest]);
};

export const useCreateFeed = () => {
  const api = useApi();
  return useInvalidating((b: FeedCreate) => api.createFeed(b), [keys.feeds, keys.categories]);
};
export const useUpdateFeed = () => {
  const api = useApi();
  return useInvalidating(
    (v: { id: number; body: FeedUpdate }) => api.updateFeed(v.id, v.body),
    [keys.feeds, keys.categories, keys.articles],
  );
};
export const useDeleteFeed = () => {
  const api = useApi();
  return useInvalidating((id: number) => api.deleteFeed(id), [keys.feeds, keys.categories, keys.articles]);
};

export const useRefreshFeeds = () => {
  const api = useApi();
  return useInvalidating((feedId?: number | null) => api.refreshFeeds(feedId), [keys.articles, keys.feeds, keys.digest]);
};

export const useProcessAi = () => {
  const api = useApi();
  return useInvalidating(() => api.processAi(), [keys.articles, keys.digest]);
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
  return useInvalidating((b: Partial<Settings>) => api.patchSettings(b), [keys.settings, keys.digest]);
};

export const usePrintNow = () => {
  const api = useApi();
  return useInvalidating(() => api.printNow(), [keys.prints, keys.articles, keys.digest]);
};
