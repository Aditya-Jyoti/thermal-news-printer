import type { ReceiptBitmap } from '../device/contracts';
import { PROFILES, encodeBitmap, type DarknessLevel, type PrintProfile } from './protocol';

export type { DarknessLevel } from './protocol';
type Store = Pick<typeof import('@react-native-async-storage/async-storage').default, 'getItem' | 'setItem'>;
/** Lazy so that merely importing this module never touches the native module (node tests, headless). */
const storage = (): Store =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage').default as Store;

export const DARKNESS_KEY = 'print_darkness';
export const DEFAULT_DARKNESS: DarknessLevel = 'dark';
export const DARKNESS_LEVELS: DarknessLevel[] = ['light', 'normal', 'dark', 'darkest'];

export const isDarkness = (v: unknown): v is DarknessLevel => DARKNESS_LEVELS.includes(v as DarknessLevel);

/** Saved darkness level; works outside React (headless prints). Falls back to the default on any error. */
export async function getDarkness(): Promise<DarknessLevel> {
  try {
    const v = await storage().getItem(DARKNESS_KEY);
    if (v == null) return DEFAULT_DARKNESS;
    if (isDarkness(v)) return v;
    console.warn(`[tnp] ignoring invalid saved darkness ${JSON.stringify(v)}, using ${DEFAULT_DARKNESS}`);
    return DEFAULT_DARKNESS;
  } catch (e) {
    console.warn(`[tnp] could not read saved darkness (${e instanceof Error ? e.message : String(e)}), using ${DEFAULT_DARKNESS}`);
    return DEFAULT_DARKNESS;
  }
}

export async function setDarkness(level: DarknessLevel): Promise<void> {
  try {
    await storage().setItem(DARKNESS_KEY, level);
  } catch {
    /* best effort */
  }
}

export const profileFor = (level: DarknessLevel): PrintProfile => PROFILES[level];

/** Resolve the level (override, else saved), encode the job with its profile and log what is used. */
export async function buildJob(
  bitmap: ReceiptBitmap,
  override?: DarknessLevel,
): Promise<{ level: DarknessLevel; profile: PrintProfile; data: Uint8Array }> {
  const level = override ?? (await getDarkness());
  const profile = profileFor(level);
  const data = encodeBitmap(bitmap, { profile });
  console.warn(
    `[tnp] print level=${level} energy=0x${profile.energy.toString(16)} speed=${profile.speed} rows=${bitmap.height} bytes=${data.length}`,
  );
  return { level, profile, data };
}
