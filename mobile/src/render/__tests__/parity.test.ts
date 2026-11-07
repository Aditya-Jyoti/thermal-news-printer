/** @jest-environment @shopify/react-native-skia/jestEnv.js */
import { installNodeFonts } from '../testing';
import * as fs from 'fs';
import * as path from 'path';
import { renderReceipt, sampleItems } from '../index';

// Writes mobile/render-out/sample_ts.png (gitignored) for eyeballing against docs/sample_receipt.png.
it('renders the sample receipt to render-out/sample_ts.png', async () => {
  installNodeFonts();
  const r = await renderReceipt(sampleItems(), { editionDate: new Date(2026, 10, 7) });
  const dir = path.join(__dirname, '../../../render-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample_ts.png'), Buffer.from(r.pngBase64, 'base64'));
  console.log('sample height', r.bitmap.height);
  expect(r.bitmap.height).toBeGreaterThan(500);
});
