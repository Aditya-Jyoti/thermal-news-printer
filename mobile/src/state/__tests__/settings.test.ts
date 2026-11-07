import { parseStored } from '../settings';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

const fallback = { baseUrl: 'http://localhost:8000', mode: 'device' as const };

describe('parseStored', () => {
  it('defaults to device mode', () => {
    expect(parseStored(null, fallback)).toEqual(fallback);
    expect(parseStored('not json', fallback)).toEqual(fallback);
  });

  it('migrates legacy demo=true to mode demo, and demo=false to the default', () => {
    expect(parseStored(JSON.stringify({ baseUrl: 'http://h:1', demo: true }), fallback)).toEqual({ baseUrl: 'http://h:1', mode: 'demo' });
    expect(parseStored(JSON.stringify({ baseUrl: 'http://h:1', demo: false }), fallback).mode).toBe('device');
  });

  it('keeps a valid stored mode over legacy flags and ignores junk', () => {
    expect(parseStored(JSON.stringify({ mode: 'remote', demo: true }), fallback).mode).toBe('remote');
    expect(parseStored(JSON.stringify({ mode: 'bogus' }), fallback).mode).toBe('device');
  });
});
