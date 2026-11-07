/** Lightweight timing logs, only in dev builds (never under jest). */
const enabled = () =>
  typeof __DEV__ !== 'undefined' && __DEV__ && typeof process !== 'undefined' && !process.env?.JEST_WORKER_ID;

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[perf] ${label} ${Date.now() - t0}ms`);
  }
}

/** Let the UI thread breathe between chunks of JS work. */
export const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
