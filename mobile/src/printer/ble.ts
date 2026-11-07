import { Buffer } from 'buffer';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State, type Device } from 'react-native-ble-plx';

import type { PrinterDriver, PrinterInfo, ReceiptBitmap } from '../device/contracts';
import { buildJob, type DarknessLevel } from './darkness';
import {
  PrinterError,
  PrinterNotFound,
  RX_CHARACTERISTIC_UUID,
  SCAN_TIMEOUT_MS,
  SERVICE_UUIDS,
  TX_CHARACTERISTIC_UUID,
  isPrinter,
  sendJob,
  type Connector,
  type PrinterLink,
  type SendOptions,
} from './transport';

export interface DriverOptions extends SendOptions {
  /** Overrides the saved darkness level. */
  darkness?: DarknessLevel;
  /** Saved printer id, used when print() gets no deviceId. */
  getSavedId?: () => string | null | undefined;
}

let manager: BleManager | null = null;
function getManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

async function ensurePoweredOn(m: BleManager, timeoutMs = 5000): Promise<void> {
  const state = await m.state();
  if (state === State.PoweredOn) return;
  if (state === State.PoweredOff) throw new PrinterError('Bluetooth is turned off. Turn it on and try again.');
  if (state === State.Unauthorized) throw new PrinterError('Bluetooth permission was denied.');
  if (state === State.Unsupported) throw new PrinterError('This device does not support Bluetooth LE.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new PrinterError('Bluetooth is not ready.'));
    }, timeoutMs);
    const sub = m.onStateChange((s) => {
      if (s === State.PoweredOn) {
        clearTimeout(timer);
        sub.remove();
        resolve();
      }
    }, true);
  });
}

export async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  if (api >= 31) {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export async function scanPrinters(timeoutMs = SCAN_TIMEOUT_MS, stopOnFirst = false): Promise<PrinterInfo[]> {
  const m = getManager();
  await ensurePoweredOn(m);
  const found = new Map<string, PrinterInfo>();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      m.stopDeviceScan().catch(() => undefined);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    m.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        clearTimeout(timer);
        m.stopDeviceScan().catch(() => undefined);
        reject(new PrinterError(`Bluetooth scan failed: ${error.message}`, error));
        return;
      }
      if (!device) return;
      const name = device.name ?? device.localName;
      if (!isPrinter(name, device.serviceUUIDs)) return;
      found.set(device.id, { id: device.id, name: name ?? '(unknown)', rssi: device.rssi });
      if (stopOnFirst) finish();
    });
  });
  return [...found.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

class BlxLink implements PrinterLink {
  constructor(
    private readonly m: BleManager,
    private device: Device,
    private readonly service: string,
  ) {}

  async requestMtu(mtu: number): Promise<number | void> {
    if (Platform.OS !== 'android') return;
    try {
      this.device = await this.m.requestMTUForDevice(this.device.id, mtu);
      return this.device.mtu;
    } catch {
      /* best effort */
    }
  }

  async subscribe(onData: (d: Uint8Array) => void, onError: (e: unknown) => void): Promise<() => void> {
    const sub = this.m.monitorCharacteristicForDevice(this.device.id, this.service, RX_CHARACTERISTIC_UUID, (err, ch) => {
      if (err) return onError(err);
      if (ch?.value) onData(new Uint8Array(Buffer.from(ch.value, 'base64')));
    });
    const disc = this.m.onDeviceDisconnected(this.device.id, (err) => onError(err ?? new Error('disconnected')));
    return () => {
      sub.remove();
      disc.remove();
    };
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.m.writeCharacteristicWithoutResponseForDevice(this.device.id, this.service, TX_CHARACTERISTIC_UUID, b64(chunk));
  }

  async disconnect(): Promise<void> {
    await this.m.cancelDeviceConnection(this.device.id);
  }
}

class BlxConnector implements Connector {
  constructor(private readonly m: BleManager) {}

  async connect(deviceId: string): Promise<PrinterLink> {
    let device = await this.m.connectToDevice(deviceId, { timeout: 10_000 });
    try {
      device = await device.discoverAllServicesAndCharacteristics();
      let service: string | null = null;
      for (const s of await device.services()) {
        const chars = await device.characteristicsForService(s.uuid);
        if (chars.some((c) => c.uuid.toLowerCase() === TX_CHARACTERISTIC_UUID)) {
          service = s.uuid;
          break;
        }
      }
      if (!service) throw new PrinterError('This device does not expose the printer characteristic (0xAE01).');
      return new BlxLink(this.m, device, service);
    } catch (e) {
      await this.m.cancelDeviceConnection(deviceId).catch(() => undefined);
      throw e;
    }
  }
}

export function createPrinterDriver(driverOpts: DriverOptions = {}): PrinterDriver {
  return {
    ensurePermissions,
    scan: (timeoutMs) => scanPrinters(timeoutMs ?? SCAN_TIMEOUT_MS),
    async print(bitmap: ReceiptBitmap, opts) {
      if (!(await ensurePermissions())) throw new PrinterError('Bluetooth permission was denied.');
      const m = getManager();
      await ensurePoweredOn(m);
      let id = opts?.deviceId ?? driverOpts.getSavedId?.() ?? null;
      if (!id) {
        const found = await scanPrinters(SCAN_TIMEOUT_MS, true);
        if (!found.length) throw new PrinterNotFound();
        id = found[0].id;
      }
      const { data } = await buildJob(bitmap, driverOpts.darkness);
      await sendJob(new BlxConnector(m), id, data, { ...driverOpts, onProgress: opts?.onProgress ?? driverOpts.onProgress });
    },
  };
}

export { SERVICE_UUIDS };
