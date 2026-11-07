/** Wiring layer: ingest -> AI-curated edition -> render -> print. */
import type { DigestItem, Edition, IngestResult, PrintRecord, PrintTrigger } from '../api/types';
import { getDevice, type DeviceServices } from '../device/contracts';
import type { AiClient } from './ai/client';
import type { Db } from './db/adapter';
import { archiveEdition, listEditionItems } from './db/edition';
import { clearError, recordError } from './diagnostics';
import { createPrint, getPrint, setPrintStatus } from './db/prints';
import { getSettings } from './db/settings';
import { buildEdition } from './edition';
import { emit } from './events';
import { savePrintPng } from './files';
import type { FetchLike } from './http';
import { runIngest } from './ingest/service';
import { timed } from './perf';

/** The persisted edition as a print batch: only summarized items, renumbered 1..n. */
export async function buildDigest(db: Db): Promise<DigestItem[]> {
  return (await listEditionItems(db))
    .filter((i): i is typeof i & { tldr: string } => i.tldr !== null)
    .map((i, idx) => ({ article_id: i.article_id, position: idx + 1, category_slug: i.category_slug, tldr: i.tldr }));
}

export interface PrintDeps {
  /** Inject an AI client (tests); default: built from the stored API key. */
  client?: AiClient;
  fetch?: FetchLike;
  device?: DeviceServices;
  savePng?: (printId: number, pngBase64: string) => Promise<unknown>;
  now?: Date;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * persisted edition (built first if missing, summaries finished) -> create pending print -> render -> save PNG -> print over BLE -> printed/failed.
 * Returns null (no record) when the digest is empty. A failed print is recorded with its error and
 * returned (status 'failed'); its articles become eligible again.
 */
export async function runPrint(db: Db, trigger: PrintTrigger, deps: PrintDeps = {}): Promise<PrintRecord | null> {
  // Print exactly what Feed/Preview show: never re-curate here, only fill in what is missing.
  await buildEdition(db, { client: deps.client, fetch: deps.fetch, now: deps.now }, { ensureOnly: true });
  const digest = await buildDigest(db);
  if (digest.length === 0) return null;
  const pid = await createPrint(db, trigger, digest);
  let stage: 'render' | 'print' = 'render';
  try {
    const device = deps.device ?? getDevice();
    const settings = await getSettings(db);
    const rendered = await device.render(digest, { editionDate: deps.now ?? new Date(), issueNo: pid });
    await clearError(db, 'render');
    try {
      await (deps.savePng ?? savePrintPng)(pid, rendered.pngBase64);
    } catch {
      // history image is a nicety; never block printing on it
    }
    stage = 'print';
    await device.printer.print(rendered.bitmap, { deviceId: settings.printer_address ?? undefined });
    await setPrintStatus(db, pid, 'printed');
    await clearError(db, 'print');
    // Printed stories move to History (status "Printed"); the next edition is curated in the background.
    await archiveEdition(db, { printId: pid, onlyArticleIds: new Set(digest.map((d) => d.article_id)) });
    emit('edition');
    emit('history');
    void buildEdition(db, { client: deps.client, fetch: deps.fetch }).catch(() => undefined);
  } catch (e) {
    console.warn(`[${stage}] failed: ${errText(e)}`);
    await recordError(db, stage, `${stage === 'render' ? 'Rendering' : 'Printing'} failed: ${errText(e)}`);
    await setPrintStatus(db, pid, 'failed', errText(e)); // the edition is kept for a retry
  }
  emit('prints');
  return getPrint(db, pid);
}

export interface CycleResult {
  ingest: IngestResult;
  edition: Edition;
  print: PrintRecord | null;
}

/** ingest -> buildEdition -> runPrint. */
export async function runCycle(
  db: Db,
  trigger: PrintTrigger = 'schedule',
  deps: PrintDeps = {},
): Promise<CycleResult> {
  const ingest = await timed('ingest', () => runIngest(db, { fetch: deps.fetch }));
  const edition = await buildEdition(
    db,
    { client: deps.client, fetch: deps.fetch, now: deps.now },
    { newArticles: ingest.new_articles },
  );
  const print = await runPrint(db, trigger, deps);
  return { ingest, edition, print };
}
