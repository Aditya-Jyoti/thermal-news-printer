/** TL;DR generation for the thermal receipt (printed WITHOUT the title, so it must stand alone). */
import { prepareBody } from './clean';
import { AIError, tryModels, type AiClient } from './client';
import { POLITICS_RULES, parseVerdictJson, type ArticleForAI, type PoliticsVerdict } from './politics';

export interface SummaryResult {
  article_id: number;
  tldr: string;
  model: string;
}

export const MAX_TLDR_CHARS = 250;
export const SUMMARY_MAX_TOKENS = 120;
export const COMBINED_MAX_TOKENS = 240;
export const MIN_WORDS = 12;
export const MAX_WORDS = 45;
export const SHORT_INPUT_CHARS = 400; // teaser-only input: do not demand a minimum length (never pad)

const BANNED_RE =
  /\b(?:explor(?:es|ing)|discuss(?:es|ing)|delv(?:es|ing)|sheds? light|various|a number of|highlights? the importance|in today'?s (?:world|fast-paced)|this (?:article|post|episode|piece|essay))\b/gi;

export const TLDR_RULES = `The headline is NOT printed, so the TL;DR must stand alone and name the concrete subject (company, product, person, institution or study) explicitly.
Write 1 to 2 sentences, about 25 to 40 words, hard cap 250 characters:
1. Lead with the concrete subject and what happened: who did what, what was found, or what launched.
2. Then the single most important specific: one number, name or how it works.
3. No background. No "why it matters" clause unless it fits in the word budget.
Rules:
- Never invent facts. If the text is only a short teaser, state just what it says, concretely, without padding.
- For podcasts, essays and opinion pieces, state the actual argument or finding, not that someone talks about a topic.
- Banned filler: explores, discusses, delves, sheds light, various, a number of, highlights the importance, in today's world, rhetorical questions, and "This article/post/episode".
- Neutral newspaper tone, active voice. Plain text only: no markdown, emoji, quotation marks, hashtags or bullet points. Do not mention that you are summarizing.
Good examples:
Linear, the issue-tracking startup, launched Linear Asks, which turns Slack messages into tracked issues and routes them to the right owner. It is included in all paid plans.
A Stanford study of 2,100 adults found that walking 7,000 steps a day cut early-death risk by 47 percent versus 2,000 steps, with little extra benefit beyond 10,000.`;

export const STRICT_NUDGE =
  '\n\nYour previous answer was too vague or too short. Rewrite it: 1 to 2 concrete sentences (25 to 40 words), ' +
  'name the exact subject, include one specific number or name from the text, and avoid every banned filler word.';

export const SHORTER_NUDGE =
  '\n\nYour previous answer was too long. Rewrite it shorter: 1 to 2 sentences, 25 to 40 words, under 250 characters. ' +
  'Subject and what happened first, then the single most important specific. Drop all background.';

/** The retry nudge matching the problems found. */
export const nudgeFor = (issues: string[]): string => (issues.length === 1 && issues[0] === 'too long' ? SHORTER_NUDGE : STRICT_NUDGE);

export const SUMMARY_SYSTEM_PROMPT = `You write the digest paragraph for a tiny newspaper printed on a narrow receipt strip.

${TLDR_RULES}

Reply with the TL;DR text only.`;

export const COMBINED_SYSTEM_PROMPT = `You prepare items for a tiny newspaper printed on a narrow receipt strip. Do two things for the article below.

1. Write a TL;DR. ${TLDR_RULES}

2. Decide whether the article is political. ${POLITICS_RULES} When genuinely unclear, answer false.

Reply with ONLY a JSON object, no code fences:
{"political": true or false, "reason": "max 12 words", "tldr": "the TL;DR text"}`;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Reasons a TL;DR is not good enough to print (empty list = fine). */
export function qualityIssues(tldr: string, inputChars = 1e6): string[] {
  const issues: string[] = [];
  if (wordCount(tldr) < MIN_WORDS && inputChars >= SHORT_INPUT_CHARS) issues.push('too short');
  if (wordCount(tldr) > MAX_WORDS) issues.push('too long');
  const found = [...new Set([...tldr.matchAll(BANNED_RE)].map((m) => m[0].toLowerCase()))].sort();
  if (found.length) issues.push('filler: ' + found.join(', '));
  if (tldr.includes('?')) issues.push('question');
  return issues;
}

/** Lower is better: fewer quality issues first, then more words. */
function score(tldr: string, inChars: number): [number, number] {
  return [qualityIssues(tldr, inChars).length, -wordCount(tldr)];
}
const better = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

function articleBlock(article: ArticleForAI): string {
  const body = prepareBody(article.content_text ?? '');
  if (!body) {
    return (
      `Headline: ${article.title}\n\n(No article text is available; write the TL;DR from the ` +
      'headline alone, without inventing details.)'
    );
  }
  return `Headline: ${article.title}\n\nArticle text:\n${body}`;
}

const PREFIX_RE =
  /^\s*(?:here(?:'s| is) (?:a |the )?(?:tl;?dr|summary)[^:\n]*:|tl;?\s?dr\s*[:\-–—]?|summary\s*:|digest\s*:)\s*/i;
const WRAPPERS = new Set([...'"\'“”‘’`«»']);

function stripWrappers(t: string): string {
  let s = 0;
  let e = t.length;
  while (s < e && WRAPPERS.has(t[s])) s++;
  while (e > s && WRAPPERS.has(t[e - 1])) e--;
  return t.slice(s, e);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const ends = [...cut.matchAll(/[.!?](?=\s|$)/g)];
  if (ends.length) {
    const end = (ends[ends.length - 1].index ?? 0) + 1;
    if (end >= limit * 0.4) return cut.slice(0, end).trim();
  }
  let c = text.slice(0, limit - 1);
  if (c.includes(' ')) c = c.slice(0, c.lastIndexOf(' '));
  return c.replace(/[ ,;:\-–—]+$/, '') + '…';
}

/** Normalize model output into printable plain text of at most `maxChars`. */
export function cleanTldr(raw: string, maxChars: number = MAX_TLDR_CHARS): string {
  let t = raw.trim();
  t = t.replace(/```/g, '');
  t = t.replace(PREFIX_RE, '');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // markdown links/images -> their text
  t = t.replace(/^\s{0,3}(?:#{1,6}\s+|[-*•>]\s+|\d+[.)]\s+)/gm, '');
  t = t.replace(/\*\*|__|~~|`/g, '');
  t = t.replace(/(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g, ''); // lone emphasis asterisks
  t = t.replace(/[\u{1F000}-\u{1FAFF}☀-➿️‍]/gu, ''); // emoji
  t = t.replace(/\s+/g, ' ').trim();
  t = stripWrappers(t).trim();
  t = t.replace(PREFIX_RE, '');
  return truncate(t, maxChars);
}

interface ModelOpts {
  client: AiClient;
  model: string;
  fallbackModel?: string | null;
}

/** TL;DR via `model`; on AIError retry once with `fallbackModel`. result.model = model used. */
export async function summarize(article: ArticleForAI, o: ModelOpts): Promise<SummaryResult> {
  const user = articleBlock(article);
  const inChars = (article.content_text ?? '').length;
  const ask = async (m: string, u: string) =>
    cleanTldr(await o.client.chat({ model: m, system: SUMMARY_SYSTEM_PROMPT, user: u, maxTokens: SUMMARY_MAX_TOKENS }));

  return tryModels([o.model, o.fallbackModel], async (m) => {
    let tldr = await ask(m, user);
    if (!tldr) throw new AIError('model returned no usable TL;DR');
    const issues = qualityIssues(tldr, inChars);
    if (issues.length) {
      try {
        // one stricter retry on the same model
        const retry = await ask(m, user + nudgeFor(issues));
        if (retry && better(score(retry, inChars), score(tldr, inChars))) tldr = retry;
      } catch (e) {
        if (!(e instanceof AIError)) throw e; // keep the first answer
      }
    }
    return { article_id: article.id, tldr, model: m };
  });
}

function extractJson(raw: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const obj: unknown = JSON.parse(m[0]);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One call returning both the TL;DR and the politics verdict (cheaper than two calls). */
export async function summarizeAndClassify(
  article: ArticleForAI,
  o: ModelOpts,
): Promise<[SummaryResult, PoliticsVerdict]> {
  const user = articleBlock(article);
  const inChars = (article.content_text ?? '').length;

  const once = async (m: string, u: string): Promise<[string, string]> => {
    const raw = await o.client.chat({ model: m, system: COMBINED_SYSTEM_PROMPT, user: u, maxTokens: COMBINED_MAX_TOKENS });
    const data = extractJson(raw);
    return [data ? cleanTldr(String(data.tldr ?? '')) : '', raw];
  };

  return tryModels([o.model, o.fallbackModel], async (m) => {
    let [tldr, raw] = await once(m, user);
    if (!tldr) throw new AIError('combined response had no usable tldr');
    const issues = qualityIssues(tldr, inChars);
    if (issues.length) {
      try {
        const [tldr2, raw2] = await once(m, user + nudgeFor(issues));
        if (tldr2 && better(score(tldr2, inChars), score(tldr, inChars))) [tldr, raw] = [tldr2, raw2];
      } catch (e) {
        if (!(e instanceof AIError)) throw e; // keep the first answer
      }
    }
    return [{ article_id: article.id, tldr, model: m }, parseVerdictJson(raw, article.id)] as [SummaryResult, PoliticsVerdict];
  });
}
