/** @jest-environment @shopify/react-native-skia/jestEnv.js */
import { installNodeFonts } from '../testing';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { renderReceipt, sampleItems } from '../index';
import { PAD, PAD_R, WIDTH } from '../layout';

const SAMPLE_HEIGHT = 1508;

const opts = { editionDate: new Date(2026, 10, 7) };

beforeAll(() => installNodeFonts());

describe('renderReceipt', () => {
  it('produces a 384px wide 1-bit bitmap and PNG', async () => {
    const r = await renderReceipt(sampleItems(), opts);
    expect(r.bitmap.width).toBe(384);
    expect(r.bitmap.pixels.length).toBe(384 * r.bitmap.height);
    expect(r.bitmap.pixels.every((v) => v === 0 || v === 1)).toBe(true);
    const black = r.bitmap.pixels.reduce((a, v) => a + v, 0);
    expect(black).toBeGreaterThan(5000);
    expect(black).toBeLessThan(r.bitmap.pixels.length / 2);
    const png = Buffer.from(r.pngBase64, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(384);
    expect(png.readUInt32BE(20)).toBe(r.bitmap.height);
  });

  it('height grows with more items', async () => {
    const all = sampleItems();
    const a = await renderReceipt(all.slice(0, 1), opts);
    const b = await renderReceipt(all.slice(0, 3), opts);
    const c = await renderReceipt(all, opts);
    expect(b.bitmap.height).toBeGreaterThan(a.bitmap.height);
    expect(c.bitmap.height).toBeGreaterThan(b.bitmap.height);
  });

  it('sample height is stable (no edition row, 22px right safe margin)', async () => {
    const r = await renderReceipt(sampleItems(), opts);
    expect(r.bitmap.height).toBe(SAMPLE_HEIGHT);
  });

  it('is deterministic', async () => {
    const a = await renderReceipt(sampleItems(), opts);
    const b = await renderReceipt(sampleItems(), opts);
    expect(Buffer.from(a.bitmap.pixels).equals(Buffer.from(b.bitmap.pixels))).toBe(true);
    expect(a.pngBase64).toBe(b.pngBase64);
  });

  it('renders the empty digest', async () => {
    const r = await renderReceipt([], opts);
    expect(r.bitmap.width).toBe(384);
    expect(r.bitmap.height).toBe(100 + 60 + 144);
    expect(r.bitmap.pixels.some((v) => v === 1)).toBe(true);
  });

  it('wraps long text and a very long word without drawing outside the margins', async () => {
    const items = [
      {
        article_id: 1,
        position: 0,
        category_slug: 'engineering',
        tldr:
          'Pneumonoultramicroscopicsilicovolcanoconiosis' +
          'Pneumonoultramicroscopicsilicovolcanoconiosis ' +
          'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(12),
      },
    ];
    const r = await renderReceipt(items, opts);
    const { pixels, height } = r.bitmap;
    // everything between header and footer rules is body text: nothing past the right padding / left padding
    let beyond = 0;
    for (let y = 130; y < height - 160; y++) {
      for (let x = WIDTH - PAD_R + 1; x < WIDTH; x++) beyond += pixels[y * WIDTH + x];
      for (let x = 0; x < PAD - 2; x++) beyond += pixels[y * WIDTH + x];
    }
    expect(beyond).toBe(0);
    expect(height).toBeGreaterThan(600);
  });
});
