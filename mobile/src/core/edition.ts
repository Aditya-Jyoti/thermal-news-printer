/**
 * The AI-curated edition: one cheap AI call picks the most interesting recent stories, code enforces the
 * rules (limits, cap, dedup), only the chosen stories are enriched + summarized, and the result is persisted
 * so Feed, Preview and Print all show exactly the same thing.
 */
import type { AiKeyTestResult, Diagnostics, Edition, EditionStatus, FetchNewsResult } from '../api/types';
import { curateWithAi } from './ai/curate';
import { AIError, AIUnavailable, createAiClient, SAFE_FALLBACK_MODEL, withSafeFallback, type AiClient } from './ai/client';
import { clearError, getLastErrors, pickLastError, recordError } from './diagnostics';
import { summarize } from './ai/summarize';
import type { Db } from './db/adapter';
import { countArticles, countByCategory, feedDiagnostics, getPrintedArticleIds, listCurationCandidates, setPoliticalMany, upsertSummary, type CandidateRow } from './db/articles';
import { listCategories } from './db/catalog';
import { archiveEdition, clearEdition, countEditionSummarized, getEditionBuiltAt, hasArticlesSince, listEditionItems, replaceEdition } from './db/edition';
import { getLastPrintItems } from './db/prints';
import { getSettings } from './db/settings';
import { capPerCategory, selectBalanced } from './digest/order';
import { enrichRows } from './enrich';
import { runIngest } from './ingest/service';
import { emit } from './events';
import type { FetchLike } from './http';
import { mapLimit, timed } from './perf';
import { redact } from './redact';
import { getApiKey } from './secrets';

/** Candidates per AI call (compact lines keep the prompt small). */
export const MAX_CANDIDATES = 100;
/** Candidates per category sent to the AI (newest, feeds alternating). */
export const PER_CATEGORY_CANDIDATES = 25;
/** Safety cap on rows read for one curation (everything inside the age window). */
export const POOL_LIMIT = 1000;
/** Default / bounds of the "Max story age" setting. */
export const MAX_AGE_DAYS = 3;
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
  /** the freshness window used (settings.max_age_days). */
  windowDays: number;
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

const effectiveTime = (c: CandidateRow) => parseDt(c.published_at ?? c.fetched_at)?.getTime() ?? 0;

/**
 * Pick the stories of the next edition from articles no older than settings.max_age_days (no widening: when
 * the window cannot fill the target the edition is simply smaller). The AI sees up to 25 newest candidates
 * per category (never a global slice swamped by one busy feed) and ranks them; selectBalanced then
 * guarantees coverage of every category with fresh stories, applies print limits as soft caps, alternates
 * feeds and interleaves categories. Without an AI the same rules run on newest-first order.
 */
export async function curateEdition(db: Db, deps: EditionDeps = {}): Promise<Curated> {
  const rules = await rulesOptions(db);
  const client = await resolveClient(deps);
  const windowDays = rules.settings.max_age_days;
  const asItem = (c: CandidateRow) => ({ article_id: c.id, title: c.title, category_slug: c.category_slug, feed_id: c.feed_id });

  const all = await listCurationCandidates(db, { limit: POOL_LIMIT, maxAgeDays: windowDays, now: deps.now });
  const remaining = [...all];
  const byId = new Map<number, CandidateRow>(all.map((c) => [c.id, c]));
  const vetted: CandidateRow[] = []; // non-political
  const aiPicks: number[] = [];
  let usedAi = false;
  let aiOff = !client;
  let noKey = !client;
  let items: ReturnType<typeof asItem>[] = [];

  const select = () => {
    const picked = new Set(aiPicks);
    const rest = vetted.filter((c) => !picked.has(c.id)).sort((x, y) => effectiveTime(y) - effectiveTime(x) || y.id - x.id);
    const ranked = [...aiPicks.map((id) => byId.get(id)!), ...rest].map(asItem);
    return selectBalanced(ranked, rules);
  };

  while (remaining.length > 0) {
    // Next batch: balanced across categories, so every category reaches the AI.
    const batch = capPerCategory(remaining, PER_CATEGORY_CANDIDATES, MAX_CANDIDATES);
    const inBatch = new Set(batch.map((c) => c.id));
    for (let i = remaining.length - 1; i >= 0; i--) if (inBatch.has(remaining[i].id)) remaining.splice(i, 1);
    let aiOk = false;
    if (!aiOff && client) {
      try {
        const verdict = await timed('curate.ai', () =>
          curateWithAi(
            batch.map((c) => ({ id: c.id, category_slug: c.category_slug, title: c.title, content_text: c.content_text })),
            {
              client,
              model: rules.settings.model,
              fallbackModel: rules.settings.fallback_model,
              maxPicks: Math.min(batch.length, rules.maxTotal * 2),
            },
          ),
        );
        if (verdict && (verdict.picks.length > 0 || usedAi)) {
          aiOk = true;
          usedAi = true;
          await clearError(db, 'curate');
          const political = new Set(verdict.political);
          await setPoliticalMany(db, [...political], true);
          await setPoliticalMany(db, batch.filter((c) => !political.has(c.id)).map((c) => c.id), false);
          aiPicks.push(...verdict.picks.filter((id) => !political.has(id)));
          vetted.push(...batch.filter((c) => !political.has(c.id)));
        } else {
          console.warn(`[curate] AI reply unusable (model ${rules.settings.model}): no picks parsed`);
          await recordError(db, 'curate', 'Curation failed: the AI reply had no usable picks');
          aiOff = true;
        }
      } catch (e) {
        aiOff = true;
        if (e instanceof AIUnavailable) noKey = true;
        else if (e instanceof AIError) {
          console.warn(`[curate] AI curation failed (model ${rules.settings.model}): ${redact(e.message).slice(0, 200)}`);
          await recordError(db, 'curate', `Curation failed: ${e.message}`);
        } else throw e;
      }
    }
    if (!aiOk) vetted.push(...batch);
    items = select();
    if (items.length >= rules.maxTotal) break;
  }
  if (all.length === 0) await clearError(db, 'curate');
  return { items, usedAi, noKey, windowDays };
}

/** Enrich (full text if short) + summarize the edition items that lack a TL;DR; concurrency <= 3. */
async function summarizeMissing(db: Db, deps: EditionDeps): Promise<void> {
  const state = stateOf(db);
  const missing = (await listEditionItems(db)).filter((i) => i.tldr === null);
  if (missing.length === 0) {
    await clearError(db, 'summarize');
    return;
  }
  const client = await resolveClient(deps);
  if (!client) {
    state.status.no_key = true;
    return;
  }
  const settings = await getSettings(db);
  setStatus(db, { phase: 'summarizing', done: 0, total: missing.length });
  let aborted = false;
  let failures = 0;
  let firstFailure: string | null = null;
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
        } else {
          failures += 1;
          const msg = e instanceof Error ? e.message : String(e);
          firstFailure ??= msg;
          console.warn(`[summarize] article ${item.article_id} failed (model ${settings.model}): ${redact(msg).slice(0, 200)}`);
        }
      } finally {
        state.status.done += 1;
        emit('edition');
      }
    }),
  );
  if (failures > 0) {
    await recordError(db, 'summarize', `Summaries failed (${failures} of ${missing.length}): ${firstFailure}`);
  } else if (!aborted) {
    await clearError(db, 'summarize');
  }
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
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('edition build failed', redact(msg));
        return recordError(db, 'curate', `Building the edition failed: ${msg}`);
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
  const lastError = pickLastError(await getLastErrors(db));
  const { max_items_total, max_age_days } = await getSettings(db);
  return {
    items,
    status: { ...state.status, no_key: noKey, last_error: lastError },
    built_at: await getEditionBuiltAt(db),
    target: max_items_total,
    max_age_days,
  };
}

/**
 * "Fetch new news": the current edition goes to History (Not printed), the feeds are ingested, a fresh edition
 * is curated. With `awaitBuild: false` the (slow) curation + summaries continue in the background.
 */
export async function fetchNewNews(db: Db, deps: EditionDeps = {}, o: { awaitBuild?: boolean } = {}): Promise<FetchNewsResult> {
  await editionIdle(db);
  if (await archiveEdition(db)) emit('history');
  emit('edition');
  const ingest = await runIngest(db, { fetch: deps.fetch });
  const build = buildEdition(db, deps, { force: true });
  if (o.awaitBuild === false) {
    void build.catch(() => undefined);
    return { ingest, edition: await getEdition(db, deps) };
  }
  return { ingest, edition: await build };
}

export async function getDiagnostics(db: Db, deps: EditionDeps = {}): Promise<Diagnostics> {
  const windowDays = (await getSettings(db)).max_age_days;
  const counts = await countArticles(db, { maxAgeDays: windowDays, now: deps.now });
  const ed = await countEditionSummarized(db);
  const inEdition = new Map<string, number>();
  for (const i of await listEditionItems(db)) inEdition.set(i.category_slug, (inEdition.get(i.category_slug) ?? 0) + 1);
  const categories = (await countByCategory(db, { maxAgeDays: windowDays, now: deps.now })).map((c) => ({
    ...c,
    in_edition: inEdition.get(c.slug) ?? 0,
  }));
  const { model, fallback_model } = await getSettings(db);
  const hints: string[] = [];
  if (!fallback_model || fallback_model === model) {
    hints.push(`Fallback model is not set or equals the main model; ${SAFE_FALLBACK_MODEL} is used as the automatic fallback.`);
  }
  return {
    hints,
    window_days: windowDays,
    feeds: await feedDiagnostics(db, { maxAgeDays: windowDays, now: deps.now }),
    categories,
    last_errors: await getLastErrors(db),
    counts: { articles: counts.articles, candidates: counts.candidates, edition_size: ed.size, summarized: ed.summarized },
  };
}

export { clearEdition };

/** One tiny request (max_tokens 5) per configured model (primary, then fallback); never throws. */
export async function testAiKey(db: Db, deps: EditionDeps = {}): Promise<AiKeyTestResult> {
  const client = await resolveClient(deps);
  if (!client) return { ok: false, results: [{ model: '-', ok: false, message: 'No OpenRouter API key is set' }] };
  const { model, fallback_model } = await getSettings(db);
  const results: AiKeyTestResult['results'] = [];
  for (const m of withSafeFallback([model, fallback_model])) {
    try {
      await client.chat({ model: m, system: 'Reply with one word.', user: 'Say ok.', maxTokens: 5, temperature: 0 });
      results.push({ model: m, ok: true, message: 'OK' });
    } catch (e) {
      const status = e instanceof AIError ? e.status : undefined;
      results.push({ model: m, ok: false, status, message: redact(e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}
