/** Code rules applied to an externally ranked (AI) list. */
import { DEFAULT_CATEGORY_LIMIT } from './select';
import { jaccard, NEAR_DUPLICATE_THRESHOLD, titleTokens } from './similarity';

export interface OrderedCandidate {
  article_id: number;
  title: string;
  category_slug: string;
}

/**
 * Keeps the given order and enforces: printed exclusion, per-category limits, the overall cap and
 * near-duplicate removal (vs the last print and within the batch).
 */
export function selectInOrder<T extends OrderedCandidate>(
  ordered: T[],
  o: {
    limits: Record<string, number>;
    maxTotal: number;
    printedIds: ReadonlySet<number>;
    lastPrintTitles: string[];
  },
): T[] {
  const limitOf = (slug: string) => (slug in o.limits ? o.limits[slug] : DEFAULT_CATEGORY_LIMIT);
  const prev = o.lastPrintTitles.map(titleTokens);
  const chosenTokens: Set<string>[] = [];
  const taken = new Map<string, number>();
  const seen = new Set<number>();
  const out: T[] = [];
  for (const c of ordered) {
    if (out.length >= o.maxTotal) break;
    if (seen.has(c.article_id) || o.printedIds.has(c.article_id)) continue;
    seen.add(c.article_id);
    if ((taken.get(c.category_slug) ?? 0) >= limitOf(c.category_slug)) continue;
    const toks = titleTokens(c.title);
    if (prev.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) continue;
    if (chosenTokens.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) continue;
    chosenTokens.push(toks);
    taken.set(c.category_slug, (taken.get(c.category_slug) ?? 0) + 1);
    out.push(c);
  }
  return out;
}

/**
 * Guaranteed-size selection. Order of preference:
 *  (a) `picks` (AI order) within the per-category limits,
 *  (b) the remaining picks, limits ignored,
 *  (c) `pool` (newest first), round-robin across categories, limits ignored.
 * Categories with limit 0, printed articles and near-duplicates are always skipped. The result only falls short
 * of `maxTotal` when every eligible story is exhausted.
 */
export function selectGuaranteed<T extends OrderedCandidate>(
  picks: T[],
  pool: T[],
  o: { limits: Record<string, number>; maxTotal: number; printedIds: ReadonlySet<number>; lastPrintTitles: string[] },
): T[] {
  const limitOf = (slug: string) => (slug in o.limits ? o.limits[slug] : DEFAULT_CATEGORY_LIMIT);
  const prev = o.lastPrintTitles.map(titleTokens);
  const chosenTokens: Set<string>[] = [];
  const taken = new Map<string, number>();
  const used = new Set<number>();
  const out: T[] = [];

  const tryTake = (c: T, honourLimit: boolean): boolean => {
    if (out.length >= o.maxTotal || used.has(c.article_id) || o.printedIds.has(c.article_id)) return false;
    if (limitOf(c.category_slug) <= 0) return false;
    if (honourLimit && (taken.get(c.category_slug) ?? 0) >= limitOf(c.category_slug)) return false;
    const toks = titleTokens(c.title);
    if (prev.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) return false;
    if (chosenTokens.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) return false;
    used.add(c.article_id);
    chosenTokens.push(toks);
    taken.set(c.category_slug, (taken.get(c.category_slug) ?? 0) + 1);
    out.push(c);
    return true;
  };

  for (const c of picks) tryTake(c, true);
  for (const c of picks) tryTake(c, false);

  // Round-robin over categories (first-seen order) so the top-up stays varied.
  const queues = new Map<string, T[]>();
  for (const c of pool) {
    const q = queues.get(c.category_slug);
    if (q) q.push(c);
    else queues.set(c.category_slug, [c]);
  }
  const lists = [...queues.values()];
  for (let i = 0; out.length < o.maxTotal && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) tryTake(l[i], false);
  }
  return out;
}
