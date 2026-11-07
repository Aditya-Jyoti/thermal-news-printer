/** One-call edition curation: rank recent candidates by interest and flag political ones. */
import { chatWithFallback, type AiClient } from './client';

export interface CurateCandidate {
  id: number;
  category_slug: string;
  title: string;
  content_text: string | null;
}

export const SNIPPET_CHARS = 160;
export const CURATE_MAX_TOKENS = 500;

export const CURATE_SYSTEM_PROMPT = `You are the editor of a tiny daily newspaper printed on a narrow receipt strip, for a curious reader.
Below is a list of candidate stories, one per line: id | #category | title | opening text.

1. Pick the most interesting, substantive, NON-political stories: new product launches, research and scientific findings, engineering deep dives, education and learning ideas, big non-political breaking news.
2. Skip listicles, promotions and ads, podcast-episode filler, link roundups, vague teasers, and near-duplicates of a story you already picked (keep the better one).
3. Order the picks from most to least interesting. Pick at most MAX_PICKS.
4. Separately list the ids of POLITICAL stories: elections, parties, politicians or officials as the focus, legislation or regulatory fights, partisan debates, protests, war or geopolitical commentary, culture-war topics. A company merely mentioning a law in passing is not political. Political stories must never be picked.

Reply with ONLY a JSON object, no code fences and no commentary:
{"picks": [ids in order of interest], "political": [ids]}`;

const clip = (s: string | null, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const oneLine = (s: string) => s.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Compact candidate lines: `id | #category | title | first ~160 chars of content`. */
export function candidateLines(cands: CurateCandidate[]): string {
  return cands
    .map((c) => `${c.id} | #${c.category_slug} | ${oneLine(c.title)} | ${oneLine(clip(c.content_text, SNIPPET_CHARS))}`)
    .join('\n');
}

export function buildCurateUser(cands: CurateCandidate[], maxPicks: number): string {
  return `MAX_PICKS = ${maxPicks}\n\nCandidates:\n${candidateLines(cands)}`;
}

export interface CurateVerdict {
  picks: number[];
  political: number[];
}

function idList(v: unknown, valid: ReadonlySet<number>): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? Number(x) : NaN;
    if (Number.isInteger(n) && valid.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Robust parse (code fences, surrounding prose, string ids). Returns null when no usable JSON object is found. */
export function parseCurateJson(raw: string, validIds: Iterable<number>): CurateVerdict | null {
  const valid = new Set(validIds);
  const text = raw.replace(/```(?:json)?/gi, '');
  const spans: string[] = [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) spans.push(text.slice(first, last + 1));
  const lazy = /\{[\s\S]*?\}/.exec(text);
  if (lazy) spans.push(lazy[0]);
  for (const span of spans) {
    try {
      const obj: unknown = JSON.parse(span);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const o = obj as Record<string, unknown>;
        if (!('picks' in o) && !('political' in o)) continue;
        const political = idList(o.political, valid);
        const picks = idList(o.picks, valid).filter((id) => !political.includes(id));
        return { picks, political };
      }
    } catch {
      // try the next span
    }
  }
  return null;
}

/** Ask the model; returns the parsed verdict or null when the reply is unusable. Throws AIError / AIUnavailable. */
export async function curateWithAi(
  cands: CurateCandidate[],
  o: { client: AiClient; model: string; fallbackModel?: string | null; maxPicks: number },
): Promise<CurateVerdict | null> {
  const ids = cands.map((c) => c.id);
  const [raw] = await chatWithFallback(o.client, [o.model, o.fallbackModel], {
    system: CURATE_SYSTEM_PROMPT,
    user: buildCurateUser(cands, o.maxPicks),
    maxTokens: CURATE_MAX_TOKENS,
    temperature: 0.2,
  });
  return parseCurateJson(raw, ids);
}
