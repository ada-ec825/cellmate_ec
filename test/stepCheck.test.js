// Tests for src/stepCheck.ts (whole-plan progress check).
// Runs against the compiled output — run `npm run compile` first, then:
//   node --test test/
// Uses only Node built-ins so no test dependency is added to package.json.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  fillProgressCheckTemplate,
  parseProgressCheck,
  runProgressCheck,
} = require('../out/stepCheck.js');
const { LOCAL_REPO_PATH } = require('../out/gitUtils.js');

/** Build a plan of n steps; checkHint only on step 2 to cover both shapes. */
function makePlanSteps(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    label: `Step ${i + 1}`,
    intent: `Work out part ${i + 1} of the task.`,
    ...(i === 1 ? { checkHint: 'A loop appears over the input.' } : {}),
  }));
}

const CTX = {
  exerciseId: 'acc_data_velocity',
  problemDescription: 'Compute velocities from acceleration data.',
  code: 'acc_array = load()',
  steps: makePlanSteps(3),
};

// ── fillProgressCheckTemplate ──────────────────────────────────────

const TPL = 'EX: {{exercise_id}}\nDESC: {{problem_description}}\nSTEPS:\n{{steps}}\nCODE:\n{{code}}';

test('renders every step as a numbered line with its intent', () => {
  const prompt = fillProgressCheckTemplate(TPL, CTX);
  assert.match(prompt, /1\. Step 1 — Work out part 1 of the task\./);
  assert.match(prompt, /3\. Step 3 — Work out part 3 of the task\./);
  assert.doesNotMatch(prompt, /\{\{/); // no placeholder residue
});

test('appends checkHint as an evidence note only where present', () => {
  const prompt = fillProgressCheckTemplate(TPL, CTX);
  assert.match(prompt, /2\. Step 2 — .*\(evidence: A loop appears over the input\.\)/);
  assert.doesNotMatch(prompt, /1\. Step 1 — .*evidence/);
});

test('fills exercise id, description and code', () => {
  const prompt = fillProgressCheckTemplate(TPL, CTX);
  assert.match(prompt, /EX: acc_data_velocity/);
  assert.match(prompt, /DESC: Compute velocities/);
  assert.match(prompt, /CODE:\nacc_array = load\(\)/);
});

// ── parseProgressCheck ─────────────────────────────────────────────

const DONE = { status: 'done' };

test('accepts a valid assessment, tolerating fences and prose', () => {
  const raw =
    'Here you go:\n```json\n' +
    JSON.stringify({
      steps: [DONE, { status: 'issue', note: 'Something is used but never defined.' }, { status: 'missing' }],
      feedback: 'Nice start on loading.',
    }) +
    '\n```';
  const r = parseProgressCheck(raw, 3);
  assert.deepEqual(r, {
    verdicts: [
      { status: 'done' },
      { status: 'issue', note: 'Something is used but never defined.' },
      { status: 'missing' },
    ],
    feedback: 'Nice start on loading.',
  });
});

test('drops blank notes but keeps the status', () => {
  const raw = JSON.stringify({
    steps: [DONE, { status: 'issue', note: '  ' }, { status: 'missing' }],
    feedback: 'ok',
  });
  const r = parseProgressCheck(raw, 3);
  assert.deepEqual(r.verdicts[1], { status: 'issue' });
});

test('returns null when the verdict count does not match the plan', () => {
  const raw = JSON.stringify({ steps: [DONE, DONE], feedback: 'ok' });
  assert.equal(parseProgressCheck(raw, 3), null);
});

test('returns null on an unknown status', () => {
  const raw = JSON.stringify({
    steps: [DONE, { status: 'partly' }, DONE],
    feedback: 'ok',
  });
  assert.equal(parseProgressCheck(raw, 3), null);
});

test('returns null on missing or blank feedback', () => {
  assert.equal(parseProgressCheck(JSON.stringify({ steps: [DONE, DONE, DONE] }), 3), null);
  assert.equal(
    parseProgressCheck(JSON.stringify({ steps: [DONE, DONE, DONE], feedback: '  ' }), 3),
    null
  );
});

test('returns null when there is no JSON at all', () => {
  assert.equal(parseProgressCheck('cannot help with that', 3), null);
});

// ── runProgressCheck (fail-open) ───────────────────────────────────

const TEMPLATE_PATH = path.join(LOCAL_REPO_PATH, 'prompts', 'progress_check.txt');
let createdTemplate = false;

before(() => {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    fs.mkdirSync(path.dirname(TEMPLATE_PATH), { recursive: true });
    fs.writeFileSync(TEMPLATE_PATH, TPL);
    createdTemplate = true;
  }
});

after(() => {
  if (createdTemplate) {
    fs.rmSync(TEMPLATE_PATH, { force: true });
  }
});

/** Fake LLM replaying scripted responses; Error entries throw. */
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

test('returns the assessment and sends plan plus code to the model', async () => {
  const llm = fakeLLM([
    JSON.stringify({
      steps: [DONE, DONE, { status: 'missing' }],
      feedback: 'Two down, one to go.',
    }),
  ]);
  const r = await runProgressCheck(CTX, llm.call);
  assert.deepEqual(r, {
    verdicts: [{ status: 'done' }, { status: 'done' }, { status: 'missing' }],
    feedback: 'Two down, one to go.',
  });
  assert.equal(llm.prompts.length, 1);
  assert.match(llm.prompts[0], /1\. Step 1/); // plan made it into the prompt
  assert.match(llm.prompts[0], /acc_array = load\(\)/); // so did the live code
});

test('fails open on transport errors', async () => {
  const llm = fakeLLM([new Error('boom')]);
  const r = await runProgressCheck(CTX, llm.call);
  assert.equal(r, null); // no exception escapes
});

test('fails open on malformed output, with exactly one call (no retry)', async () => {
  const llm = fakeLLM(['nonsense']);
  const r = await runProgressCheck(CTX, llm.call);
  assert.equal(r, null);
  assert.equal(llm.prompts.length, 1);
});
