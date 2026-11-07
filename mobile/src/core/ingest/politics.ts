/** Conservative keyword prefilter for political content; only flags clear matches. */
export const POLITICAL_KEYWORDS: readonly string[] = [
  'election', 'elections', 'senate', 'senator', 'congress', 'congressional',
  'parliament', 'parliamentary', 'trump', 'biden', 'obama',
  'democrat', 'democrats', 'democratic party', 'republican', 'republicans', 'gop',
  'campaign trail', 'presidential', 'partisan', 'legislation', 'geopolitics',
  'geopolitical', 'white house', 'prime minister', 'lawmakers', 'impeachment',
  'ballot', 'midterms', 'political party', 'politician', 'politicians',
  'kremlin', 'brexit',
];

const PATTERN = new RegExp(
  '\\b(?:' + POLITICAL_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i',
);

/** True if the title or the start of the body contains a political keyword. */
export function isClearlyPolitical(title: string, text?: string | null): boolean {
  return PATTERN.test(`${title}\n${(text ?? '').slice(0, 1500)}`);
}
