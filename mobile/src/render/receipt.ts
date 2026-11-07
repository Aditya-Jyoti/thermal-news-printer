import { AlphaType, ColorType, PaintStyle, Skia } from '@shopify/react-native-skia';
import type { ReceiptBitmap, RenderReceipt } from '../device/contracts';
import { DEFAULT_DARKNESS, getDarkness, type DarknessLevel } from '../printer/darkness';
import { loadReceiptFonts } from './fonts';
import { THRESHOLD, WIDTH, layoutReceipt, type DrawOp } from './layout';

/**
 * Ink weight per darkness level. Thin serif hairlines vanish at a hard 1-bit threshold, so the
 * heavier levels (a) raise the threshold so antialiased edge pixels count as black, (b) add a
 * thin outline stroke to text/diamonds and (c) for 'darkest' switch to heavier font instances.
 * Only 'darkest' changes glyph widths (and so possibly the wrapping); wrapping is always measured
 * with the same font that is drawn. 'light' and 'normal' render exactly as before.
 */
export interface InkSpec {
  threshold: number;
  strokeWidth: number;
  heavyFonts: boolean;
}
export const INK: Record<DarknessLevel, InkSpec> = {
  light: { threshold: THRESHOLD, strokeWidth: 0, heavyFonts: false },
  normal: { threshold: THRESHOLD, strokeWidth: 0, heavyFonts: false },
  dark: { threshold: 190, strokeWidth: 0.4, heavyFonts: false },
  darkest: { threshold: 200, strokeWidth: 0.5, heavyFonts: true },
};

/**
 * Renders the receipt: draw antialiased black-on-white with Skia, then hard-threshold (no dither)
 * to 1-bit using render.py's THRESHOLD. Deterministic.
 */
export const renderReceipt: RenderReceipt = async (items, opts) =>
  renderReceiptAt(items, opts, await getDarkness().catch(() => DEFAULT_DARKNESS));

/** Same as renderReceipt but with an explicit darkness level (previews, tests). */
export const renderReceiptAt = async (
  items: Parameters<RenderReceipt>[0],
  opts: Parameters<RenderReceipt>[1],
  level: DarknessLevel,
): ReturnType<RenderReceipt> => {
  const ink = INK[level] ?? INK[DEFAULT_DARKNESS];
  const fonts = await loadReceiptFonts(ink.heavyFonts ? 'heavy' : 'normal');
  const layout = layoutReceipt(items, opts, fonts);
  const h = layout.height;

  const surface = Skia.Surface.Make(WIDTH, h);
  if (!surface) throw new Error('Could not create Skia surface');
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('black'));
  paint.setAntiAlias(true);
  const outline = Skia.Paint();
  outline.setColor(Skia.Color('black'));
  outline.setAntiAlias(true);
  outline.setStyle(PaintStyle.Stroke);
  outline.setStrokeWidth(ink.strokeWidth);

  const drawOp = (op: DrawOp) => {
    switch (op.t) {
      case 'rect':
        paint.setAntiAlias(false);
        canvas.drawRect(Skia.XYWHRect(op.x0, op.y0, op.x1 - op.x0 + 1, op.y1 - op.y0 + 1), paint);
        paint.setAntiAlias(true);
        break;
      case 'diamond': {
        const b = Skia.PathBuilder.Make();
        b.moveTo(op.cx + 0.5, op.cy - op.r);
        b.lineTo(op.cx + op.r + 0.5, op.cy + 0.5);
        b.lineTo(op.cx + 0.5, op.cy + op.r + 1);
        b.lineTo(op.cx - op.r, op.cy + 0.5);
        b.close();
        const path = b.build();
        canvas.drawPath(path, paint);
        if (ink.strokeWidth) canvas.drawPath(path, outline);
        break;
      }
      case 'text': {
        const font = fonts.font(op.font);
        const by = op.y + fonts.ascent(op.font);
        canvas.drawText(op.text, op.x, by, paint, font);
        if (ink.strokeWidth) canvas.drawText(op.text, op.x, by, outline, font);
        break;
      }
    }
  };
  layout.ops.forEach(drawOp);
  surface.flush();

  const snap = surface.makeImageSnapshot();
  const rgba = snap.readPixels(0, 0, {
    width: WIDTH,
    height: h,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!rgba) throw new Error('Could not read surface pixels');

  const pixels = new Uint8Array(WIDTH * h);
  const out = new Uint8Array(WIDTH * h * 4);
  for (let i = 0; i < WIDTH * h; i++) {
    const black = rgba[i * 4] < ink.threshold ? 1 : 0;
    pixels[i] = black;
    const v = black ? 0 : 255;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  const img = Skia.Image.MakeImage(
    { width: WIDTH, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
    Skia.Data.fromBytes(out),
    WIDTH * 4,
  );
  if (!img) throw new Error('Could not build PNG image');
  const pngBase64 = img.encodeToBase64();

  const bitmap: ReceiptBitmap = { width: 384, height: h, pixels };
  return { bitmap, pngBase64 };
};
