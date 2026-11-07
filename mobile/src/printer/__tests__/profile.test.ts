import { describe, expect, it, jest } from '@jest/globals';
import { makeEvennessBitmap } from '../testPattern';
import type { ReceiptBitmap } from '../../device/contracts';
import {
  CMD_SET_ENERGY,
  CMD_SET_QUALITY,
  CMD_SET_SPEED,
  PROFILES,
  REFERENCE_PROFILE,
  cmdPrintRow,
  cmdSetSpeed,
  encodeBitmap,
  frame,
  toHex,
} from '../protocol';
import golden from './fixtures/golden.json';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DARKNESS_KEY, DEFAULT_DARKNESS, buildJob, getDarkness, profileFor, setDarkness } from '../darkness';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store.get(k) ?? null),
      setItem: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    },
  };
});


const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const bitmap = (h: number, fill: (x: number, y: number) => number): ReceiptBitmap => {
  const pixels = new Uint8Array(384 * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < 384; x++) pixels[y * 384 + x] = fill(x, y);
  return { width: 384, height: h, pixels };
};

/** Split a job stream into [cmd, payload] frames. */
function parse(buf: Uint8Array): { cmd: number; payload: number[] }[] {
  const out: { cmd: number; payload: number[] }[] = [];
  for (let i = 0; i < buf.length; ) {
    expect([buf[i], buf[i + 1]]).toEqual([0x51, 0x78]);
    const len = buf[i + 4] | (buf[i + 5] << 8);
    out.push({ cmd: buf[i + 2], payload: Array.from(buf.subarray(i + 6, i + 6 + len)) });
    i += 6 + len + 2;
  }
  return out;
}

describe('print profiles', () => {
  it('reference profile is byte-identical to the golden fixtures', () => {
    for (const c of Object.values(golden.cases)) {
      const bm: ReceiptBitmap = { width: 384, height: c.height, pixels: fromHex(c.pixelsHex) };
      expect(toHex(encodeBitmap(bm, { profile: REFERENCE_PROFILE }))).toBe(c.job);
    }
  });

  it('cmdSetSpeed frames a single byte on 0xBD', () => {
    expect(toHex(cmdSetSpeed(36))).toBe(toHex(frame(0xbd, [36])));
    expect(cmdSetSpeed(36)[2]).toBe(CMD_SET_SPEED);
    expect(cmdSetSpeed(36)[6]).toBe(36);
  });

  it('presets get progressively slower and keep max energy except light', () => {
    const { light, normal, dark, darkest } = PROFILES;
    expect(light.speed).toBeLessThan(normal.speed);
    expect(normal.speed).toBeLessThan(dark.speed);
    expect(dark.speed).toBeLessThan(darkest.speed);
    expect([normal, dark, darkest].every((p) => p.energy === 0xffff)).toBe(true);
    expect(light.energy).toBeLessThan(0xffff);
    // symmetric energy values are endianness-independent
    for (const p of Object.values(PROFILES)) expect(p.energy & 0xff).toBe(p.energy >> 8);
  });

  it.each(Object.entries(PROFILES))('%s: speed is sent after quality and before energy/lattice', (_n, p) => {
    const frames = parse(encodeBitmap(bitmap(2, () => 1), { profile: p }));
    const cmds = frames.map((f) => f.cmd);
    expect(cmds.slice(0, 7)).toEqual([0xa3, CMD_SET_QUALITY, CMD_SET_SPEED, CMD_SET_ENERGY, 0xbe, 0xa9, 0xa6]);
    expect(frames[1].payload).toEqual([p.quality]);
    expect(frames[2].payload).toEqual([p.speed]);
    expect(frames[3].payload).toEqual([p.energy >> 8, p.energy & 0xff]);
    // the post-rows 0xBD(25) is kept
    const post = frames.filter((f) => f.cmd === 0xbd);
    expect(post).toHaveLength(2);
    expect(post[1].payload).toEqual([25]);
    expect(cmds.slice(-6)).toEqual([0xbd, 0xa1, 0xa1, 0xa1, 0xa6, 0xa3]);
  });

  it('profile.speed 0 omits the speed command; explicit energy wins over the profile', () => {
    const frames = parse(encodeBitmap(bitmap(1, () => 1), { profile: PROFILES.dark, energy: 0x1234 }));
    expect(frames[3].payload).toEqual([0x12, 0x34]);
    const ref = parse(encodeBitmap(bitmap(1, () => 1)));
    expect(ref.filter((f) => f.cmd === 0xbd)).toHaveLength(1);
  });
});

describe('row polarity (1 = black = burn)', () => {
  it('an all-black row encodes as burn runs (bit7 set) and an all-white row as non-burn', () => {
    const black = cmdPrintRow(new Uint8Array(384).fill(1));
    const white = cmdPrintRow(new Uint8Array(384));
    // frame: header(6) + payload; RLE bytes are 0x7f|0x80 for burn
    expect(black[2]).toBe(0xbf);
    expect(black[6] & 0x80).toBe(0x80);
    expect(white[6] & 0x80).toBe(0);
  });

  it('raw rows pack LSB-first with 1 = burn (checkerboard defeats RLE)', () => {
    const row = new Uint8Array(384);
    for (let x = 0; x < 384; x++) row[x] = x % 2 === 0 ? 1 : 0; // pixel 0,2,4,6 black
    const f = cmdPrintRow(row);
    expect(f[2]).toBe(0xa2);
    expect(f[6]).toBe(0b01010101);
    const odd = new Uint8Array(384);
    for (let x = 0; x < 384; x++) odd[x] = x % 3 === 0 ? 1 : 0;
    const g = cmdPrintRow(odd);
    expect(g[2]).toBe(0xa2);
    expect(g[6]).toBe(0b01001001);
  });
});

describe('darkness storage', () => {
  it('defaults to dark when nothing is stored', async () => {
    expect(await getDarkness()).toBe('dark');
    expect(DEFAULT_DARKNESS).toBe('dark');
  });

  it('round-trips a level and ignores garbage', async () => {
    await setDarkness('darkest');
    expect(await getDarkness()).toBe('darkest');
    await AsyncStorage.setItem(DARKNESS_KEY, 'bogus');
    expect(await getDarkness()).toBe('dark');
    expect(profileFor('light')).toBe(PROFILES.light);
  });

  it('falls back to the default when storage throws', async () => {
    (AsyncStorage.getItem as any).mockRejectedValueOnce(new Error('boom'));
    expect(await getDarkness()).toBe('dark');
    (AsyncStorage.setItem as any).mockRejectedValueOnce(new Error('boom'));
    await expect(setDarkness('light')).resolves.toBeUndefined();
  });
});

describe('buildJob applies the saved level', () => {
  it.each(['light', 'normal', 'dark', 'darkest'] as const)('uses the %s profile from storage', async (level) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setDarkness(level);
    const bm = bitmap(2, () => 1);
    const job = await buildJob(bm);
    const p = PROFILES[level];
    expect(job.level).toBe(level);
    expect(job.profile).toBe(p);
    expect(toHex(job.data)).toBe(toHex(encodeBitmap(bm, { profile: p })));
    const frames = parse(job.data);
    expect(frames.find((f) => f.cmd === CMD_SET_SPEED)?.payload).toEqual([p.speed]);
    expect(frames.find((f) => f.cmd === CMD_SET_ENERGY)?.payload).toEqual([p.energy >> 8, p.energy & 0xff]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`level=${level} `));
    warn.mockRestore();
  });

  it('an explicit override beats storage; reference profile has no 0xA9', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setDarkness('light');
    expect((await buildJob(bitmap(1, () => 1), 'darkest')).level).toBe('darkest');
    expect(parse(encodeBitmap(bitmap(1, () => 1))).some((f) => f.cmd === 0xa9)).toBe(false);
    warn.mockRestore();
  });
});

describe('evenness pattern', () => {
  it('is 384 wide with 6 solid bands, a checkerboard and hairlines', () => {
    const b = makeEvennessBitmap();
    expect(b.width).toBe(384);
    expect(b.pixels.length).toBe(384 * b.height);
    const rowSum = (y: number) => b.pixels.subarray(y * 384, (y + 1) * 384).reduce((a, v) => a + v, 0);
    expect(rowSum(0)).toBe(384);
    expect(rowSum(7)).toBe(384);
    expect(rowSum(8)).toBe(0);
    expect(rowSum(56)).toBe(384);
    expect(rowSum(6 * 56 + 10)).toBe(192);
  });
});
