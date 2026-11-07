export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = 'termal-news-printer/0.1';

/** fetch() with an AbortController timeout. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
