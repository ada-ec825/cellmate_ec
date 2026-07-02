import { Decomposition, DECOMPOSITION_VERSION, validateDecomposition } from './schema';

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

  if (!validateDecomposition(candidate)) {
    return {
      ok: false,
      reason: 'steps failed schema validation (3-7 steps, plain-English intents)',
    };
  }

  return { ok: true, decomposition: candidate };
}
