const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  bull: '•', middot: '·', eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä', euro: '€',
  pound: '£', yen: '¥', deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Lightweight HTML -> plain text: block tags become paragraph breaks, scripts/styles dropped. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let t = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|li|blockquote|tr|h[1-6]|pre)\s*>/gi, '\n\n');
  t = t.replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  t = t.replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t || null;
}

/** src of the first <img> in an HTML fragment. */
export function firstImageSrc(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  const src = m ? (m[1] ?? m[2]) : null;
  return src ? decodeEntities(src) : null;
}
