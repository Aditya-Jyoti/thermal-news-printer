import type { PrintRecord } from '../../api/types';
import type { Db } from '../../core/db/adapter';
import { createSchedule } from '../../core/db/settings';
import type { CycleResult } from '../../core/pipeline';
import { createMemoryDb } from '../../core/testing/sqljs';
import type { PrintSchedulerNative } from '../native';
import { fakeNative } from '../testing';
import { MAX_LATE_MS, runScheduledPrint } from '../task';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const now = new Date(2026, 10, 7, 8, 0, 5);
const record = (over: Partial<PrintRecord>): PrintRecord => ({
  id: 1,
  created_at: now.toISOString(),
  trigger: 'schedule',
  status: 'printed',
  error: null,
  items: [],
  ...over,
});
const cycleOf = (print: PrintRecord | null): CycleResult => ({
  ingest: { feeds_fetched: 0, new_articles: 0, errors: [] } as never,
  edition: { items: [], status: { phase: 'idle', done: 0, total: 0, no_key: false }, built_at: null, target: 8 },
  print,
});
const item = { article_id: 1, title: 't', category_slug: 'products', tldr: 'x' } as never;

let db: Db;
let native: jest.Mocked<PrintSchedulerNative>;
beforeEach(async () => {
  db = await createMemoryDb();
  await createSchedule(db, '0 8 * * *');
  native = fakeNative();
});

const run = (data: Parameters<typeof runScheduledPrint>[0], cycle: () => Promise<CycleResult>) =>
  runScheduledPrint(data, { getDb: async () => db, native, ensureDevice: jest.fn(), cycle, now: () => now });

const texts = () => native.updateNotification.mock.calls.map((c) => c[0]);

describe('runScheduledPrint', () => {
  it('happy path: prints, reports the story count and re-arms tomorrow', async () => {
    const cycle = jest.fn(async () => cycleOf(record({ items: [item, item, item] })));
    const r = await run({ scheduledAt: now.getTime() - 5000 }, cycle);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ outcome: 'printed', message: 'Printed 3 stories' });
    expect(texts()).toContain('Printed 3 stories');
    // armed once up front and once after: always for the next 08:00 (tomorrow)
    const tomorrow = new Date(2026, 10, 8, 8, 0).getTime();
    expect(native.setNextAlarm).toHaveBeenCalledTimes(2);
    expect(native.setNextAlarm).toHaveBeenLastCalledWith(tomorrow, expect.any(Number));
  });

  it('singular story wording', async () => {
    const r = await run({}, async () => cycleOf(record({ items: [item] })));
    expect(r.message).toBe('Printed 1 story');
  });

  it('printer not found: failure message, still re-arms', async () => {
    const r = await run({}, async () => cycleOf(record({ status: 'failed', error: 'No printer found nearby' })));
    expect(r.outcome).toBe('printer-failed');
    expect(r.message).toBe('Printer not found — will try next time');
    expect(native.setNextAlarm).toHaveBeenCalled();
  });

  it('other print failure includes the reason', async () => {
    const r = await run({}, async () => cycleOf(record({ status: 'failed', error: 'Bluetooth is turned off.' })));
    expect(r.outcome).toBe('printer-failed');
    expect(r.message).toContain('Bluetooth is turned off.');
  });

  it('empty digest: nothing new to print', async () => {
    const r = await run({}, async () => cycleOf(null));
    expect(r).toEqual({ outcome: 'nothing', message: 'Nothing new to print' });
    expect(texts()).toContain('Nothing new to print');
  });

  it('a throwing cycle is caught and the schedule is still armed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await run({}, async () => {
      throw new Error('boom');
    });
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('boom');
    expect(native.setNextAlarm).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips the print when the alarm fired more than 2h late, but re-arms', async () => {
    const cycle = jest.fn(async () => cycleOf(null));
    const r = await run({ scheduledAt: now.getTime() - MAX_LATE_MS - 60_000 }, cycle);
    expect(r.outcome).toBe('skipped-late');
    expect(cycle).not.toHaveBeenCalled();
    expect(native.setNextAlarm).toHaveBeenCalled();
  });

  it('a manual test run ignores lateness', async () => {
    const cycle = jest.fn(async () => cycleOf(null));
    await run({ manual: true, scheduledAt: 1 }, cycle);
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('registers the device before running the cycle', async () => {
    const order: string[] = [];
    await runScheduledPrint(
      { manual: true },
      {
        getDb: async () => db,
        native,
        ensureDevice: () => order.push('device'),
        cycle: async () => {
          order.push('cycle');
          return cycleOf(null);
        },
        now: () => now,
      },
    );
    expect(order).toEqual(['device', 'cycle']);
  });
});
