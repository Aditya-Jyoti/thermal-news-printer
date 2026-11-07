import { cronMatches, nextRun, validateCron } from '../cron';

// Local-time constructor: month is 1-based here. 2026-11-01 is a Sunday.
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const parts = (d: Date | null) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

describe('cronMatches', () => {
  it('matches every minute for all stars', () => {
    expect(cronMatches('* * * * *', at(2026, 11, 2, 0, 0))).toBe(true);
    expect(cronMatches('* * * * *', at(2026, 11, 7, 23, 59))).toBe(true);
  });
  it('fixed time', () => {
    expect(cronMatches('0 8 * * *', at(2026, 11, 9, 8, 0))).toBe(true);
    expect(cronMatches('0 8 * * *', at(2026, 11, 9, 8, 1))).toBe(false);
    expect(cronMatches('0 8 * * *', at(2026, 11, 9, 7, 0))).toBe(false);
  });
  it('lists, ranges and steps', () => {
    expect(cronMatches('0,30 9,17 * * *', at(2026, 11, 9, 9, 30))).toBe(true);
    expect(cronMatches('0,30 9,17 * * *', at(2026, 11, 9, 9, 15))).toBe(false);
    expect(cronMatches('0 9-17 * * *', at(2026, 11, 9, 17, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', at(2026, 11, 9, 18, 0))).toBe(false);
    expect([10, 20, 30].every((m) => cronMatches('10-30/10 * * * *', at(2026, 11, 9, 5, m)))).toBe(true);
    expect(cronMatches('10-30/10 * * * *', at(2026, 11, 9, 5, 15))).toBe(false);
    expect(cronMatches('*/15 * * * *', at(2026, 11, 9, 5, 45))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(2026, 11, 9, 5, 44))).toBe(false);
    expect(cronMatches('5/20 * * * *', at(2026, 11, 9, 5, 25))).toBe(true);
    expect(cronMatches('5/20 * * * *', at(2026, 11, 9, 5, 30))).toBe(false);
  });
  it('month restriction', () => {
    expect(cronMatches('0 0 * 11 *', at(2026, 11, 9, 0, 0))).toBe(true);
    expect(cronMatches('0 0 * 12 *', at(2026, 11, 9, 0, 0))).toBe(false);
  });
  it.each(['0', '7'])('day-of-week %s is Sunday', (s) => {
    expect(cronMatches(`0 10 * * ${s}`, at(2026, 11, 1, 10, 0))).toBe(true);
    expect(cronMatches(`0 10 * * ${s}`, at(2026, 11, 2, 10, 0))).toBe(false);
  });
  it('dom/dow OR rule when both restricted, AND otherwise', () => {
    // 15th OR Monday: 2026-11-02 is Monday, 2026-11-15 a Sunday
    expect(cronMatches('0 0 15 * 1', at(2026, 11, 2, 0, 0))).toBe(true);
    expect(cronMatches('0 0 15 * 1', at(2026, 11, 15, 0, 0))).toBe(true);
    expect(cronMatches('0 0 15 * 1', at(2026, 11, 3, 0, 0))).toBe(false);
    expect(cronMatches('0 0 15 * *', at(2026, 11, 15, 0, 0))).toBe(true);
    expect(cronMatches('0 0 15 * *', at(2026, 11, 2, 0, 0))).toBe(false);
  });
});

describe('validateCron', () => {
  it.each(['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *', '5-2 * * * *'])(
    'rejects %s',
    (e) => expect(() => validateCron(e)).toThrow(),
  );
  it('normalizes whitespace', () => expect(validateCron('  0   8 * *  * ')).toBe('0 8 * * *'));
});

describe('nextRun', () => {
  it('daily time later today / tomorrow', () => {
    expect(parts(nextRun('30 8 * * *', at(2026, 11, 7, 7, 0)))).toEqual([2026, 11, 7, 8, 30]);
    expect(parts(nextRun('30 8 * * *', at(2026, 11, 7, 9, 0)))).toEqual([2026, 11, 8, 8, 30]);
  });
  it('is strictly after from, even from exactly the minute', () => {
    expect(parts(nextRun('30 8 * * *', at(2026, 11, 7, 8, 30)))).toEqual([2026, 11, 8, 8, 30]);
    expect(parts(nextRun('30 8 * * *', at(2026, 11, 7, 8, 29, 59)))).toEqual([2026, 11, 7, 8, 30]);
  });
  it('lists, ranges, steps', () => {
    expect(parts(nextRun('0,30 9,17 * * *', at(2026, 11, 7, 9, 30)))).toEqual([2026, 11, 7, 17, 0]);
    expect(parts(nextRun('*/15 * * * *', at(2026, 11, 7, 5, 44)))).toEqual([2026, 11, 7, 5, 45]);
    expect(parts(nextRun('10-30/10 * * * *', at(2026, 11, 7, 5, 30)))).toEqual([2026, 11, 7, 6, 10]);
  });
  it('weekday 0 and 7 are Sunday', () => {
    // 2026-11-07 is Saturday -> next Sunday is the 8th
    expect(parts(nextRun('0 10 * * 0', at(2026, 11, 7, 12, 0)))).toEqual([2026, 11, 8, 10, 0]);
    expect(parts(nextRun('0 10 * * 7', at(2026, 11, 7, 12, 0)))).toEqual([2026, 11, 8, 10, 0]);
  });
  it('weekday range Mon-Fri skips the weekend', () => {
    expect(parts(nextRun('0 8 * * 1-5', at(2026, 11, 7, 12, 0)))).toEqual([2026, 11, 9, 8, 0]);
  });
  it('OR rule', () => {
    expect(parts(nextRun('0 0 15 * 1', at(2026, 11, 7, 12, 0)))).toEqual([2026, 11, 9, 0, 0]);
    expect(parts(nextRun('0 0 15 * 1', at(2026, 11, 10, 12, 0)))).toEqual([2026, 11, 15, 0, 0]);
  });
  it('month and year rollover', () => {
    expect(parts(nextRun('0 0 1 1 *', at(2026, 11, 7, 12, 0)))).toEqual([2027, 1, 1, 0, 0]);
    expect(parts(nextRun('0 0 * 3 *', at(2026, 11, 7, 12, 0)))).toEqual([2027, 3, 1, 0, 0]);
  });
  it('Feb 29 is found within 4 years', () => {
    expect(parts(nextRun('0 0 29 2 *', at(2026, 11, 7, 12, 0)))).toEqual([2028, 2, 29, 0, 0]);
  });
  it('null for invalid or impossible expressions', () => {
    expect(nextRun('nope', new Date())).toBeNull();
    expect(nextRun('0 0 31 2 *', at(2026, 11, 7, 12, 0))).toBeNull();
  });
});
