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
