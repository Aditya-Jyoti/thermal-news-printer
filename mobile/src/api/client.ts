import { ApiError, isNotImplemented } from './errors';
import type { Api, ArticleSummary, DigestItem, Edition, EditionItem, HistoryEdition, Page } from './types';

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

const unsupported = (): never => {
  throw new ApiError(501, 'Not supported with remote backend');
};

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

  /** Remote backends only expose the digest preview; join it with recent articles for title/url/image. */
  async function remoteEdition(): Promise<Edition> {
    const [digest, cats, arts] = await Promise.all([
      req<DigestItem[]>('GET', '/digest/preview'),
      req<import('./types').Category[]>('GET', '/categories'),
      req<Page<ArticleSummary>>('GET', '/articles', { query: { limit: 200, offset: 0, include_political: false } }),
    ]);
    const byId = new Map(arts.items.map((a) => [a.id, a]));
    const items: EditionItem[] = [];
    for (const d of digest) {
      const a = byId.get(d.article_id);
      const category = a?.category ?? cats.find((c) => c.slug === d.category_slug);
      if (!category) continue;
      items.push({
        position: items.length + 1,
        article_id: d.article_id,
        category_slug: d.category_slug,
        category,
        title: a?.title ?? d.tldr.slice(0, 80),
        url: a?.url ?? '',
        image_url: a?.image_url ?? null,
        published_at: a?.published_at ?? null,
        tldr: d.tldr,
        read_at: null,
      });
    }
    return { items, status: { phase: 'idle', done: 0, total: 0, no_key: false }, built_at: null, target: items.length };
  }

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
    listPrints: (limit = 20, offset = 0) => req('GET', '/prints', { query: { limit, offset } }),
    getPrint: (id) => req('GET', `/prints/${id}`),
    listSchedules: () => req('GET', '/schedules'),
    createSchedule: (body) => req('POST', '/schedules', { body }),
    updateSchedule: (id, body) => req('PATCH', `/schedules/${id}`, { body }),
    deleteSchedule: (id) => req('DELETE', `/schedules/${id}`),
    getSettings: () => req('GET', '/settings'),
    patchSettings: (body) => req('PATCH', '/settings', { body }),
    getModels: () => req('GET', '/models'),
    getEdition: remoteEdition,
    async rebuildEdition() {
      await req('POST', '/ai/process').catch(() => undefined);
      return remoteEdition();
    },
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
    // History is best-effort over the print log; read state, diagnostics and the key test are device-only.
    async listHistory(limit = 60) {
      const page = await req<Page<import('./types').PrintRecord>>('GET', '/prints', { query: { limit, offset: 0 } });
      return page.items
        .filter((p) => p.status === 'printed')
        .map(
          (p): HistoryEdition => ({
            id: p.id,
            created_at: p.created_at,
            archived_at: p.created_at,
            print_id: p.id,
            printed: true,
            items: p.items.map((i) => ({
              position: i.position,
              article_id: i.article_id,
              category_slug: i.category_slug,
              category: null,
              title: i.title ?? null,
              url: i.url ?? null,
              image_url: i.image_url ?? null,
              tldr: i.tldr,
              read_at: null,
            })),
          }),
        );
    },
    setRead: () => unsupported(),
    async fetchNews() {
      const ingest = await req<import('./types').IngestResult>('POST', '/feeds/refresh');
      await req('POST', '/ai/process').catch(() => undefined);
      return { ingest, edition: await remoteEdition() };
    },
    getDiagnostics: () => unsupported(),
    testAiKey: () => unsupported(),
  };
}
