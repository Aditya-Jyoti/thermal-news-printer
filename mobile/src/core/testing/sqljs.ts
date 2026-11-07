// Test-only: in-memory Db adapter over sql.js (pure WASM SQLite). Never imported by app code.
import initSqlJs from 'sql.js';

import type { Db, RunResult, SqlValue } from '../db/adapter';
import { migrate } from '../db/schema';

let sqlP: ReturnType<typeof initSqlJs> | null = null;

export async function createMemoryDb(opts: { migrate?: boolean } = {}): Promise<Db> {
  sqlP ??= initSqlJs();
  const SQL = await sqlP;
  const raw = new SQL.Database();
  const db: Db = {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params: SqlValue[] = []): Promise<RunResult> {
      raw.run(sql, params);
      const id = raw.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
      return { changes: raw.getRowsModified(), lastInsertRowId: id };
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      return (await db.all<T>(sql, params))[0] ?? null;
    },
  };
  if (opts.migrate !== false) await migrate(db);
  return db;
}
