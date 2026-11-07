/** Strip anything that looks like an API key / bearer token before it is logged or stored. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text
    .replace(/sk-or-[A-Za-z0-9_-]{4,}/g, 'sk-or-***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/authorization["']?\s*[:=]\s*["']?[^\s"',}]+/gi, 'authorization: ***');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}
