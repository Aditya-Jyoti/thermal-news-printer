import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import type { ReceiptBitmap, RenderReceipt } from '../device/contracts';
import { loadReceiptFonts } from './fonts';
import { THRESHOLD, WIDTH, layoutReceipt, type DrawOp } from './layout';

/**
 * Renders the receipt: draw antialiased black-on-white with Skia, then hard-threshold (no dither)
 * to 1-bit using render.py's THRESHOLD. Deterministic.
 */
export const renderReceipt: RenderReceipt = async (items, opts) => {
  const fonts = await loadReceiptFonts();
  const layout = layoutReceipt(items, opts, fonts);
  const h = layout.height;

  const surface = Skia.Surface.Make(WIDTH, h);
  if (!surface) throw new Error('Could not create Skia surface');
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('black'));
  paint.setAntiAlias(true);

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
        canvas.drawPath(b.build(), paint);
        break;
      }
      case 'text': {
        const font = fonts.font(op.font);
        canvas.drawText(op.text, op.x, op.y + fonts.ascent(op.font), paint, font);
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
    const black = rgba[i * 4] < THRESHOLD ? 1 : 0;
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
