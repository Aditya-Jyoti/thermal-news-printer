/** Wiring layer: ingest -> AI summarize/classify -> digest -> render -> print. */
import type { AiProcessResult, DigestItem, IngestResult, PrintRecord, PrintTrigger, Settings } from '../api/types';
import { getDevice, type DeviceServices } from '../device/contracts';
import { AIError, AIUnavailable, createAiClient, type AiClient } from './ai/client';
import type { ArticleForAI } from './ai/politics';
import { summarize, summarizeAndClassify } from './ai/summarize';
import type { Db } from './db/adapter';
import {
  getPrintedArticleIds,
  listArticlesNeedingSummary,
  listDigestCandidates,
  setPolitical,
  upsertSummary,
  type PendingRow,
} from './db/articles';
import { listCategories } from './db/catalog';
import { createPrint, getLastPrintItems, getPrint, setPrintStatus } from './db/prints';
import { getSettings } from './db/settings';
import { selectDigest } from './digest/select';
import { enrichRows } from './enrich';
import { savePrintPng } from './files';
import type { FetchLike } from './http';
import { runIngest } from './ingest/service';
import { getApiKey } from './secrets';

export type ProcessResult = AiProcessResult;

const parseDt = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function toAiArticle(row: PendingRow, contentText: string | null): ArticleForAI {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    content_text: contentText,
    category_slug: row.category_slug,
    published_at: parseDt(row.published_at),
  };
}

export interface ProcessOptions {
  /** Inject an AI client (tests); default: built from the stored API key. */
  client?: AiClient;
  fetch?: FetchLike;
  settings?: Settings;
  limit?: number;
  maxAgeDays?: number;
  now?: Date;
}

async function processPendingImpl(db: Db, o: ProcessOptions): Promise<ProcessResult> {
  const result: ProcessResult = { summarized: 0, flagged_political: 0, failed: 0, skipped_no_key: false };
  let client = o.client;
  if (!client) {
    const key = await getApiKey();
    if (!key) {
      result.skipped_no_key = true;
      return result;
    }
    client = createAiClient({ apiKey: key, fetch: o.fetch });
  }
  const settings = o.settings ?? (await getSettings(db));
  const limit = o.limit ?? 40;
  const cutoff = (o.now ?? new Date()).getTime() - (o.maxAgeDays ?? 4) * 86_400_000;

  // Over-fetch so old rows filtered out by age don't starve the batch.
  const pending = await listArticlesNeedingSummary(db, limit * 5 + 50);
  const batch = pending
    .filter((r) => {
      const when = parseDt(r.published_at) ?? parseDt(r.fetched_at);
      return when === null || when.getTime() >= cutoff;
    })
    .slice(0, limit);
  const enriched = await enrichRows(db, batch, { fetch: o.fetch });

  for (const row of batch) {
    const art = toAiArticle(row, enriched.get(row.id) ?? row.content_text);
    const ai = { client, model: settings.model, fallbackModel: settings.fallback_model };
    try {
      let summary;
      if (row.is_political === null) {
        const [s, verdict] = await summarizeAndClassify(art, ai);
        summary = s;
        await setPolitical(db, art.id, verdict.is_political);
        if (verdict.is_political) {
          result.flagged_political += 1;
          continue;
        }
      } else {
        summary = await summarize(art, ai);
      }
      await upsertSummary(db, art.id, summary.tldr, summary.model);
      result.summarized += 1;
    } catch (e) {
      if (e instanceof AIUnavailable) {
        result.skipped_no_key = true;
        break;
      }
      if (!(e instanceof AIError)) console.warn(`processing failed for article ${art.id}`);
      result.failed += 1;
    }
  }
  return result;
}

let inflight: Promise<ProcessResult> | null = null;

/**
 * Summarize (and politics-classify) recent articles that lack a TL;DR, newest first.
 * Never throws for a missing API key or a per-article AI failure. Single-flight: concurrent
 * callers share one run.
 */
export function processPending(db: Db, o: ProcessOptions = {}): Promise<ProcessResult> {
  if (inflight) return inflight;
  const p = processPendingImpl(db, o).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

/** The next print batch given limits, settings and print history. */
export async function buildDigest(db: Db): Promise<DigestItem[]> {
  const candidates = (await listDigestCandidates(db)).map((r) => ({
    article_id: r.article_id,
    title: r.title,
    category_slug: r.category_slug,
    tldr: r.tldr,
    published_at: parseDt(r.published_at),
  }));
  const limits: Record<string, number> = {};
  for (const c of await listCategories(db)) limits[c.slug] = c.print_limit;
  const lastTitles = (await getLastPrintItems(db)).map((i) => i.title).filter((t): t is string => !!t);
  return selectDigest(candidates, {
    limits,
    maxTotal: (await getSettings(db)).max_items_total,
    printedIds: await getPrintedArticleIds(db),
    lastPrintTitles: lastTitles,
  });
}

export interface PrintDeps {
  device?: DeviceServices;
  savePng?: (printId: number, pngBase64: string) => Promise<unknown>;
  now?: Date;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * digest -> create pending print -> render -> save PNG -> print over BLE -> printed/failed.
 * Returns null (no record) when the digest is empty. A failed print is recorded with its error and
 * returned (status 'failed'); its articles become eligible again.
 */
export async function runPrint(db: Db, trigger: PrintTrigger, deps: PrintDeps = {}): Promise<PrintRecord | null> {
  const digest = await buildDigest(db);
  if (digest.length === 0) return null;
  const pid = await createPrint(db, trigger, digest);
  try {
    const device = deps.device ?? getDevice();
    const settings = await getSettings(db);
    const rendered = await device.render(digest, { editionDate: deps.now ?? new Date(), issueNo: pid });
    try {
      await (deps.savePng ?? savePrintPng)(pid, rendered.pngBase64);
    } catch {
      // history image is a nicety; never block printing on it
    }
    await device.printer.print(rendered.bitmap, { deviceId: settings.printer_address ?? undefined });
    await setPrintStatus(db, pid, 'printed');
  } catch (e) {
    await setPrintStatus(db, pid, 'failed', errText(e));
  }
  return getPrint(db, pid);
}

export interface CycleResult {
  ingest: IngestResult;
  process: ProcessResult;
  print: PrintRecord | null;
}

/** ingest -> processPending -> runPrint. */
export async function runCycle(
  db: Db,
  trigger: PrintTrigger = 'schedule',
  deps: PrintDeps & { fetch?: FetchLike; client?: AiClient } = {},
): Promise<CycleResult> {
  const ingest = await runIngest(db, { fetch: deps.fetch });
  const process = await processPending(db, { fetch: deps.fetch, client: deps.client });
  const print = await runPrint(db, trigger, deps);
  return { ingest, process, print };
}
