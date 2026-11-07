/** Thin typed wrapper over the local Android module `modules/print-scheduler` (null off Android / in tests). */
import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

export type AlarmMode = 'exact' | 'inexact';

export interface PrintSchedulerNative {
  /** Arms the single next alarm (replaces any previous one). 'inexact' = exact-alarm access denied. */
  setNextAlarm(epochMs: number, scheduleId: number): AlarmMode;
  cancelAlarm(): void;
  /** Starts the foreground service + headless task right now (manual test run). */
  runNow(): void;
  canScheduleExactAlarms(): boolean;
  openExactAlarmSettings(): void;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
  openAppSettings(): void;
  /** ongoing=true: foreground notification text; false: dismissible result notification. */
  updateNotification(text: string, ongoing: boolean): void;
}

let cached: PrintSchedulerNative | null | undefined;

export function getNative(): PrintSchedulerNative | null {
  if (cached === undefined) {
    cached = Platform.OS === 'android' ? requireOptionalNativeModule<PrintSchedulerNative>('TnpPrintScheduler') : null;
  }
  return cached;
}

const NOTIF_PERM = 'android.permission.POST_NOTIFICATIONS' as const;

/** Android 13+ runtime permission; always true below API 33 and off Android. */
export async function hasNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  try {
    return await PermissionsAndroid.check(NOTIF_PERM);
  } catch {
    return false;
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  try {
    return (await PermissionsAndroid.request(NOTIF_PERM)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
