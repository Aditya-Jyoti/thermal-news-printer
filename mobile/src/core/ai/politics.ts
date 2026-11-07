import { chatWithFallback, type AiClient } from './client';

export interface ArticleForAI {
  id: number;
  title: string;
  url: string;
  content_text: string | null;
  category_slug: string;
  published_at: Date | null;
}

export interface PoliticsVerdict {
  article_id: number;
  is_political: boolean;
  reason: string | null;
}

export const POLITICS_RULES =
  'Political = elections, political parties, politicians or government officials as the focus, ' +
  'legislation or regulatory fights, partisan policy debates, protests, geopolitical conflict or war commentary, ' +
  'culture-war topics. ' +
  'NOT political (allowed) = new initiatives, education, scientific breakthroughs, product launches, ' +
  'startup news, engineering deep dives, psychology and learning, and major breaking news such as disasters ' +
  'or accidents. A company or product merely mentioning a government or law in passing is not political.';

export const POLITICS_SYSTEM_PROMPT = `You are a strict content filter for a non-political daily news print.
${POLITICS_RULES}
When it is genuinely unclear, answer false.

Reply with ONLY a JSON object, no code fences:
{"political": true or false, "reason": "max 12 words"}`;

const FALSE_WORDS = new Set(['false', 'no', '0', 'n']);
const TRUE_WORDS = new Set(['true', 'yes', '1', 'y']);

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  return null;
}

/** Robustly parse a verdict; unparseable output yields political=false, reason='unparsed'. */
export function parseVerdictJson(raw: string, articleId: number): PoliticsVerdict {
  let flag: boolean | null = null;
  let reason: string | null = null;
  const span = /\{[\s\S]*\}/.exec(raw);
  const first = /\{[\s\S]*?\}/.exec(raw);
  for (const cand of [span?.[0], first?.[0]]) {
    if (!cand) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(cand);
    } catch {
      continue;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      flag = asBool(o.political ?? o.is_political);
      const r = o.reason;
      reason = r ? String(r).trim().slice(0, 200) : null;
      break;
    }
  }
  if (flag === null) {
    // loose fallback: `"political": true`, `Political: yes`, or a bare true/false
    const lm = /political\W{0,5}(true|false|yes|no)\b/i.exec(raw);
    if (lm) flag = asBool(lm[1]);
    else {
      const bm = /^\W*(true|false|yes|no)\W*$/i.exec(raw.trim());
      if (bm) flag = asBool(bm[1]);
    }
  }
  if (flag === null) return { article_id: articleId, is_political: false, reason: 'unparsed' };
  return { article_id: articleId, is_political: flag, reason };
}

export async function classifyPolitics(
  article: ArticleForAI,
  o: { client: AiClient; model: string; fallbackModel?: string | null },
): Promise<PoliticsVerdict> {
  const body = (article.content_text ?? '').trim().replace(/\s+/g, ' ').slice(0, 1500);
  const user = body ? `Headline: ${article.title}\n\nExcerpt: ${body}` : `Headline: ${article.title}`;
  const [raw] = await chatWithFallback(o.client, [o.model, o.fallbackModel], {
    system: POLITICS_SYSTEM_PROMPT,
    user,
    maxTokens: 60,
    temperature: 0.0,
  });
  return parseVerdictJson(raw, article.id);
}
