import { getPromptContent } from './gitUtils';
import { Decomposition, DECOMPOSITION_VERSION, listDecompositionViolations } from './schema';

/** Template id of the decompose prompt in the prompt repository. */
export const DECOMPOSE_PROMPT_ID = 'decompose';

/** Inputs the decompose template needs; gathered by the command layer. */
export interface DecomposeContext {
  exerciseId: string;
  problemDescription: string;
  /** Student's current code; may be empty for a stuck-from-the-start case. */
  code: string;
}

/** Fill one {{key}} placeholder everywhere it appears in the template. */
function fillAll(template: string, key: string, value: string): string {
  return template.split(`{{${key}}}`).join(value);
}

/**
 * Fill the decompose template with an exercise context. Pure counterpart
 * of buildDecomposePrompt so tests can run it without a synced repo.
 * Kept separate from promptUtils.fillPromptTemplate because these inputs
 * come from the engine, not from notebook annotations.
 */
export function fillDecomposeTemplate(template: string, ctx: DecomposeContext): string {
  let prompt = fillAll(template, 'exercise_id', ctx.exerciseId);
  prompt = fillAll(prompt, 'problem_description', ctx.problemDescription.trim());
  prompt = fillAll(prompt, 'code', ctx.code.trim());
  return prompt;
}

/** Load the decompose template from the synced prompt repository and fill it. */
export async function buildDecomposePrompt(ctx: DecomposeContext): Promise<string> {
  const template = await getPromptContent(DECOMPOSE_PROMPT_ID);
  return fillDecomposeTemplate(template, ctx);
}

/** Outcome of one generation run, with the attempt count for telemetry. */
export type GenerateDecompositionResult =
  | { ok: true; decomposition: Decomposition; attempts: number }
  | { ok: false; reason: string; attempts: number };

/**
 * Generate a decomposition via the injected LLM caller.
 *
 * The caller is injected (rather than importing the extension's LLM client)
 * so the engine stays free of vscode dependencies and tests can drive it
 * with a fake. Parse or validation failures are retried once, feeding the
 * rejection reason back to the model; transport errors are not retried —
 * the command layer decides how to surface those.
 */
export async function generateDecomposition(
  ctx: DecomposeContext,
  callLLM: (prompt: string) => Promise<string>
): Promise<GenerateDecompositionResult> {
  const basePrompt = await buildDecomposePrompt(ctx);

  let lastReason = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : basePrompt +
          `\n\nYour previous answer was rejected: ${lastReason}. ` +
          'Correct this and reply with the raw JSON object only.';

    let raw: string;
    try {
      raw = await callLLM(prompt);
    } catch (e: any) {
      return { ok: false, reason: `LLM call failed: ${e?.message ?? e}`, attempts: attempt };
    }

    const parsed = parseDecomposition(raw, ctx.exerciseId);
    if (parsed.ok) {
      return { ok: true, decomposition: parsed.decomposition, attempts: attempt };
    }
    lastReason = parsed.reason;
  }

  return { ok: false, reason: lastReason, attempts: 2 };
}

/** Outcome of parsing one LLM response into a Decomposition. */
export type ParseDecompositionResult =
  | { ok: true; decomposition: Decomposition }
  | { ok: false; reason: string };

/**
 * Extract the first balanced JSON object from raw model output.
 * Tolerates markdown fences and prose around the object.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse raw LLM output into a validated Decomposition.
 *
 * Fields the extension owns (exerciseId, version, source) are stamped
 * authoritatively rather than trusted from the model's echo. The
 * model-authored steps must pass validateDecomposition and carry
 * contiguous 1-based indices; any violation is returned as a reason
 * string so the caller can decide to retry.
 */
export function parseDecomposition(raw: string, exerciseId: string): ParseDecompositionResult {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { ok: false, reason: 'no JSON object found in model output' };
  }

  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch (e: any) {
    return { ok: false, reason: `invalid JSON: ${e.message}` };
  }

  const candidate: Decomposition = {
    exerciseId,
    version: DECOMPOSITION_VERSION,
    source: 'generated',
    steps: Array.isArray(data.steps) ? data.steps : [],
  };

  // Report index problems before the coarser schema gate so the retry
  // signal names the exact position.
  for (let i = 0; i < candidate.steps.length; i++) {
    if (candidate.steps[i]?.index !== i + 1) {
      return {
        ok: false,
        reason: `step indices must run 1..N; found ${candidate.steps[i]?.index} at position ${i + 1}`,
      };
    }
  }

  // Name every broken rule so a retry prompt can list all fixes at once.
  const violations = listDecompositionViolations(candidate);
  if (violations.length > 0) {
    return {
      ok: false,
      reason: `steps failed schema validation: ${violations.join('; ')}`,
    };
  }

  return { ok: true, decomposition: candidate };
}
