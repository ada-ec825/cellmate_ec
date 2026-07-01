import * as vscode from 'vscode';
import { ExerciseHelpState, HELP_STATE_VERSION } from './schema';


let ctx: vscode.ExtensionContext;

export function initState(c: vscode.ExtensionContext) {
  ctx = c;
}

/** Storage key for a given exercise's ladder state. */
function key(exerciseId: string): string {
  return `cellmate.help.${exerciseId}`;
}

/** Fresh Idle state for an exercise that has no stored progress yet. */
function defaultState(exerciseId: string): ExerciseHelpState {
  return {
    exerciseId,
    state: 'Idle',
    guideStep: 0,
    version: HELP_STATE_VERSION,
    helpRequestedSinceRun: false,
    updatedAt: Date.now(),
  };
}


export function getHelpState(exerciseId: string): ExerciseHelpState {
  const stored = ctx.workspaceState.get<ExerciseHelpState>(key(exerciseId));
  if (!stored || stored.version !== HELP_STATE_VERSION) {
    return defaultState(exerciseId);
  }
  return stored;
}

/** Persist the ladder state, stamping updatedAt. */
export async function setHelpState(state: ExerciseHelpState): Promise<void> {
  state.updatedAt = Date.now();
  await ctx.workspaceState.update(key(state.exerciseId), state);
}

/** Clear an exercise's ladder state, returning it to Idle. */
export async function resetHelpState(exerciseId: string): Promise<void> {
  await ctx.workspaceState.update(key(exerciseId), undefined);
}
