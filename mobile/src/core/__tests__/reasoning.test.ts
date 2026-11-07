import { AIError, SAFE_FALLBACK_MODEL, createAiClient, withSafeFallback } from '../ai/client';
import { summarize } from '../ai/summarize';
import { redact } from '../redact';

const noSleep = async () => undefined;
const reasoningOnly = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'thinking...' } }] }), { status: 200 });
const answer = (t: string) => new Response(JSON.stringify({ choices: [{ message: { content: t } }] }), { status: 200 });

describe('reasoning models', () => {
  it('turns thinking off and raises the max_tokens floor', async () => {
    const f = jest.fn(async (_u: string, _i?: RequestInit) => answer('hi'));
    await createAiClient({ apiKey: 'k', fetch: f, sleep: noSleep }).chat({ model: 'm', system: 's', user: 'u', maxTokens: 200 });
    const body = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(body.reasoning.enabled).toBe(false);
    expect(body.max_tokens).toBe(2048);
  });

  it('reasoning-only response raises a specific error', async () => {
    const client = createAiClient({ apiKey: 'k', fetch: async () => reasoningOnly(), sleep: noSleep });
    const err = await client.chat({ model: 'm', system: 's', user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.message).toMatch(/no answer \(reasoning used the token budget; finish_reason=length\)/);
  });

  it('a fallback equal to the primary falls back to the safe model', async () => {
    expect(withSafeFallback(['a', 'a'])).toEqual(['a', SAFE_FALLBACK_MODEL]);
    expect(withSafeFallback(['a', null])).toEqual(['a']);
    expect(withSafeFallback([SAFE_FALLBACK_MODEL, SAFE_FALLBACK_MODEL])).toEqual([SAFE_FALLBACK_MODEL]);
    const models: string[] = [];
    const f = async (_u: string, i?: RequestInit) => {
      const m = JSON.parse(i?.body as string).model as string;
      models.push(m);
      return m === 'reasoner'
        ? reasoningOnly()
        : answer('Acme launched the Zephyr chip, which runs models locally at 40 tokens per second on three watts of power and ships to phone makers in March this year.');
    };
    const client = createAiClient({ apiKey: 'k', fetch: f, sleep: noSleep });
    const r = await summarize(
      { id: 1, title: 'T', url: 'u', content_text: 'x'.repeat(100), category_slug: 'products', published_at: null },
      { client, model: 'reasoner', fallbackModel: 'reasoner' },
    );
    expect(r.model).toBe(SAFE_FALLBACK_MODEL);
    expect(models).toEqual(['reasoner', SAFE_FALLBACK_MODEL]);
  });
});

describe('redact', () => {
  it('removes key-like strings and bearer headers', () => {
    expect(redact('bad key sk-or-v1-abcdef1234567890 here')).not.toContain('abcdef');
    expect(redact('Authorization: Bearer abc.def.ghi12345')).not.toContain('ghi12345');
    expect(redact('my secret-value-123 leaked', ['secret-value-123'])).not.toContain('secret-value');
  });
});
