import type { DigestItem } from '../api/types';

export { renderReceipt } from './receipt';
export { loadReceiptFonts, setFontLoader } from './fonts';
export type { ReceiptFonts } from './fonts';

const SAMPLE: [string, string][] = [
  ['products',
    'Linear has launched a built-in AI triage assistant that reads incoming bug reports, ' +
    'tags them by severity and routes them to the right team, which early testers say ' +
    'cuts the weekly sorting grind from hours to minutes.'],
  ['engineering',
    'A deep dive into how one large payments team moved from a tangled monolith to small ' +
    'services without a rewrite, using feature flags, strangler patterns and a strict rule ' +
    'that every migration step must be reversible within a day.'],
  ['psychology',
    'New research suggests that people who write down their worries for ten minutes before ' +
    'a stressful task perform better, because putting anxious thoughts on paper frees up ' +
    'working memory for the problem at hand.'],
  ['learning',
    'Spaced repetition beats cramming by a wide margin, researchers found: students who ' +
    'reviewed material at growing intervals remembered about twice as much a month later ' +
    'while studying for less total time.'],
  ['products',
    'A small startup has unveiled a pocket-sized solar charger that fully powers a phone ' +
    'in about two hours of sunlight, folds flat like a wallet and ships with a repairable, ' +
    'replaceable battery pack.'],
  ['engineering',
    'SQLite is quietly becoming a serious production database: teams are pairing it with ' +
    'streaming replication to run fast, cheap, single-node services, trading some ' +
    'scalability for dramatic simplicity in operations.'],
];

/** Port of backend/tnp/print/samples.py for previews and tests. */
export function sampleItems(): DigestItem[] {
  return SAMPLE.map(([category_slug, tldr], i) => ({ article_id: i + 1, position: i, category_slug, tldr }));
}
