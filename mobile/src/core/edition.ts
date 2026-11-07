/**
 * The AI-curated edition: one cheap AI call picks the most interesting recent stories, code enforces the
 * rules (limits, cap, dedup), only the chosen stories are enriched + summarized, and the result is persisted
 * so Feed, Preview and Print all show exactly the same thing.
 */
import type { Edition, EditionStatus } from '../api/types';
import { curateWithAi } from './ai/curate';
import { AIError, AIUnavailable, createAiClient, type AiClient } from './ai/client';
import { summarize } from './ai/summarize';
import type { Db } from './db/adapter';
import { getPrintedArticleIds, listCurationCandidates, setPoliticalMany, upsertSummary, type CandidateRow } from './db/articles';
import { listCategories } from './db/catalog';
import { clearEdition, getEditionBuiltAt, hasArticlesSince, listEditionItems, replaceEdition } from './db/edition';
import { getLastPrintItems } from './db/prints';
import { getSettings } from './db/settings';
import { selectInOrder } from './digest/order';
import { selectDigest } from './digest/select';
import { enrichRows } from './enrich';
import { emit } from './events';
import type { FetchLike } from './http';
import { mapLimit, timed } from './perf';
import { getApiKey } from './secrets';

export const MAX_CANDIDATES = 60;
export const MAX_AGE_DAYS = 4;
export const CONCURRENCY = 3;

export interface EditionDeps {
  /** Inject an AI client (tests); default: built from the stored API key. */
  client?: AiClient;
  fetch?: FetchLike;
  now?: Date;
}

export interface Curated {
  items: { article_id: number; title: string; category_slug: string }[];
  /** true when the AI ranking was used; false for the deterministic fallback. */
  usedAi: boolean;
  /** no OpenRouter key configured. */
  noKey: boolean;
}

interface State {
  status: EditionStatus;
  inflight: Promise<void> | null;
}
const states = new WeakMap<Db, State>();
const stateOf = (db: Db): State => {
  let s = states.get(db);
  if (!s) {
    s = { status: { phase: 'idle', done: 0, total: 0, no_key: false }, inflight: null };
    states.set(db, s);
  }
  return s;
};

const setStatus = (db: Db, patch: Partial<EditionStatus>) => {
  Object.assign(stateOf(db).status, patch);
  emit('edition');
};

const parseDt = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function resolveClient(deps: EditionDeps): Promise<AiClient | null> {
  if (deps.client) return deps.client;
  const key = await getApiKey();
  return key ? createAiClient({ apiKey: key, fetch: deps.fetch }) : null;
}

async function rulesOptions(db: Db) {
  const limits: Record<string, number> = {};
  for (const c of await listCategories(db)) limits[c.slug] = c.print_limit;
  const settings = await getSettings(db);
  return {
    limits,
    settings,
    maxTotal: settings.max_items_total,
    printedIds: await getPrintedArticleIds(db),
    lastPrintTitles: (await getLastPrintItems(db)).map((i) => i.title).filter((t): t is string => !!t),
  };
}

/** Pick the stories of the next edition (AI order + code rules), flagging political articles on the way. */
export async function curateEdition(db: Db, deps: EditionDeps = {}): Promise<Curated> {
  const rules = await rulesOptions(db);
  const candidates = await listCurationCandidates(db, { limit: MAX_CANDIDATES, maxAgeDays: MAX_AGE_DAYS, now: deps.now });
  if (candidates.length === 0) return { items: [], usedAi: false, noKey: !(await resolveClient(deps)) };

  const asItem = (c: CandidateRow) => ({ article_id: c.id, title: c.title, category_slug: c.category_slug });
  const fallback = (noKey: boolean): Curated => {
    const picked = selectDigest(
      candidates.map((c) => ({ ...asItem(c), tldr: '', published_at: parseDt(c.published_at) })),
      rules,
    );
    const byId = new Map(candidates.map((c) => [c.id, c]));
    return { items: picked.map((p) => asItem(byId.get(p.article_id)!)), usedAi: false, noKey };
  };

  const client = await resolveClient(deps);
  if (!client) return fallback(true);

  let verdict;
  try {
    verdict = await timed('curate.ai', () =>
      curateWithAi(
        candidates.map((c) => ({ id: c.id, category_slug: c.category_slug, title: c.title, content_text: c.content_text })),
        {
          client,
          model: rules.settings.model,
          fallbackModel: rules.settings.fallback_model,
          maxPicks: Math.min(candidates.length, rules.maxTotal * 2),
        },
      ),
    );
  } catch (e) {
    if (e instanceof AIUnavailable) return fallback(true);
    if (e instanceof AIError) return fallback(false);
    throw e;
  }
  if (!verdict || verdict.picks.length === 0) return fallback(false);

  // Everything we sent is now checked: political ids flagged, the rest marked non-political.
  const political = new Set(verdict.political);
  await setPoliticalMany(db, [...political], true);
  await setPoliticalMany(
    db,
    candidates.filter((c) => !political.has(c.id)).map((c) => c.id),
    false,
  );

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ordered = verdict.picks.map((id) => asItem(byId.get(id)!));
  return { items: selectInOrder(ordered, rules), usedAi: true, noKey: false };
}

/** Enrich (full text if short) + summarize the edition items that lack a TL;DR; concurrency <= 3. */
async function summarizeMissing(db: Db, deps: EditionDeps): Promise<void> {
  const state = stateOf(db);
  const missing = (await listEditionItems(db)).filter((i) => i.tldr === null);
  if (missing.length === 0) return;
  const client = await resolveClient(deps);
  if (!client) {
    state.status.no_key = true;
    return;
  }
  const settings = await getSettings(db);
  setStatus(db, { phase: 'summarizing', done: 0, total: missing.length });
  let aborted = false;
  await timed(`summarize x${missing.length}`, () =>
    mapLimit(missing, CONCURRENCY, async (item) => {
      if (aborted) return;
      try {
        const row = await db.get<{ id: number; content_text: string | null; url: string; published_at: string | null }>(
          'SELECT id, content_text, url, published_at FROM articles WHERE id=?',
          [item.article_id],
        );
        if (!row) return;
        const enriched = await enrichRows(db, [{ id: row.id, url: row.url, content_text: row.content_text }], { fetch: deps.fetch });
        const s = await summarize(
          {
            id: item.article_id,
            title: item.title,
            url: item.url,
            content_text: enriched.get(row.id) ?? row.content_text,
            category_slug: item.category_slug,
            published_at: parseDt(row.published_at),
          },
          { client, model: settings.model, fallbackModel: settings.fallback_model },
        );
        await upsertSummary(db, item.article_id, s.tldr, s.model);
      } catch (e) {
        if (e instanceof AIUnavailable) {
          aborted = true;
          state.status.no_key = true;
        } else if (!(e instanceof AIError)) {
          console.warn(`summarizing article ${item.article_id} failed`);
        }
      } finally {
        state.status.done += 1;
        emit('edition');
      }
    }),
  );
}

export interface BuildOptions {
  /** Re-curate even if an edition exists. */
  force?: boolean;
  /** Number of freshly ingested articles (ingest result); > 0 triggers a rebuild. */
  newArticles?: number;
  /** Only build when there is no edition yet; never re-curate (used right before printing). */
  ensureOnly?: boolean;
}

async function buildImpl(db: Db, deps: EditionDeps, o: BuildOptions): Promise<void> {
  const state = stateOf(db);
  const existing = await listEditionItems(db);
  let stale = o.force === true || existing.length === 0;
  if (!stale && !o.ensureOnly) {
    if ((o.newArticles ?? 0) > 0) stale = true;
    else {
      const builtAt = await getEditionBuiltAt(db);
      if (builtAt && (await hasArticlesSince(db, builtAt))) stale = true;
      // A key was added after an unkeyed (fallback) edition: re-curate with the AI.
      else if (state.status.no_key && (await resolveClient(deps))) stale = true;
    }
  }
  if (stale) {
    setStatus(db, { phase: 'curating', done: 0, total: 0 });
    const curated = await timed('curate', () => curateEdition(db, deps));
    state.status.no_key = curated.noKey;
    await replaceEdition(
      db,
      curated.items.map((i) => ({ article_id: i.article_id, category_slug: i.category_slug })),
    );
    emit('edition');
  }
  await summarizeMissing(db, deps);
}

/**
 * Build / refresh the persisted edition and summarize its stories. Single-flight per database: while a
 * build is running (including its summaries) further calls just await it, so the edition never reshuffles
 * under the user's feet.
 */
export function buildEdition(db: Db, deps: EditionDeps = {}, o: BuildOptions = {}): Promise<Edition> {
  const state = stateOf(db);
  if (!state.inflight) {
    const p: Promise<void> = buildImpl(db, deps, o)
      .catch((e) => {
        console.warn('edition build failed', e instanceof Error ? e.message : e);
      })
      .finally(() => {
        if (state.inflight === p) state.inflight = null;
        setStatus(db, { phase: 'idle', done: 0, total: 0 });
      });
    state.inflight = p;
  }
  return state.inflight.then(() => getEdition(db, deps));
}

/** Resolves when no build is running. */
export function editionIdle(db: Db): Promise<void> {
  return stateOf(db).inflight ?? Promise.resolve();
}

export async function getEdition(db: Db, deps: EditionDeps = {}): Promise<Edition> {
  const state = stateOf(db);
  const items = await listEditionItems(db);
  const noKey = !(await resolveClient(deps));
  return { items, status: { ...state.status, no_key: noKey }, built_at: await getEditionBuiltAt(db) };
}

export { clearEdition };
