import { XMLParser } from 'fast-xml-parser';

import { firstImageSrc } from './html';

export interface ParsedEntry {
  title: string;
  url: string;
  guid: string;
  author: string | null;
  publishedAt: Date | null;
  contentHtml: string | null;
  imageUrl: string | null;
}

export interface ParsedFeed {
  title: string | null;
  entries: ParsedEntry[];
}

type Node = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  'item', 'entry', 'link', 'enclosure', 'media:content', 'media:thumbnail', 'media:group', 'content', 'author',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const asNode = (v: unknown): Node | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null);
const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text of a node that may be a string or {#text, @_attr...}. */
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? text(v[0]) : '';
  const n = asNode(v);
  return n && typeof n['#text'] === 'string' ? (n['#text'] as string).trim() : '';
}

const attr = (n: unknown, name: string): string => {
  const o = asNode(n);
  const v = o?.[`@_${name}`];
  return typeof v === 'string' ? v : '';
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** RFC 822 / ISO 8601 date parsing that does not depend on engine quirks. */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = Date.parse(s);
  if (!Number.isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(iso);
  const m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,5}|[+-]\d{4})?$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      let year = parseInt(m[3], 10);
      if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
      let offset = 0;
      const tz = m[7];
      if (tz && /^[+-]\d{4}$/.test(tz)) {
        offset = (tz[0] === '-' ? -1 : 1) * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3), 10));
      } else if (tz) {
        const named: Record<string, number> = { EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };
        offset = named[tz.toUpperCase()] ?? 0;
      }
      const t = Date.UTC(year, mon, parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6] ?? '0', 10));
      return new Date(t - offset * 60_000);
    }
  }
  return Number.isNaN(iso) ? null : new Date(iso);
}

function pickLink(entry: Node): string {
  const links = asArray(entry.link);
  // Atom: <link rel="alternate" href>; RSS: <link>text</link>
  let fallback = '';
  for (const l of links) {
    const href = attr(l, 'href');
    const rel = attr(l, 'rel') || 'alternate';
    if (href) {
      if (rel === 'alternate') return href;
      if (rel !== 'enclosure' && rel !== 'self' && !fallback) fallback = href;
    } else {
      const t = text(l);
      if (t) return t;
    }
  }
  return fallback;
}

function contentHtml(entry: Node): string | null {
  const candidates: string[] = [];
  for (const c of asArray(entry['content:encoded'])) candidates.push(text(c));
  for (const c of asArray(entry.content)) candidates.push(text(c));
  const best = candidates.filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (best) return best;
  return text(entry.summary) || text(entry.description) || null;
}

function mediaContents(entry: Node): unknown[] {
  const out = [...asArray(entry['media:content'])];
  for (const g of asArray(entry['media:group'])) out.push(...asArray(asNode(g)?.['media:content']));
  return out;
}

export function extractImage(entry: Node, html: string | null): string | null {
  for (const m of mediaContents(entry)) {
    const url = attr(m, 'url');
    const type = attr(m, 'type').toLowerCase();
    const medium = attr(m, 'medium').toLowerCase();
    if (url && (type.startsWith('image') || medium === 'image' || !(type || medium))) return url;
  }
  for (const t of asArray(entry['media:thumbnail'])) {
    const url = attr(t, 'url');
    if (url) return url;
  }
  for (const e of asArray(entry.enclosure)) {
    if (attr(e, 'type').toLowerCase().startsWith('image') && attr(e, 'url')) return attr(e, 'url');
  }
  for (const l of asArray(entry.link)) {
    if (attr(l, 'rel') === 'enclosure' && attr(l, 'type').toLowerCase().startsWith('image') && attr(l, 'href')) {
      return attr(l, 'href');
    }
  }
  return firstImageSrc(html);
}

function author(entry: Node): string | null {
  const a = asArray(entry.author)[0];
  const n = asNode(a);
  const v = (n ? text(n.name) : text(a)) || text(entry['dc:creator']);
  return v || null;
}

function parseEntry(e: Node): ParsedEntry | null {
  const title = text(e.title);
  const url = pickLink(e);
  if (!title && !url) return null;
  const html = contentHtml(e);
  const dateRaw = text(e.pubDate) || text(e.published) || text(e.updated) || text(e['dc:date']) || text(e.pubdate);
  return {
    title: title || url,
    url,
    guid: text(e.guid) || text(e.id) || url || title,
    author: author(e),
    publishedAt: parseDate(dateRaw),
    contentHtml: html,
    imageUrl: extractImage(e, html),
  };
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom XML. Throws on unparseable/unsupported documents. */
export function parseFeed(xml: string): ParsedFeed {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new Error(`unparseable feed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rss = asNode(doc.rss);
  const atom = asNode(doc.feed);
  const rdf = asNode(doc['rdf:RDF']);
  let title: string | null = null;
  let rawEntries: unknown[] = [];
  if (rss) {
    const channel = asNode(rss.channel) ?? {};
    title = text(channel.title) || null;
    rawEntries = asArray(channel.item);
  } else if (atom) {
    title = text(atom.title) || null;
    rawEntries = asArray(atom.entry);
  } else if (rdf) {
    title = text(asNode(rdf.channel)?.title) || null;
    rawEntries = asArray(rdf.item);
  } else {
    throw new Error('unparseable feed: not RSS or Atom');
  }
  const entries: ParsedEntry[] = [];
  for (const raw of rawEntries) {
    const n = asNode(raw);
    const parsed = n ? parseEntry(n) : null;
    if (parsed) entries.push(parsed);
  }
  return { title, entries };
}
