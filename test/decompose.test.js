// Tests for src/decompose.ts (parseDecomposition / extractJsonObject).
// Runs against the compiled output — run `npm run compile` first, then:
//   node --test test/
// Uses only Node built-ins so no test dependency is added to package.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractJsonObject, parseDecomposition } = require('../out/decompose.js');

/** Build a valid 3..7-step plan the parser should accept. */
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

test('accepts a valid plan and stamps exerciseId/version/source', () => {
  const raw =
    'Sure!\n```json\n' +
    JSON.stringify({
      exerciseId: 'echoed-wrong',
      version: 99,
      source: 'gold',
      steps: makeSteps(3),
    }) +
    '\n```';
  const r = parseDecomposition(raw, 'count_words');
  assert.equal(r.ok, true);
  // Fields the extension owns are stamped, not trusted from the echo.
  assert.equal(r.decomposition.exerciseId, 'count_words');
  assert.equal(r.decomposition.version, 1);
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
  const r = parseDecomposition('{"plan": []}', 'ex');
  assert.equal(r.ok, false);
  assert.match(r.reason, /schema validation/);
});

test('rejects too few and too many steps', () => {
  const few = parseDecomposition(JSON.stringify({ steps: makeSteps(2) }), 'ex');
  const many = parseDecomposition(JSON.stringify({ steps: makeSteps(8) }), 'ex');
  assert.equal(few.ok, false);
  assert.equal(many.ok, false);
});

test('rejects code traces in an intent', () => {
  for (const leaky of [
    'just return x here',
    'Return the final list to the caller', // keyword check is case-insensitive
    'write def solve first',
    'you should import math',
    'use ``` to format',
    'call `text.split()` on the input', // inline code span
    'set counter = 0 before the loop', // assignment operator
    'loop with for word in words', // Python-style loop header
  ]) {
    const steps = makeSteps(3);
    steps[1].intent = leaky;
    const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
    assert.equal(r.ok, false, `intent should be rejected: "${leaky}"`);
    assert.match(r.reason, /schema validation/);
  }
});

test('rejects code traces in a checkHint', () => {
  const steps = makeSteps(3);
  steps[2].checkHint = 'Sets total = 0 before the loop.';
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
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
});

test('rejects empty or whitespace-only label and intent', () => {
  const blankLabel = makeSteps(3);
  blankLabel[0].label = '   ';
  assert.equal(parseDecomposition(JSON.stringify({ steps: blankLabel }), 'ex').ok, false);

  const blankIntent = makeSteps(3);
  blankIntent[2].intent = '';
  assert.equal(parseDecomposition(JSON.stringify({ steps: blankIntent }), 'ex').ok, false);
});

test('rejects a non-string checkHint', () => {
  const steps = makeSteps(3);
  steps[1].checkHint = 42;
  const r = parseDecomposition(JSON.stringify({ steps }), 'ex');
  assert.equal(r.ok, false);
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
