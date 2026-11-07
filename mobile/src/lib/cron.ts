export interface DailyTime {
  hour: number;
  minute: number;
}

/** Parses "M H * * *" into a time; null if the cron is anything more complex. */
export function parseDailyCron(cron: string): DailyTime | null {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  return { hour, minute };
}

export const toDailyCron = ({ hour, minute }: DailyTime): string => `${minute} ${hour} * * *`;

/** Light structural validation of a 5-field cron expression. */
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-A-Za-z?LW#]+$/.test(p));
}

export function formatTime({ hour, minute }: DailyTime): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function describeCron(cron: string): string {
  const t = parseDailyCron(cron);
  return t ? `Every day at ${formatTime(t)}` : `Cron: ${cron}`;
}
