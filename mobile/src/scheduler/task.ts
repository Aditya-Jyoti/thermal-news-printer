/** Headless JS task "TnpScheduledPrint": the whole news cycle, run by the native foreground service. */
import type { Db } from '../core/db/adapter';
import { runCycle, type CycleResult } from '../core/pipeline';
import { rearm } from './arm';
import { getNative, type PrintSchedulerNative } from './native';

export const TASK_NAME = 'TnpScheduledPrint';
export const MAX_LATE_MS = 2 * 60 * 60 * 1000;

export interface TaskData {
  scheduledAt?: number;
  scheduleId?: number;
  manual?: boolean;
}

export interface TaskDeps {
  getDb?: () => Promise<Db>;
  native?: PrintSchedulerNative | null;
  ensureDevice?: () => void;
  cycle?: (db: Db) => Promise<CycleResult>;
  now?: () => Date;
}

export type Outcome = 'printed' | 'nothing' | 'printer-failed' | 'error' | 'skipped-late';

export interface TaskResult {
  outcome: Outcome;
  message: string;
}

function describe(r: CycleResult): TaskResult {
  const p = r.print;
  if (!p) return { outcome: 'nothing', message: 'Nothing new to print' };
  if (p.status === 'printed') {
    const n = p.items.length;
    return { outcome: 'printed', message: `Printed ${n} ${n === 1 ? 'story' : 'stories'}` };
  }
  const err = p.error ?? '';
  if (/not found|no printer|scan/i.test(err)) {
    return { outcome: 'printer-failed', message: 'Printer not found — will try next time' };
  }
  return { outcome: 'printer-failed', message: `Print failed — will try next time${err ? `: ${err.slice(0, 80)}` : ''}` };
}

/** Never throws: every failure becomes a notification message. Always re-arms the next alarm. */
export async function runScheduledPrint(data: TaskData = {}, deps: TaskDeps = {}): Promise<TaskResult> {
  const native = deps.native === undefined ? getNative() : deps.native;
  const now = deps.now ?? (() => new Date());
  const notify = (text: string, ongoing: boolean) => {
    try {
      native?.updateNotification(text, ongoing);
    } catch {
      // notifications are best effort
    }
  };
  let db: Db | null = null;
  const arm = async () => {
    if (!db) return;
    try {
      await rearm(db, { native, now: now() });
    } catch (e) {
      console.warn('rearm failed', e);
    }
  };

  let result: TaskResult;
  try {
    db = await (deps.getDb ?? (await import('../core/db')).getDb)();
    // Arm tomorrow's run first so a crash or timeout below can never leave the schedule dead.
    await arm();

    const late = !data.manual && data.scheduledAt && now().getTime() - data.scheduledAt > MAX_LATE_MS;
    if (late) {
      result = { outcome: 'skipped-late', message: 'Skipped a missed print (over 2 hours late)' };
    } else {
      // Headless runs bypass the root layout, so register the real renderer + printer here.
      (deps.ensureDevice ?? (await import('../device/register')).ensureRealDevice)();
      const cycle = deps.cycle ?? ((d: Db) => runCycle(d, 'schedule'));
      result = describe(await cycle(db));
    }
  } catch (e) {
    console.warn('scheduled print failed', e);
    result = { outcome: 'error', message: `Scheduled print failed — ${e instanceof Error ? e.message.slice(0, 80) : 'unknown error'}` };
  }
  notify(result.message, true);
  notify(result.message, false);
  await arm();
  return result;
}

/** The function registered with AppRegistry.registerHeadlessTask. */
export default async function headlessTask(data: TaskData): Promise<void> {
  await runScheduledPrint(data);
}
