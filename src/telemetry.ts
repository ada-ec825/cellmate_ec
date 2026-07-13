import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { TelemetryEvent, TELEMETRY_VERSION } from './schema';


const STORE_KEY = 'cellmate.telemetry';

let ctx: vscode.ExtensionContext;
let sessionId = randomUUID();

export function initTelemetry(c: vscode.ExtensionContext) {
  ctx = c;
  // A fresh session id per activation keeps traces groupable without
  // identifying the user.
  sessionId = randomUUID();
}

/** Record one help-trajectory event. */
export async function logEvent(
  event: Omit<TelemetryEvent, 'ts' | 'sessionId' | 'version'>
): Promise<void> {
  const full: TelemetryEvent = {
    ...event,
    ts: Date.now(),
    sessionId,
    version: TELEMETRY_VERSION,
  };
  const buffer = ctx.globalState.get<TelemetryEvent[]>(STORE_KEY, []);
  buffer.push(full);
  await ctx.globalState.update(STORE_KEY, buffer);
}

/** Return all buffered events (e.g. for export at the end of a session). */
export function getEvents(): TelemetryEvent[] {
  return ctx.globalState.get<TelemetryEvent[]>(STORE_KEY, []);
}

/** Discard all buffered events. */
export async function clearEvents(): Promise<void> {
  await ctx.globalState.update(STORE_KEY, []);
}
