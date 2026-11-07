import { describe, expect, it, jest } from '@jest/globals';
import { encodeBitmap } from '../protocol';
import { makeTestBitmap } from '../testPattern';
import {
  PrinterError,
  chunkify,
  isJobDone,
  isPrinter,
  sendJob,
  type Connector,
  type PrinterLink,
} from '../transport';

const STATE_REPLY = Uint8Array.from([0x51, 0x78, 0xa3, 0x01, 0x03, 0x00, 0x00, 0x02, 0x28, 0xf2, 0xff]);
const READY = Uint8Array.from([0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff]);

function fakeLink(onWrite?: (n: number, emit: (d: Uint8Array) => void, fail: (e: unknown) => void) => void) {
  const writes: Uint8Array[] = [];
  const log: string[] = [];
  let emit: (d: Uint8Array) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const link: PrinterLink = {
    requestMtu: async () => void log.push('mtu'),
    subscribe: async (d, e) => {
      emit = d;
      fail = e;
      return () => void log.push('unsub');
    },
    write: async (c) => {
      writes.push(c);
      onWrite?.(writes.length, (d) => emit(d), (e) => fail(e));
    },
    disconnect: async () => void log.push('disconnect'),
  };
  return { link, writes, log, emit: (d: Uint8Array) => emit(d) };
}

const fast = { pacingMs: 0, graceMs: 0, connectBackoffMs: 0, sleep: async () => {} };

describe('helpers', () => {
  it('chunkifies', () => {
    expect(chunkify(new Uint8Array(250), 100).map((x) => x.length)).toEqual([100, 100, 50]);
  });
  it('recognises printers', () => {
    expect(isPrinter('SC03h-5CA6')).toBe(true);
    expect(isPrinter('Headphones')).toBe(false);
    expect(isPrinter(null, ['0000ae30-0000-1000-8000-00805f9b34fb'])).toBe(true);
  });
  it('done detection', () => {
    expect(isJobDone(READY, [READY])).toBe(true);
    expect(isJobDone(STATE_REPLY, [STATE_REPLY])).toBe(false);
    expect(isJobDone(STATE_REPLY, [STATE_REPLY, STATE_REPLY])).toBe(true);
  });
});

describe('sendJob', () => {
  const data = encodeBitmap(makeTestBitmap());
  const lastWrite = Math.ceil(data.length / 100);

  it('chunks to 100 bytes, paces, reports progress, finishes on 2nd state reply, disconnects', async () => {
    const f = fakeLink((n, emit) => {
      if (n === 1) emit(STATE_REPLY);
      if (n === lastWrite) emit(STATE_REPLY);
    });
    const sleeps: number[] = [];
    const progress: number[] = [];
    await sendJob({ connect: async () => f.link }, 'id', data, {
      ...fast,
      pacingMs: 20,
      graceMs: 1000,
      sleep: async (ms) => void sleeps.push(ms),
      onProgress: (p) => progress.push(p.sentBytes),
    });
    expect(f.writes.every((w) => w.length <= 100)).toBe(true);
    expect(f.writes.reduce((a, w) => a + w.length, 0)).toBe(data.length);
    expect(sleeps.filter((s) => s === 20)).toHaveLength(f.writes.length);
    expect(sleeps[sleeps.length - 1]).toBe(1000);
    expect(progress[progress.length - 1]).toBe(data.length);
    expect(f.log).toEqual(['mtu', 'unsub', 'disconnect']);
  });

  it('waits for the 2nd reply after writes finish', async () => {
    const f = fakeLink();
    const p = sendJob({ connect: async () => f.link }, 'id', data, { ...fast, doneTimeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.log).not.toContain('disconnect');
    f.emit(STATE_REPLY);
    f.emit(STATE_REPLY);
    await p;
    expect(f.log).toContain('disconnect');
  });

  it('times out with a warning, not an error', async () => {
    const f = fakeLink();
    const warn = jest.fn();
    await sendJob({ connect: async () => f.link }, 'id', data, { ...fast, doneTimeoutMs: 30, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.log).toContain('disconnect');
  });

  it('retries connect then succeeds', async () => {
    const f = fakeLink((n, emit) => {
      if (n === lastWrite) emit(READY);
    });
    let calls = 0;
    const c: Connector = {
      connect: async () => {
        if (++calls < 3) throw new Error('gatt 133');
        return f.link;
      },
    };
    await sendJob(c, 'id', data, fast);
    expect(calls).toBe(3);
  });

  it('gives up after 3 failed connects', async () => {
    let calls = 0;
    const c: Connector = {
      connect: async () => {
        calls++;
        throw new Error('nope');
      },
    };
    await expect(sendJob(c, 'id', data, fast)).rejects.toBeInstanceOf(PrinterError);
    expect(calls).toBe(3);
  });

  it('errors if the link drops mid-job, and still disconnects', async () => {
    const f = fakeLink((n, _emit, fail) => {
      if (n === 2) fail(new Error('dropped'));
    });
    await expect(sendJob({ connect: async () => f.link }, 'id', data, fast)).rejects.toThrow(/disconnected/);
    expect(f.log).toContain('disconnect');
  });
});

describe('flow control', () => {
  const data = encodeBitmap(makeTestBitmap());
  const PAUSE = Uint8Array.from([0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x10, 0x70, 0xff]);
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it('halts writes on pause and resumes on resume', async () => {
    const f = fakeLink((n, emit) => {
      if (n === 3) emit(PAUSE);
      if (n === Math.ceil(data.length / 100)) { emit(STATE_REPLY); emit(STATE_REPLY); }
    });
    const p = sendJob({ connect: async () => f.link }, 'id', data, { ...fast, pacingMs: 1, sleep: tick.bind(null, 1) as any });
    await tick(60);
    expect(f.writes).toHaveLength(3);
    await tick(60);
    expect(f.writes).toHaveLength(3); // still held
    f.emit(READY); // resume (same bytes as the reference 'ready')
    await p;
    expect(f.writes.reduce((a, w) => a + w.length, 0)).toBe(data.length);
  });

  it('a resume mid-stream does not end the job early', async () => {
    const f = fakeLink((n, emit) => {
      if (n === 2) emit(READY);
    });
    const warn = jest.fn();
    await sendJob({ connect: async () => f.link }, 'id', data, { ...fast, doneTimeoutMs: 20, warn });
    expect(warn).toHaveBeenCalledTimes(1); // only the done-timeout, i.e. READY was not taken as done
    expect(f.writes.reduce((a, w) => a + w.length, 0)).toBe(data.length);
  });

  it('continues after the pause timeout with a warning', async () => {
    const f = fakeLink((n, emit) => {
      if (n === 2) emit(PAUSE);
      if (n === Math.ceil(data.length / 100)) { emit(STATE_REPLY); emit(STATE_REPLY); }
    });
    const warn = jest.fn();
    await sendJob({ connect: async () => f.link }, 'id', data, { ...fast, pauseTimeoutMs: 40, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not resume/));
    expect(f.writes.reduce((a, w) => a + w.length, 0)).toBe(data.length);
  });

  it('a link error while paused aborts instead of hanging', async () => {
    const f = fakeLink((n, emit, fail) => {
      if (n === 2) {
        emit(PAUSE);
        setTimeout(() => fail(new Error('dropped')), 10);
      }
    });
    await expect(
      sendJob({ connect: async () => f.link }, 'id', data, { ...fast, pauseTimeoutMs: 5000 }),
    ).rejects.toThrow(/disconnected/);
  });

  it('ignores unrelated notifications and keeps a steady pace', async () => {
    const f = fakeLink((n, emit) => {
      if (n % 5 === 0) emit(Uint8Array.from([0x51, 0x78, 0xa1, 0x01, 0x00]));
      if (n === Math.ceil(data.length / 100)) { emit(STATE_REPLY); emit(STATE_REPLY); }
    });
    const sleeps: number[] = [];
    await sendJob({ connect: async () => f.link }, 'id', data, {
      ...fast,
      pacingMs: 10,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(f.writes.reduce((a, w) => a + w.length, 0)).toBe(data.length);
    expect(sleeps.filter((s) => s === 10)).toHaveLength(f.writes.length);
  });

  it('caps the chunk size to the negotiated MTU minus 3', async () => {
    const f = fakeLink((n, emit) => {
      if (n >= 1) { emit(STATE_REPLY); emit(STATE_REPLY); }
    });
    f.link.requestMtu = async () => 53;
    await sendJob({ connect: async () => f.link }, 'id', data, fast);
    expect(Math.max(...f.writes.map((w) => w.length))).toBe(50);
  });
});
