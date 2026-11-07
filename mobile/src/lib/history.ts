import type { HistoryEdition } from '@/api/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DayGroup {
  /** Local calendar day, YYYY-MM-DD. */
  key: string;
  label: string;
  editions: HistoryEdition[];
  stories: number;
  printed: number;
  notPrinted: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function dayLabel(d: Date, now: Date): string {
  const key = localDayKey(d);
  if (key === localDayKey(now)) return 'Today';
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(y)) return 'Yesterday';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Group archived editions by local calendar day, newest first. */
export function groupHistoryByDay(editions: HistoryEdition[], now: Date = new Date()): DayGroup[] {
  const sorted = [...editions].sort((a, b) => b.archived_at.localeCompare(a.archived_at) || b.id - a.id);
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const e of sorted) {
    const d = new Date(e.archived_at);
    const key = localDayKey(d);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: dayLabel(d, now), editions: [], stories: 0, printed: 0, notPrinted: 0 };
      byKey.set(key, g);
      groups.push(g);
    }
    g.editions.push(e);
    g.stories += e.items.length;
    if (e.printed) g.printed += 1;
    else g.notPrinted += 1;
  }
  return groups;
}
