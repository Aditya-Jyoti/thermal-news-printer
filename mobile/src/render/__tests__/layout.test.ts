import { describe, it, expect } from '@jest/globals';
import type { DigestItem } from '../../api/types';
import { LEADING, PAD, PAD_R, TEXT_W, WIDTH, layoutReceipt, wrapText, formatDate, type TextMetrics, type FontSpec } from '../layout';

// 1px per char per 2px of font size => deterministic fake metrics.
const fake: TextMetrics = {
  measure: (t: string, f: FontSpec) => t.length * f.size * 0.5,
  ascent: (f: FontSpec) => Math.ceil(f.size * 1.0),
  descent: (f: FontSpec) => Math.ceil(f.size * 0.25),
};
const item = (position: number, tldr: string, slug = 'products'): DigestItem => ({
  article_id: position + 1,
  position,
  category_slug: slug,
  tldr,
});
const date = new Date(2026, 10, 7);

describe('wrapText', () => {
  const body: FontSpec = { face: 'body', size: 20 }; // 10px per char
  it('wraps greedily within max width', () => {
    const lines = wrapText('aaaa bbbb cccc dddd', body, 90, fake.measure);
    expect(lines).toEqual(['aaaa bbbb', 'cccc dddd']);
    for (const l of lines) expect(fake.measure(l, body)).toBeLessThanOrEqual(90);
  });
  it('splits words wider than the column by character', () => {
    const lines = wrapText('x'.repeat(25), body, 100, fake.measure);
    expect(lines).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
  it('collapses whitespace and handles empty text', () => {
    expect(wrapText('  a   b ', body, 100, fake.measure)).toEqual(['a b']);
    expect(wrapText('', body, 100, fake.measure)).toEqual([]);
  });
});

describe('layoutReceipt', () => {
  it('is exactly 384 wide and grows with items', () => {
    const one = layoutReceipt([item(0, 'hello world')], { editionDate: date }, fake);
    const two = layoutReceipt([item(0, 'hello world'), item(1, 'again')], { editionDate: date }, fake);
    expect(one.width).toBe(384);
    expect(two.height).toBeGreaterThan(one.height);
  });
  it('height formula (no edition row): 100 + sum(24+n*26+6) + 14*(k-1) + 144', () => {
    const l = layoutReceipt([item(0, 'hi')], { editionDate: date }, fake);
    expect(l.height).toBe(100 + (24 + 1 * LEADING + 6) + 144);
  });
  it('empty digest has the no-stories text and no tags', () => {
    const l = layoutReceipt([], { editionDate: date }, fake);
    const texts = l.ops.filter((o) => o.t === 'text').map((o) => (o as any).text as string);
    expect(texts.some((t) => t.startsWith('No new stories'))).toBe(true);
    expect(texts.some((t) => t.startsWith('#'))).toBe(false);
    expect(texts).toContain('0 stories');
    expect(l.height).toBe(100 + 60 + 144);
  });
  it('prints plain #tag, no titles, orders by position', () => {
    const l = layoutReceipt([item(1, 'second', 'learning'), item(0, 'first', 'products')], { editionDate: date }, fake);
    const texts = l.ops.filter((o) => o.t === 'text').map((o) => (o as any).text as string);
    expect(texts.indexOf('#products')).toBeLessThan(texts.indexOf('#learning'));
    expect(texts).toContain('2 stories');
  });
  it('header copy: masthead and date only (no edition name / issue number row)', () => {
    const l = layoutReceipt([item(0, 'x')], { editionDate: date, editionName: 'Evening Edition', issueNo: 42 }, fake);
    const texts = l.ops.filter((o) => o.t === 'text').map((o) => (o as any).text as string);
    expect(texts).toContain('THE THERMAL TIMES');
    expect(texts).toContain('Saturday, November 7, 2026');
    expect(texts).not.toContain('EVENING EDITION');
    expect(texts.some((t) => t.startsWith('NO.'))).toBe(false);
    expect(texts).toContain('1 story');
  });
  it('body lines never exceed the text column under the fake metrics', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const l = layoutReceipt([item(0, long)], { editionDate: date }, fake);
    for (const o of l.ops) {
      if (o.t === 'text' && o.font.face === 'body') {
        expect(o.x).toBe(PAD);
        expect(fake.measure(o.text, o.font)).toBeLessThanOrEqual(TEXT_W);
      }
      if (o.t === 'rect') expect(o.x1).toBeLessThanOrEqual(WIDTH - PAD_R);
    }
  });
  it('masthead auto-fits to the column', () => {
    const l = layoutReceipt([], { editionDate: date }, fake);
    const mast = l.ops.find((o) => o.t === 'text' && o.font.face === 'mast') as any;
    expect(fake.measure(mast.text, mast.font)).toBeLessThanOrEqual(WIDTH - PAD - PAD_R);
    expect(mast.font.size).toBeLessThanOrEqual(44);
  });
  it('formats dates', () => {
    expect(formatDate(new Date(2026, 0, 1))).toBe('Thursday, January 1, 2026');
  });
});
