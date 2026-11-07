/** Last pipeline error per stage, persisted in settings (key `last_errors`) so failures are visible in release builds. */
import type { LastErrors, PipelineStage } from '../api/types';
import type { Db } from './db/adapter';
import { getSetting, setSetting } from './db/settings';
import { emit } from './events';
import { redact } from './redact';

export const LAST_ERRORS_KEY = 'last_errors';
export const MAX_ERROR_CHARS = 300;

export async function getLastErrors(db: Db): Promise<LastErrors> {
  try {
    return (await getSetting<LastErrors>(db, LAST_ERRORS_KEY, {})) ?? {};
  } catch {
    return {};
  }
}

/** Record (redacted, truncated) the latest error of a stage. Never throws. */
export async function recordError(db: Db, stage: PipelineStage, message: string): Promise<void> {
  try {
    const all = await getLastErrors(db);
    all[stage] = { message: redact(message).slice(0, MAX_ERROR_CHARS), at: new Date().toISOString() };
    await setSetting(db, LAST_ERRORS_KEY, all);
    emit('diagnostics');
  } catch {
    // diagnostics must never break the pipeline
  }
}

/** Clear a stage's error after a success. Never throws. */
export async function clearError(db: Db, stage: PipelineStage): Promise<void> {
  try {
    const all = await getLastErrors(db);
    if (!(stage in all)) return;
    delete all[stage];
    await setSetting(db, LAST_ERRORS_KEY, all);
    emit('diagnostics');
  } catch {
    // ignore
  }
}

/** The error to show next to the edition: the most recent one. */
export function pickLastError(all: LastErrors): { stage: PipelineStage; message: string; at: string } | undefined {
  let best: { stage: PipelineStage; message: string; at: string } | undefined;
  for (const [stage, e] of Object.entries(all) as [PipelineStage, { message: string; at: string }][]) {
    if (!best || e.at > best.at) best = { stage, message: e.message, at: e.at };
  }
  return best;
}

export const STAGE_LABEL: Record<PipelineStage, string> = {
  ingest: 'Fetching feeds',
  curate: 'Curation',
  summarize: 'Summaries',
  render: 'Rendering',
  print: 'Printing',
};
