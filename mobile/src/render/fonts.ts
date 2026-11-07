/**
 * Receipt fonts for Skia. Works outside React components (no hooks): `loadReceiptFonts()` is a plain
 * async function that caches its result, so it can be awaited from a background print task.
 *
 * Skia cannot set variable-font axes, so assets/fonts holds static instances baked from the
 * backend's variable fonts at exactly the weights/optical sizes render.py uses (see make_static.py).
 */
import { Skia, type SkData, type SkFont, type SkTypeface } from '@shopify/react-native-skia';
import type { FontFace, FontSpec, TextMetrics } from './layout';

export type FontLoader = (face: FontFace) => Promise<SkData>;

/** Default loader: bundled asset -> local file (expo-asset) -> SkData. Lazy so tests never touch `require`. */
const bundledLoader: FontLoader = async (face) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Asset } = require('expo-asset') as typeof import('expo-asset');
  const modules: Record<FontFace, number> = {
    mast: require('../../assets/fonts/PlayfairDisplay-Mast.ttf'),
    body: require('../../assets/fonts/SourceSerif4-Body.ttf'),
    small: require('../../assets/fonts/SourceSerif4-Small.ttf'),
    tag: require('../../assets/fonts/SourceSerif4-Tag.ttf'),
    date: require('../../assets/fonts/SourceSerif4-DateItalic.ttf'),
  };
  const asset = Asset.fromModule(modules[face]);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  return Skia.Data.fromURI(uri);
};

let loader: FontLoader = bundledLoader;
let cache: Promise<ReceiptFonts> | null = null;

/** Override how font bytes are obtained (tests / node scripts). Clears the cache. */
export function setFontLoader(fn: FontLoader | null): void {
  loader = fn ?? bundledLoader;
  cache = null;
}

const FACES: FontFace[] = ['mast', 'body', 'small', 'tag', 'date'];

export class ReceiptFonts implements TextMetrics {
  private fonts = new Map<string, SkFont>();
  constructor(private typefaces: Record<FontFace, SkTypeface>) {}

  font(spec: FontSpec): SkFont {
    const key = `${spec.face}:${spec.size}`;
    let f = this.fonts.get(key);
    if (!f) {
      f = Skia.Font(this.typefaces[spec.face], spec.size);
      f.setSubpixel(false);
      f.setLinearMetrics(false);
      f.setHinting(1 /* Slight */);
      f.setEdging(1 /* AntiAlias */);
      this.fonts.set(key, f);
    }
    return f;
  }
  measure(text: string, spec: FontSpec): number {
    return this.font(spec).getTextWidth(text);
  }
  ascent(spec: FontSpec): number {
    return Math.ceil(-this.font(spec).getMetrics().ascent);
  }
  descent(spec: FontSpec): number {
    return Math.ceil(this.font(spec).getMetrics().descent);
  }
}

export function loadReceiptFonts(): Promise<ReceiptFonts> {
  if (!cache) {
    cache = (async () => {
      const typefaces = {} as Record<FontFace, SkTypeface>;
      await Promise.all(
        FACES.map(async (face) => {
          const tf = Skia.Typeface.MakeFreeTypeFaceFromData(await loader(face));
          if (!tf) throw new Error(`Failed to load receipt font "${face}"`);
          typefaces[face] = tf;
        }),
      );
      return new ReceiptFonts(typefaces);
    })();
    cache.catch(() => {
      cache = null; // allow retry
    });
  }
  return cache;
}
