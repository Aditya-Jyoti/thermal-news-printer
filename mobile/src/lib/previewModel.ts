import type { DigestItem, EditionItem } from '@/api/types';

export interface PreviewModel {
  /** Summarized stories: what the real renderer draws. */
  ready: DigestItem[];
  /** Stories still without a TL;DR, shown as placeholders so the pane is never blank. */
  pending: DigestItem[];
}

/** Split the edition into printable (summarized) and placeholder (waiting for a summary) stories. */
export function previewModel(items: EditionItem[], idle: boolean): PreviewModel {
  const placeholder = idle ? 'Summary unavailable. Will retry.' : 'Summarizing…';
  const ready: DigestItem[] = [];
  const pending: DigestItem[] = [];
  for (const i of items) {
    if (i.tldr !== null) ready.push({ article_id: i.article_id, position: ready.length + 1, category_slug: i.category_slug, tldr: i.tldr });
    else pending.push({ article_id: i.article_id, position: pending.length + 1, category_slug: i.category_slug, tldr: placeholder });
  }
  return { ready, pending };
}
