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

export interface BalancedCandidate extends OrderedCandidate {
  feed_id: number;
}

interface BalancedOptions {
  limits: Record<string, number>;
  maxTotal: number;
  printedIds: ReadonlySet<number>;
  lastPrintTitles: string[];
}

/**
 * Balanced edition from `ranked` (best first: AI order when available, else newest first).
 *  A. coverage: the best story of every category with eligible stories (categories ordered by that story's rank)
 *  B. interest: rank order within the per-category print limits, alternating feeds inside a category and
 *     keeping any single feed to ceil(target/3)
 *  C. fill: rank order ignoring category limits, same feed rules
 *  D. last resort: rank order, feed rules relaxed
 * Limit-0 categories, printed articles and near-duplicates are never taken. The result is interleaved
 * round-robin by category so the receipt alternates topics.
 */
export function selectBalanced<T extends BalancedCandidate>(ranked: T[], o: BalancedOptions): T[] {
  const limitOf = (slug: string) => (slug in o.limits ? o.limits[slug] : DEFAULT_CATEGORY_LIMIT);
  const prev = o.lastPrintTitles.map(titleTokens);
  const tokens = new Map<number, Set<string>>();
  const tok = (c: T) => {
    let t = tokens.get(c.article_id);
    if (!t) tokens.set(c.article_id, (t = titleTokens(c.title)));
    return t;
  };
  const chosenTokens: Set<string>[] = [];
  const catCount = new Map<string, number>();
  const feedCount = new Map<number, number>();
  const feedInCat = new Map<string, number>(); // `${slug}:${feed}`
  const used = new Set<number>();
  const out: T[] = [];
  const feedCap = Math.max(1, Math.ceil(o.maxTotal / 3));
  const key = (c: T) => `${c.category_slug}:${c.feed_id}`;

  const eligible = (c: T): boolean => {
    if (used.has(c.article_id) || o.printedIds.has(c.article_id) || limitOf(c.category_slug) <= 0) return false;
    const t = tok(c);
    if (prev.some((p) => jaccard(t, p) >= NEAR_DUPLICATE_THRESHOLD)) return false;
    return !chosenTokens.some((p) => jaccard(t, p) >= NEAR_DUPLICATE_THRESHOLD);
  };
  const take = (c: T) => {
    used.add(c.article_id);
    chosenTokens.push(tok(c));
    catCount.set(c.category_slug, (catCount.get(c.category_slug) ?? 0) + 1);
    feedCount.set(c.feed_id, (feedCount.get(c.feed_id) ?? 0) + 1);
    feedInCat.set(key(c), (feedInCat.get(key(c)) ?? 0) + 1);
    out.push(c);
  };

  // A. coverage
  const seenCat = new Set<string>();
  for (const c of ranked) {
    if (out.length >= o.maxTotal) break;
    if (seenCat.has(c.category_slug) || !eligible(c)) continue;
    seenCat.add(c.category_slug);
    take(c);
  }

  // B-D: repeatedly take the best-ranked candidate whose feed is the least used in its category.
  const phase = (catCaps: boolean, feedRules: boolean) => {
    while (out.length < o.maxTotal) {
      const ok = ranked.filter(
        (c) =>
          eligible(c) &&
          (!catCaps || (catCount.get(c.category_slug) ?? 0) < limitOf(c.category_slug)) &&
          (!feedRules || (feedCount.get(c.feed_id) ?? 0) < feedCap),
      );
      if (ok.length === 0) return;
      let pick = ok[0];
      if (feedRules) {
        const least = new Map<string, number>();
        for (const c of ok) least.set(c.category_slug, Math.min(least.get(c.category_slug) ?? Infinity, feedInCat.get(key(c)) ?? 0));
        pick = ok.find((c) => (feedInCat.get(key(c)) ?? 0) === least.get(c.category_slug))!;
      }
      take(pick);
    }
  };
  phase(true, true);
  phase(false, true);
  phase(false, false);

  // Interleave categories (order of first appearance) round-robin.
  const queues = new Map<string, T[]>();
  for (const c of out) {
    const q = queues.get(c.category_slug);
    if (q) q.push(c);
    else queues.set(c.category_slug, [c]);
  }
  const lists = [...queues.values()];
  const result: T[] = [];
  for (let i = 0; result.length < out.length; i++) for (const l of lists) if (i < l.length) result.push(l[i]);
  return result;
}

/**
 * Candidate list for the AI call: at most `perCategory` stories per category and `total` overall, alternating
 * feeds inside a category and categories in the round, so one high-volume feed cannot swamp the rest.
 * Input must be newest first; the output keeps that order per feed.
 */
export function capPerCategory<T extends { category_slug: string; feed_id: number }>(rows: T[], perCategory: number, total: number): T[] {
  const cats = new Map<string, Map<number, T[]>>();
  for (const r of rows) {
    let feeds = cats.get(r.category_slug);
    if (!feeds) cats.set(r.category_slug, (feeds = new Map()));
    const q = feeds.get(r.feed_id);
    if (q) q.push(r);
    else feeds.set(r.feed_id, [r]);
  }
  const perCat = [...cats.values()].map((feeds) => {
    const qs = [...feeds.values()];
    const list: T[] = [];
    for (let i = 0; list.length < perCategory && qs.some((q) => i < q.length); i++) {
      for (const q of qs) if (i < q.length && list.length < perCategory) list.push(q[i]);
    }
    return list;
  });
  const out: T[] = [];
  for (let i = 0; out.length < total && perCat.some((l) => i < l.length); i++) {
    for (const l of perCat) if (i < l.length && out.length < total) out.push(l[i]);
  }
  return out;
}
