import { getPromptContent } from './gitUtils';
import { DecompositionStep } from './schema';
import { extractJsonObject } from './decompose';

/** Template id of the progress-check prompt in the prompt repository. */
export const PROGRESS_CHECK_PROMPT_ID = 'progress_check';

/** Inputs for checking the student's code against the whole plan. */
export interface ProgressCheckContext {
  exerciseId: string;
  problemDescription: string;
  /** The student's code as it stands right now. */
  code: string;
  /** Every step of the current plan, in order. */
  steps: DecompositionStep[];
}

/**
 * done: clear evidence and looks sound. issue: attempted, but seems wrong,
 * incomplete or would fail to run. missing: no visible attempt yet.
 */
export type StepStatus = 'done' | 'issue' | 'missing';

export interface StepVerdict {
  status: StepStatus;
  /** For issues: one short symptom description — never the fix, never code. */
  note?: string;
}

/**
 * The model's assessment of one check: a verdict per plan step plus one
 * short overall remark. Advisory only — never a gate.
 */
export interface ProgressCheckResult {
  /** One entry per plan step, in plan order. */
  verdicts: StepVerdict[];
  feedback: string;
}

/** Fill one {{key}} placeholder everywhere it appears in the template. */
function fillAll(template: string, key: string, value: string): string {
  return template.split(`{{${key}}}`).join(value);
}

/** Render the plan as a numbered list the model can judge against. */
function renderSteps(steps: DecompositionStep[]): string {
  return steps
    .map((s) => {
      const hint = s.checkHint ? `  (evidence: ${s.checkHint})` : '';
      return `${s.index}. ${s.label} — ${s.intent}${hint}`;
    })
    .join('\n');
}

/** Pure counterpart of buildProgressCheckPrompt, testable without a repo. */
export function fillProgressCheckTemplate(template: string, ctx: ProgressCheckContext): string {
  let prompt = fillAll(template, 'exercise_id', ctx.exerciseId);
  prompt = fillAll(prompt, 'problem_description', ctx.problemDescription.trim());
  prompt = fillAll(prompt, 'code', ctx.code.trim());
  prompt = fillAll(prompt, 'steps', renderSteps(ctx.steps));
  return prompt;
}

/** Load the progress-check template from the synced prompt repository and fill it. */
export async function buildProgressCheckPrompt(ctx: ProgressCheckContext): Promise<string> {
  const template = await getPromptContent(PROGRESS_CHECK_PROMPT_ID);
  return fillProgressCheckTemplate(template, ctx);
}

/**
 * Parse the model's assessment. Lenient by design: any shape problem —
 * wrong verdict count, non-boolean entries, missing feedback — returns
 * null rather than an error. A lost nudge must never cost the student
 * anything.
 */
const VALID_STATUSES = new Set(['done', 'issue', 'missing']);

export function parseProgressCheck(raw: string, stepCount: number): ProgressCheckResult | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!Array.isArray(data.steps) || data.steps.length !== stepCount) return null;

  const verdicts: StepVerdict[] = [];
  for (const entry of data.steps) {
    if (!entry || typeof entry !== 'object' || !VALID_STATUSES.has(entry.status)) return null;
    const verdict: StepVerdict = { status: entry.status };
    if (typeof entry.note === 'string' && entry.note.trim() !== '') {
      verdict.note = entry.note.trim();
    }
    verdicts.push(verdict);
  }

  if (typeof data.feedback !== 'string' || data.feedback.trim() === '') return null;

  return { verdicts, feedback: data.feedback.trim() };
}

/**
 * Check the student's current code against the whole plan in one call.
 * Fail-open: template missing, transport error or malformed output all
 * yield null. No retry — this is a background nudge, not a gate.
 */
export async function runProgressCheck(
  ctx: ProgressCheckContext,
  callLLM: (prompt: string) => Promise<string>
): Promise<ProgressCheckResult | null> {
  try {
    const prompt = await buildProgressCheckPrompt(ctx);
    const raw = await callLLM(prompt);
    return parseProgressCheck(raw, ctx.steps.length);
  } catch {
    return null;
  }
}
