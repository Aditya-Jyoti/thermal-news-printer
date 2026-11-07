import type { Schedule, Settings } from '../../api/types';
import { NotFound } from '../errors';
import type { Db, SqlValue } from './adapter';
import { applyUpdate } from './catalog';

// --- schedules ----------------------------------------------------------------

interface ScheduleRow {
  id: number;
  cron: string;
  label: string | null;
  enabled: number;
}

const toSchedule = (r: ScheduleRow): Schedule => ({ id: r.id, cron: r.cron, label: r.label, enabled: r.enabled !== 0 });

export async function listSchedules(db: Db): Promise<Schedule[]> {
  return (await db.all<ScheduleRow>('SELECT * FROM schedules ORDER BY id')).map(toSchedule);
}

export async function getSchedule(db: Db, id: number): Promise<Schedule> {
  const r = await db.get<ScheduleRow>('SELECT * FROM schedules WHERE id=?', [id]);
  if (!r) throw new NotFound(`schedule ${id} not found`);
  return toSchedule(r);
}

export async function createSchedule(db: Db, cron: string, label: string | null = null, enabled = true): Promise<Schedule> {
  const r = await db.run('INSERT INTO schedules(cron, label, enabled) VALUES(?,?,?)', [cron, label, enabled ? 1 : 0]);
  return getSchedule(db, r.lastInsertRowId);
}

export async function updateSchedule(
  db: Db,
  id: number,
  f: { cron?: string | null; label?: string | null; enabled?: boolean | null },
): Promise<Schedule> {
  await getSchedule(db, id);
  const sets: Record<string, SqlValue> = {};
  if (f.cron !== undefined && f.cron !== null) sets.cron = f.cron;
  if ('label' in f) sets.label = f.label ?? null;
  if (f.enabled !== undefined && f.enabled !== null) sets.enabled = f.enabled ? 1 : 0;
  await applyUpdate(db, 'schedules', id, sets);
  return getSchedule(db, id);
}

export async function deleteSchedule(db: Db, id: number): Promise<void> {
  await getSchedule(db, id);
  await db.run('DELETE FROM schedules WHERE id=?', [id]);
}

// --- settings (JSON-encoded values) -------------------------------------------

export async function getSetting<T = unknown>(db: Db, key: string, fallback: T | null = null): Promise<T | null> {
  const r = await db.get<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.run(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, JSON.stringify(value)],
  );
}

export const DEFAULT_SETTINGS: Settings = {
  max_items_total: 8,
  max_age_days: 3,
  model: 'google/gemma-3-12b-it',
  fallback_model: 'deepseek/deepseek-v4.1-flash',
  printer_address: null,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if ((SETTING_KEYS as string[]).includes(r.key)) out[r.key] = JSON.parse(r.value);
  return out as unknown as Settings;
}

/** Partial update; null values are ignored except printer_address and fallback_model (clearable). */
export async function updateSettings(db: Db, fields: Partial<Settings>): Promise<Settings> {
  for (const [k, v] of Object.entries(fields)) {
    if (!(SETTING_KEYS as string[]).includes(k) || v === undefined) continue;
    if (v === null && k !== 'printer_address' && k !== 'fallback_model') continue;
    await setSetting(db, k, v);
  }
  return getSettings(db);
}
