/** Pure, deterministic selection of the next print batch. */
import type { DigestItem } from '../../api/types';
import { jaccard, NEAR_DUPLICATE_THRESHOLD, titleTokens } from './similarity';

export const DEFAULT_CATEGORY_LIMIT = 2;

export interface DigestCandidate {
  article_id: number;
  title: string;
  category_slug: string;
  tldr: string;
  published_at: Date | null;
}

/** Newest first; undated last; article_id desc as a stable tiebreak. */
function compare(a: DigestCandidate, b: DigestCandidate): number {
  const ad = a.published_at ? a.published_at.getTime() : null;
  const bd = b.published_at ? b.published_at.getTime() : null;
  if ((ad === null) !== (bd === null)) return ad === null ? 1 : -1;
  if (ad !== null && bd !== null && ad !== bd) return bd - ad;
  return b.article_id - a.article_id;
}

export function selectDigest(
  candidates: DigestCandidate[],
  o: {
    limits: Record<string, number>;
    maxTotal: number;
    printedIds: ReadonlySet<number>;
    lastPrintTitles: string[];
  },
): DigestItem[] {
  const { limits, maxTotal, printedIds, lastPrintTitles } = o;
  const limitOf = (slug: string) => (slug in limits ? limits[slug] : DEFAULT_CATEGORY_LIMIT);
  const prevTokens = lastPrintTitles.map(titleTokens);

  // Per-category queues of eligible candidates, newest first.
  const queues = new Map<string, DigestCandidate[]>();
  const seen = new Set<number>();
  for (const c of [...candidates].sort(compare)) {
    if (printedIds.has(c.article_id) || seen.has(c.article_id)) continue;
    if (limitOf(c.category_slug) <= 0) continue;
    seen.add(c.article_id);
    const q = queues.get(c.category_slug);
    if (q) q.push(c);
    else queues.set(c.category_slug, [c]);
  }

  // Categories in limits order first (settings order), then unknown slugs alphabetically.
  const order = [
    ...Object.keys(limits).filter((s) => queues.has(s)),
    ...[...queues.keys()].filter((s) => !(s in limits)).sort(),
  ];

  const taken = new Map(order.map((s) => [s, 0]));
  const cursors = new Map(order.map((s) => [s, 0]));
  const chosenTokens: Set<string>[] = [];
  const result: DigestItem[] = [];

  let progressed = true;
  while (progressed && result.length < maxTotal) {
    progressed = false;
    for (const slug of order) {
      if (result.length >= maxTotal) break;
      const cap = limitOf(slug);
      const q = queues.get(slug)!;
      // Take the next acceptable candidate from this category (skipping near-duplicates).
      while ((taken.get(slug) ?? 0) < cap && (cursors.get(slug) ?? 0) < q.length) {
        const c = q[cursors.get(slug)!];
        cursors.set(slug, cursors.get(slug)! + 1);
        const toks = titleTokens(c.title);
        if (prevTokens.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) continue;
        if (chosenTokens.some((p) => jaccard(toks, p) >= NEAR_DUPLICATE_THRESHOLD)) continue;
        chosenTokens.push(toks);
        taken.set(slug, (taken.get(slug) ?? 0) + 1);
        result.push({ article_id: c.article_id, position: result.length + 1, category_slug: slug, tldr: c.tldr });
        progressed = true;
        break;
      }
    }
  }
  return result;
}
