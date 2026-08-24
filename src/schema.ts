export interface DecompositionStep {
  /** 1-based position in the ordered plan. */
  index: number;
  /** Short subgoal name, e.g. "Choose a loop bound". */
  label: string;
  /** One or two sentences describing the intent. Must not contain code. */
  intent: string;
  /** Optional: what step_check should look for as evidence of this intent. */
  checkHint?: string;
  /**
   * Optional (v2): recommended share of the whole exercise's time, as a
   * percentage. Guidance for pacing, never a deadline. Either every step
   * carries one or none does, and a plan's shares sum to roughly 100.
   */
  timeShare?: number;
}

export interface Decomposition {
  exerciseId: string;
  /** Hand-written gold plan vs. LLM-generated plan. */
  source: 'gold' | 'generated';
  /** Ordered subgoals. The plan constrains this to 3..8 steps. */
  steps: DecompositionStep[];
}


export const HELP_STATE_VERSION = 1;

export type HelpState = 'Idle' | 'Hint1' | 'Hint2' | 'Guide' | 'Consolidate';

export interface ExerciseHelpState {
  exerciseId: string;
  state: HelpState;
  /** Current step index while in Guide; 0 otherwise. */
  guideStep: number;
  /** Equals HELP_STATE_VERSION at write time. */
  version: number;
  /**
   * Fingerprint of the last code execution (e.g. execution order + code hash).
   * Used to enforce the "rerun your code between help requests" brake.
   */
  lastRunToken?: string;
  /** Whether the student has requested help without rerunning since. */
  helpRequestedSinceRun: boolean;
  updatedAt: number;
}


export const TELEMETRY_VERSION = 1;

export type TelemetryEventType =
  | 'help_request'
  | 'state_transition'
  | 'code_run'
  | 'step_reveal'
  | 'step_check'
  | 'consolidate_result';

export interface TelemetryEvent {
  /** Epoch milliseconds. */
  ts: number;
  /** Random per-session id; carries no name or account. */
  sessionId: string;
  exerciseId: string;
  /** Equals TELEMETRY_VERSION at write time. */
  version: number;
  event: TelemetryEventType;
  fromState?: HelpState;
  toState?: HelpState;
  guideStep?: number;
  /** Non-identifying extras, e.g. leakage flags or pass/fail counts. */
  meta?: Record<string, unknown>;
}

// No code-trace regex gate. Every pattern tried — keywords, back-ticks,
// "=", even literal "def name(" — ended up rejecting legitimate plans that
// quoted the exercise's own contract or signatures. Leakage review is the
// job of the offline audit (LLM judge + human reading), never of a
// parse-time regex; the validator below checks structure only.

/**
 * Every rule the candidate breaks, as one-line messages that name the
 * step and field concretely. The engine feeds these back to the model on
 * a retry, so precision here buys retry success; they also tell a gold
 * file author exactly what to fix.
 */
export function listDecompositionViolations(d: any): string[] {
  const violations: string[] = [];
  if (!d || typeof d !== 'object') {
    return ['decomposition must be an object'];
  }

  if (typeof d.exerciseId !== 'string' || d.exerciseId.trim() === '') {
    violations.push('exerciseId must be a non-empty string');
  }
  if (d.source !== 'gold' && d.source !== 'generated') {
    violations.push("source must be 'gold' or 'generated'");
  }
  if (!Array.isArray(d.steps)) {
    violations.push('steps must be an array');
    return violations;
  }
  if (d.steps.length < 3 || d.steps.length > 8) {
    violations.push(`the plan must have 3 to 8 steps, found ${d.steps.length}`);
  }

  d.steps.forEach((s: any, i: number) => {
    const n = i + 1;
    if (!s || typeof s !== 'object') {
      violations.push(`step ${n} is not an object`);
      return;
    }
    if (s.index !== n) {
      violations.push(`step ${n} has index ${s.index}; indices must run 1..N in order`);
    }
    if (typeof s.label !== 'string' || s.label.trim() === '') {
      violations.push(`step ${n} label must be a non-empty string`);
    }
    if (typeof s.intent !== 'string' || s.intent.trim() === '') {
      violations.push(
        `step ${n} must carry its specification in a field named exactly "intent"; ` +
          'a non-empty string, not "spec" or any other synonym'
      );
    }
    if (s.checkHint !== undefined && typeof s.checkHint !== 'string') {
      violations.push(`step ${n} checkHint must be a string when present`);
    }
    if (s.timeShare !== undefined) {
      if (!Number.isFinite(s.timeShare) || s.timeShare < 5 || s.timeShare > 100) {
        violations.push(`step ${n} timeShare must be a number between 5 and 100`);
      }
    }
  });

  // timeShare is all-or-none, and a complete set must sum to roughly 100.
  const withShare = d.steps.filter((s: any) => s && s.timeShare !== undefined);
  if (withShare.length > 0 && withShare.length !== d.steps.length) {
    violations.push('timeShare must be given on every step or on none');
  } else if (d.steps.length > 0 && withShare.length === d.steps.length) {
    const sum = withShare.reduce(
      (acc: number, s: any) => acc + (Number.isFinite(s.timeShare) ? s.timeShare : 0),
      0
    );
    if (sum < 90 || sum > 110) {
      violations.push(`timeShare values must sum to roughly 100, found ${sum}`);
    }
  }

  return violations;
}

/**
 * Structural gate for both LLM-generated plans and hand-written gold files.
 */
export function validateDecomposition(d: any): d is Decomposition {
  return listDecompositionViolations(d).length === 0;
}
