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
