import type { ReceiptBitmap } from '../device/contracts';

const W = 384;
const H = 120;

// 5x7 block glyphs
const GLYPHS: Record<string, string[]> = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
};

/** A 384x120 self-test: border, "TNP" in block letters and a gradient of bar widths. */
export function makeTestBitmap(): ReceiptBitmap {
  const pixels = new Uint8Array(W * H);
  const set = (x: number, y: number) => {
    if (x >= 0 && x < W && y >= 0 && y < H) pixels[y * W + x] = 1;
  };
  const rect = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y);
  };
  // border (3px) + inner hairlines
  rect(0, 0, W, 3);
  rect(0, H - 3, W, 3);
  rect(0, 0, 3, H);
  rect(W - 3, 0, 3, H);
  rect(8, 8, W - 16, 1);
  rect(8, H - 9, W - 16, 1);

  // "TNP" scaled 6x (glyph 30x42, gap 12)
  const s = 6;
  const gap = 12;
  const totalW = 3 * 5 * s + 2 * gap;
  let x0 = Math.floor((W - totalW) / 2);
  for (const ch of 'TNP') {
    GLYPHS[ch].forEach((row, gy) => {
      [...row].forEach((c, gx) => {
        if (c === '#') rect(x0 + gx * s, 16 + gy * s, s, s);
      });
    });
    x0 += 5 * s + gap;
  }

  // gradient of bar widths: bars get gradually wider
  let x = 16;
  for (let i = 1; x + i < W - 16 && i <= 14; i++) {
    rect(x, 66, i, 36);
    x += i + Math.max(2, 8 - Math.floor(i / 2));
  }
  return { width: 384, height: H, pixels };
}

/** Below `bitmap`: a solid bar, 1px and 2px line groups and a dot grid, to compare darkness on paper. */
export function withDarknessPattern(bitmap: ReceiptBitmap): ReceiptBitmap {
  const extra = 90;
  const h = bitmap.height + extra;
  const pixels = new Uint8Array(W * h);
  pixels.set(bitmap.pixels);
  const rect = (x0: number, y0: number, w: number, hh: number) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + w; x++) pixels[(bitmap.height + y) * W + x] = 1;
  };
  rect(6, 4, W - 12, 18); // solid bar
  for (let i = 0; i < 4; i++) rect(6, 28 + i * 4, 180, 1); // 1px hairlines every 4px
  for (let i = 0; i < 4; i++) rect(198, 28 + i * 6, 180, 2); // 2px lines
  for (let y = 50; y < 80; y += 3) for (let x = 6; x < W - 6; x += 3) rect(x, y, 1, 1); // dot grid
  return { width: 384, height: h, pixels };
}

/**
 * Diagnostic strip (384 x 404) to tell print problems apart: six evenly spaced 8-row solid bands
 * (banding / fading along the length), a 60-row 1px checkerboard (50% dots, dense data that can starve
 * the printer), and ten 1px hairlines 4 rows apart (vertical streaks and fine detail).
 */
export function makeEvennessBitmap(): ReceiptBitmap {
  const bands = 6;
  const pitch = 56;
  const checkerH = 60;
  const lines = 10;
  const h = bands * pitch + checkerH + lines * 4 + 16;
  const pixels = new Uint8Array(W * h);
  const fillRows = (y0: number, n: number) => pixels.fill(1, y0 * W, (y0 + n) * W);
  let y = 0;
  for (let i = 0; i < bands; i++, y += pitch) fillRows(y, 8);
  for (let r = 0; r < checkerH; r++) for (let x = 0; x < W; x++) if ((x + r) % 2 === 0) pixels[(y + r) * W + x] = 1;
  y += checkerH + 8;
  for (let i = 0; i < lines; i++, y += 4) fillRows(y, 1);
  return { width: 384, height: h, pixels };
}
