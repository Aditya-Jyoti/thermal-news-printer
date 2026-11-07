import { MAX_INPUT_CHARS, prepareBody, stripBoilerplate } from '../ai/clean';
import { AIError, AIUnavailable, chatWithFallback, createAiClient, tryModels, type AiClient, type ChatOptions } from '../ai/client';
import { classifyPolitics, parseVerdictJson, type ArticleForAI } from '../ai/politics';
import {
  cleanTldr,
  COMBINED_SYSTEM_PROMPT,
  MAX_TLDR_CHARS,
  qualityIssues,
  STRICT_NUDGE,
  summarize,
  summarizeAndClassify,
  SUMMARY_SYSTEM_PROMPT,
} from '../ai/summarize';

const GOOD =
  'Acme Corp launched the Zephyr 2 chip, which runs language models on-device at 40 tokens per second ' +
  'while drawing 3 watts. It ships to phone makers in March and doubles the speed of the earlier Zephyr ' +
  'design, which could bring offline assistants to mid-range handsets.';
const LONG_BODY = 'Acme details. '.repeat(100);

const art = (o: Partial<ArticleForAI> = {}): ArticleForAI => ({
  id: 1,
  title: 'Acme launches Zephyr 2',
  url: 'https://x.test/1',
  content_text: LONG_BODY,
  category_slug: 'products',
  published_at: null,
  ...o,
});

type Reply = string | Error | ((o: ChatOptions) => string);
function fakeClient(replies: Record<string, Reply[]> | Reply[]): AiClient & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  const queues: Record<string, Reply[]> = Array.isArray(replies) ? { '*': [...replies] } : Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    async chat(o) {
      calls.push(o);
      const q = queues[o.model] ?? queues['*'];
      const r = q?.shift();
      if (r === undefined) throw new AIError('no more replies');
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(o) : r;
    },
  };
}

describe('boilerplate + body budget', () => {
  it('removes known boilerplate but stays conservative', () => {
    const text = [
      'Hi, this is Gergely with a bonus, free issue of the Pragmatic Engineer Newsletter.',
      'Subscribe',
      'Share',
      'Listen to the episode on Spotify',
      'Sponsored by Acme',
      'This post was originally published on example.com',
      'https://example.com/only-a-url',
      'Read more',
      'The real content starts here and it matters.',
      'Share prices of Acme rose 5 percent after the launch announcement today.',
    ].join('\n');
    expect(stripBoilerplate(text).split('\n')).toEqual([
      'The real content starts here and it matters.',
      'Share prices of Acme rose 5 percent after the launch announcement today.',
    ]);
    const keep = 'Hi there, this is a story about a dog who learned to surf in Hawaii last summer.';
    expect(stripBoilerplate(keep)).toBe(keep);
  });

  it('bounds the body at a paragraph boundary', () => {
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(100)).join('\n\n');
    const out = prepareBody(paras);
    expect(out.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(out.startsWith('Paragraph 0.')).toBe(true);
    expect(out.trimEnd().endsWith('word')).toBe(true);
    expect(prepareBody('Short text.')).toBe('Short text.');
  });
});

describe('cleanTldr', () => {
  const cases: [string, string][] = [
    ['TL;DR: Apple ships the X.', 'Apple ships the X.'],
    ['TLDR - Apple ships the X.', 'Apple ships the X.'],
    ["Here's a TL;DR: Foo happens.", 'Foo happens.'],
    ['Here is the summary: Foo happens.', 'Foo happens.'],
    ['Summary: Foo happens.', 'Foo happens.'],
    ['**Bold** claim and *italic* word.', 'Bold claim and italic word.'],
    ['__under__ and ~~strike~~ and `code`.', 'under and strike and code.'],
    ['See [the paper](https://x.example/p) now.', 'See the paper now.'],
    ['![alt text](https://x.example/i.png) Caption.', 'alt text Caption.'],
    ['- first point', 'first point'],
    ['1. numbered point', 'numbered point'],
    ['# Heading\nBody text.', 'Heading Body text.'],
    ['"Quoted whole sentence."', 'Quoted whole sentence.'],
    ['“Curly quoted.”', 'Curly quoted.'],
    ['Launch today\u{1F680} ✨ now.', 'Launch today now.'],
    ['Line one.\n\nLine   two.', 'Line one. Line two.'],
    ['```\nFenced text.\n```', 'Fenced text.'],
    ['Price 5 * 3 is 15.', 'Price 5 * 3 is 15.'],
  ];
  it.each(cases)('normalizes %j', (raw, expected) => {
    expect(cleanTldr(raw)).toBe(expected);
  });

  it('handles empty and prefix-only', () => {
    expect(cleanTldr('')).toBe('');
    expect(cleanTldr('   ')).toBe('');
    expect(cleanTldr('TL;DR:')).toBe('');
  });

  it('caps at 450 with sentence/word/hard cuts', () => {
    expect(MAX_TLDR_CHARS).toBe(450);
    expect(cleanTldr('He said "yes" today.')).toBe('He said "yes" today.');
    expect(cleanTldr('word '.repeat(200)).length).toBeLessThanOrEqual(450);
    expect(cleanTldr('A'.repeat(250) + '. ' + 'b '.repeat(200))).toBe('A'.repeat(250) + '.');
    const w = cleanTldr('word '.repeat(100));
    expect(w.endsWith('…')).toBe(true);
    expect(w.slice(0, -1).split(' ').every((t) => t === 'word')).toBe(true);
    const hard = cleanTldr('x'.repeat(1000));
    expect(hard).toHaveLength(450);
    expect(hard.endsWith('…')).toBe(true);
    expect(cleanTldr(GOOD)).toBe(GOOD);
    expect(cleanTldr('a'.repeat(50) + ' ' + 'b'.repeat(50), 40).length).toBeLessThanOrEqual(40);
  });
});

describe('prompts + quality', () => {
  it('prompts carry the descriptiveness rules verbatim', () => {
    for (const p of [SUMMARY_SYSTEM_PROMPT, COMBINED_SYSTEM_PROMPT]) {
      const low = p.toLowerCase();
      expect(low).toContain('name the concrete subject');
      expect(low).toContain('45 to 70 words');
      expect(low).toContain('never invent facts');
      expect(low).toContain('good examples');
    }
    expect(COMBINED_SYSTEM_PROMPT).toContain('"tldr"');
    expect(SUMMARY_SYSTEM_PROMPT.startsWith('You write the digest paragraph for a tiny newspaper printed on a narrow receipt strip.')).toBe(true);
  });

  it('flags quality issues', () => {
    expect(qualityIssues(GOOD)).toEqual([]);
    expect(qualityIssues('Acme ships a chip.')).toContain('too short');
    expect(qualityIssues('Acme ships a chip.', 100)).toEqual([]);
    expect(qualityIssues(GOOD + ' The post explores various ideas.').some((i) => i.startsWith('filler'))).toBe(true);
    expect(qualityIssues(GOOD + ' Why?')).toContain('question');
  });
});

describe('verdict parsing', () => {
  const cases: [string, boolean, string | null][] = [
    ['{"political": true, "reason": "election coverage"}', true, 'election coverage'],
    ['```json\n{"political": false, "reason": "product launch"}\n```', false, 'product launch'],
    ['{"is_political": true}', true, null],
    ['{"political": "false"}', false, null],
    ['{"political": "yes"}', true, null],
    ['{"political": 0}', false, null],
    ['Political: yes', true, null],
    ['"political": true, but truncated', true, null],
    ['false', false, null],
    ['Yes.', true, null],
  ];
  it.each(cases)('parses %j', (raw, flag, reason) => {
    expect(parseVerdictJson(raw, 7)).toEqual({ article_id: 7, is_political: flag, reason });
  });

  it('defaults to not political when unparseable; truncates reason', () => {
    for (const raw of ['', 'I cannot tell', '{broken']) {
      expect(parseVerdictJson(raw, 1)).toMatchObject({ is_political: false, reason: 'unparsed' });
    }
    expect(parseVerdictJson(JSON.stringify({ political: true, reason: 'x'.repeat(500) }), 1).reason).toHaveLength(200);
  });

  it('classifyPolitics uses the fallback', async () => {
    const c = fakeClient({ a: [new AIError('x')], b: ['{"political": true, "reason": "senate"}'] });
    const v = await classifyPolitics(art(), { client: c, model: 'a', fallbackModel: 'b' });
    expect(v.is_political).toBe(true);
    expect(c.calls[1].maxTokens).toBe(60);
    expect(c.calls[1].temperature).toBe(0);
  });
});

describe('summarize', () => {
  it('records the primary model and cleans output', async () => {
    const c = fakeClient([`TL;DR: ${GOOD}`]);
    const r = await summarize(art(), { client: c, model: 'p', fallbackModel: 'f' });
    expect(r).toEqual({ article_id: 1, tldr: GOOD, model: 'p' });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].user).toContain('Headline: Acme launches Zephyr 2');
  });

  it('retries once with a stricter nudge and keeps the better answer', async () => {
    const c = fakeClient(['Acme ships a chip.', GOOD]);
    const r = await summarize(art(), { client: c, model: 'p' });
    expect(r.tldr).toBe(GOOD);
    expect(c.calls[1].user.endsWith(STRICT_NUDGE)).toBe(true);
    // a worse retry is discarded
    const c2 = fakeClient([GOOD.replace('launched', 'explores') , 'Short.']);
    expect((await summarize(art(), { client: c2, model: 'p' })).tldr).toContain('explores');
    // a failing retry keeps the first answer
    const c3 = fakeClient(['Acme ships a chip.', new AIError('x')]);
    expect((await summarize(art(), { client: c3, model: 'p' })).tldr).toBe('Acme ships a chip.');
  });

  it('falls back when the primary errors or returns nothing usable', async () => {
    const c = fakeClient({ p: [new AIError('boom')], f: [GOOD] });
    expect(await summarize(art(), { client: c, model: 'p', fallbackModel: 'f' })).toMatchObject({ model: 'f' });
    const c2 = fakeClient({ p: ['   '], f: [GOOD] });
    expect((await summarize(art(), { client: c2, model: 'p', fallbackModel: 'f' })).model).toBe('f');
    const c3 = fakeClient({ p: [new AIError('boom')] });
    await expect(summarize(art(), { client: c3, model: 'p' })).rejects.toBeInstanceOf(AIError);
  });

  it('still calls the model with the headline when there is no content', async () => {
    const c = fakeClient([GOOD]);
    await summarize(art({ content_text: null }), { client: c, model: 'p' });
    expect(c.calls[0].user).toContain('No article text is available');
  });
});

describe('summarizeAndClassify', () => {
  const combined = (tldr: string, political = false) => JSON.stringify({ political, reason: 'r', tldr });

  it('parses the combined JSON', async () => {
    const c = fakeClient([combined(GOOD)]);
    const [s, v] = await summarizeAndClassify(art(), { client: c, model: 'p' });
    expect(s.tldr).toBe(GOOD);
    expect(v).toEqual({ article_id: 1, is_political: false, reason: 'r' });
    expect(c.calls[0].system).toBe(COMBINED_SYSTEM_PROMPT);
  });

  it('falls back on bad JSON and records the model; missing tldr fails without fallback', async () => {
    const c = fakeClient({ p: ['not json'], f: [combined(GOOD, true)] });
    const [s, v] = await summarizeAndClassify(art(), { client: c, model: 'p', fallbackModel: 'f' });
    expect(s.model).toBe('f');
    expect(v.is_political).toBe(true);
    const c2 = fakeClient([JSON.stringify({ political: false })]);
    await expect(summarizeAndClassify(art(), { client: c2, model: 'p' })).rejects.toBeInstanceOf(AIError);
  });
});

describe('tryModels', () => {
  it('dedupes, skips blanks, raises when none, does not fall back on AIUnavailable', async () => {
    const seen: string[] = [];
    await expect(
      tryModels(['a', 'a', '', null, 'b'], async (m) => {
        seen.push(m);
        throw new AIError('x');
      }),
    ).rejects.toBeInstanceOf(AIError);
    expect(seen).toEqual(['a', 'b']);
    await expect(tryModels([null, ''], async () => 1)).rejects.toThrow('no model configured');
    const seen2: string[] = [];
    await expect(
      tryModels(['a', 'b'], async (m) => {
        seen2.push(m);
        throw new AIUnavailable();
      }),
    ).rejects.toBeInstanceOf(AIUnavailable);
    expect(seen2).toEqual(['a']);
    const c = fakeClient({ a: [new AIError('x')], b: ['ok'] });
    expect(await chatWithFallback(c, ['a', 'b'], { system: 's', user: 'u' })).toEqual(['ok', 'b']);
  });
});

describe('createAiClient (HTTP)', () => {
  const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const noSleep = jest.fn(async () => undefined);

  it('sends a single user message with OpenRouter headers', async () => {
    const f = jest.fn(async (_u: string, _i?: RequestInit) => ok('hello'));
    const client = createAiClient({ apiKey: 'sk-secret', fetch: f, sleep: noSleep });
    expect(await client.chat({ model: 'm', system: 'SYS', user: 'USR', maxTokens: 10, temperature: 0 })).toBe('hello');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret');
    expect(headers['HTTP-Referer']).toBe('termal-news-printer');
    expect(headers['X-Title']).toBe('termal-news-printer');
    const body = JSON.parse(init?.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'SYS\n\n---\n\nUSR' }]);
    expect(body).toMatchObject({ model: 'm', max_tokens: 10, temperature: 0 });
  });

  it('retries 429/5xx and network errors with backoff, then succeeds', async () => {
    const seq: (Response | Error)[] = [new Response('', { status: 429 }), new Error('net'), new Response('', { status: 503 }), ok('fine')];
    const f = jest.fn(async () => {
      const r = seq.shift()!;
      if (r instanceof Error) throw r;
      return r;
    });
    const sleep = jest.fn(async () => undefined);
    const client = createAiClient({ apiKey: 'k', fetch: f, sleep });
    expect(await client.chat({ model: 'm', system: 's', user: 'u' })).toBe('fine');
    expect(f).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
  });

  it('gives up after retries; 4xx fails fast; empty/odd responses raise AIError; key never leaks', async () => {
    const f = jest.fn(async () => new Response('', { status: 500 }));
    const client = createAiClient({ apiKey: 'sk-secret', fetch: f, sleep: noSleep });
    const err = await client.chat({ model: 'm', system: 's', user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(f).toHaveBeenCalledTimes(4);
    expect(String(err.message)).not.toContain('sk-secret');

    const f401 = jest.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    await expect(createAiClient({ apiKey: 'k', fetch: f401, sleep: noSleep }).chat({ model: 'm', system: 's', user: 'u' })).rejects.toThrow(/401: bad key/);
    expect(f401).toHaveBeenCalledTimes(1);

    for (const content of [null, '   ', '']) {
      const fe = async () => ok(content);
      await expect(createAiClient({ apiKey: 'k', fetch: fe, sleep: noSleep }).chat({ model: 'm', system: 's', user: 'u' })).rejects.toBeInstanceOf(AIError);
    }
    const fa = async () => ok([{ type: 'text', text: 'parts' }]);
    expect(await createAiClient({ apiKey: 'k', fetch: fa, sleep: noSleep }).chat({ model: 'm', system: 's', user: 'u' })).toBe('parts');
  });
});
