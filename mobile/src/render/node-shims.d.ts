// Minimal Node typings for the render tests (the project has no @types/node and we add no deps).
declare module 'fs' {
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}
declare module 'path' {
  export function join(...parts: string[]): string;
}
declare const __dirname: string;
declare const global: any;
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayLike<number>, encoding?: string): Buffer;
  equals(other: Uint8Array): boolean;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
  readUInt32BE(offset: number): number;
}
