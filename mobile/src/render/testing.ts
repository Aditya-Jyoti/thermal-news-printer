/**
 * Jest helper (not shipped in the app bundle: only imported by tests).
 * Test files must start with the docblock `@jest-environment @shopify/react-native-skia/jestEnv.js`
 * and import this module BEFORE any render code, so Skia is mocked onto CanvasKit-in-node.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'fs';
import * as path from 'path';
import { Skia } from '@shopify/react-native-skia';
import { setFontLoader } from './fonts';
import type { FontFace } from './layout';

// Same as @shopify/react-native-skia/jestSetup.js but using the CommonJS mock build.
jest.mock('@shopify/react-native-skia', () => {
  jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
    const Noop = () => undefined;
    return { OS: 'web', PixelRatio: 1, requireNativeComponent: Noop, resolveAsset: Noop, findNodeHandle: Noop, NativeModules: Noop, View: Noop };
  });
  return require('@shopify/react-native-skia/lib/commonjs/mock').Mock((global as any).CanvasKit);
});

const FILES: Record<FontFace, string> = {
  mast: 'PlayfairDisplay-Mast.ttf',
  body: 'SourceSerif4-Body.ttf',
  small: 'SourceSerif4-Small.ttf',
  tag: 'SourceSerif4-Tag.ttf',
  date: 'SourceSerif4-DateItalic.ttf',
};

export function installNodeFonts(): void {
  setFontLoader(async (face) => {
    const buf = fs.readFileSync(path.join(__dirname, '../../assets/fonts', FILES[face]));
    return Skia.Data.fromBytes(new Uint8Array(buf));
  });
}
