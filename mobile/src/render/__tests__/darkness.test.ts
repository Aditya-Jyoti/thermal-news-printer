/** @jest-environment @shopify/react-native-skia/jestEnv.js */
import { installNodeFonts } from '../testing';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { renderReceiptAt, sampleItems } from '../index';
import { PAD, PAD_R, WIDTH } from '../layout';

const opts = { editionDate: new Date(2026, 10, 7) };
const black = (p: Uint8Array) => p.reduce((a, v) => a + v, 0);

beforeAll(() => installNodeFonts());

describe('render ink weight per darkness level', () => {
  it('heavier levels print more black pixels for the same input', async () => {
    const [normal, dark, darkest] = await Promise.all(
      (['normal', 'dark', 'darkest'] as const).map((l) => renderReceiptAt(sampleItems(), opts, l)),
    );
    const n = black(normal.bitmap.pixels);
    const d = black(dark.bitmap.pixels);
    const k = black(darkest.bitmap.pixels);
    expect(d).toBeGreaterThan(n * 1.05);
    expect(k).toBeGreaterThan(d);
  });

  it('dark keeps the layout height of normal; width is 384 and bitmap 1-bit at every level', async () => {
    const normal = await renderReceiptAt(sampleItems(), opts, 'normal');
    for (const l of ['light', 'normal', 'dark', 'darkest'] as const) {
      const r = await renderReceiptAt(sampleItems(), opts, l);
      expect(r.bitmap.width).toBe(384);
      expect(r.bitmap.pixels.length).toBe(384 * r.bitmap.height);
      expect(r.bitmap.pixels.every((v) => v === 0 || v === 1)).toBe(true);
      if (l !== 'darkest') expect(r.bitmap.height).toBe(normal.bitmap.height);
    }
  });

  it('is deterministic per level', async () => {
    for (const l of ['light', 'dark', 'darkest'] as const) {
      const a = await renderReceiptAt(sampleItems(), opts, l);
      const b = await renderReceiptAt(sampleItems(), opts, l);
      expect(Buffer.from(a.bitmap.pixels).equals(Buffer.from(b.bitmap.pixels))).toBe(true);
    }
  });

  it('wrapping stays inside the margins with the bold fonts', async () => {
    const items = [
      {
        article_id: 1,
        position: 0,
        category_slug: 'engineering',
        tldr:
          'Pneumonoultramicroscopicsilicovolcanoconiosis ' +
          'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW ' +
          'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(10),
      },
    ];
    for (const l of ['dark', 'darkest'] as const) {
      const r = await renderReceiptAt(items, opts, l);
      const { pixels, height } = r.bitmap;
      let beyond = 0;
      for (let y = 130; y < height - 160; y++) {
        for (let x = WIDTH - PAD_R + 1; x < WIDTH; x++) beyond += pixels[y * WIDTH + x];
        for (let x = 0; x < PAD - 2; x++) beyond += pixels[y * WIDTH + x];
      }
      expect(beyond).toBe(0);
    }
  });
});
