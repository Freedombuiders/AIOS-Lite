// Helpers shared by the runtime adapters (genbot, mock): results, events, options, doctor reports.
import type { RunEvent, RuntimeId } from '../core/types.js';
import type { DoctorCheck, DoctorReport, RunError, RunRequest, RunResult } from './contracts.js';

export function failed(error: RunError, extra: Partial<RunResult> = {}): RunResult {
  return { ok: false, output: '', error, ...extra };
}

export function emitSafe(req: RunRequest, event: RunEvent): void {
  try {
    req.onEvent(event);
  } catch {
    /* a listener failure must never break a run */
  }
}

export function runtimeOption(req: RunRequest, key: string): string | number | boolean | undefined {
  return req.agent.runtimeOptions?.[key];
}

/** Cap long texts shown in run events and doctor messages. */
export function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compose the standard doctor report from checks. */
export function makeReport(runtime: RuntimeId, checks: DoctorCheck[], extra: { version?: string; command?: string } = {}): DoctorReport {
  const status = checks.some((c) => c.level === 'error') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { runtime, status, version: extra.version, command: extra.command, checks, testedAt: new Date().toISOString() };
}
