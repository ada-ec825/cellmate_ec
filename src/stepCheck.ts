import { getPromptContent } from './gitUtils';
import { DecompositionStep } from './schema';
import { extractJsonObject } from './decompose';

/** Template id of the step-check prompt in the prompt repository. */
export const STEP_CHECK_PROMPT_ID = 'step_check';

/** Inputs for checking one finished step against the student's code. */
export interface StepCheckContext {
  exerciseId: string;
  problemDescription: string;
  /** The student's code as it stands right now. */
  code: string;
  /** The step the student just marked as done. */
  step: DecompositionStep;
}

/** The model's verdict on one step. Advisory only — never a gate. */
export interface StepCheckResult {
  addressed: boolean;
  feedback: string;
}

/** Fill one {{key}} placeholder everywhere it appears in the template. */
function fillAll(template: string, key: string, value: string): string {
  return template.split(`{{${key}}}`).join(value);
}

/** Pure counterpart of buildStepCheckPrompt, testable without a repo. */
export function fillStepCheckTemplate(template: string, ctx: StepCheckContext): string {
  let prompt = fillAll(template, 'exercise_id', ctx.exerciseId);
  prompt = fillAll(prompt, 'problem_description', ctx.problemDescription.trim());
  prompt = fillAll(prompt, 'code', ctx.code.trim());
  prompt = fillAll(prompt, 'label', ctx.step.label);
  prompt = fillAll(prompt, 'intent', ctx.step.intent);
  prompt = fillAll(prompt, 'check_hint', ctx.step.checkHint ?? '(none given)');
  return prompt;
}

/** Load the step-check template from the synced prompt repository and fill it. */
export async function buildStepCheckPrompt(ctx: StepCheckContext): Promise<string> {
  const template = await getPromptContent(STEP_CHECK_PROMPT_ID);
  return fillStepCheckTemplate(template, ctx);
}

/**
 * Parse the model's verdict. Lenient by design: any shape problem returns
 * null rather than an error — a lost nudge must never cost the student
 * anything.
 */
export function parseStepCheck(raw: string): StepCheckResult | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (typeof data.addressed !== 'boolean') return null;
  if (typeof data.feedback !== 'string' || data.feedback.trim() === '') return null;

  return { addressed: data.addressed, feedback: data.feedback.trim() };
}

/**
 * Check one finished step against the student's current code.
 * Fail-open: template missing, transport error or malformed output all
 * yield null. No retry — this is a background nudge, not a gate.
 */
export async function runStepCheck(
  ctx: StepCheckContext,
  callLLM: (prompt: string) => Promise<string>
): Promise<StepCheckResult | null> {
  try {
    const prompt = await buildStepCheckPrompt(ctx);
    const raw = await callLLM(prompt);
    return parseStepCheck(raw);
  } catch {
    return null;
  }
}
