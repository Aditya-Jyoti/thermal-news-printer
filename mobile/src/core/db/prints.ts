import type { DigestItem, PrintItem, PrintRecord, PrintStatus, PrintTrigger } from '../../api/types';
import { NotFound } from '../errors';
import type { Db } from './adapter';
import { nowIso } from './time';

/** Create a 'pending' print with its items; returns the print id. */
export async function createPrint(db: Db, trigger: PrintTrigger, items: DigestItem[]): Promise<number> {
  const r = await db.run("INSERT INTO prints(created_at, trigger, status) VALUES(?,?,'pending')", [nowIso(), trigger]);
  const pid = r.lastInsertRowId;
  for (const i of items) {
    await db.run(
      'INSERT INTO print_items(print_id, article_id, position, category_slug, tldr) VALUES(?,?,?,?,?)',
      [pid, i.article_id, i.position, i.category_slug, i.tldr],
    );
  }
  return pid;
}

export async function setPrintStatus(db: Db, id: number, status: PrintStatus, error: string | null = null): Promise<void> {
  const r = await db.run('UPDATE prints SET status=?, error=? WHERE id=?', [status, error, id]);
  if (r.changes === 0) throw new NotFound(`print ${id} not found`);
}

interface ItemRow {
  position: number;
  article_id: number | null;
  category_slug: string;
  tldr: string;
  title: string | null;
  url: string | null;
  image_url: string | null;
}

export async function getPrintItems(db: Db, printId: number): Promise<PrintItem[]> {
  return (await db.all<ItemRow>(
    'SELECT pi.*, a.title AS title, a.url AS url, a.image_url AS image_url FROM print_items pi LEFT JOIN articles a ON a.id=pi.article_id ' +
      'WHERE pi.print_id=? ORDER BY pi.position',
    [printId],
  )).map(toItem);
}

interface PrintRow {
  id: number;
  created_at: string;
  trigger: PrintTrigger;
  status: PrintStatus;
  error: string | null;
}

const toItem = (i: ItemRow): PrintItem => ({
  position: i.position,
  article_id: i.article_id,
  category_slug: i.category_slug,
  tldr: i.tldr,
  title: i.title,
  url: i.url,
  image_url: i.image_url,
});

const toRecord = (r: PrintRow, items: PrintItem[]): PrintRecord => ({
  id: r.id,
  created_at: r.created_at,
  trigger: r.trigger,
  status: r.status,
  error: r.error,
  items,
});

export async function getPrint(db: Db, id: number): Promise<PrintRecord> {
  const r = await db.get<PrintRow>('SELECT * FROM prints WHERE id=?', [id]);
  if (!r) throw new NotFound(`print ${id} not found`);
  return toRecord(r, await getPrintItems(db, r.id));
}

export async function listPrints(db: Db, limit = 20, offset = 0): Promise<{ items: PrintRecord[]; total: number }> {
  const total = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prints'))?.n ?? 0;
  const rows = await db.all<PrintRow>('SELECT * FROM prints ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
  if (rows.length === 0) return { items: [], total };
  // One query for every print's items (no N+1).
  const all = await db.all<ItemRow & { print_id: number }>(
    'SELECT pi.*, a.title AS title, a.url AS url, a.image_url AS image_url FROM print_items pi ' +
      'LEFT JOIN articles a ON a.id=pi.article_id ' +
      `WHERE pi.print_id IN (${rows.map(() => '?').join(',')}) ORDER BY pi.print_id, pi.position`,
    rows.map((r) => r.id),
  );
  const byPrint = new Map<number, PrintItem[]>();
  for (const i of all) {
    const list = byPrint.get(i.print_id);
    if (list) list.push(toItem(i));
    else byPrint.set(i.print_id, [toItem(i)]);
  }
  return { items: rows.map((r) => toRecord(r, byPrint.get(r.id) ?? [])), total };
}

/** Items of the most recent print that actually printed (empty if none). */
export async function getLastPrintItems(db: Db): Promise<PrintItem[]> {
  const r = await db.get<{ id: number }>("SELECT id FROM prints WHERE status='printed' ORDER BY id DESC LIMIT 1");
  return r ? getPrintItems(db, r.id) : [];
}
