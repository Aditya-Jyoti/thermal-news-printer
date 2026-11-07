/** Registers the real on-device services (Skia renderer + BLE driver). Idempotent; used by the app root and the headless task. */
import { createPrinterDriver } from '../printer';
import { renderReceipt } from '../render';
import { getDevice, registerDevice } from './contracts';

export function ensureRealDevice(): void {
  try {
    getDevice();
  } catch {
    registerDevice({ render: renderReceipt, printer: createPrinterDriver() });
  }
}
