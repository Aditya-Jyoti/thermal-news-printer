/** 5-field cron (minute hour day-of-month month day-of-week), local time. Mirrors backend/tnp/cron.py. */
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
const ATOM = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function validField(field: string, lo: number, hi: number): boolean {
  for (const part of field.split(',')) {
    const m = ATOM.exec(part);
    if (!m) return false;
    const [, start, end, step] = m;
    if (start !== undefined) {
      if (Number(start) < lo || Number(start) > hi) return false;
      if (end !== undefined && !(Number(start) <= Number(end) && Number(end) <= hi)) return false;
    } else if (end !== undefined) return false;
    if (step !== undefined && Number(step) < 1) return false;
  }
  return true;
}

/** Returns the normalized expression or throws. */
export function validateCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have exactly 5 fields (minute hour day month weekday)');
  fields.forEach((f, i) => {
    if (!validField(f, RANGES[i][0], RANGES[i][1])) throw new Error(`invalid cron ${NAMES[i]} field: '${f}'`);
  });
  return fields.join(' ');
}

function expand(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [, start, end, step] = ATOM.exec(part)!;
    let a = lo;
    let b = hi;
    if (start !== undefined) {
      a = Number(start);
      b = end !== undefined ? Number(end) : step !== undefined ? hi : a;
    }
    for (let v = a; v <= b; v += step ? Number(step) : 1) out.add(v);
  }
  return out;
}

interface Parsed {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  orRule: boolean;
}

function parse(expr: string): Parsed {
  const [mi, h, dom, mo, dow] = validateCron(expr).split(' ');
  return {
    minute: expand(mi, 0, 59),
    hour: expand(h, 0, 23),
    dom: expand(dom, 1, 31),
    month: expand(mo, 1, 12),
    dow: new Set([...expand(dow, 0, 7)].map((d) => d % 7)),
    orRule: !dom.startsWith('*') && !dow.startsWith('*'),
  };
}

function dayOk(p: Parsed, d: Date): boolean {
  const dom = p.dom.has(d.getDate());
  const dow = p.dow.has(d.getDay());
  return p.orRule ? dom || dow : dom && dow;
}

/** True if `expr` fires during the minute of `when` (local time). Throws on an invalid expression. */
export function cronMatches(expr: string, when: Date): boolean {
  const p = parse(expr);
  return (
    p.minute.has(when.getMinutes()) &&
    p.hour.has(when.getHours()) &&
    p.month.has(when.getMonth() + 1) &&
    dayOk(p, when)
  );
}

/**
 * First minute strictly after `from` (local time, seconds zeroed) at which `expr` fires, searching up to
 * 4 years ahead (covers Feb-29). Null if none or the expression is invalid.
 */
export function nextRun(expr: string, from: Date): Date | null {
  let p: Parsed;
  try {
    p = parse(expr);
  } catch {
    return null;
  }
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!p.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(p, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!p.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!p.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}
