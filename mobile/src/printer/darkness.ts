import AsyncStorage from '@react-native-async-storage/async-storage';
import { PROFILES, type DarknessLevel, type PrintProfile } from './protocol';

export type { DarknessLevel } from './protocol';
export const DARKNESS_KEY = 'print_darkness';
export const DEFAULT_DARKNESS: DarknessLevel = 'dark';
export const DARKNESS_LEVELS: DarknessLevel[] = ['light', 'normal', 'dark', 'darkest'];

export const isDarkness = (v: unknown): v is DarknessLevel => DARKNESS_LEVELS.includes(v as DarknessLevel);

/** Saved darkness level; works outside React (headless prints). Falls back to the default on any error. */
export async function getDarkness(): Promise<DarknessLevel> {
  try {
    const v = await AsyncStorage.getItem(DARKNESS_KEY);
    return isDarkness(v) ? v : DEFAULT_DARKNESS;
  } catch {
    return DEFAULT_DARKNESS;
  }
}

export async function setDarkness(level: DarknessLevel): Promise<void> {
  try {
    await AsyncStorage.setItem(DARKNESS_KEY, level);
  } catch {
    /* best effort */
  }
}

export const profileFor = (level: DarknessLevel): PrintProfile => PROFILES[level];
