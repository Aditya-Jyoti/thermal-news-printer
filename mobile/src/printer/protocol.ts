/**
 * Byte-exact port of backend/tnp/print/catprinter/protocol.py (cat-printer protocol,
 * reverse-engineered by https://github.com/rbaron/catprinter, MIT).
 * Frame: 51 78 cmd 00 len_lo len_hi payload crc8(payload) ff. Pixels pack LSB-first, 1 = burn.
 */
import type { ReceiptBitmap } from '../device/contracts';

export const PRINT_WIDTH = 384;
export const ROW_BYTES = PRINT_WIDTH / 8; // 48
export const DEFAULT_ENERGY = 0xffff;
export const DEFAULT_FEED = 25;

export const CMD_GET_DEV_STATE = 0xa3;
export const CMD_SET_QUALITY = 0xa4;
export const CMD_PRINT_ROW_RAW = 0xa2;
export const CMD_PRINT_ROW_RLE = 0xbf;
export const CMD_FEED_PAPER = 0xbd;
export const CMD_SET_SPEED = 0xbd;
export const CMD_SET_PAPER = 0xa1;
export const CMD_LATTICE = 0xa6;
export const CMD_SET_ENERGY = 0xaf;
export const CMD_APPLY_ENERGY = 0xbe;
export const CMD_UPDATE_DEVICE = 0xa9;

const CRC8_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t.push(c);
  }
  return t;
})();

export function crc8(data: ArrayLike<number>): number {
  let c = 0;
  for (let i = 0; i < data.length; i++) c = CRC8_TABLE[c ^ (data[i] & 0xff)];
  return c;
}

export function frame(cmd: number, payload: ArrayLike<number> = []): Uint8Array {
  const n = payload.length;
  const out = new Uint8Array(6 + n + 2);
  out.set([0x51, 0x78, cmd, 0x00, n & 0xff, (n >> 8) & 0xff], 0);
  for (let i = 0; i < n; i++) out[6 + i] = payload[i] & 0xff;
  out[6 + n] = crc8(payload);
  out[7 + n] = 0xff;
  return out;
}

export const cmdGetDevState = () => frame(CMD_GET_DEV_STATE, [0x00]);
export const cmdSetQuality200dpi = () => frame(CMD_SET_QUALITY, [0x32]);
/**
 * NOTE endianness: this is big-endian (rbaron). NaitLee sends the 16-bit energy little-endian and lists
 * the SC03h as "new kind". Both agree only for symmetric values (0xFFFF, 0x4040); if an asymmetric
 * energy is ever introduced, verify on hardware and prefer NaitLee's little-endian order.
 */
export const cmdSetEnergy = (val: number) => frame(CMD_SET_ENERGY, [(val >> 8) & 0xff, val & 0xff]);
/**
 * 0xA9 "update device" (NaitLee/Cat-Printer, GPL-3.0; protocol facts only): sent right after apply-energy,
 * before the lattice start; it appears to make the printer commit the speed/energy settings.
 */
export const cmdUpdateDevice = () => frame(CMD_UPDATE_DEVICE, [0x00]);
export const cmdApplyEnergy = () => frame(CMD_APPLY_ENERGY, [0x01]);
export const cmdLatticeStart = () =>
  frame(CMD_LATTICE, [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c]);
export const cmdLatticeEnd = () =>
  frame(CMD_LATTICE, [0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17]);
export const cmdFeedPaper = (amount: number) => frame(CMD_FEED_PAPER, [amount & 0xff]);
/**
 * 0xBD is "set speed" in NaitLee/Cat-Printer (GPL-3.0; protocol facts only, no code copied):
 * one byte, "the lower, the quicker"; a slower feed means longer head heating, so darker output.
 * rbaron/catprinter sends the same opcode once after the rows and calls it feed paper.
 */
export const cmdSetSpeed = (speed: number) => frame(CMD_SET_SPEED, [speed & 0xff]);
export const cmdSetPaper = () => frame(CMD_SET_PAPER, [0x30, 0x00]);

function rleRun(count: number, val: number, out: number[]): void {
  while (count > 0x7f) {
    out.push(0x7f | (val << 7));
    count -= 0x7f;
  }
  if (count > 0) out.push((val << 7) | count);
}

/** Each byte: bit7 = pixel value, bits0-6 = run length (1..127). */
export function runLengthEncode(row: ArrayLike<number>): number[] {
  const out: number[] = [];
  let run = 0;
  let last = -1;
  for (let i = 0; i < row.length; i++) {
    const v = row[i] ? 1 : 0;
    if (v === last) run++;
    else {
      if (last !== -1) rleRun(run, last, out);
      run = 1;
      last = v;
    }
  }
  if (last !== -1) rleRun(run, last, out);
  return out;
}

/** Pack pixels (1 = burn) LSB-first. */
export function packRow(row: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(row.length / 8));
  for (let i = 0; i < row.length; i++) if (row[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

export function cmdPrintRow(row: ArrayLike<number>): Uint8Array {
  if (row.length !== PRINT_WIDTH) throw new Error(`row must be ${PRINT_WIDTH} pixels wide, got ${row.length}`);
  const rle = runLengthEncode(row);
  if (rle.length > ROW_BYTES) return frame(CMD_PRINT_ROW_RAW, packRow(row));
  return frame(CMD_PRINT_ROW_RLE, rle);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface PrintProfile {
  /** Thermal energy 0..0xFFFF (0xAF). Only symmetric values (0xFFFF, 0x4040) are endianness-safe. */
  energy: number;
  /** Speed byte sent before the lattice (0xBD). Lower = faster = lighter. 0 = do not send. */
  speed: number;
  /** Quality byte for 0xA4. 0x32 (50) = 200 dpi, the only value both reference projects send. */
  quality: number;
  /** Send 0xA9 "update device" after apply-energy. Off for the reference envelope. */
  commit?: boolean;
}

export type DarknessLevel = 'light' | 'normal' | 'dark' | 'darkest';

/**
 * Presets. NaitLee's CLI maps quality 1..4 to speed 4*(q+5) = 24..36 (default 32) and uses energy
 * 0x4000 (graphics) / 0x6000 (text); its web UI offers speeds 28..40. Energy 0xFFFF is max.
 * Energy is kept symmetric (same value in both bytes) because rbaron sends the 16-bit value
 * big-endian while NaitLee sends it little-endian; 0xFFFF and 0x4040 are identical either way.
 */
export const PROFILES: Record<DarknessLevel, PrintProfile> = {
  light: { energy: 0x4040, speed: 24, quality: 0x32, commit: true },
  normal: { energy: 0xffff, speed: 32, quality: 0x32, commit: true },
  dark: { energy: 0xffff, speed: 36, quality: 0x32, commit: true },
  darkest: { energy: 0xffff, speed: 40, quality: 0x32, commit: true },
};

/** Exactly the rbaron/catprinter envelope (no speed command): used for the golden fixtures. */
export const REFERENCE_PROFILE: PrintProfile = { energy: DEFAULT_ENERGY, speed: 0, quality: 0x32 };

export function encodeRows(
  rows: ArrayLike<number>[],
  energy = DEFAULT_ENERGY,
  feed = DEFAULT_FEED,
  profile: Pick<PrintProfile, 'speed' | 'quality' | 'commit'> = REFERENCE_PROFILE,
): Uint8Array {
  return concat([
    cmdGetDevState(),
    frame(CMD_SET_QUALITY, [profile.quality & 0xff]),
    ...(profile.speed ? [cmdSetSpeed(profile.speed)] : []),
    cmdSetEnergy(energy),
    cmdApplyEnergy(),
    ...(profile.commit ? [cmdUpdateDevice()] : []),
    cmdLatticeStart(),
    ...rows.map(cmdPrintRow),
    cmdFeedPaper(feed),
    cmdSetPaper(),
    cmdSetPaper(),
    cmdSetPaper(),
    cmdLatticeEnd(),
    cmdGetDevState(),
  ]);
}

export interface EncodeOptions {
  /** Takes precedence over profile.energy. */
  energy?: number;
  feed?: number;
  /** Default: REFERENCE_PROFILE (byte-identical to the Python reference). */
  profile?: PrintProfile;
}

/** Full byte stream for one print job (same envelope as Python encode_image). */
export function encodeBitmap(bitmap: ReceiptBitmap, opts: EncodeOptions = {}): Uint8Array {
  if (bitmap.pixels.length !== bitmap.width * bitmap.height) throw new Error('bitmap pixel count mismatch');
  const rows: Uint8Array[] = [];
  for (let y = 0; y < bitmap.height; y++) rows.push(bitmap.pixels.subarray(y * bitmap.width, (y + 1) * bitmap.width));
  const profile = opts.profile ?? REFERENCE_PROFILE;
  return encodeRows(rows, opts.energy ?? profile.energy, opts.feed ?? DEFAULT_FEED, profile);
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
