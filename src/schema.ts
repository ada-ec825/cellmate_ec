export const DECOMPOSITION_VERSION = 1;

export interface DecompositionStep {
  /** 1-based position in the ordered plan. */
  index: number;
  /** Short subgoal name, e.g. "Choose a loop bound". */
  label: string;
  /** One or two sentences describing the intent. Must not contain code. */
  intent: string;
  /** Optional: what step_check should look for as evidence of this intent. */
  checkHint?: string;
}

export interface Decomposition {
  exerciseId: string;
  /** Equals DECOMPOSITION_VERSION at write time. */
  version: number;
  /** Hand-written gold plan vs. LLM-generated plan. */
  source: 'gold' | 'generated';
  /** Ordered subgoals. The plan constrains this to 3..7 steps. */
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

/**
 * Patterns that suggest code has leaked into prose fields. Shared by the
 * decomposition validator and reusable for later hint leakage audits.
 * Deliberately conservative: a false hit costs one retry, a miss leaks
 * implementation.
 */
const CODE_TRACE_PATTERNS: RegExp[] = [
  /```/, // fenced code block
  /`[^`\n]+`/, // inline code span
  /\bdef\s+\w+/i, // function definition
  /\bimport\b/i, // import statement
  /\breturn\b/i, // return statement
  /\bfor\s+\w+\s+in\b/i, // Python-style loop header
  /=/, // assignment or comparison operator
];

/** True if the text looks like it contains code rather than plain English. */
export function containsCodeTrace(text: string): boolean {
  return CODE_TRACE_PATTERNS.some((re) => re.test(text));
}

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
  if (d.version !== DECOMPOSITION_VERSION) {
    violations.push(`version must equal ${DECOMPOSITION_VERSION}`);
  }
  if (d.source !== 'gold' && d.source !== 'generated') {
    violations.push("source must be 'gold' or 'generated'");
  }
  if (!Array.isArray(d.steps)) {
    violations.push('steps must be an array');
    return violations;
  }
  if (d.steps.length < 3 || d.steps.length > 7) {
    violations.push(`the plan must have 3 to 7 steps, found ${d.steps.length}`);
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
      violations.push(`step ${n} intent must be a non-empty string`);
    } else if (containsCodeTrace(s.intent)) {
      violations.push(`step ${n} intent contains code; rewrite it as plain English`);
    }
    if (s.checkHint !== undefined) {
      if (typeof s.checkHint !== 'string') {
        violations.push(`step ${n} checkHint must be a string when present`);
      } else if (containsCodeTrace(s.checkHint)) {
        violations.push(`step ${n} checkHint contains code; rewrite it as plain English`);
      }
    }
  });

  return violations;
}

/**
 * Structural gate for both LLM-generated plans and hand-written gold files.
 * Tightening these checks does not change the data shape, so it needs no
 * DECOMPOSITION_VERSION bump.
 */
export function validateDecomposition(d: any): d is Decomposition {
  return listDecompositionViolations(d).length === 0;
}
