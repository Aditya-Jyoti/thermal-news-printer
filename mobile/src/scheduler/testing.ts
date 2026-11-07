// Test-only: a fully mocked native scheduler module.
import type { PrintSchedulerNative } from './native';

export function fakeNative(): jest.Mocked<PrintSchedulerNative> {
  return {
    setNextAlarm: jest.fn((_epochMs: number, _scheduleId: number) => 'exact' as const),
    cancelAlarm: jest.fn(),
    runNow: jest.fn(),
    canScheduleExactAlarms: jest.fn(() => true),
    openExactAlarmSettings: jest.fn(),
    isIgnoringBatteryOptimizations: jest.fn(() => true),
    requestIgnoreBatteryOptimizations: jest.fn(),
    openAppSettings: jest.fn(),
    updateNotification: jest.fn(),
  };
}
