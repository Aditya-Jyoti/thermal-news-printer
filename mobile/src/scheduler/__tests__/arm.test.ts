import type { Db } from '../../core/db/adapter';
import { createSchedule, updateSchedule } from '../../core/db/settings';
import { createMemoryDb } from '../../core/testing/sqljs';
import { computeNext, rearm } from '../arm';
import { fakeNative } from '../testing';

const now = new Date(2026, 10, 7, 9, 0, 0); // Sat 2026-11-07 09:00 local

let db: Db;
beforeEach(async () => {
  db = await createMemoryDb();
});

describe('computeNext', () => {
  it('picks the soonest enabled schedule', () => {
    const next = computeNext(
      [
        { id: 1, cron: '0 8 * * *', label: null, enabled: true }, // tomorrow 08:00
        { id: 2, cron: '30 18 * * *', label: null, enabled: true }, // today 18:30
        { id: 3, cron: '0 10 * * *', label: null, enabled: false }, // soonest but disabled
      ],
      now,
    );
    expect(next?.scheduleId).toBe(2);
    expect(next?.at).toEqual(new Date(2026, 10, 7, 18, 30));
  });
  it('ignores invalid cron and returns null with nothing usable', () => {
    expect(computeNext([{ id: 1, cron: 'bogus', label: null, enabled: true }], now)).toBeNull();
    expect(computeNext([], now)).toBeNull();
  });
});

describe('rearm', () => {
  it('arms the soonest enabled schedule', async () => {
    const native = fakeNative();
    await createSchedule(db, '0 8 * * *');
    const evening = await createSchedule(db, '30 18 * * *');
    const r = await rearm(db, { native, now });
    expect(native.setNextAlarm).toHaveBeenCalledTimes(1);
    expect(native.setNextAlarm).toHaveBeenCalledWith(new Date(2026, 10, 7, 18, 30).getTime(), evening.id);
    expect(r.mode).toBe('exact');
    expect(r.next?.scheduleId).toBe(evening.id);
  });

  it('re-arms to a different schedule after it is disabled', async () => {
    const native = fakeNative();
    const morning = await createSchedule(db, '0 8 * * *');
    const evening = await createSchedule(db, '30 18 * * *');
    await updateSchedule(db, evening.id, { enabled: false });
    await rearm(db, { native, now });
    expect(native.setNextAlarm).toHaveBeenCalledWith(new Date(2026, 10, 8, 8, 0).getTime(), morning.id);
  });

  it('cancels the alarm when no schedule is enabled', async () => {
    const native = fakeNative();
    const s = await createSchedule(db, '0 8 * * *');
    await updateSchedule(db, s.id, { enabled: false });
    const r = await rearm(db, { native, now });
    expect(native.cancelAlarm).toHaveBeenCalledTimes(1);
    expect(native.setNextAlarm).not.toHaveBeenCalled();
    expect(r.next).toBeNull();
  });

  it('reports the inexact mode and tolerates a missing native module', async () => {
    const native = fakeNative();
    native.setNextAlarm.mockReturnValue('inexact');
    await createSchedule(db, '0 8 * * *');
    expect((await rearm(db, { native, now })).mode).toBe('inexact');
    const r = await rearm(db, { native: null, now });
    expect(r.mode).toBeNull();
    expect(r.next).not.toBeNull();
  });
});
