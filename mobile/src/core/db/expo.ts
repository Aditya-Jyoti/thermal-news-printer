import * as SQLite from 'expo-sqlite';

import type { Db, RunResult, SqlValue } from './adapter';

/** Db adapter over expo-sqlite's async API. */
export async function openExpoDb(name = 'tnp.db'): Promise<Db> {
  const raw = await SQLite.openDatabaseAsync(name);
  return {
    exec: (sql) => raw.execAsync(sql),
    async run(sql, params = []): Promise<RunResult> {
      const r = await raw.runAsync(sql, params);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    all: <T,>(sql: string, params: SqlValue[] = []) => raw.getAllAsync<T>(sql, params),
    async get<T>(sql: string, params: SqlValue[] = []) {
      return (await raw.getFirstAsync<T>(sql, params)) ?? null;
    },
  };
}
