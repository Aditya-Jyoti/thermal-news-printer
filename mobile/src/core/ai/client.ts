import { defaultFetch, fetchWithTimeout, type FetchLike } from '../http';
import { redact } from '../redact';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;
/** Reasoning models spend hidden tokens first; a small cap leaves them with an empty answer. */
export const MIN_MAX_TOKENS = 2048;
/** Non-reasoning model used when the configured fallback is missing or identical to the primary. */
export const SAFE_FALLBACK_MODEL = 'google/gemma-3-12b-it';

/** Distinct models in order; a fallback equal to the primary is pointless, so use the safe model instead. */
export function withSafeFallback(models: (string | null | undefined)[]): string[] {
  const given = models.filter((m): m is string => !!m);
  const ordered = [...new Set(given)];
  if (ordered.length === 1 && given.length > 1 && ordered[0] !== SAFE_FALLBACK_MODEL) ordered.push(SAFE_FALLBACK_MODEL);
  return ordered;
}

export class AIError extends Error {
  /** HTTP status of the failing call, when there was one. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AIError';
    this.status = status;
  }
}

/** AI features are not configured (no API key). */
export class AIUnavailable extends AIError {
  constructor(message = 'OpenRouter API key is not set; AI summarization and politics classification are unavailable.') {
    super(message);
    this.name = 'AIUnavailable';
  }
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiClient {
  chat(o: ChatOptions): Promise<string>;
}

export interface AiClientConfig {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Backoff sleeper (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/** OpenRouter (OpenAI-compatible) client over fetch. The API key is only ever sent in the Authorization header. */
export function createAiClient(cfg: AiClientConfig): AiClient {
  const fetchImpl = cfg.fetch ?? defaultFetch;
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const retries = cfg.maxRetries ?? MAX_RETRIES;
  const sleep = cfg.sleep ?? realSleep;

  return {
    async chat({ model, system, user, maxTokens = 200, temperature = 0.3 }) {
      const body = JSON.stringify({
        model,
        // Some models (e.g. Gemma) reject a system role; a single user message is universally safe.
        messages: [{ role: 'user', content: `${system}\n\n---\n\n${user}` }],
        max_tokens: Math.max(maxTokens, MIN_MAX_TOKENS),
        // OpenRouter's unified switch: no thinking, just a normal answer. Ignored by non-reasoning models.
        reasoning: { enabled: false },
        temperature,
      });
      let lastErr = 'unknown error';
      let lastStatus: number | undefined;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        let res: Response;
        try {
          res = await fetchWithTimeout(
            fetchImpl,
            `${base}/chat/completions`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'termal-news-printer',
                'X-Title': 'termal-news-printer',
              },
              body,
            },
            cfg.timeoutMs ?? TIMEOUT_MS,
          );
        } catch (e) {
          lastErr = redact(e instanceof Error ? e.message : String(e), [cfg.apiKey]);
          console.warn(`[ai] model=${model} request failed: ${lastErr.slice(0, 200)}`);
          continue; // connection error / timeout: retry
        }
        if (!res.ok) {
          let raw = '';
          try {
            raw = await res.text();
          } catch {
            // unreadable body
          }
          let detail = '';
          try {
            const j = JSON.parse(raw) as { error?: { message?: string } };
            detail = j.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : '';
          } catch {
            // non-JSON error body
          }
          detail = redact(detail, [cfg.apiKey]);
          console.warn(`[ai] model=${model} HTTP ${res.status} body=${redact(raw, [cfg.apiKey]).replace(/\s+/g, ' ').slice(0, 200)}`);
          lastErr = `HTTP ${res.status}${detail}`;
          lastStatus = res.status;
          if (RETRYABLE(res.status)) continue;
          throw new AIError(`model call failed: HTTP ${res.status}${detail}`, res.status);
        }
        let text = '';
        let reasoned = false;
        let finish = '';
        try {
          const j = (await res.json()) as {
            choices?: { finish_reason?: string; message?: { content?: unknown; reasoning?: unknown; reasoning_details?: unknown } }[];
          };
          const msg = j.choices?.[0]?.message;
          text = contentText(msg?.content);
          finish = j.choices?.[0]?.finish_reason ?? '';
          reasoned = !!msg?.reasoning || (Array.isArray(msg?.reasoning_details) && msg.reasoning_details.length > 0);
        } catch (e) {
          console.warn(`[ai] model=${model} unexpected response shape`);
          throw new AIError(`unexpected response shape: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!text.trim()) {
          console.warn(`[ai] model=${model} empty model response finish_reason=${finish}`);
          if (reasoned || finish === 'length') {
            throw new AIError(`model returned no answer (reasoning used the token budget; finish_reason=${finish || 'unknown'})`);
          }
          throw new AIError('empty model response');
        }
        return text;
      }
      throw new AIError(`model call failed: ${lastErr}`, lastStatus);
    },
  };
}

/**
 * Run `attempt(model)` for each distinct model in order; return the first success.
 * Only AIError triggers the next model; AIUnavailable aborts. Re-throws the last AIError.
 */
export async function tryModels<R>(
  models: (string | null | undefined)[],
  attempt: (model: string) => Promise<R>,
): Promise<R> {
  const ordered = withSafeFallback(models);
  if (ordered.length === 0) throw new AIError('no model configured');
  let last: AIError | null = null;
  for (const model of ordered) {
    try {
      return await attempt(model);
    } catch (e) {
      if (e instanceof AIUnavailable) throw e;
      if (e instanceof AIError) {
        last = new AIError(`${model}: ${e.message}`, e.status);
        continue;
      }
      throw e;
    }
  }
  throw last as AIError;
}

/** chat() over `models` in order. Returns [text, modelThatAnswered]. */
export function chatWithFallback(
  client: AiClient,
  models: (string | null | undefined)[],
  o: Omit<ChatOptions, 'model'>,
): Promise<[string, string]> {
  return tryModels(models, async (m) => [await client.chat({ ...o, model: m }), m] as [string, string]);
}
