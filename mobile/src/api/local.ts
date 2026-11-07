import { isValidCron } from '@/lib/cron';
import { rearmSoon } from '@/scheduler/arm';
import { validateCron } from '@/scheduler/cron';

import { getDevice, type DeviceServices } from '../device/contracts';
import type { AiClient } from '../core/ai/client';
import type { Db } from '../core/db/adapter';
import {
  createCategory,
  createFeed,
  deleteCategory,
  deleteFeed,
  listCategories,
  listFeeds,
  updateCategory,
  updateFeed,
} from '../core/db/catalog';
import { getDb } from '../core/db';
import { getPrint, listPrints } from '../core/db/prints';
import {
  createSchedule,
  deleteSchedule,
  getSettings,
  listSchedules,
  updateSchedule,
  updateSettings,
} from '../core/db/settings';
import { Conflict, NotFound } from '../core/errors';
import type { FetchLike } from '../core/http';
import { runIngest } from '../core/ingest/service';
import { buildEdition, getEdition } from '../core/edition';
import { timed } from '../core/perf';
import { buildDigest, runPrint } from '../core/pipeline';
import { ApiError } from './errors';
import type { Api, ModelOption } from './types';

/** Curated OpenRouter models for the picker (free text still allowed). Mirrors backend SUPPORTED_MODELS. */
export const SUPPORTED_MODELS: ModelOption[] = [
  { id: 'google/gemma-3-12b-it', label: 'Gemma 3 12B (default)' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
];

export interface LocalApiOptions {
  /** Defaults to the app-wide expo-sqlite database. */
  db?: Db;
  fetch?: FetchLike;
  aiClient?: AiClient;
  device?: DeviceServices;
}

function mapError(e: unknown): never {
  if (e instanceof ApiError) throw e;
  if (e instanceof NotFound) throw new ApiError(404, e.message);
  if (e instanceof Conflict) throw new ApiError(409, e.message);
  throw e;
}

const checkFeedUrl = (url: string): string => {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) throw new ApiError(422, 'feed url must start with http:// or https://');
  return u;
};
const checkCron = (c: string): string => {
  if (!isValidCron(c)) throw new ApiError(422, `invalid cron expression: ${c}`);
  try {
    return validateCron(c);
  } catch (e) {
    throw new ApiError(422, `invalid cron expression: ${e instanceof Error ? e.message : c}`);
  }
};

/** The Api implemented on-device: SQLite + RSS + OpenRouter + renderer + BLE printer. */
export function createLocalApi(opts: LocalApiOptions = {}): Api {
  const db = (): Promise<Db> => (opts.db ? Promise.resolve(opts.db) : getDb());
  /** Run `fn` with the db, translating domain errors into ApiError. */
  const run = async <T,>(fn: (d: Db) => Promise<T>): Promise<T> => {
    try {
      return await fn(await db());
    } catch (e) {
      return mapError(e);
    }
  };
  const device = () => opts.device ?? getDevice();
  const edDeps = { client: opts.aiClient, fetch: opts.fetch };

  return {
    health: async () => ({ status: 'ok' }),

    listCategories: () => run((d) => listCategories(d)),
    createCategory: (b) =>
      run((d) => {
        if (b.print_limit !== undefined && b.print_limit < 0) throw new ApiError(422, 'print_limit must be >= 0');
        return createCategory(d, b.name.trim(), b.color ?? null, b.print_limit ?? 2);
      }),
    updateCategory: (id, b) =>
      run((d) => {
        if (b.print_limit != null && b.print_limit < 0) throw new ApiError(422, 'print_limit must be >= 0');
        return updateCategory(d, id, b.name != null ? { ...b, name: b.name.trim() } : b);
      }),
    deleteCategory: (id) => run((d) => deleteCategory(d, id)),

    listFeeds: (categoryId) => run((d) => listFeeds(d, categoryId)),
    createFeed: (b) => run((d) => createFeed(d, checkFeedUrl(b.url), b.category_id, b.title ?? null, b.enabled ?? true)),
    updateFeed: (id, b) =>
      run((d) => updateFeed(d, id, b.url != null ? { ...b, url: checkFeedUrl(b.url) } : b)),
    deleteFeed: (id) => run((d) => deleteFeed(d, id)),

    refreshFeeds: (feedId) =>
      run(async (d) => {
        const result = await runIngest(d, { feedId, fetch: opts.fetch });
        // Re-curate in the background when something new arrived; never block the UI on AI calls.
        void buildEdition(d, edDeps, { newArticles: result.new_articles }).catch(() => undefined);
        return result;
      }),

    getEdition: () => run((d) => getEdition(d, edDeps)),
    rebuildEdition: () =>
      run(async (d) => {
        void buildEdition(d, edDeps, { force: true }).catch(() => undefined);
        return getEdition(d, edDeps);
      }),

    listPrints: (limit = 20, offset = 0) =>
      run(async (d) => {
        const { items, total } = await listPrints(d, limit, offset);
        return { items, total, limit, offset };
      }),
    getPrint: (id) => run((d) => getPrint(d, id)),

    listSchedules: () => run((d) => listSchedules(d)),
    // Every schedule mutation re-arms the native alarm so edits take effect immediately.
    createSchedule: (b) =>
      run(async (d) => {
        const s = await createSchedule(d, checkCron(b.cron), b.label ?? null, b.enabled ?? true);
        rearmSoon(d);
        return s;
      }),
    updateSchedule: (id, b) =>
      run(async (d) => {
        const s = await updateSchedule(d, id, b.cron != null ? { ...b, cron: checkCron(b.cron) } : b);
        rearmSoon(d);
        return s;
      }),
    deleteSchedule: (id) =>
      run(async (d) => {
        await deleteSchedule(d, id);
        rearmSoon(d);
      }),

    getSettings: () => run((d) => getSettings(d)),
    patchSettings: (b) =>
      run((d) => {
        if (b.max_items_total != null && (!Number.isInteger(b.max_items_total) || b.max_items_total < 1 || b.max_items_total > 30)) {
          throw new ApiError(422, 'max_items_total must be between 1 and 30');
        }
        return updateSettings(d, b);
      }),
    getModels: async () => SUPPORTED_MODELS,

    async previewImage() {
      try {
        const d = await db();
        const digest = await buildDigest(d);
        const rendered = await timed('render.preview', () => device().render(digest, { editionDate: new Date() }));
        return { uri: `data:image/png;base64,${rendered.pngBase64}` };
      } catch {
        return null; // renderer unavailable: the Preview screen falls back to the in-app receipt mock
      }
    },

    printNow: () =>
      run(async (d) => {
        const rec = await runPrint(d, 'manual', { device: opts.device, client: opts.aiClient, fetch: opts.fetch });
        if (!rec) throw new ApiError(409, 'Nothing new to print');
        if (rec.status === 'failed') throw new ApiError(502, `Print ${rec.id} failed: ${rec.error ?? 'unknown error'}`);
        return rec;
      }),
  };
}
