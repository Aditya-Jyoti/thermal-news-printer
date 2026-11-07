/**
 * Phone-only architecture: shared contracts between the on-device modules.
 * Orchestrator-owned — change only via the Orchestrator (see docs/MOBILE_ARCHITECTURE.md).
 *
 *   src/core/     content pipeline: SQLite, RSS ingest, full text, OpenRouter, digest   (Stream C)
 *   src/render/   384px newspaper receipt rendering with Skia                           (Stream R)
 *   src/printer/  BLE cat-printer protocol + transport (react-native-ble-plx)           (Stream P)
 *   src/api/local.ts  implements the existing `Api` interface on top of core + render + printer (Stream C)
 *
 * core/ must not import render/ or printer/ directly: it receives them through `registerDevice()`.
 */
import type { DigestItem } from '../api/types';

/** A 1-bit receipt image. `pixels` has width*height bytes, row-major, 1 = black (burned), 0 = white. */
export interface ReceiptBitmap {
  width: 384;
  height: number;
  pixels: Uint8Array;
}

export interface RenderOptions {
  editionDate: Date;
  editionName?: string; // default "Morning Edition"
  issueNo?: number;
}

export interface RenderedReceipt {
  bitmap: ReceiptBitmap;
  /** PNG of the same 1-bit image, base64 (no data: prefix) — used by the Print Preview pane. */
  pngBase64: string;
}

/** Implemented by src/render. Must be deterministic for the same input. Empty items → "No new stories" receipt. */
export type RenderReceipt = (items: DigestItem[], opts: RenderOptions) => Promise<RenderedReceipt>;

export interface PrinterInfo {
  id: string; // BLE device id (MAC on Android)
  name: string; // e.g. "SC03h-5CA6"
  rssi?: number | null;
}

export interface PrintProgress {
  sentBytes: number;
  totalBytes: number;
}

/** Implemented by src/printer. */
export interface PrinterDriver {
  /** Ensure BLE permissions are granted (Android 12+: BLUETOOTH_SCAN/CONNECT). Returns false if denied. */
  ensurePermissions(): Promise<boolean>;
  /** Scan for cat printers (service 0xAE30/0xAF30 or known name prefixes) for `timeoutMs`. */
  scan(timeoutMs?: number): Promise<PrinterInfo[]>;
  /** Print a bitmap. Connects (to `deviceId`, else the saved printer, else first found), sends, waits for completion, disconnects. */
  print(bitmap: ReceiptBitmap, opts?: { deviceId?: string; onProgress?: (p: PrintProgress) => void }): Promise<void>;
}

export interface DeviceServices {
  render: RenderReceipt;
  printer: PrinterDriver;
}

let services: DeviceServices | null = null;

export function registerDevice(s: DeviceServices): void {
  services = s;
}

export function getDevice(): DeviceServices {
  if (!services) throw new Error('Device services not registered (call registerDevice at app start)');
  return services;
}
