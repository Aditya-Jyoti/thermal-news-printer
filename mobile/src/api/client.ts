import { ApiError, isNotImplemented } from './errors';
import type { Api, ArticleQuery } from './types';

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q?: Query): string {
  if (!q) return '';
  const p = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
}

async function errorFrom(res: Response): Promise<ApiError> {
  let detail = res.statusText;
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (j.detail !== undefined) {
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    }
  } catch {
    // non-JSON error body
  }
  return new ApiError(res.status, detail || `HTTP ${res.status}`);
}

/** Typed fetch client for the TNP REST API. */
export function createHttpApi(rawBase: string): Api {
  const base = rawBase.trim().replace(/\/+$/, '');

  async function raw(method: string, path: string, opts: { query?: Query; body?: unknown } = {}) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}${qs(opts.query)}`, {
        method,
        headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, `Cannot reach backend at ${base}. ${e instanceof Error ? e.message : ''}`.trim());
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  async function req<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const res = await raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const articleQuery = (q: ArticleQuery = {}): Query => ({
    category_id: q.category_id,
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
    include_political: q.include_political ?? false,
  });

  return {
    health: () => req('GET', '/health'),
    listCategories: () => req('GET', '/categories'),
    createCategory: (body) => req('POST', '/categories', { body }),
    updateCategory: (id, body) => req('PATCH', `/categories/${id}`, { body }),
    deleteCategory: (id) => req('DELETE', `/categories/${id}`),
    listFeeds: (categoryId) => req('GET', '/feeds', { query: { category_id: categoryId } }),
    createFeed: (body) => req('POST', '/feeds', { body }),
    updateFeed: (id, body) => req('PATCH', `/feeds/${id}`, { body }),
    deleteFeed: (id) => req('DELETE', `/feeds/${id}`),
    refreshFeeds: (feedId) => req('POST', '/feeds/refresh', { query: { feed_id: feedId } }),
    listArticles: (q) => req('GET', '/articles', { query: articleQuery(q) }),
    getArticle: (id) => req('GET', `/articles/${id}`),
    listPrints: (limit = 20, offset = 0) => req('GET', '/prints', { query: { limit, offset } }),
    getPrint: (id) => req('GET', `/prints/${id}`),
    listSchedules: () => req('GET', '/schedules'),
    createSchedule: (body) => req('POST', '/schedules', { body }),
    updateSchedule: (id, body) => req('PATCH', `/schedules/${id}`, { body }),
    deleteSchedule: (id) => req('DELETE', `/schedules/${id}`),
    getSettings: () => req('GET', '/settings'),
    patchSettings: (body) => req('PATCH', '/settings', { body }),
    getModels: () => req('GET', '/models'),
    processAi: () => req('POST', '/ai/process'),
    digestPreview: () => req('GET', '/digest/preview'),
    async previewImage() {
      // Probe first so a 501 (renderer not available on the backend) falls back to the mock receipt.
      try {
        await raw('GET', '/print/preview.png', { query: { probe: Date.now() } });
      } catch (e) {
        if (isNotImplemented(e)) return null;
        throw e;
      }
      return { uri: `${base}/print/preview.png?t=${Date.now()}` };
    },
    printNow: () => req('POST', '/print'),
  };
}
