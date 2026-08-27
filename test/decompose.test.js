// Tests for src/decompose.ts (parseDecomposition / extractJsonObject).
// Runs against the compiled output — run `npm run compile` first, then:
//   node --test test/
// Uses only Node built-ins so no test dependency is added to package.json.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractJsonObject,
  parseDecomposition,
  fillDecomposeTemplate,
  generateDecomposition,
} = require('../out/decompose.js');
const { listDecompositionViolations } = require('../out/schema.js');
const { LOCAL_REPO_PATH } = require('../out/gitUtils.js');

/** Build a valid 3..8-step plan the parser should accept. */
function makeSteps(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    label: `Step ${i + 1}`,
    intent: 'Think about what this part of the task needs.',
  }));
}

// ── extractJsonObject ──────────────────────────────────────────────

test('extracts a bare JSON object unchanged', () => {
  const src = '{"a": 1}';
  assert.equal(extractJsonObject(src), src);
});

test('extracts an object wrapped in a markdown fence with prose around it', () => {
  const obj = '{"a": {"b": 2}}';
  const raw = 'Here is the plan:\n```json\n' + obj + '\n```\nHope this helps!';
  assert.equal(extractJsonObject(raw), obj);
});

test('keeps nested objects balanced', () => {
  const obj = '{"steps": [{"index": 1}, {"index": 2}]}';
  assert.equal(extractJsonObject('x' + obj + 'y'), obj);
});

test('ignores braces inside string values', () => {
  const obj = '{"intent": "use { and } wisely"}';
  assert.equal(extractJsonObject(obj + ' trailing'), obj);
});

test('handles escaped quotes inside strings', () => {
  const obj = '{"label": "a \\" b { c"}';
  assert.equal(extractJsonObject(obj), obj);
});

test('returns the first object when two are present', () => {
  assert.equal(extractJsonObject('{"a":1} {"b":2}'), '{"a":1}');
});

test('returns null when there is no object', () => {
  assert.equal(extractJsonObject('no json here'), null);
});

test('returns null for an unbalanced (truncated) object', () => {
  assert.equal(extractJsonObject('{"a": {"b": 1}'), null);
});

// ── parseDecomposition: happy path ─────────────────────────────────

test('accepts a valid plan and stamps exerciseId/source', () => {
  const raw =
    'Sure!\n```json\n' +
    JSON.stringify({
      exerciseId: 'echoed-wrong',
      source: 'gold',
      steps: makeSteps(3),
    }) +
    '\n```';
  const r = parseDecomposition(raw, 'count_words');
  assert.equal(r.ok, true);
  // Fields the extension owns are stamped, not trusted from the echo.
  assert.equal(r.decomposition.exerciseId, 'count_words');
  assert.equal(r.decomposition.source, 'generated');
  assert.equal(r.decomposition.steps.length, 3);
});

test('preserves model-authored step content, including checkHint', () => {
  const steps = makeSteps(4);
  steps[1].checkHint = 'A loop goes over the words.';
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex1');
  assert.equal(r.ok, true);
  assert.equal(r.decomposition.steps[1].checkHint, 'A loop goes over the words.');
  assert.equal(r.decomposition.steps[3].label, 'Step 4');
});

test('accepts the 3-step and 7-step boundaries', () => {
  assert.equal(parseDecomposition(JSON.stringify({ steps: makeSteps(3) }), 'ex').ok, true);
  assert.equal(parseDecomposition(JSON.stringify({ steps: makeSteps(7) }), 'ex').ok, true);
});

// ── parseDecomposition: rejections ─────────────────────────────────

test('rejects output with no JSON object', () => {
  const r = parseDecomposition('I cannot answer that.', 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no JSON object/);
});

test('rejects malformed JSON', () => {
  const r = parseDecomposition("{steps: 'not valid json'}", 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid JSON/);
});

test('rejects a missing steps array', () => {
  // The parser normalises a missing steps field to [], so the violation
  // surfaces as a step-count problem rather than a type problem.
  const r = parseDecomposition('{"plan": []}', 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /3 to 8 steps, found 0/);
});

test('rejects too few and too many steps, reporting the count', () => {
  const few = parseDecomposition(JSON.stringify({ steps: makeSteps(2) }), 'ex');
  const many = parseDecomposition(JSON.stringify({ steps: makeSteps(9) }), 'ex');
  assert.equal(few.ok, false);
  assert.match(few.reason, /3 to 8 steps, found 2/);
  assert.equal(many.ok, false);
  assert.match(many.reason, /3 to 8 steps, found 9/);
});

test('accepts an eight-step plan', () => {
  const r = parseDecomposition(JSON.stringify({ steps: makeSteps(8) }), 'ex');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decomposition.steps.length, 8);
});

test('keeps LaTeX commands out of JSON escaping', () => {
  // "\times" and "\frac" begin with escapes JSON accepts, so before the
  // guard they parsed into a tab and a formfeed and silently ate a letter.
  const raw = String.raw`{"steps":[
    {"index":1,"label":"A","intent":"v = \Delta t \times (\frac{1}{2}a_0)"},
    {"index":2,"label":"B","intent":"plain"},
    {"index":3,"label":"C","intent":"plain"}]}`;
  const r = parseDecomposition(raw, 'ex');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decomposition.steps[0].intent, 'v = \\Delta t \\times (\\frac{1}{2}a_0)');
});

test('leaves newline separators, \\uXXXX and escaped backslashes alone', () => {
  const raw = String.raw`{"steps":[
    {"index":1,"label":"A","intent":"goal\n- one\n- two"},
    {"index":2,"label":"B","intent":"caf\u00e9 value"},
    {"index":3,"label":"C","intent":"path C:\\tmp here"}]}`;
  const r = parseDecomposition(raw, 'ex');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decomposition.steps[0].intent, 'goal\n- one\n- two');
  assert.equal(r.decomposition.steps[1].intent, 'caf\u00e9 value');
  assert.equal(r.decomposition.steps[2].intent, 'path C:\\tmp here');
});

test('rejects an intent left holding a swallowed LaTeX command', () => {
  // Checked on the parsed string, so build one directly: a JSON round-trip
  // would re-escape the control character and the LaTeX guard would undo it.
  const steps = makeSteps(3);
  steps[0].intent = 'scale by \u0009imes two'; // what "\times" used to become
  steps[2].intent = 'half is \u000crac{1}{2}'; // and "\frac"
  const v = listDecompositionViolations(makeGold(steps));
  assert.ok(v.some((m) => /step 1 intent contains a control character/.test(m)), v.join('; '));
  assert.ok(v.some((m) => /step 3 intent contains a control character/.test(m)), v.join('; '));
});

test('allows a leading tab as indentation', () => {
  const steps = makeSteps(3);
  steps[0].intent = 'goal line\n\tcontinued here';
  assert.deepEqual(listDecompositionViolations(makeGold(steps)), []);
});

test('accepts a step whose specification arrives as "spec"', () => {
  // qwen3.6 via ChatESE renames the field; rejecting it costs a whole
  // regeneration, so the parser moves the synonym onto intent.
  const steps = makeSteps(3).map(({ intent, ...rest }) => ({ ...rest, spec: intent }));
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decomposition.steps[0].intent, 'Think about what this part of the task needs.');
  assert.equal(r.decomposition.steps[0].spec, undefined);
});

test('keeps a real intent when a synonym is also present', () => {
  const steps = makeSteps(3).map((s) => ({ ...s, spec: 'the wrong one' }));
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.decomposition.steps[0].intent, 'Think about what this part of the task needs.');
});

test('names the intent field when no synonym is recognised', () => {
  const steps = makeSteps(3).map(({ intent, ...rest }) => ({ ...rest, blurb: intent }));
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /named exactly "intent"/);
});

test('never rejects prose for looking like code', () => {
  // The validator checks structure only. Contract quoting, math, keywords,
  // even signature snippets must all pass; leakage review happens in the
  // offline audit, not at parse time.
  for (const ok of [
    'The function compute_velocity(dt, k, a) should return one velocity value.',
    'Assume v(0) = 0, exactly as the exercise states.',
    'Read the values from data/acc.dat before you import any plotting library.',
    'Write def compute_velocity(dt, k, a) exactly as the exercise names it.',
    'Decide what the function hands back for an empty input.',
  ]) {
    const steps = makeSteps(3);
    steps[1].intent = ok;
    steps[2].checkHint = ok;
    const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
    assert.equal(r.ok, true, `should be accepted: "${ok}"`);
  }
});

test('accepts plain-English prose that merely sounds imperative', () => {
  const steps = makeSteps(3);
  steps[0].intent = 'For each word, keep a running tally and hand the result back.';
  steps[0].checkHint = 'A dictionary-like structure is updated inside a loop.';
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, true);
});

test('rejects non-string label or intent', () => {
  const steps = makeSteps(3);
  steps[0].label = 42;
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /step 1 label must be a non-empty string/);
});

test('rejects empty or whitespace-only label and intent', () => {
  const blankLabel = makeSteps(3);
  blankLabel[0].label = '   ';
  const r1 = parseDecomposition(JSON.stringify({ steps: blankLabel }), 'ex');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /step 1 label/);

  const blankIntent = makeSteps(3);
  blankIntent[2].intent = '';
  const r2 = parseDecomposition(JSON.stringify({ steps: blankIntent }), 'ex');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /step 3 must carry its specification/);
});

test('rejects a non-string checkHint', () => {
  const steps = makeSteps(3);
  steps[1].checkHint = 42;
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /step 2 checkHint must be a string/);
});

test('names every violation at once, not just the first', () => {
  const steps = makeSteps(3);
  steps[0].intent = '   '; // blank intent
  steps[1].label = '   '; // blank label
  steps[2].checkHint = 42; // wrong type
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /step 1 must carry its specification/);
  assert.match(r.reason, /step 2 label must be a non-empty string/);
  assert.match(r.reason, /step 3 checkHint must be a string/);
});

test('rejects non-contiguous step indices and reports the position', () => {
  const steps = makeSteps(3);
  steps[2].index = 5; // 1, 2, 5
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /found 5 at position 3/);
});

test('rejects steps listed out of order', () => {
  const steps = [makeSteps(3)[1], makeSteps(3)[0], makeSteps(3)[2]]; // 2, 1, 3
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /indices must run 1\.\.N/);
});

// ── fillDecomposeTemplate ──────────────────────────────────────────

const TPL =
  'ID: {{exercise_id}}\nDesc:\n{{problem_description}}\nCode:\n{{code}}\nAgain: {{exercise_id}}';

test('fills every placeholder, including repeated ones', () => {
  const prompt = fillDecomposeTemplate(TPL, {
    exerciseId: 'count_words',
    problemDescription: 'Count each word in a sentence.',
    code: 'x',
  });
  assert.match(prompt, /ID: count_words\n/);
  assert.match(prompt, /Again: count_words/);
  assert.match(prompt, /Count each word in a sentence\./);
  assert.doesNotMatch(prompt, /\{\{/); // no residue
});

test('trims the description and code before inserting', () => {
  const prompt = fillDecomposeTemplate(TPL, {
    exerciseId: 'ex',
    problemDescription: '  padded description  \n',
    code: '\n  x  \n',
  });
  assert.match(prompt, /Desc:\npadded description\n/);
  assert.match(prompt, /Code:\nx\n/);
});

test('empty student code leaves an empty section, not a placeholder', () => {
  const prompt = fillDecomposeTemplate(TPL, {
    exerciseId: 'ex',
    problemDescription: 'd',
    code: '',
  });
  assert.match(prompt, /Code:\n\nAgain/);
  assert.doesNotMatch(prompt, /\{\{code\}\}/);
});

test('inserts regex-special sequences in values verbatim', () => {
  // String.replace would expand $& and $1; split/join must not.
  const prompt = fillDecomposeTemplate(TPL, {
    exerciseId: 'ex',
    problemDescription: 'd',
    code: 'price = "$&" + "$1"',
  });
  assert.match(prompt, /price = "\$&" \+ "\$1"/);
});

test('leaves placeholders it does not own untouched', () => {
  const prompt = fillDecomposeTemplate('{{exercise_id}} {{hidden_tests}}', {
    exerciseId: 'ex',
    problemDescription: 'd',
    code: '',
  });
  assert.equal(prompt, 'ex {{hidden_tests}}');
});

// ── generateDecomposition ──────────────────────────────────────────
// The engine loads its template through the synced prompt repository.
// If no repo (or no decompose template) exists on this machine, create a
// minimal one for the test run and remove exactly what was created.

const TEMPLATE_PATH = path.join(LOCAL_REPO_PATH, 'prompts', 'decompose.txt');
let createdTemplate = false;

before(() => {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    fs.mkdirSync(path.dirname(TEMPLATE_PATH), { recursive: true });
    fs.writeFileSync(
      TEMPLATE_PATH,
      'ID: {{exercise_id}}\nDESC: {{problem_description}}\nCODE: {{code}}\n'
    );
    createdTemplate = true;
  }
});

after(() => {
  if (createdTemplate) {
    fs.rmSync(TEMPLATE_PATH, { force: true });
  }
});

const CTX = {
  exerciseId: 'count_words',
  problemDescription: 'Count each word in a sentence.',
  code: '',
};

/** Fake LLM that replays scripted responses and records the prompts. */
function fakeLLM(responses) {
  const prompts = [];
  const call = async (prompt) => {
    prompts.push(prompt);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { call, prompts };
}

const VALID_RESPONSE = JSON.stringify({ steps: makeSteps(3) });

test('engine succeeds on the first attempt', async () => {
  const llm = fakeLLM([VALID_RESPONSE]);
  const r = await generateDecomposition(CTX, llm.call);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.decomposition.exerciseId, 'count_words');
  assert.equal(llm.prompts.length, 1);
  assert.match(llm.prompts[0], /count_words/); // placeholder was filled
});

test('engine retries once and feeds the rejection reason back', async () => {
  const badIndex = makeSteps(3);
  badIndex[2].index = 5;
  const llm = fakeLLM([JSON.stringify({ steps: badIndex }), VALID_RESPONSE]);
  const r = await generateDecomposition(CTX, llm.call);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(llm.prompts.length, 2);
  assert.match(llm.prompts[1], /Your previous answer was rejected:/);
  assert.match(llm.prompts[1], /found 5 at position 3/); // specific reason fed back
});

test('engine gives up after two bad answers with the last reason', async () => {
  const llm = fakeLLM(['nonsense', 'still nonsense']);
  const r = await generateDecomposition(CTX, llm.call);
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.match(r.reason, /no JSON object/);
});

test('engine does not retry transport errors', async () => {
  const llm = fakeLLM([new Error('boom')]);
  const r = await generateDecomposition(CTX, llm.call);
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.match(r.reason, /LLM call failed: boom/);
  assert.equal(llm.prompts.length, 1); // exactly one call, no retry
});

// ── timeShare (schema v2) ──────────────────────────────────────────
// Exercised through listDecompositionViolations directly: gold files skip
// the parser, so the validator must hold these rules on its own.

/** A gold-file-shaped object. */
function makeGold(steps) {
  return { exerciseId: 'ex', source: 'gold', steps };
}

/** Attach the given shares to a fresh 3-step plan. */
function stepsWithShares(shares) {
  return makeSteps(shares.length).map((s, i) =>
    shares[i] === undefined ? s : { ...s, timeShare: shares[i] }
  );
}

test('accepts a v1 gold plan without timeShare (compatibility)', () => {
  const v = listDecompositionViolations(makeGold(makeSteps(3)));
  assert.deepEqual(v, []);
});

test('accepts a full set of timeShares summing to 100', () => {
  const v = listDecompositionViolations(makeGold(stepsWithShares([20, 30, 50])));
  assert.deepEqual(v, []);
});

test('rejects timeShare on only some steps', () => {
  const v = listDecompositionViolations(makeGold(stepsWithShares([50, undefined, undefined])));
  assert.ok(v.some((m) => /every step or on none/.test(m)), v.join('; '));
});

test('rejects shares that do not sum to roughly 100', () => {
  const v = listDecompositionViolations(makeGold(stepsWithShares([50, 50, 30])));
  assert.ok(v.some((m) => /sum to roughly 100, found 130/.test(m)), v.join('; '));
});

test('rejects a share below 5 percent', () => {
  const v = listDecompositionViolations(makeGold(stepsWithShares([2, 49, 49])));
  assert.ok(v.some((m) => /step 1 timeShare must be a number between 5 and 100/.test(m)), v.join('; '));
});

test('parses timeShare through from model output', () => {
  const steps = stepsWithShares([25, 25, 50]);
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, true);
  assert.equal(r.decomposition.steps[2].timeShare, 50);
});
