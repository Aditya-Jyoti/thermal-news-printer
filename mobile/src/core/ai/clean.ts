/** Conservative input cleanup: drop newsletter/podcast boilerplate lines and build a bounded prompt body. */
export const MAX_INPUT_CHARS = 12000;

const URL_ONLY = /^\(?<?(?:https?:\/\/|www\.)\S+>?\)?[.,]?$/i;
// Bare one-to-four word labels ("Subscribe", "Share", "Read more").
const BARE =
  /^(?:subscribe|share|sponsored|sponsor|advertisement|read more|continue reading|leave a comment|sign up|click here|show notes|transcript|full transcript|listen now|watch now)\b[\w\s!.:|-]{0,20}$/i;
// Short call-to-action lines (<= 120 chars).
const SHORT_CTA =
  /^(?:listen (?:to|now|on)|watch (?:the|on|now)|subscribe (?:to|now|here|on|for)|share (?:this|on|via|with)|leave a comment|like and subscribe|follow us|sign up (?:for|to|now)|click here|get the newsletter|support (?:us|the show)|(?:the )?full (?:episode|transcript))\b/i;
// Lines of any (reasonable) length that are boilerplate by their opening.
const ALWAYS =
  /^(?:this (?:post|article|story|piece|episode) (?:was )?(?:originally )?(?:published|appeared)|the post .{0,200}appeared first on|originally published (?:on|at|in)|sponsored by\b|this (?:episode|issue|post) is (?:sponsored|brought to you) by|(?:subscribe|share) (?:this|to|now|the)\b.{0,80}$|if you(?:'d| would)? (?:like|enjoy).{0,60}(?:subscribe|newsletter)|you(?:'re| are) (?:receiving|getting) this (?:email|newsletter)|unsubscribe\b|view (?:this )?(?:email )?in (?:your )?browser)/i;
const GREETING = /^(?:hi|hello|hey|welcome)\b[^.\n]{0,60}?\bthis is\b/i;
const GREETING_HINT = /newsletter|podcast|episode|issue|subscribers?|bonus|edition/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function isBoilerplate(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (URL_ONLY.test(s)) return true;
  if (words(s).length <= 4 && BARE.test(s)) return true;
  if (s.length <= 120 && SHORT_CTA.test(s)) return true;
  if (ALWAYS.test(s)) return true;
  if (s.length <= 500 && GREETING.test(s) && GREETING_HINT.test(s)) return true;
  return false;
}

/** Remove obvious newsletter/podcast boilerplate lines; keep everything else untouched. */
export function stripBoilerplate(text: string): string {
  const kept = text.split(/\r?\n/).filter((ln) => !isBoilerplate(ln));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Clean and bound article text: keep the beginning, cutting at a paragraph (else sentence/word) boundary. */
export function prepareBody(text: string, limit: number = MAX_INPUT_CHARS): string {
  const paras = stripBoilerplate(text)
    .split(/\n\s*\n|\n/)
    .map((p) => p.replace(/[ \t\f\v]+/g, ' ').trim());
  const body = paras.filter(Boolean).join('\n');
  if (body.length <= limit) return body;
  const cut = body.slice(0, limit);
  const nl = cut.lastIndexOf('\n');
  if (nl >= limit * 0.5) return cut.slice(0, nl).trimEnd();
  const ends = [...cut.matchAll(/[.!?](?=\s|$)/g)];
  if (ends.length) {
    const last = ends[ends.length - 1];
    const end = (last.index ?? 0) + 1;
    if (end >= limit * 0.5) return cut.slice(0, end);
  }
  return cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')).trimEnd() : cut;
}
