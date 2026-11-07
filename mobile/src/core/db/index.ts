import type { Db } from './adapter';
import { migrate } from './schema';
import { seedDefaults } from '../seed';

export * from './adapter';
export * from './articles';
export * from './catalog';
export * from './edition';
export * from './prints';
export * from './settings';
export { migrate } from './schema';

/** Migrate + seed an opened Db (idempotent). */
export async function initDb(db: Db): Promise<Db> {
  await migrate(db);
  await seedDefaults(db);
  return db;
}

let shared: Promise<Db> | null = null;

/** The app-wide expo-sqlite database, opened/migrated/seeded on first use. */
export function getDb(): Promise<Db> {
  if (!shared) {
    shared = (async () => {
      const { openExpoDb } = await import('./expo');
      return initDb(await openExpoDb());
    })();
    shared.catch(() => {
      shared = null; // allow retry after a failed open
    });
  }
  return shared;
}
