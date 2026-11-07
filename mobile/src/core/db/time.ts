/** ISO-8601 UTC timestamp with second precision (e.g. 2026-01-02T03:04:05+00:00). */
export function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19) + '+00:00';
}

export const nowIso = (): string => isoSeconds(new Date());

/** Normalize a Date or ISO string to the stored format; null for null/unparseable. */
export function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : isoSeconds(d);
}

/** A feed is stale when its newest story is older than this. */
export const STALE_FEED_DAYS = 30;

export const isStale = (newestAt: string | null, now: Date = new Date()): boolean =>
  newestAt !== null && new Date(newestAt).getTime() < now.getTime() - STALE_FEED_DAYS * 86_400_000;
