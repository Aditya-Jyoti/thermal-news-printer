import { sha256Hex } from './sha256';

const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/;

/** Lowercase scheme+host, drop utm_* params and fragment, strip trailing slash. */
export function normalizeUrl(url: string): string {
  const u = url.trim();
  const m = URL_RE.exec(u);
  if (!m) return u.replace(/#.*$/, '').replace(/\/+$/, '');
  const [, scheme, host, path, query] = m;
  const kept = (query ?? '')
    .split('&')
    .filter((p) => p !== '' && !p.toLowerCase().startsWith('utm_'));
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${path.replace(/\/+$/, '')}${kept.length ? '?' + kept.join('&') : ''}`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sha256 of the normalized URL (fallback: normalized title). */
export function computeFingerprint(url: string | null | undefined, title: string): string {
  const basis = url && url.trim() ? normalizeUrl(url) : normalizeTitle(title);
  return sha256Hex(basis);
}
