/**
 * Transport logic for the cat printer, independent of react-native-ble-plx so it can be unit-tested
 * with a fake link. Mirrors backend/tnp/print/catprinter/ble.py (see its notes on the SC03h).
 */

export const SERVICE_UUIDS = ['0000ae30-0000-1000-8000-00805f9b34fb', '0000af30-0000-1000-8000-00805f9b34fb'] as const;
export const TX_CHARACTERISTIC_UUID = '0000ae01-0000-1000-8000-00805f9b34fb';
export const RX_CHARACTERISTIC_UUID = '0000ae02-0000-1000-8000-00805f9b34fb';

export const KNOWN_NAME_RE = /^(SC0\d|GB0[1-4]|GT0[1-3]|MX0\d|MX1\d|YT0\d|JX0\d|X\d{1,2}|PD\d|Cat ?Printer)/i;

export const PRINTER_READY_NOTIFICATION = Uint8Array.from([0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff]);
const STATE_REPLY_PREFIX = [0x51, 0x78, 0xa3, 0x01];

// Hardware-verified on the SC03h: 244-byte chunks time the link out, 100 bytes @ 20 ms works.
// With flow control honoured (below) the printer can no longer be overrun, so pace at 10 ms
// (~10 KB/s, the rate NaitLee/Cat-Printer reaches with 200-byte chunks @ 20 ms) to avoid starving it.
export const MAX_CHUNK = 100;
export const PACING_MS = 10;
/** Give up waiting for a 'resume' after this long and carry on (a lost notification must not hang a print). */
export const PAUSE_TIMEOUT_MS = 5_000;
/** ATT overhead: a write-without-response carries at most MTU - 3 bytes. */
export const ATT_OVERHEAD = 3;

/**
 * Flow control, protocol facts from NaitLee/Cat-Printer (GPL-3.0; nothing copied): the printer sends
 * 51 78 ae 01 01 00 10 70 ff on 0xAE02 when its buffer is full (pause) and 51 78 ae 01 01 00 00 00 ff
 * when it can take data again (resume). The latter is byte-identical to rbaron's 'ready' notification.
 */
export const DATA_FLOW_PAUSE = Uint8Array.from([0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x10, 0x70, 0xff]);
export const DATA_FLOW_RESUME = PRINTER_READY_NOTIFICATION;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && b.every((v, i) => a[i] === v);
export const isFlowPause = (b: Uint8Array) => same(b, DATA_FLOW_PAUSE);
export const isFlowResume = (b: Uint8Array) => same(b, DATA_FLOW_RESUME);
export const DONE_TIMEOUT_MS = 30_000;
export const GRACE_MS = 1_000;
export const CONNECT_ATTEMPTS = 3;
export const CONNECT_BACKOFF_MS = 700;
export const REQUESTED_MTU = 247;
export const SCAN_TIMEOUT_MS = 10_000;

export class PrinterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PrinterError';
  }
}

export class PrinterNotFound extends PrinterError {
  constructor(message = 'No printer found. Is it switched on and within range?') {
    super(message);
    this.name = 'PrinterNotFound';
  }
}

export function isPrinter(name: string | null | undefined, serviceUuids?: readonly string[] | null): boolean {
  if (serviceUuids?.some((u) => (SERVICE_UUIDS as readonly string[]).includes(u.toLowerCase()))) return true;
  return !!name && KNOWN_NAME_RE.test(name);
}

export function chunkify(data: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

const startsWith = (b: Uint8Array, prefix: readonly number[]) => prefix.every((v, i) => b[i] === v);

export function isStateReply(b: Uint8Array): boolean {
  return startsWith(b, STATE_REPLY_PREFIX);
}

/** The reference's 'ready' notification, or the 2nd get-device-state reply of a job (SC03h). */
export function isJobDone(payload: Uint8Array, received: Uint8Array[]): boolean {
  if (payload.length === PRINTER_READY_NOTIFICATION.length && PRINTER_READY_NOTIFICATION.every((v, i) => payload[i] === v)) {
    return true;
  }
  return isStateReply(payload) && received.filter(isStateReply).length >= 2;
}

/** A connected GATT link to a printer (adapter over ble-plx; faked in tests). */
export interface PrinterLink {
  /** Best effort; failures are ignored. Resolves to the negotiated MTU when known. */
  requestMtu(mtu: number): Promise<number | void>;
  /** Subscribe to RX notifications. Returns an unsubscribe function. */
  subscribe(onData: (data: Uint8Array) => void, onError: (e: unknown) => void): Promise<() => void>;
  /** Write one chunk to TX (write without response). */
  write(chunk: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
}

export interface Connector {
  connect(deviceId: string): Promise<PrinterLink>;
}

export interface SendOptions {
  maxChunk?: number;
  pacingMs?: number;
  pauseTimeoutMs?: number;
  doneTimeoutMs?: number;
  graceMs?: number;
  connectAttempts?: number;
  connectBackoffMs?: number;
  onProgress?: (p: { sentBytes: number; totalBytes: number }) => void;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function connectWithRetry(c: Connector, id: string, o: SendOptions = {}): Promise<PrinterLink> {
  const attempts = o.connectAttempts ?? CONNECT_ATTEMPTS;
  const sleep = o.sleep ?? realSleep;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await c.connect(id);
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep((o.connectBackoffMs ?? CONNECT_BACKOFF_MS) * (i + 1));
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new PrinterError(`Could not connect to the printer after ${attempts} attempts (${detail}). Check that it is on and nearby.`, last);
}

/** Connect, stream `data`, wait for completion (or timeout -> warning), always disconnect. */
export async function sendJob(c: Connector, deviceId: string, data: Uint8Array, o: SendOptions = {}): Promise<void> {
  const sleep = o.sleep ?? realSleep;
  const warn = o.warn ?? ((m: string) => console.warn(m));
  const link = await connectWithRetry(c, deviceId, o);
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const mtu = await link.requestMtu(REQUESTED_MTU).catch(() => undefined);
    // Never exceed what the negotiated MTU allows (and the hardware-verified cap).
    const chunkSize = Math.max(20, Math.min(o.maxChunk ?? MAX_CHUNK, typeof mtu === 'number' && mtu > 0 ? mtu - ATT_OVERHEAD : Infinity));

    console.warn(`[tnp] link mtu=${mtu ?? 'unknown'} chunk=${chunkSize} pacing=${o.pacingMs ?? PACING_MS}ms`);
    const received: Uint8Array[] = [];
    let done = false;
    let linkError: unknown = null;
    let wake: (() => void) | null = null;
    const notify = () => wake?.();
    let paused = false;
    let allSent = false;
    let resumeWake: (() => void) | null = null;
    unsubscribe = await link.subscribe(
      (payload) => {
        if (isFlowPause(payload)) {
          paused = true;
          return;
        }
        if (isFlowResume(payload) && !allSent) {
          // Mid-stream this is a resume, not 'job done'.
          paused = false;
          resumeWake?.();
          return;
        }
        received.push(payload);
        if (!done && isJobDone(payload, received)) {
          done = true;
          notify();
        }
      },
      (e) => {
        if (!done) linkError = e;
        resumeWake?.();
        notify();
      },
    );

    const parts = chunkify(data, chunkSize);
    const pauseTimeout = o.pauseTimeoutMs ?? PAUSE_TIMEOUT_MS;
    const waitWhilePaused = async () => {
      if (!paused || linkError) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          paused = false;
          warn(`Printer did not resume within ${pauseTimeout / 1000}s, continuing`);
          resolve();
        }, pauseTimeout);
        resumeWake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      resumeWake = null;
    };
    const pacing = o.pacingMs ?? PACING_MS;
    let sent = 0;
    o.onProgress?.({ sentBytes: 0, totalBytes: data.length });
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      await waitWhilePaused();
      if (linkError) break;
      if (i === parts.length - 1) allSent = true; // from here a 0x00 notification means 'job done'
      await link.write(part);
      sent += part.length;
      o.onProgress?.({ sentBytes: sent, totalBytes: data.length });
      if (pacing > 0) await sleep(pacing);
    }
    allSent = true;
    if (linkError && !done) throw new PrinterError('The printer disconnected during printing.', linkError);

    if (!done) {
      const timeoutMs = o.doneTimeoutMs ?? DONE_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        wake = resolve;
        if (done || linkError) resolve();
      });
      if (linkError && !done) throw new PrinterError('The printer disconnected before confirming the print.', linkError);
      if (!done) warn(`Printer did not confirm completion within ${timeoutMs / 1000}s`);
    }
    if (done) await sleep(o.graceMs ?? GRACE_MS);
  } catch (e) {
    if (e instanceof PrinterError) throw e;
    throw new PrinterError(`Printing over Bluetooth failed: ${e instanceof Error ? e.message : String(e)}`, e);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      unsubscribe?.();
    } catch {}
    await link.disconnect().catch(() => undefined);
  }
}
