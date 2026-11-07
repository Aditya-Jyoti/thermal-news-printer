/**
 * Pure layout engine for the 384px newspaper receipt. A faithful port of
 * backend/tnp/print/render.py (constants, leading, rules, masthead auto-fit, footer).
 * No Skia types: text is measured through the injected `TextMetrics`.
 */
import type { DigestItem } from '../api/types';

export const WIDTH = 384;
export const PAD = 6; // left margin
/** Right margin: the SC03h clips the right edge of a 384-dot row, so keep content well inside. */
export const PAD_R = 22;
export const TEXT_X = PAD;
export const TEXT_R = WIDTH - PAD_R;
/** Horizontal extent of the printable area; centred content is centred here, not on the raw canvas. */
const CX0 = PAD;
const CX1 = WIDTH - PAD_R;
export const TEXT_W = TEXT_R - TEXT_X;
export const TRAIL = 44;
export const BODY_SIZE = 21;
export const LEADING = 26;
/** Gray (0 black .. 255 white) below which a pixel becomes black. Same as render.py. */
export const THRESHOLD = 150;
export const PAPER_NAME = 'THE THERMAL TIMES';
export const EMPTY_TEXT = 'No new stories — check back later';

export type FontFace = 'mast' | 'body' | 'small' | 'tag' | 'date';
export interface FontSpec {
  face: FontFace;
  size: number;
}

export interface TextMetrics {
  measure(text: string, font: FontSpec): number;
  /** Positive pixel ascent / descent (PIL `getmetrics()` equivalent). */
  ascent(font: FontSpec): number;
  descent(font: FontSpec): number;
}

export type DrawOp =
  /** `y` is the TOP of the text box (PIL convention); the renderer adds the ascent for the baseline. */
  | { t: 'text'; x: number; y: number; text: string; font: FontSpec }
  /** Filled rect with inclusive pixel bounds (PIL `rectangle`). 1px rule = y0 === y1. */
  | { t: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'diamond'; cx: number; cy: number; r: number };

export interface RenderLayout {
  width: 384;
  height: number;
  ops: DrawOp[];
}

export interface LayoutOptions {
  editionDate: Date;
  editionName?: string;
  issueNo?: number;
}

const BODY: FontSpec = { face: 'body', size: BODY_SIZE };
const TAG: FontSpec = { face: 'tag', size: 17 };
const SMALL: FontSpec = { face: 'small', size: 13 };
const DATE_IT: FontSpec = { face: 'date', size: 15 };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Greedy pixel-width word wrap; over-long words are split by character (no hyphens). */
export function wrapText(
  text: string,
  font: FontSpec,
  maxW: number,
  measure: TextMetrics['measure'],
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (measure(word, font) > maxW) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      let cut = word.length;
      while (cut > 1 && measure(word.slice(0, cut), font) > maxW) cut--;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const trial = cur ? `${cur} ${word}` : word;
    if (measure(trial, font) <= maxW) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitMasthead(text: string, maxW: number, m: TextMetrics): FontSpec {
  for (let size = 44; size > 12; size--) {
    const f: FontSpec = { face: 'mast', size };
    if (m.measure(text, f) <= maxW) return f;
  }
  return { face: 'mast', size: 12 };
}

function hline(ops: DrawOp[], y: number, x0: number, x1: number) {
  ops.push({ t: 'rect', x0, y0: y, x1, y1: y });
}

function ornament(ops: DrawOp[], y: number, x0: number, x1: number) {
  const cx = Math.floor((x0 + x1) / 2);
  hline(ops, y, x0, cx - 22);
  hline(ops, y, cx + 22, x1);
  ops.push({ t: 'diamond', cx: cx - 12, cy: y, r: 2 });
  ops.push({ t: 'diamond', cx, cy: y, r: 3 });
  ops.push({ t: 'diamond', cx: cx + 12, cy: y, r: 2 });
}

export function layoutReceipt(items: DigestItem[], opts: LayoutOptions, m: TextMetrics): RenderLayout {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  const ops: DrawOp[] = [];
  const mast = fitMasthead(PAPER_NAME, TEXT_R - TEXT_X, m);
  const wrapped = ordered.map((i) => wrapText(i.tldr, BODY, TEXT_W, (t, f) => m.measure(t, f)));
  const itemH = wrapped.map((ls) => 24 + ls.length * LEADING + 6);
  const headerH = 100;
  const contentH = ordered.length ? itemH.reduce((a, b) => a + b, 0) + 14 * (ordered.length - 1) : 60;
  const footerH = 100 + TRAIL;
  let height = headerH + contentH + footerH;

  const centered = (y: number, text: string, font: FontSpec, x0 = CX0, x1 = CX1) => {
    const w = m.measure(text, font);
    ops.push({ t: 'text', x: Math.round(x0 + (x1 - x0 - w) / 2), y, text, font });
  };

  // masthead
  let y = 6;
  ops.push({ t: 'rect', x0: PAD, y0: y, x1: TEXT_R, y1: y + 2 });
  hline(ops, y + 5, PAD, TEXT_R);
  y += 9;
  ops.push({
    t: 'text',
    x: Math.round(CX0 + (CX1 - CX0 - m.measure(PAPER_NAME, mast)) / 2),
    y,
    text: PAPER_NAME,
    font: mast,
  });
  y += m.ascent(mast) + m.descent(mast) + 2;
  hline(ops, y, PAD, TEXT_R);
  y += 5;
  centered(y, formatDate(opts.editionDate), DATE_IT);
  y += 22;
  // no edition name / issue number row (user preference): the date line is followed directly by a rule
  ops.push({ t: 'rect', x0: PAD, y0: y, x1: TEXT_R, y1: y + 1 });
  y += 10;

  // items
  if (!ordered.length) {
    centered(y + 16, EMPTY_TEXT, DATE_IT, TEXT_X, TEXT_R);
    y += contentH;
  } else {
    ordered.forEach((it, n) => {
      ops.push({ t: 'text', x: TEXT_X, y, text: `#${it.category_slug}`, font: TAG });
      y += 24;
      for (const line of wrapped[n]) {
        ops.push({ t: 'text', x: TEXT_X, y, text: line, font: BODY });
        y += LEADING;
      }
      y += 6;
      if (n < ordered.length - 1) {
        ornament(ops, y + 3, TEXT_X, TEXT_R);
        y += 14;
      }
    });
  }

  // footer
  let fy = y + 4;
  ops.push({ t: 'rect', x0: PAD, y0: fy, x1: TEXT_R, y1: fy + 1 });
  hline(ops, fy + 4, PAD, TEXT_R);
  fy += 12;
  const n = ordered.length;
  centered(fy, `${n} ${n === 1 ? 'story' : 'stories'}`, DATE_IT);
  fy += 22;
  ornament(ops, fy, PAD + 60, TEXT_R - 60);
  fy += 10;
  centered(fy, "That's all for today!", DATE_IT);
  fy += 20;
  centered(fy, 'Full stories in the app', SMALL);

  // never clip (python's fixed header height can undershoot for odd fonts)
  height = Math.max(height, fy + m.ascent(SMALL) + m.descent(SMALL) + TRAIL);
  return { width: WIDTH, height, ops };
}
