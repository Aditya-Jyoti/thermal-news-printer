/** Minimal async SQLite surface used by core/. expo-sqlite in the app, sql.js in tests. */
export type SqlValue = string | number | null;

export interface RunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
}

export async function exists(db: Db, sql: string, params: SqlValue[] = []): Promise<boolean> {
  return (await db.get(sql, params)) !== null;
}
