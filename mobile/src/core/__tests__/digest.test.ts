import { selectDigest, type DigestCandidate } from '../digest/select';
import { isNearDuplicate, jaccard, normalizeTitle, titleTokens } from '../digest/similarity';

const BASE = Date.UTC(2026, 0, 1);

function cand(i: number, cat: string, o: { title?: string; age?: number } = {}): DigestCandidate {
  return {
    article_id: i,
    title: o.title ?? `Unique story number ${i} about ${cat}${i * 7}`,
    category_slug: cat,
    tldr: `tldr ${i}`,
    published_at: new Date(BASE - (o.age ?? 0) * 3_600_000),
  };
}

function run(cands: DigestCandidate[], kw: Partial<Parameters<typeof selectDigest>[1]> = {}) {
  return selectDigest(cands, { limits: { a: 2, b: 2 }, maxTotal: 10, printedIds: new Set(), lastPrintTitles: [], ...kw });
}
const ids = (r: { article_id: number }[]) => r.map((i) => i.article_id);

describe('similarity', () => {
  it('normalizes and computes jaccard', () => {
    expect(normalizeTitle('  Héllo, World!! ')).toBe('hello world');
    expect(jaccard(titleTokens('a b c d'), titleTokens('a b c d'))).toBe(1);
    expect(jaccard(titleTokens('a b'), titleTokens('c d'))).toBe(0);
    expect(isNearDuplicate('Apple launches new phone', 'Apple Launches New Phone!')).toBe(true);
  });
});

describe('selectDigest', () => {
  it('applies category limits and the default of 2', () => {
    const cands = [1, 2, 3, 4, 5].map((i) => cand(i, 'a', { age: i })).concat([10, 11, 12, 13, 14].map((i) => cand(i, 'z', { age: i })));
    const out = run(cands, { limits: { a: 3 } });
    expect(out.filter((i) => i.category_slug === 'a')).toHaveLength(3);
    expect(out.filter((i) => i.category_slug === 'z')).toHaveLength(2);
  });

  it('skips limit-0 categories', () => {
    expect(ids(run([cand(1, 'a'), cand(2, 'b')], { limits: { a: 0, b: 2 } }))).toEqual([2]);
  });

  it('honours max_total and assigns positions', () => {
    const cands = [1, 2, 3, 4].map((i) => cand(i, 'a', { age: i })).concat([11, 12, 13, 14].map((i) => cand(i, 'b', { age: i })));
    const out = run(cands, { limits: { a: 4, b: 4 }, maxTotal: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((i) => i.position)).toEqual([1, 2, 3]);
  });

  it('excludes printed ids', () => {
    expect(ids(run([cand(1, 'a'), cand(2, 'a')], { printedIds: new Set([1]) }))).toEqual([2]);
  });

  it('drops near-duplicates of the last print', () => {
    const c = [cand(1, 'a', { title: 'OpenAI releases brand new model today' }), cand(2, 'a', { title: 'Totally different thing here' })];
    expect(ids(run(c, { lastPrintTitles: ['OpenAI releases brand new model today!'] }))).toEqual([2]);
  });

  it('drops near-duplicates within the batch across categories', () => {
    const c = [
      cand(1, 'a', { title: 'Startup raises big seed round for robots', age: 1 }),
      cand(2, 'b', { title: 'Startup raises big seed round for robots', age: 0 }),
    ];
    expect(ids(run(c))).toEqual([1]);
  });

  it('uses the next in category when one is a duplicate', () => {
    const c = [
      cand(1, 'a', { title: 'Same headline words here ok', age: 0 }),
      cand(2, 'a', { title: 'Same headline words here ok', age: 1 }),
      cand(3, 'a', { title: 'Another distinct headline entirely', age: 2 }),
    ];
    expect(ids(run(c, { limits: { a: 2 } }))).toEqual([1, 3]);
  });

  it('round-robins across categories in limits order, then others alphabetically', () => {
    const c = [cand(1, 'a', { age: 0 }), cand(2, 'a', { age: 1 }), cand(3, 'b', { age: 2 }), cand(4, 'b', { age: 3 }), cand(5, 'c', { age: 4 })];
    expect(ids(run(c, { limits: { b: 2, a: 2 } }))).toEqual([3, 1, 5, 4, 2]);
  });

  it('orders newest first with undated last', () => {
    const undated: DigestCandidate = { article_id: 9, title: 'undated distinct piece', category_slug: 'a', tldr: 'x', published_at: null };
    expect(ids(run([undated, cand(1, 'a', { age: 5 }), cand(2, 'a', { age: 1 })], { limits: { a: 3 } }))).toEqual([2, 1, 9]);
  });

  it('is deterministic regardless of input order', () => {
    const c = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => cand(i, i % 2 ? 'a' : 'b', { age: i }));
    expect(run(c)).toEqual(run([...c].reverse()));
    expect(run(c)).toEqual(run(c));
  });

  it('handles empty input', () => {
    expect(run([])).toEqual([]);
  });
});
