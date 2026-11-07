import type { Schedule } from '../api/types';
import type { Db } from '../core/db/adapter';
import { listSchedules } from '../core/db/settings';
import { nextRun } from './cron';
import { getNative, type AlarmMode, type PrintSchedulerNative } from './native';

export interface NextRun {
  at: Date;
  scheduleId: number;
}

/** Soonest next fire time (strictly after `from`) across enabled schedules; null if none. */
export function computeNext(schedules: Schedule[], from: Date = new Date()): NextRun | null {
  let best: NextRun | null = null;
  for (const s of schedules) {
    if (!s.enabled) continue;
    const at = nextRun(s.cron, from);
    if (at && (!best || at.getTime() < best.at.getTime())) best = { at, scheduleId: s.id };
  }
  return best;
}

export interface ArmResult {
  next: NextRun | null;
  /** null when nothing was armed or the native module is unavailable. */
  mode: AlarmMode | null;
}

/** Arms the native alarm for the soonest enabled schedule, or cancels it when there is none. */
export async function rearm(db: Db, deps: { native?: PrintSchedulerNative | null; now?: Date } = {}): Promise<ArmResult> {
  const native = deps.native === undefined ? getNative() : deps.native;
  const next = computeNext(await listSchedules(db), deps.now ?? new Date());
  if (!native) return { next, mode: null };
  if (!next) {
    native.cancelAlarm();
    return { next: null, mode: null };
  }
  return { next, mode: native.setNextAlarm(next.at.getTime(), next.scheduleId) };
}

/** Fire-and-forget variant for mutation paths: never throws. */
export function rearmSoon(db: Db): void {
  rearm(db).catch((e) => console.warn('rearm failed', e));
}
