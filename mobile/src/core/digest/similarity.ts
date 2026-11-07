/** Title normalization and token Jaccard similarity for near-duplicate detection. */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(' ').filter(Boolean));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isNearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  return jaccard(titleTokens(a), titleTokens(b)) >= threshold;
}
