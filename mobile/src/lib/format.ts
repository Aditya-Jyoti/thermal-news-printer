import type { Category } from '@/api/types';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Category color: explicit one if set, otherwise a stable pick from the supplied (dynamic theme) palette. */
export function categoryColor(cat: Pick<Category, 'id' | 'color'>, palette: string[]): string {
  if (cat.color) return cat.color;
  return palette[cat.id % palette.length] ?? '#888888';
}
