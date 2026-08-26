#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractCode } = require('./lib/extract.js');
const { functionBlocks, mergeUnlocked } = require('./lib/functions.js');
const { clientFromSpec, inspectResolvedModel, resolveModelSpec } = require('./lib/model.js');
const { evaluateAssertions, grade, gradeLogical, testNames } = require('./lib/grader.js');
const { scorePairedUnseenTests, validatePairedReference } = require('./lib/unseen-tests.js');

const ROOT = __dirname;
const RUNS = path.join(__dirname, '..', 'runs');
const DEFAULT_PROTOCOL = null;
const MODEL_SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const FUNCTIONS = ['parse_amount', 'parse_record', 'load_records', 'match_payments', 'compute_refunds', 'build_summary'];
const ARMS = ['plain_note', 'plain_note_clear', 'steps_note', 'steps_note_clear'];
const CLEAR_ARMS = ARMS;
const TASK_FUNCTIONS = {
  reconciliation: FUNCTIONS,
  parcel_quotes: ['parse_weight', 'parse_parcel', 'load_parcels', 'quote_parcels', 'count_express', 'build_summary'],
  service_credits: ['parse_timestamp', 'parse_case', 'load_cases', 'calculate_credits', 'summarise_accounts', 'build_report'],
};
const TASK_MODELS = {
  reconciliation: MODEL_SNAPSHOT,
  parcel_quotes: 'gpt-4o-mini',
  service_credits: 'gpt-4o-mini',
};
const EXPECTED = {
  seeds: 25, sessions: 100, calls: 4800, smoke: false,
  stages: 6, presentationVersion: 'presentations', arms: ARMS,
  clearProbability: 0.25, repairs: 18, capRetries: 1,
};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function wordCount(value) { return String(value ?? '').trim().split(/\s+/).filter(Boolean).length; }
function truncateWords(value, maximumWords) {
  const text = String(value ?? '').trim();
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= maximumWords) return text;
  const last = words[maximumWords - 1];
  return text.slice(0, last.index + last[0].length).trim();
}
function readRoot(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); }
function writeNew(filename, value) {
  fs.writeFileSync(filename, typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value), { flag: 'wx' });
}
function writeCanonicalOrVerify(filename, value) {
  const bytes = canonicalJson(value);
  if (!fs.existsSync(filename)) {
    writeNew(filename, bytes);
    return;
  }
  if (fs.readFileSync(filename, 'utf8') !== bytes) {
    throw new Error(`existing final artifact differs: ${filename}`);
  }
}
function appendLine(filename, value) { fs.appendFileSync(filename, `${JSON.stringify(value)}\n`); }
function hashInt(text) { return Number.parseInt(sha256(text).slice(0, 8), 16) & 0x7fffffff; }
function hashUniform(text) { return Number.parseInt(sha256(text).slice(0, 8), 16) / 0x100000000; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function loadLocalApiKey() {
  if (process.env.OPENAI_API_KEY) return;
  const candidates = [
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '..', '.env.local'),
    path.join(ROOT, '..', '..', '.env.local'),
    path.join(ROOT, '..', '..', '..', '.env.local'),
  ];
  for (const filename of candidates) {
    if (!fs.existsSync(filename)) continue;
    const line = fs.readFileSync(filename, 'utf8').split(/\r?\n/)
      .find((item) => /^(?:export\s+)?OPENAI_API_KEY\s*=/.test(item));
    if (!line) continue;
    let value = line.slice(line.indexOf('=') + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) process.env.OPENAI_API_KEY = value;
    return;
  }
}

function noteClearEnabled(definition) {
  return definition.noteClear ?? definition.noteWipe ?? false;
}

function noteClearApplied(protocol, definition, seed, absoluteRound) {
  if (!noteClearEnabled(definition) || absoluteRound === 1) return false;
  if (protocol.noteClearProbability !== undefined) {
    return hashUniform(`${protocol.noteClearSeedSalt}|${seed}|round|${absoluteRound}`) < protocol.noteClearProbability;
  }
  const fixedStages = protocol.noteWipeBeforeStages ?? [protocol.noteWipeBeforeStage];
  return fixedStages.includes(absoluteRound);
}

function scheduledNoteClearRounds(protocol, definition, seed) {
  if (!noteClearEnabled(definition)) return [];
  const maximum = protocol.numberOfStages + protocol.maximumFinalRepairRounds;
  return Array.from({ length: maximum }, (_, index) => index + 1)
    .filter((round) => noteClearApplied(protocol, definition, seed, round));
}

function parseArgs(argv) {
  const result = { protocol: DEFAULT_PROTOCOL, runId: null, preflightOnly: false, resume: false, concurrency: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--protocol') result.protocol = path.resolve(argv[++index]);
    else if (argv[index] === '--run-id') result.runId = argv[++index];
    else if (argv[index] === '--preflight-only') result.preflightOnly = true;
    else if (argv[index] === '--resume') result.resume = true;
    else if (argv[index] === '--concurrency') result.concurrency = Number.parseInt(argv[++index], 10);
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  if (!result.protocol) {
    throw new Error(
      'this is the shared session engine; use run_formal_note_comparison.js for the retained experiment',
    );
  }
  if (!result.preflightOnly && (!result.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(result.runId))) {
    throw new Error('use --preflight-only or --run-id SAFE_VALUE');
  }
  return result;
}

function loadProtocol(filename, runId = null) {
  const protocolBytes = fs.readFileSync(filename);
  const protocol = JSON.parse(protocolBytes.toString('utf8'));
  const taskFunctions = TASK_FUNCTIONS[protocol.task];
  const taskModel = TASK_MODELS[protocol.task];
  const pilot = protocol.protocolVersion === 'pilot';
  const pilotNoteVersions = ['note-priority', 'note-priority-v2', 'note-priority-v3', 'note-priority-v4', 'note-priority-v5', 'structured-note', 'source-note'];
  const experimentNoteVersions = ['note', 'note-priority-v5', 'structured-note', 'source-note'];
  const expected = ['experiment', 'pilot'].includes(protocol.protocolVersion) && taskFunctions && taskModel
    ? {
      ...EXPECTED,
      ...(pilot ? {
        seeds: protocol.seeds?.length,
        sessions: protocol.seeds?.length * ARMS.length,
        calls: protocol.seeds?.length * ARMS.length *
          (protocol.numberOfStages + protocol.maximumFinalRepairRounds) *
          (['note-priority-v5', 'structured-note', 'source-note'].includes(protocol.noteInstructionVersion) ? 6 :
            protocol.noteInstructionVersion === 'note-priority-v4' ? 4 : 2),
      } : ['note-priority-v5', 'structured-note'].includes(protocol.noteInstructionVersion) ? {
        calls: EXPECTED.calls * 3,
      } : {}),
      task: protocol.task, model: taskModel, designSource: protocol.designSource, functions: taskFunctions,
      noteInstructionVersion: protocol.noteInstructionVersion,
    }
    : null;
  const wipeStages = protocol.noteWipeBeforeStages ?? [protocol.noteWipeBeforeStage];
  const probabilisticClear = expected?.clearProbability !== undefined;
  const expectedArms = expected?.arms ?? ARMS;
  if (!expected ||
      protocol.status !== 'frozen' ||
      protocol.designSource !== expected.designSource ||
      protocol.task !== expected.task ||
      protocol.model?.spec !== `openai-responses:${expected.model}` ||
      protocol.model?.snapshot !== expected.model ||
      JSON.stringify(protocol.arms) !== JSON.stringify(expectedArms) ||
      protocol.seeds?.length !== expected.seeds ||
      new Set(protocol.seeds).size !== expected.seeds ||
      protocol.numberOfStages !== expected.stages ||
      (!probabilisticClear && JSON.stringify(wipeStages) !== JSON.stringify(expected.wipeStages)) ||
      (probabilisticClear && (protocol.noteClearProbability !== expected.clearProbability ||
        typeof protocol.noteClearSeedSalt !== 'string' || !protocol.noteClearSeedSalt ||
        protocol.noteWipeBeforeStages !== undefined || protocol.noteWipeBeforeStage !== undefined)) ||
      JSON.stringify(protocol.functionNames ?? FUNCTIONS) !== JSON.stringify(expected.functions) ||
      protocol.maximumNoteCharacters !== (['structured-note', 'source-note'].includes(protocol.noteInstructionVersion) ? 3000 : protocol.noteInstructionVersion === 'note-priority-v5' ? 400 : 300) ||
      (['structured-note', 'source-note'].includes(protocol.noteInstructionVersion) && protocol.maximumNoteWords !== 300) ||
      (pilot && !pilotNoteVersions.includes(protocol.noteInstructionVersion)) ||
      (!pilot && !experimentNoteVersions.includes(protocol.noteInstructionVersion)) ||
      protocol.noteInstructionVersion !== expected.noteInstructionVersion ||
      protocol.temperature !== 0.2 || protocol.repeatRepairTemperature !== 0.4 ||
      protocol.numPredict !== 1800 || protocol.maximumFinalRepairRounds !== expected.repairs ||
      (protocol.maximumCompletionCapRetries ?? 0) !== (expected.capRetries ?? 0) ||
      protocol.maximumTransportAttempts !== 3 ||
      protocol.rules?.repair !== true ||
      protocol.formalRun?.expectedSessions !== expected.sessions ||
      protocol.formalRun?.maximumStudentCalls !== expected.calls) {
    throw new Error('protocol settings do not match this experiment');
  }
  const expectedCells = probabilisticClear ? {
    plain_note: { presentation: 'plain', noteClear: false },
    plain_note_clear: { presentation: 'plain', noteClear: true },
    steps_note: { presentation: 'project_steps', noteClear: false },
    steps_note_clear: { presentation: 'project_steps', noteClear: true },
  } : {
    plain_note: { presentation: 'plain', noteWipe: false },
    plain_note_wipe: { presentation: 'plain', noteWipe: true },
    steps_note: { presentation: 'project_steps', noteWipe: false },
    steps_note_wipe: { presentation: 'project_steps', noteWipe: true },
  };
  if (JSON.stringify(protocol.cellDefinitions) !== JSON.stringify(expectedCells)) {
    throw new Error('condition definitions do not match this experiment');
  }
  if (expected.smoke) {
    if (protocol.smokeGate?.requiredStepsNoteCompletions !== 2 ||
        protocol.smokeGate?.requiredPlainNoteCompletions !== 1 ||
        protocol.smokeGate?.minimumStepsNoteMedianRounds !== expected.smokeMinRounds ||
        protocol.smokeGate?.maximumStepsNoteMedianRounds !== expected.smokeMaxRounds ||
        protocol.smokeGate?.maximumMechanicalFailures !== 0 ||
        (!probabilisticClear && protocol.smokeGate?.requiredWipesPerWipeSession !== expected.requiredWipes) ||
        (probabilisticClear && protocol.smokeGate?.requiredClearScheduleIntegrity !== true)) {
      throw new Error('unexpected smoke gate');
    }
  } else if (protocol.smokeGate !== undefined) {
    throw new Error('formal protocol must not contain a smoke gate');
  }
  if (runId && runId !== protocol.formalRun.requiredRunId) {
    throw new Error(`run id must be ${protocol.formalRun.requiredRunId}`);
  }
  const assets = Object.fromEntries(Object.entries(protocol.assets).map(([key, relative]) => [key, readRoot(relative)]));
  const presentations = JSON.parse(assets.presentations);
  if (presentations.version !== expected.presentationVersion || presentations.numberOfStages !== expected.stages ||
      presentations.arms?.plain?.length !== expected.stages ||
      presentations.arms?.project_steps?.length !== expected.stages) {
    throw new Error('presentation material does not match the protocol');
  }
  if (expected.functions.some((name) => !functionBlocks(assets.starter).has(name) || !functionBlocks(assets.reference).has(name))) {
    throw new Error('starter/reference functions do not match the protocol');
  }
  return { protocol, protocolBytes, assets, presentations, expected };
}

async function verifyModel(protocol) {
  const resolution = resolveModelSpec(protocol.model.spec);
  const identity = await inspectResolvedModel(resolution, { timeoutMs: 15_000 });
  if (identity?.id !== protocol.model.snapshot) {
    throw new Error(`requested snapshot ${protocol.model.snapshot} is unavailable or resolved as ${String(identity?.id)}`);
  }
  return { resolution, identity };
}

function mergeCandidate(currentCode, raw, functionNames = FUNCTIONS) {
  const codeChannel = String(raw ?? '').replace(/^NOTE:.*$/gmi, '');
  const extracted = extractCode(codeChannel);
  const candidateFunctions = extracted.code ? functionBlocks(extracted.code) : new Map();
  if (candidateFunctions.size === 0) {
    return { code: currentCode, applied: [], candidateFunctions: [], extractionSource: extracted.source };
  }
  const merged = mergeUnlocked({
    currentCode,
    candidateCode: extracted.code,
    functionNames,
    unlocked: functionNames,
  });
  return { ...merged, extractionSource: extracted.source };
}

function noteInstruction(maximumCharacters, version = 'note', partsRepeat = false, maximumWords = 300) {
  if (version === 'source-note') {
    return [
      'You have a note area. It is the only prose information that can carry over to later rounds.',
      partsRepeat
        ? 'Only the current task part is visible. After the final part, the task starts again from Part 1. Your private reasoning is not retained; cumulative code remains visible.'
        : 'The task description changes every round. Your private reasoning is not retained; cumulative code remains visible.',
      ...(partsRepeat ? [
        'Repeated parts belong to the same task and are shown again only for review and correction. They are not a new task or a changed requirement.',
        'Preserve correct work. Revise code only when the current text or visible test evidence shows a real problem.',
      ] : []),
      `Every round, replace the complete note with one JSON object of at most ${maximumWords} words. Do not wrap the JSON in a markdown fence.`,
      'Write only these two keys: rules and checks. The harness adds read-only status and todo fields after grading.',
      'Each short source rule in the current task part has an ID such as P2-L3.',
      'rules: an array of source ID strings, ordered most important first. Use only IDs from the current task part or inherit IDs from the preceding note. The harness carries and displays the authoritative text for each accepted ID, drops unsupported IDs, and drops lowest-priority IDs from the end if the expanded note exceeds the limit.',
      'checks: up to three executable observations, each written as one Python assert statement of at most 1000 characters. Example: "assert parse_amount(\'1e2\') is None". Use ==, !=, is, or is not. Start from public task functions; signed numeric literals, date/datetime/timedelta/Decimal constructors, nested public task calls, and literal integer/string indexing of returned lists or dictionaries are allowed. Variables, slices, arbitrary attributes, comprehensions, and other calls are not allowed.',
      'A check asks what the current code does. OBSERVED_PASS does not prove that the behaviour is required by the task. Never copy a check into rules unless a visible task line states the same rule.',
      'Checks expire quickly. Resubmit a useful passing check to keep it; drop checks that failed or are no longer useful.',
      'status and todo are produced only from official visible tests. Do not write or override them.',
    ].join('\n');
  }
  if (version === 'structured-note') {
    return [
      'You have a note area. It is the only prose information that can carry over to later rounds.',
      partsRepeat
        ? 'Only the current task part is visible. After the final part, the task starts again from Part 1. Your private reasoning is not retained; cumulative code remains visible.'
        : 'The task description changes every round. Your private reasoning is not retained; cumulative code remains visible.',
      ...(partsRepeat ? [
        'Repeated parts belong to the same task and are shown again only for review and correction. They are not a new task or a changed requirement.',
        'Do not overreact to repeated text: preserve correct code and completed work; revise only when the repeated specification or test evidence reveals a real problem.',
      ] : []),
      `Every round, rewrite the complete note from scratch. Replace the previous note; never append to it. The complete note must contain at most ${maximumWords} words.`,
      'Use exactly these five sections:',
      'TASK BRIEF: one short line describing the task.',
      'GLOBAL CONSTRAINTS: concise bullets for cross-cutting rules, especially exact numbers, strings, and boundary choices.',
      'PROGRESS: concise bullets stating what is implemented and what visible tests confirm.',
      'TODO: concise bullets for unfinished work and the next action.',
      'QUESTIONS: concise bullets for unresolved doubts or failed approaches; write "- none" if empty.',
      'Use compact key-value items or bullets, never prose paragraphs.',
      'Before rewriting, use the latest test feedback to delete or correct contradicted claims. Do not preserve guesses as facts.',
      'Delete completed details that are already represented by passing code when space is needed; prioritise unimplemented rules and unresolved problems.',
    ].join('\n');
  }
  const lengthRule = version === 'note-priority-v5'
    ? 'On every round, rewrite the entire note rather than appending to it. Aim for at most 300 characters; the hard limit is 400 characters.'
    : `On every round, rewrite the entire note rather than appending to it. The complete note may contain at most ${maximumCharacters} characters.`;
  const base = [
    'You have a note area. It is the only prose information that can carry over to later rounds.',
    partsRepeat
      ? 'Only the current task part is visible. After the final part, the task starts again from Part 1. Your private reasoning is not retained. The cumulative code remains visible separately.'
      : 'The task description changes every round and will not be shown again. Your private reasoning is not retained. The cumulative code remains visible separately.',
    lengthRule,
    'You may choose what to preserve, including global rules that apply to multiple functions, verified or unverified progress, the next intended action, and approaches already tried that failed.',
  ];
  const rules = [
    ...base,
    'When writing the note:',
    '1. Prioritise concrete numbers, exact strings, and binary rules. These details cannot be reconstructed by guessing, while code structure can be reconstructed from the code itself.',
    '2. Write rules in directly executable form, such as "window=72h; endpoints=included", not vague reminders such as "remember the time window".',
    partsRepeat
      ? '3. After reading the current task part, first extract its rule-like information into the note, then write code. This part will not reappear until the next reading pass.'
      : '3. After reading the new task part, first extract its rule-like information into the note, then write code. The task part will not reappear, so this is the only chance to preserve it.',
    '4. Use short key-value pairs or list items rather than complete sentences.',
    '5. Before rewriting the note, compare it with the latest test feedback. Delete or correct every note claim that conflicts with that feedback. Record rules stated by the task and facts confirmed by tests, not your guesses; a hypothesis disproved by a test must not remain in the note.',
  ];
  if (version === 'note-priority') {
    rules.push('6. When space is limited, delete rules that are already correctly implemented in the code and have passed their tests; the code itself is their record. Prioritise rules that have been read but not yet implemented, and problems that remain unresolved.');
  } else if (['note-priority-v2', 'note-priority-v3', 'note-priority-v4', 'note-priority-v5'].includes(version)) {
    rules.push('6. Treat the note as a pending-work list, not a project summary. Do not copy old note text by default. Delete project background and rules already implemented in the code and listed among passing tests; the code itself is their record. Keep only rules already read but not yet implemented and problems still unresolved.');
  }
  return rules.join('\n');
}

function firstJsonObject(text) {
  const source = String(text ?? '');
  let start = 0;
  while (/\s/.test(source[start] ?? '')) start += 1;

  const fence = source.slice(start).match(/^```(?:json)?[ \t]*(?:\r?\n|$)/i);
  if (fence) {
    start += fence[0].length;
    while (/\s/.test(source[start] ?? '')) start += 1;
  }
  if (source[start] !== '{') return null;

  const delimiters = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      delimiters.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (delimiters.pop() !== expected) return null;
    if (delimiters.length === 0) return source.slice(start, index + 1);
  }
  return null;
}

function parseNote(raw, maximumCharacters, version = 'note', maximumWords = 300) {
  const source = String(raw ?? '');
  const marker = source.match(/^NOTE:\s*/im);
  let full = '';
  if (version === 'source-note') {
    const remainder = (marker ? source.slice(marker.index + marker[0].length) : source).trimStart();
    const jsonObject = firstJsonObject(remainder);
    full = (jsonObject ?? remainder).trim();
  } else if (marker && version === 'structured-note') {
    const remainder = source.slice(marker.index + marker[0].length);
    const fenceIndex = remainder.search(/^```/m);
    full = (fenceIndex >= 0 ? remainder.slice(0, fenceIndex) : remainder).trim();
  } else if (marker) {
    full = source.slice(marker.index + marker[0].length).split(/\r?\n/, 1)[0].trim();
  }
  const exceedsWords = ['structured-note', 'source-note'].includes(version) && wordCount(full) > maximumWords;
  const exceedsCharacters = full.length > maximumCharacters;
  if (['structured-note', 'source-note'].includes(version)) {
    const note = truncateWords(full.slice(0, maximumCharacters), maximumWords);
    return {
      note, full, found: Boolean(marker) || (version === 'source-note' && Boolean(sourceNoteObject(full))), truncated: exceedsWords || exceedsCharacters,
      wordCount: wordCount(full),
    };
  }
  let note = full.slice(0, maximumCharacters);
  if (version === 'note-priority-v3' && full.length > maximumCharacters) {
    const tail = full.slice(-maximumCharacters);
    const firstBoundary = tail.search(/\s/);
    note = (firstBoundary >= 0 ? tail.slice(firstBoundary + 1) : tail).trim();
  }
  return { note, full, found: Boolean(marker), truncated: full.length > maximumCharacters, wordCount: wordCount(full) };
}

function sourceNoteObject(note) {
  try {
    const value = JSON.parse(String(note ?? ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sourceLineMap(text, partIndex) {
  const result = new Map();
  String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?;])\s+/).forEach((line, index) => {
    const value = line.trim();
    if (value) result.set(`P${partIndex}-L${index + 1}`, value);
  });
  return result;
}

function annotatedSource(text, partIndex) {
  return [...sourceLineMap(text, partIndex).entries()]
    .map(([id, line]) => `[${id}] ${line}`).join('\n');
}

function sourceNoteForPrompt(note) {
  const value = sourceNoteObject(note);
  if (!value) return '(empty)';
  const rules = Array.isArray(value.rules) ? value.rules : [];
  const compact = { ...value, rules: rules.map((item) => item?.id).filter(Boolean) };
  const text = rules.filter((item) => item?.id && item?.quote)
    .map((item) => `[${item.id}] ${item.quote}`).join('\n');
  return `${canonicalJson(compact).trim()}\n\nSaved rule text:\n${text || '(none)'}`;
}

function officialNoteState(visible, requirementMap, functionNames, revealVisible) {
  if (!revealVisible || !visible?.pytestReport) return { status: {}, todo: [] };
  const tests = new Map((visible.pytestReport.tests ?? []).map((item) => [
    String(item.nodeid ?? '').split('::').at(-1), item.outcome,
  ]));
  const prefixes = {
    parse_amount: 'amount_', parse_record: 'record_', load_records: 'load_',
    match_payments: 'match_', compute_refunds: 'refunds_', build_summary: 'summary_',
  };
  const status = {};
  for (const name of functionNames) {
    const relevant = Object.entries(requirementMap)
      .filter(([key]) => key.startsWith(prefixes[name] ?? `${name}_`))
      .map(([, item]) => tests.get(item.visibleTest)).filter(Boolean);
    status[name] = relevant.length === 0 ? 'not_tested'
      : relevant.every((outcome) => outcome === 'passed') ? 'passing' : 'failing';
  }
  const todo = Object.values(requirementMap)
    .map((item) => item.visibleTest)
    .filter((name) => tests.get(name) && tests.get(name) !== 'passed');
  return { status, todo };
}

function normaliseSourceNote(note, {
  currentPart, currentPartIndex, precedingNote, maximumWords = 300,
  checkResults = [], visible = null, requirementMap = {}, functionNames, revealVisible = false,
}) {
  const submitted = sourceNoteObject(note);
  const preceding = sourceNoteObject(precedingNote);
  const corrections = [];
  if (!submitted) corrections.push('invalid JSON: retained the preceding structured state where possible');
  const available = sourceLineMap(currentPart, currentPartIndex);
  if (Array.isArray(preceding?.rules)) {
    preceding.rules.forEach((item) => {
      if (item && typeof item.id === 'string' && typeof item.quote === 'string') available.set(item.id, item.quote);
    });
  }
  const submittedRules = Array.isArray(submitted?.rules) ? submitted.rules : (preceding?.rules ?? []);
  const canonicalRules = [];
  const seen = new Set();
  submittedRules.forEach((item) => {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !available.has(id)) {
      corrections.push(`dropped unsupported source ID ${String(id)}`);
    } else if (!seen.has(id)) {
      seen.add(id);
      canonicalRules.push({ id, quote: available.get(id) });
    }
  });
  const submittedChecks = new Set((Array.isArray(submitted?.checks) ? submitted.checks : [])
    .filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3));
  const evaluated = new Map(checkResults.map((item) => [item.assertion, item.result]));
  const checks = [];
  for (const assertion of submittedChecks) {
    const result = evaluated.get(assertion) ?? 'INVALID';
    if (result === 'INVALID') {
      corrections.push(`dropped invalid check ${assertion}`);
      continue;
    }
    checks.push({ assertion, result, ttl: result === 'OBSERVED_PASS' ? 2 : 1 });
  }
  for (const item of Array.isArray(preceding?.checks) ? preceding.checks : []) {
    if (!item?.assertion || submittedChecks.has(item.assertion) || !Number.isInteger(item.ttl) || item.ttl <= 1) continue;
    checks.push({ assertion: item.assertion, result: item.result, ttl: item.ttl - 1 });
  }
  const official = officialNoteState(visible, requirementMap, functionNames, revealVisible);
  const value = {
    rules: canonicalRules,
    checks: checks.slice(0, 3),
    status: official.status,
    todo: official.todo,
  };
  while (wordCount(canonicalJson(value)) > maximumWords && value.rules.length > 0) {
    corrections.push(`dropped low-priority source ID ${value.rules.at(-1).id} to fit the note limit`);
    value.rules.pop();
  }
  while (wordCount(canonicalJson(value)) > maximumWords && value.checks.length > 0) {
    corrections.push('dropped a low-priority check to fit the note limit');
    value.checks.pop();
  }
  return { value, corrections };
}

function stableInterface(interfaceLines = null) {
  return interfaceLines ?? [
    'The cumulative module contains these fixed signatures:',
    '- parse_money(value)',
    '- load_records(rows)',
    '- match_records(records)',
    '- apply_refunds(records)',
    '- build_summary(matches, refunds)',
    'Decimal and InvalidOperation are already imported.',
  ].join('\n');
}

function stagePrompt({
  presentation, installment, stage, code, note, maximumNoteCharacters,
  numberOfStages = 5, interfaceLines = null, noteInstructionVersion = 'note',
  maximumNoteWords = 300,
  repeatParts = false, absoluteRound = stage, maximumTotalRounds = numberOfStages,
  readingPass = 1, totalReadingPasses = 1, noteEnabled = true,
}) {
  const label = String(presentation).startsWith('plain') ? 'plain source-order part' : 'project step';
  const noteFirst = true;
  const noteOutputRule = noteInstructionVersion === 'source-note'
    ? `First write NOTE: followed by one valid JSON object with only rules and checks. Do not use a JSON markdown fence. Stay within ${maximumNoteWords} words.`
    : noteInstructionVersion === 'structured-note'
    ? `First write NOTE: followed by a complete replacement note using TASK BRIEF, GLOBAL CONSTRAINTS, PROGRESS, TODO, and QUESTIONS. Use bullets, not prose, and stay within ${maximumNoteWords} words.`
    : noteInstructionVersion === 'note-priority-v5'
      ? 'First write one line beginning NOTE: with the complete note for the next round. Aim for at most 300 characters; never exceed 400.'
      : `First write one line beginning NOTE: with the complete note for the next round, using at most ${maximumNoteCharacters} characters.`;
  return [
    repeatParts
      ? `You are a novice Python student completing one project over at most ${maximumTotalRounds} rounds.`
      : `You are a novice Python student completing one project over ${numberOfStages} reading rounds.`,
    noteEnabled
      ? noteInstruction(maximumNoteCharacters, noteInstructionVersion, repeatParts, maximumNoteWords)
      : 'There is no note area in this condition. No prose memory is retained between rounds; only cumulative code remains available.',
    repeatParts
      ? `READING PASS ${readingPass} OF ${totalReadingPasses}; PART ${stage} OF ${numberOfStages}; OVERALL ROUND ${absoluteRound} OF ${maximumTotalRounds}. You can see only the current ${label}; other parts are unavailable in this round.`
      : `This is round ${stage} of ${numberOfStages}. You can see only the current ${label}; previous and future specification prose is unavailable.`,
    ...(repeatParts && readingPass > 1 ? [
      'This is the same task part cycling back for review and correction, not a new task. Preserve correct work and do not rewrite code merely because the text has reappeared.',
    ] : []),
    'Use the current part and cumulative code to make concrete progress. Preserve correct earlier work. You may implement or revise any public function.',
    '',
    '--- Stable public interface ---', stableInterface(interfaceLines),
    '',
    ...(noteEnabled ? [
      '--- Note saved from the preceding round ---',
      noteInstructionVersion === 'source-note' ? sourceNoteForPrompt(note) : note || '(empty)',
      '',
    ] : []),
    `--- Current ${label}: ${installment.title} ---`,
    noteInstructionVersion === 'source-note' ? annotatedSource(installment.text, stage) : installment.text,
    '',
    '--- Current cumulative code ---', '```python', code.trim(), '```',
    '',
    ...(noteEnabled && noteFirst ? [
      noteOutputRule,
      'Immediately after the NOTE JSON, return exactly one Python code block containing complete definitions of public functions. Both outputs are mandatory on every round; a reply missing either one is rejected in full. Even if no change is needed, include at least one complete public function definition. Do not include tests, examples, or prints.',
    ] : noteEnabled ? [
      'Return only complete definitions of functions you changed in one Python code block. Never repeat an unchanged function. Do not include tests, examples, or prints.',
      `After the code block, write one line beginning NOTE: with at most ${maximumNoteCharacters} characters for the next round.`,
    ] : [
      'Return exactly one Python code block containing at least one complete public function definition. A reply without a Python code block is rejected in full. Do not write a note, tests, examples, prints, or prose outside the code block.',
    ]),
  ].join('\n');
}

function compactFeedback(result, requirementMap = {}, repeatedFailedCode = false,
  noteInstructionVersion = 'note') {
  if (result.fraction === 1) return 'All visible tests pass.';
  const hints = new Map(Object.values(requirementMap)
    .map((item) => [item.visibleTest, item.repairHint]).filter((item) => item[1]));
  const failed = (result.pytestReport?.tests ?? []).filter((item) => item.outcome !== 'passed');
  const passed = (result.pytestReport?.tests ?? []).filter((item) => item.outcome === 'passed')
    .map((item) => String(item.nodeid ?? '').split('::').at(-1));
  const evidenceChecked = true;
  const prefix = !repeatedFailedCode ? '' : evidenceChecked
    ? 'IMPORTANT: You submitted the same failed function code again. Check whether your note contains an assumption contradicted by the test feedback; delete or correct that assumption before rewriting the note. Do not resubmit the same code.\n'
    : 'IMPORTANT: Your previous repair repeated function code that had already failed. Do not submit it again. Make a concrete code change using the diagnosis below.\n';
  if (failed.length === 0) return `${prefix}Visible tests passed ${result.passed}/${result.total}. Repair the module.`;
  const passingEvidence = ['note-priority-v2', 'note-priority-v3', 'note-priority-v4', 'note-priority-v5', 'structured-note'].includes(noteInstructionVersion)
    ? `Passing visible tests: ${passed.join(', ') || '(none)'}. Remove corresponding completed rules from the note.\n`
    : '';
  return prefix + passingEvidence + failed.map((item) => {
    const name = String(item.nodeid ?? '').split('::').at(-1);
    const phase = [item.call, item.setup, item.teardown].find((value) => value?.outcome === 'failed') ?? item.call;
    const raw = String(phase?.longrepr ?? phase?.crash?.message ?? 'failed')
      .replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
    const hint = hints.get(name);
    return `- ${name}: ${raw.slice(-1000)}${hint ? `\n  DIRECT REPAIR HINT: ${hint}` : ''}`;
  }).join('\n');
}

function repairCandidateAccepted(rules, currentVisible, candidateVisible) {
  if (rules?.repair !== true) return true;
  return candidateVisible.fraction >= currentVisible.fraction;
}

function repairPrompt({
  repairRound, maximum, code, feedback, note, maximumNoteCharacters,
  numberOfStages = 5, interfaceLines = null, noteInstructionVersion = 'note',
  maximumNoteWords = 300,
  repeatParts = false, presentation = null, installment = null,
  absoluteRound = null, maximumTotalRounds = null, readingPass = null,
  totalReadingPasses = null, partIndex = null, noteEnabled = true,
}) {
  const label = String(presentation).startsWith('plain') ? 'plain source-order part' : 'project step';
  const noteFirst = true;
  const noteOutputRule = noteInstructionVersion === 'source-note'
    ? `First write NOTE: followed by one valid JSON object with only rules and checks. Do not use a JSON markdown fence. Stay within ${maximumNoteWords} words.`
    : noteInstructionVersion === 'structured-note'
    ? `First write NOTE: followed by a complete replacement note using TASK BRIEF, GLOBAL CONSTRAINTS, PROGRESS, TODO, and QUESTIONS. Use bullets, not prose, and stay within ${maximumNoteWords} words.`
    : noteInstructionVersion === 'note-priority-v5'
      ? 'First write one line beginning NOTE: with the complete note. Aim for at most 300 characters; never exceed 400.'
      : `First write one line beginning NOTE: with the complete note, using at most ${maximumNoteCharacters} characters.`;
  return [
    repeatParts
      ? `You are a novice Python student completing one project over at most ${maximumTotalRounds} rounds.`
      : `All ${numberOfStages} reading parts have now been shown and will not reappear.`,
    noteEnabled
      ? noteInstruction(maximumNoteCharacters, noteInstructionVersion, repeatParts, maximumNoteWords)
      : 'There is no note area in this condition. No prose memory is retained between rounds; only cumulative code and official visible-test feedback remain available.',
    repeatParts
      ? `READING PASS ${readingPass} OF ${totalReadingPasses}; PART ${partIndex} OF ${numberOfStages}; OVERALL ROUND ${absoluteRound} OF ${maximumTotalRounds}. You can see only the current ${label}; other parts are unavailable in this round.`
      : `This is repair round ${repairRound} of ${maximum}. Use the cumulative code and complete visible assertion feedback.`,
    ...(repeatParts && readingPass > 1 ? [
      'This is the same task part cycling back for review and correction, not a new task. Preserve correct work and do not rewrite code merely because the text has reappeared.',
    ] : []),
    '',
    '--- Stable public interface ---', stableInterface(interfaceLines),
    '',
    ...(noteEnabled ? [
      '--- Saved note ---', noteInstructionVersion === 'source-note' ? sourceNoteForPrompt(note) : note || '(empty)',
      '',
    ] : []),
    ...(repeatParts ? [`--- Current ${label}: ${installment.title} ---`,
      noteInstructionVersion === 'source-note' ? annotatedSource(installment.text, partIndex) : installment.text, ''] : []),
    '--- Current cumulative code ---', '```python', code.trim(), '```',
    '',
    '--- Visible pytest feedback ---', feedback,
    '',
    ...(noteEnabled && noteFirst ? [
      noteOutputRule,
      'Immediately after the NOTE JSON, return exactly one Python code block containing complete definitions of public functions. Both outputs are mandatory; a reply missing either one is rejected in full. Preserve passing behaviour and make a concrete repair.',
    ] : noteEnabled ? [
      'Return only complete definitions of functions you changed in one Python code block. Preserve passing behaviour and make a concrete repair.',
      `After the code block, write one line beginning NOTE: with at most ${maximumNoteCharacters} characters.`,
    ] : [
      'Return exactly one Python code block containing at least one complete public function definition. A reply without a Python code block is rejected in full. Preserve passing behaviour and make a concrete repair; do not write a note or prose outside the code block.',
    ]),
  ].join('\n');
}

function safeTransportError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.safeForLog ? error.message : 'model transport failed',
    status: error?.status ?? null,
    code: error?.code ?? null,
    requestId: error?.requestId ?? null,
  };
}

function pythonOutputBlocks(raw) {
  const blocks = [];
  const pattern = /```(?:python|py)\s*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(String(raw ?? ''))) !== null) {
    blocks.push({ code: match[1], start: match.index, end: pattern.lastIndex });
  }
  return blocks;
}

function validateRoundOutput(raw, { noteEnabled = true, functionNames = FUNCTIONS } = {}) {
  const source = String(raw ?? '');
  const errors = [];
  let noteEnd = -1;
  if (noteEnabled) {
    const marker = source.match(/^NOTE:\s*/im);
    if (!marker) {
      errors.push('missing NOTE: marker');
    } else {
      const remainderStart = marker.index + marker[0].length;
      const noteJson = firstJsonObject(source.slice(remainderStart).trimStart());
      const parsed = sourceNoteObject(noteJson);
      if (!noteJson || !parsed || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['checks', 'rules'])) {
        errors.push('NOTE must be one valid JSON object with exactly rules and checks');
      } else if (!Array.isArray(parsed.rules) || !Array.isArray(parsed.checks)) {
        errors.push('NOTE rules and checks must both be arrays');
      } else {
        const noteStart = source.indexOf(noteJson, remainderStart);
        noteEnd = noteStart + noteJson.length;
      }
    }
  }
  const blocks = pythonOutputBlocks(source);
  if (blocks.length !== 1) errors.push(`expected exactly one Python code block; found ${blocks.length}`);
  if (blocks.length === 1) {
    if (noteEnabled && blocks[0].start < noteEnd) errors.push('Python code block must appear after NOTE JSON');
    const publicFunctions = [...functionBlocks(blocks[0].code).keys()]
      .filter((name) => functionNames.includes(name));
    if (publicFunctions.length === 0) errors.push('Python code block has no complete public function definition');
  }
  return { valid: errors.length === 0, errors };
}

function completionCapRetryPrompt(prompt, noteEnabled = true) {
  return [
    prompt,
    '',
    '--- SAME-ROUND FORMAT RETRY ---',
    'Your preceding reply was rejected because it reached the output limit after repeating code. No code or note from that rejected reply was retained.',
    noteEnabled
      ? 'Return a concise replacement for this same experimental round. Write NOTE JSON first, then exactly one Python code block; both are mandatory.'
      : 'Return a concise replacement for this same experimental round as exactly one Python code block. There is no note area.',
    'Include each changed public function at most once. If only one function needs repair, return only that function. Never repeat a function definition.',
  ].join('\n');
}

function roundFormatRetryPrompt(prompt, validation, noteEnabled = true) {
  return [
    prompt,
    '',
    '--- SAME-ROUND REQUIRED-OUTPUT RETRY ---',
    'Your preceding reply was rejected in full and neither its code nor its note was retained.',
    `Problems: ${validation.errors.join('; ')}.`,
    noteEnabled
      ? 'Return exactly two things in this order: (1) NOTE: followed by one valid JSON object with exactly rules and checks arrays; (2) exactly one ```python code block containing at least one complete public function definition.'
      : 'Return exactly one ```python code block containing at least one complete public function definition. There is no note area.',
    'Do not stop after the first required item. Do not add tests, examples, prints, or prose after the required output.',
  ].join('\n');
}

async function callStudent({ protocol, resolution, prompt, seed, callPath, identity, temperature,
  formatPolicy = null }) {
  const maximumCapRetries = protocol.maximumCompletionCapRetries ?? 0;
  const maximumFormatRetries = formatPolicy ? (protocol.maximumRoundFormatRetries ?? 0) : 0;
  let requestPrompt = prompt;
  let totalStudentCalls = 0;
  let lastError = null;
  let capRetry = 0;
  let formatRetry = 0;
  while (true) {
    let response = null;
    for (let attempt = 1; attempt <= protocol.maximumTransportAttempts; attempt += 1) {
      totalStudentCalls += 1;
      appendLine(callPath, {
        ...identity, event: 'request_started', startedAt: new Date().toISOString(),
        attempt, completionCapRetry: capRetry, roundFormatRetry: formatRetry,
        seed, temperature, promptSha256: sha256(requestPrompt),
      });
      try {
        response = await clientFromSpec(protocol.model.spec, {
          temperature, seed, numPredict: protocol.numPredict, timeoutMs: 300_000,
        }, resolution).askDetailed(requestPrompt);
        appendLine(callPath, {
          ...identity, event: 'response_received', receivedAt: new Date().toISOString(),
          attempt, completionCapRetry: capRetry, roundFormatRetry: formatRetry,
          raw: response.text, metadata: response.metadata,
        });
        break;
      } catch (error) {
        lastError = safeTransportError(error);
        appendLine(callPath, {
          ...identity, event: 'response_error', receivedAt: new Date().toISOString(),
          attempt, completionCapRetry: capRetry, roundFormatRetry: formatRetry, error: lastError,
        });
        if (attempt < protocol.maximumTransportAttempts) await sleep(250 * (2 ** (attempt - 1)));
      }
    }
    if (!response) {
      return {
        raw: '', metadata: null, transportAttempts: totalStudentCalls, studentCalls: totalStudentCalls,
        completionCapRetries: capRetry, roundFormatRetries: formatRetry,
        formatValidationErrors: [], mechanicalFailure: lastError,
      };
    }
    const capped = response.metadata?.finishReason === 'length' ||
      response.metadata?.finishReason === 'max_output_tokens' ||
      Number(response.metadata?.completionTokens) >= protocol.numPredict;
    if (capped && capRetry < maximumCapRetries) {
      capRetry += 1;
      appendLine(callPath, {
        ...identity, event: 'completion_cap_retry_scheduled', scheduledAt: new Date().toISOString(),
        completionCapRetry: capRetry, roundFormatRetry: formatRetry,
        rejectedRawSha256: sha256(response.text),
      });
      requestPrompt = completionCapRetryPrompt(prompt, formatPolicy?.noteEnabled ?? true);
      continue;
    }
    if (capped) {
      return {
        raw: '', metadata: response.metadata, transportAttempts: totalStudentCalls,
        studentCalls: totalStudentCalls, completionCapRetries: capRetry,
        roundFormatRetries: formatRetry, formatValidationErrors: [],
        mechanicalFailure: 'completion_cap_reached_after_same_round_retry_reply_not_merged',
      };
    }
    const validation = formatPolicy ? validateRoundOutput(response.text, formatPolicy) : { valid: true, errors: [] };
    if (!validation.valid && formatRetry < maximumFormatRetries) {
      formatRetry += 1;
      appendLine(callPath, {
        ...identity, event: 'round_format_retry_scheduled', scheduledAt: new Date().toISOString(),
        completionCapRetry: capRetry, roundFormatRetry: formatRetry,
        validationErrors: validation.errors, rejectedRawSha256: sha256(response.text),
      });
      requestPrompt = roundFormatRetryPrompt(prompt, validation, formatPolicy.noteEnabled);
      continue;
    }
    return {
      raw: validation.valid ? response.text : '', metadata: response.metadata,
      transportAttempts: totalStudentCalls, studentCalls: totalStudentCalls,
      completionCapRetries: capRetry, roundFormatRetries: formatRetry,
      formatValidationErrors: validation.errors,
      mechanicalFailure: validation.valid ? null : 'required_round_output_missing_after_same_round_retries',
    };
  }
}

function noteCompressionPrompt(note, maximumCharacters, attempt = 1, version = 'note', maximumWords = 300) {
  if (version === 'source-note') {
    const target = attempt === 1 ? maximumWords : Math.min(220, maximumWords);
    return [
      `Your note exceeds the ${maximumWords}-word limit. Compress it to no more than ${target} words without changing the JSON schema.`,
      'Keep only the most useful source IDs and executable checks. Do not write status or todo; the harness supplies them.',
      'Return NOTE: followed by the complete JSON object and nothing else. Do not use a markdown fence or add facts.',
      '', note,
    ].join('\n');
  }
  if (version === 'structured-note') {
    const target = attempt === 1 ? maximumWords : Math.min(220, maximumWords);
    return [
      `Your note exceeds the ${maximumWords}-word limit. Rewrite and compress the entire note to no more than ${target} words. Do not append to it.`,
      'Keep exactly these sections: TASK BRIEF, GLOBAL CONSTRAINTS, PROGRESS, TODO, QUESTIONS.',
      'TASK BRIEF must be one short line. Use compact bullets for every other section; do not write prose paragraphs.',
      'Preserve unimplemented exact rules and unresolved problems. Remove background, repetition, completed details already present in passing code, and guesses. Do not add facts.',
      'Return NOTE: followed by the complete replacement note and nothing else.',
      '',
      note,
    ].join('\n');
  }
  const target = attempt === 1 ? 300 : 200;
  return [
    `Rewrite the note below in no more than ${target} characters; the hard limit is ${maximumCharacters} characters.`,
    'Keep only pending implementation details: exact values, exact strings, binary rules already read but not yet implemented, and unresolved problems.',
    'Remove project title/background, completed or passing rules, prose, and guesses. Do not add facts.',
    'Start directly with compact key-value items, not with "Implement", "Build", or a task summary.',
    'Return exactly one line beginning NOTE: and nothing else.',
    '',
    note,
  ].join('\n');
}

async function resolveNote({ protocol, resolution, raw, callPath, identity, seed,
  currentPart = '', currentPartIndex = 0, precedingNote = '', functionNames = FUNCTIONS,
  code = '', visible = null, requirementMap = {}, revealVisible = false }) {
  const maximumWords = protocol.maximumNoteWords ?? 300;
  const parsed = parseNote(raw, protocol.maximumNoteCharacters, protocol.noteInstructionVersion, maximumWords);
  if (protocol.noteInstructionVersion === 'source-note') {
    const submitted = sourceNoteObject(parsed.full);
    const assertions = (Array.isArray(submitted?.checks) ? submitted.checks : [])
      .filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3);
    const checkResults = await evaluateAssertions(code, assertions, functionNames);
    const normalised = normaliseSourceNote(parsed.full, {
      currentPart, currentPartIndex, precedingNote, functionNames, maximumWords,
      checkResults, visible, requirementMap, revealVisible,
    });
    const adjusted = parsed.truncated || normalised.corrections.length > 0;
    return {
      ...parsed, note: canonicalJson(normalised.value).trim(), truncated: adjusted,
      compressionApplied: adjusted, compressionSucceeded: true, compressionHardCapped: false,
      validationRetried: false, validationValid: Boolean(submitted), validationErrors: normalised.corrections,
      studentCalls: 0, mechanicalFailure: null,
    };
  }
  if (!['note-priority-v4', 'note-priority-v5', 'structured-note'].includes(protocol.noteInstructionVersion) || !parsed.truncated) {
    return { ...parsed, compressionApplied: false, compressionSucceeded: false, compressionHardCapped: false,
      validationRetried: false, validationValid: null, validationErrors: [], studentCalls: 0, mechanicalFailure: null };
  }
  const maximumAttempts = ['note-priority-v5', 'structured-note'].includes(protocol.noteInstructionVersion) ? 2 : 1;
  let source = parsed.full;
  let compressed = parsed;
  let studentCalls = 0;
  let lastMechanicalFailure = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const response = await callStudent({
      protocol, resolution, callPath,
      prompt: noteCompressionPrompt(source, protocol.maximumNoteCharacters, attempt, protocol.noteInstructionVersion, maximumWords),
      seed: hashInt(`${seed}|note-compression|${attempt}`), temperature: protocol.temperature,
      identity: { ...identity, phase: 'note_compression', sourcePhase: identity.phase, compressionAttempt: attempt },
    });
    studentCalls += response.studentCalls;
    lastMechanicalFailure = response.mechanicalFailure;
    compressed = parseNote(response.raw, protocol.maximumNoteCharacters, protocol.noteInstructionVersion, maximumWords);
    if (compressed.found && !compressed.truncated) {
      return {
        ...compressed, note: compressed.full, found: parsed.found, truncated: true,
        compressionApplied: true, compressionSucceeded: true,
        compressionHardCapped: false,
        studentCalls, mechanicalFailure: null,
      };
    }
    if (compressed.full) source = compressed.full;
  }
  const hardCapped = Boolean(compressed.full);
  const hardCappedNote = protocol.noteInstructionVersion === 'structured-note'
    ? truncateWords(compressed.full.slice(0, protocol.maximumNoteCharacters), maximumWords)
    : compressed.full.slice(0, protocol.maximumNoteCharacters).trim();
  return {
    ...compressed,
    note: hardCapped ? hardCappedNote : '',
    found: parsed.found,
    truncated: true,
    compressionApplied: true,
    compressionSucceeded: hardCapped,
    compressionHardCapped: hardCapped,
    studentCalls,
    mechanicalFailure: lastMechanicalFailure ?? (hardCapped ? null : 'note_compression_failed'),
  };
}

async function runSession({ protocol, presentations, assets, resolution, arm, seed, callPath, executionId }) {
  const definition = protocol.cellDefinitions[arm];
  const usePairedUnseenTests =
    protocol.testPolicy?.aggregation === 'paired_semantic_tests_all_case_variants_must_pass';
  const presentation = definition.presentation;
  const noteEnabled = definition.noteEnabled ?? true;
  const numberOfStages = definition.numberOfStages ?? protocol.numberOfStages;
  const functionNames = protocol.functionNames ?? FUNCTIONS;
  const interfaceLines = protocol.stableInterfaceLines ?? null;
  const repeatParts = protocol.rules?.repeatPartsAfterFirstPass === true;
  const maximumFinalRepairRounds = definition.maximumFinalRepairRounds ??
    ((protocol.rules?.maximumTotalRounds ??
      (numberOfStages + protocol.maximumFinalRepairRounds)) - numberOfStages);
  const maximumTotalRounds = numberOfStages + maximumFinalRepairRounds;
  if (!Number.isInteger(numberOfStages) || numberOfStages < 1 ||
      presentations.arms[presentation]?.length !== numberOfStages || maximumFinalRepairRounds < 0) {
    throw new Error(`invalid per-arm stage or round configuration for ${arm}`);
  }
  const totalReadingPasses = Math.ceil(maximumTotalRounds / numberOfStages);
  let code = assets.starter;
  let note = '';
  let mechanicalFailures = 0;
  const requirementMap = JSON.parse(assets.requirementTestMap);
  const stageRows = [];
  for (let stage = 1; stage <= numberOfStages; stage += 1) {
    const installment = presentations.arms[presentation][stage - 1];
    const noteBeforeClear = note;
    const clearApplied = noteClearApplied(protocol, definition, seed, stage);
    if (clearApplied) note = '';
    const prompt = stagePrompt({
      presentation, installment, stage, code, note,
      maximumNoteCharacters: protocol.maximumNoteCharacters,
      maximumNoteWords: protocol.maximumNoteWords ?? 300,
      numberOfStages, interfaceLines,
      noteInstructionVersion: protocol.noteInstructionVersion,
      repeatParts, absoluteRound: stage, maximumTotalRounds,
      readingPass: 1, totalReadingPasses, noteEnabled,
    });
    const callSeed = hashInt(`${protocol.generationSeedSalt}|${presentation}|${seed}|stage|${stage}`);
    const response = await callStudent({
      protocol, resolution, prompt, seed: callSeed, callPath, temperature: protocol.temperature,
      identity: { executionId, arm, generationSeed: seed, phase: 'reading_stage', stage },
      formatPolicy: protocol.rules?.requireRoundCode === true
        ? { noteEnabled, functionNames }
        : null,
    });
    if (response.mechanicalFailure) mechanicalFailures += 1;
    const merged = mergeCandidate(code, response.raw, functionNames);
    code = merged.code;
    const visible = usePairedUnseenTests ? null : await grade(code, assets.visibleTests);
    const hidden = usePairedUnseenTests ? null : await grade(code, assets.hiddenTests);
    const testScore = usePairedUnseenTests
      ? await gradeLogical(code, assets.unseenTests, protocol.testPolicy.logicalTestCount)
      : scorePairedUnseenTests(visible, hidden, requirementMap);
    const parsedNote = noteEnabled
      ? await resolveNote({
        protocol, resolution, raw: response.raw, callPath, seed: callSeed,
        identity: { executionId, arm, generationSeed: seed, phase: 'reading_stage', stage },
        currentPart: installment.text, currentPartIndex: stage, precedingNote: note, functionNames,
        code, visible, requirementMap, revealVisible: false,
      })
      : {
        note: '', full: '', found: false, truncated: false,
        compressionApplied: false, compressionSucceeded: false, compressionHardCapped: false,
        validationRetried: false, validationValid: null, validationErrors: [],
        studentCalls: 0, mechanicalFailure: null,
      };
    if (parsedNote.mechanicalFailure) mechanicalFailures += 1;
    note = parsedNote.note;
    stageRows.push({
      stage, readingPass: 1, partIndex: stage, installmentTitle: installment.title,
      installmentWords: installment.words, appliedFunctions: merged.applied,
      extractionSource: merged.extractionSource,
      ...(usePairedUnseenTests ? {
        testPassed: testScore.passed, testTotal: testScore.total, testFraction: testScore.fraction,
      } : {
        visibleFraction: visible.fraction, hiddenFraction: hidden.fraction,
      }),
      codeSha256: sha256(code), metadata: response.metadata,
      transportAttempts: response.transportAttempts, mechanicalFailure: response.mechanicalFailure,
      studentCalls: response.studentCalls + parsedNote.studentCalls,
      completionCapRetries: response.completionCapRetries,
      roundFormatRetries: response.roundFormatRetries ?? 0,
      roundFormatValidationErrors: response.formatValidationErrors ?? [],
      noteEnabled,
      noteBeforeClear, noteClearApplied: clearApplied, noteAfterStage: note,
      noteBeforeClearWords: wordCount(noteBeforeClear), noteAfterStageWords: wordCount(note),
      noteFound: parsedNote.found, noteTruncated: parsedNote.truncated,
      noteCompressionApplied: parsedNote.compressionApplied,
      noteCompressionSucceeded: parsedNote.compressionSucceeded,
      noteCompressionHardCapped: parsedNote.compressionHardCapped,
      noteValidationRetried: parsedNote.validationRetried ?? false,
      noteValidationValid: parsedNote.validationValid ?? null,
      noteValidationErrors: parsedNote.validationErrors ?? [],
    });
  }

  const preRepairVisible = usePairedUnseenTests ? null : await grade(code, assets.visibleTests);
  const preRepairHidden = usePairedUnseenTests ? null : await grade(code, assets.hiddenTests);
  const preRepairTest = usePairedUnseenTests
    ? await gradeLogical(code, assets.unseenTests, protocol.testPolicy.logicalTestCount)
    : scorePairedUnseenTests(preRepairVisible, preRepairHidden, requirementMap);
  const repairRows = [];
  let repeatedFailedCode = false;
  let previousRepairRejected = false;
  for (let repairRound = 1; repairRound <= maximumFinalRepairRounds; repairRound += 1) {
    const currentVisible = await grade(code, assets.visibleTests);
    if (currentVisible.fraction === 1) break;
    const absoluteRound = numberOfStages + repairRound;
    const readingPass = Math.floor((absoluteRound - 1) / numberOfStages) + 1;
    const partIndex = ((absoluteRound - 1) % numberOfStages) + 1;
    const installment = repeatParts ? presentations.arms[presentation][partIndex - 1] : null;
    const noteBeforeClear = note;
    const clearApplied = noteClearApplied(protocol, definition, seed, absoluteRound);
    if (clearApplied) note = '';
    const baseFeedback = compactFeedback(
      currentVisible, requirementMap, repeatedFailedCode, protocol.noteInstructionVersion,
    );
    const feedback = previousRepairRejected
      ? `IMPORTANT: The previous repair was rejected because it reduced the visible-test score. The retained code below is the last non-regressing version. Make a narrower change and preserve its passing behavior.\n${baseFeedback}`
      : baseFeedback;
    const prompt = repairPrompt({
      repairRound, maximum: maximumFinalRepairRounds, code,
      feedback, note,
      maximumNoteCharacters: protocol.maximumNoteCharacters,
      maximumNoteWords: protocol.maximumNoteWords ?? 300,
      numberOfStages, interfaceLines,
      noteInstructionVersion: protocol.noteInstructionVersion,
      repeatParts, presentation, installment, absoluteRound, maximumTotalRounds,
      readingPass, totalReadingPasses, partIndex, noteEnabled,
    });
    const callSeed = hashInt(`${protocol.generationSeedSalt}|${presentation}|${seed}|repair|${repairRound}`);
    const response = await callStudent({
      protocol, resolution, prompt, seed: callSeed, callPath,
      temperature: repeatedFailedCode ? protocol.repeatRepairTemperature : protocol.temperature,
      identity: { executionId, arm, generationSeed: seed, phase: 'final_repair', repairRound },
      formatPolicy: protocol.rules?.requireRoundCode === true
        ? { noteEnabled, functionNames }
        : null,
    });
    if (response.mechanicalFailure) mechanicalFailures += 1;
    const codeBeforeRepair = code;
    const merged = mergeCandidate(codeBeforeRepair, response.raw, functionNames);
    const thisReplyRepeatedFailedCode = merged.candidateFunctions.length > 0 && merged.applied.length === 0;
    const candidateVisible = await grade(merged.code, assets.visibleTests);
    const repairAccepted = repairCandidateAccepted(protocol.rules, currentVisible, candidateVisible);
    code = repairAccepted ? merged.code : codeBeforeRepair;
    const visible = repairAccepted ? candidateVisible : currentVisible;
    const hidden = await grade(code, assets.hiddenTests);
    const parsedNote = noteEnabled
      ? await resolveNote({
        protocol, resolution, raw: response.raw, callPath, seed: callSeed,
        identity: { executionId, arm, generationSeed: seed, phase: 'final_repair', repairRound },
        currentPart: installment?.text ?? '', currentPartIndex: partIndex, precedingNote: note, functionNames,
        code, visible, requirementMap, revealVisible: true,
      })
      : {
        note: '', full: '', found: false, truncated: false,
        compressionApplied: false, compressionSucceeded: false, compressionHardCapped: false,
        validationRetried: false, validationValid: null, validationErrors: [],
        studentCalls: 0, mechanicalFailure: null,
      };
    if (parsedNote.mechanicalFailure) mechanicalFailures += 1;
    note = parsedNote.note;
    repairRows.push({
      repairRound,
      appliedFunctions: repairAccepted ? merged.applied : [],
      candidateAppliedFunctions: merged.applied,
      extractionSource: merged.extractionSource,
      visibleFraction: visible.fraction, hiddenFraction: hidden.fraction,
      repeatedFailedCode: thisReplyRepeatedFailedCode, codeSha256: sha256(code),
      repairRule: protocol.rules?.repair === true ? 'repair' : null,
      repairAccepted,
      repairRejectedReason: repairAccepted ? null : 'visible_score_decreased',
      candidateVisibleFraction: candidateVisible.fraction,
      candidateCodeSha256: sha256(merged.code),
      metadata: response.metadata, transportAttempts: response.transportAttempts,
      mechanicalFailure: response.mechanicalFailure, absoluteRound,
      readingPass: repeatParts ? readingPass : null,
      partIndex: repeatParts ? partIndex : null,
      installmentTitle: repeatParts ? installment.title : null,
      installmentWords: repeatParts ? installment.words : null,
      studentCalls: response.studentCalls + parsedNote.studentCalls,
      completionCapRetries: response.completionCapRetries,
      roundFormatRetries: response.roundFormatRetries ?? 0,
      roundFormatValidationErrors: response.formatValidationErrors ?? [],
      noteEnabled,
      noteBeforeClear, noteClearApplied: clearApplied, noteAfterRound: note,
      noteBeforeClearWords: wordCount(noteBeforeClear), noteAfterRoundWords: wordCount(note),
      noteFound: parsedNote.found, noteTruncated: parsedNote.truncated,
      noteCompressionApplied: parsedNote.compressionApplied,
      noteCompressionSucceeded: parsedNote.compressionSucceeded,
      noteCompressionHardCapped: parsedNote.compressionHardCapped,
      noteValidationRetried: parsedNote.validationRetried ?? false,
      noteValidationValid: parsedNote.validationValid ?? null,
      noteValidationErrors: parsedNote.validationErrors ?? [],
    });
    repeatedFailedCode = thisReplyRepeatedFailedCode;
    previousRepairRejected = !repairAccepted;
  }
  const finalVisible = repairRows.length === 0 ? preRepairVisible
    : usePairedUnseenTests ? null : await grade(code, assets.visibleTests);
  const finalHidden = repairRows.length === 0 ? preRepairHidden
    : usePairedUnseenTests ? null : await grade(code, assets.hiddenTests);
  const finalTest = repairRows.length === 0 ? preRepairTest
    : usePairedUnseenTests
      ? await gradeLogical(code, assets.unseenTests, protocol.testPolicy.logicalTestCount)
      : scorePairedUnseenTests(finalVisible, finalHidden, requirementMap);
  return {
    arm, presentation, noteEnabled, noteClear: noteClearEnabled(definition),
    noteClearProbability: noteClearEnabled(definition) ? (protocol.noteClearProbability ?? null) : null,
    scheduledNoteClearRounds: scheduledNoteClearRounds(protocol, definition, seed),
    generationSeed: seed, stageRows, repairRows,
    ...(usePairedUnseenTests ? {
      preRepairTestPassed: preRepairTest.passed,
      preRepairTestTotal: preRepairTest.total,
      preRepairTestFraction: preRepairTest.fraction,
      finalTestPassed: finalTest.passed,
      finalTestTotal: finalTest.total,
      finalTestFraction: finalTest.fraction,
      testVisibility: 'unseen',
      testAggregation: 'paired_semantic_tests_all_case_variants_must_pass',
      completed: finalTest.passed === finalTest.total,
    } : {
      preRepairVisible: preRepairVisible.fraction,
      preRepairHidden: preRepairHidden.fraction,
      finalVisible: finalVisible.fraction,
      finalHidden: finalHidden.fraction,
      completed: finalHidden.fraction === 1,
    }),
    totalRounds: numberOfStages + repairRows.length,
    repairRoundsUsed: repairRows.length, mechanicalFailures,
    finalCodeSha256: sha256(code), finalCode: code,
  };
}

async function preflight(frozen) {
  const referenceVisible = await grade(frozen.assets.reference, frozen.assets.visibleTests);
  const referenceHidden = await grade(frozen.assets.reference, frozen.assets.hiddenTests);
  const starterVisible = await grade(frozen.assets.starter, frozen.assets.visibleTests);
  const starterHidden = await grade(frozen.assets.starter, frozen.assets.hiddenTests);
  if (referenceVisible.fraction !== 1 || referenceHidden.fraction !== 1) throw new Error('reference must pass both suites');
  const requirementMap = JSON.parse(frozen.assets.requirementTestMap);
  const referenceTest = validatePairedReference(
    referenceVisible, referenceHidden, requirementMap,
  );
  const starterTest = scorePairedUnseenTests(starterVisible, starterHidden, requirementMap);
  if (starterVisible.fraction !== 0) throw new Error('starter unexpectedly passes a visible function cluster');
  if (starterHidden.fraction >= 1) throw new Error('starter unexpectedly passes the complete hidden suite');
  const visibleNames = testNames(referenceVisible);
  const hiddenNames = testNames(referenceHidden);
  if (Object.values(requirementMap).some((item) => !visibleNames.includes(item.visibleTest))) {
    throw new Error('requirement map does not cover the visible suite');
  }
  const mappedHidden = Object.values(requirementMap).map((item) => item.hiddenTest).filter(Boolean);
  if (mappedHidden.length && (mappedHidden.some((name) => !hiddenNames.includes(name)) ||
      new Set(mappedHidden).size !== hiddenNames.length || new Set(visibleNames).size !== Object.keys(requirementMap).length)) {
    throw new Error('requirement map does not provide one-to-one visible/hidden coverage');
  }
  const design = readRoot(frozen.protocol.designSource);
  const secretScan = `${frozen.protocolBytes.toString('utf8')}\n${design}`;
  if (/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/.test(secretScan) || /"(?:apiKey|authorization)"\s*:/i.test(secretScan)) {
    throw new Error('secret-shaped material found in experiment files');
  }
  return {
    studentModelCalls: 0,
    logicalUnseenTests: referenceTest.total,
    underlyingCaseVariants: referenceTest.caseVariantTotal,
    referenceTest: referenceTest.fraction,
    starterTest: starterTest.fraction,
    sourceDocumentWords: frozen.presentations.sourceDocumentWords,
    presentationWords: Object.fromEntries(Object.entries(frozen.presentations.arms)
      .map(([key, rows]) => [key, rows.map((item) => item.words)])),
    noteClearPolicy: frozen.protocol.noteClearProbability === undefined
      ? { mode: 'fixed', beforeStages: frozen.protocol.noteWipeBeforeStages ?? [frozen.protocol.noteWipeBeforeStage] }
      : { mode: 'probability', probability: frozen.protocol.noteClearProbability, firstEligibleRound: 2 },
    scheduledSessions: sessionSchedule(frozen.protocol).length,
    assetSha256: Object.fromEntries(Object.entries(frozen.assets).map(([key, value]) => [key, sha256(value)])),
  };
}

function sessionSchedule(protocol) {
  return protocol.arms.flatMap((arm) => protocol.seeds.map((seed) => ({ arm, seed })))
    .sort((left, right) => sha256(`${protocol.scheduleSalt}|${left.arm}|${left.seed}`)
      .localeCompare(sha256(`${protocol.scheduleSalt}|${right.arm}|${right.seed}`)));
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summarise(protocol, rows) {
  const byArm = Object.fromEntries(protocol.arms.map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    const completed = selected.filter((row) => row.completed);
    return [arm, {
      sessions: selected.length,
      completed: completed.length,
      completionRate: selected.length ? completed.length / selected.length : null,
      meanPreRepairTest: mean(selected.map((row) => row.preRepairTestFraction)),
      meanFinalTest: mean(selected.map((row) => row.finalTestFraction)),
      meanTotalRoundsAmongCompleted: mean(completed.map((row) => row.totalRounds)),
      meanRepairRounds: mean(selected.map((row) => row.repairRoundsUsed)),
      noteCaptureRate: mean(selected.flatMap((row) => row.stageRows.map((item) => item.noteFound ? 1 : 0))),
      noteClears: selected.reduce((sum, row) => sum +
        row.stageRows.filter((item) => item.noteClearApplied ?? item.noteWipeApplied).length +
        (row.repairRows ?? []).filter((item) => item.noteClearApplied ?? item.noteWipeApplied).length, 0),
      mechanicalFailures: selected.reduce((sum, row) => sum + row.mechanicalFailures, 0),
      completionCapRetries: selected.reduce((sum, row) => sum +
        row.stageRows.reduce((inner, item) => inner + (item.completionCapRetries ?? 0), 0) +
        (row.repairRows ?? []).reduce((inner, item) => inner + (item.completionCapRetries ?? 0), 0), 0),
      studentCalls: selected.reduce((sum, row) => sum +
        row.stageRows.reduce((inner, item) => inner + (item.studentCalls ?? 1), 0) +
        (row.repairRows ?? []).reduce((inner, item) => inner + (item.studentCalls ?? 1), 0), 0),
    }];
  }));
  const pairs = protocol.seeds.map((seed) => ({
    generationSeed: seed,
    arms: Object.fromEntries(protocol.arms.map((arm) => {
      const row = rows.find((item) => item.arm === arm && item.generationSeed === seed);
      return [arm, row ? {
        completed: row.completed, preRepairTestFraction: row.preRepairTestFraction,
        finalTestFraction: row.finalTestFraction, totalRounds: row.totalRounds,
      } : null];
    })),
  }));
  const mechanicalFailures = rows.reduce((sum, row) => sum + row.mechanicalFailures, 0);
  const summary = {
    protocolVersion: protocol.protocolVersion,
    sessions: rows.length,
    expectedSessions: protocol.formalRun.expectedSessions,
    completeGrid: rows.length === protocol.formalRun.expectedSessions,
    byArm,
    pairedSeedBlocks: pairs,
    mechanicalFailures,
  };
  if (protocol.smokeGate) {
    const completedStepsRows = rows.filter((row) => row.arm === 'steps_note' && row.completed);
    const stepsCompleted = completedStepsRows.length;
    const plainCompleted = rows.filter((row) => row.arm === 'plain_note' && row.completed).length;
    const stepsMedianRounds = median(completedStepsRows.map((row) => row.totalRounds));
    const clearRows = rows.filter((row) => noteClearEnabled(protocol.cellDefinitions[row.arm]));
    const actualClearRounds = (row) => [
      ...row.stageRows.filter((item) => item.noteClearApplied ?? item.noteWipeApplied).map((item) => item.stage),
      ...(row.repairRows ?? []).filter((item) => item.noteClearApplied ?? item.noteWipeApplied)
        .map((item) => item.absoluteRound),
    ];
    const clearScheduleValid = clearRows.length === protocol.seeds.length * 2 && clearRows.every((row) => {
      const definition = protocol.cellDefinitions[row.arm];
      const expectedRounds = scheduledNoteClearRounds(protocol, definition, row.generationSeed)
        .filter((round) => round <= row.totalRounds);
      return JSON.stringify(actualClearRounds(row)) === JSON.stringify(expectedRounds);
    });
    const clearCountsValid = protocol.noteClearProbability === undefined
      ? clearRows.every((row) => actualClearRounds(row).length === protocol.smokeGate.requiredWipesPerWipeSession)
      : clearScheduleValid;
    summary.smokeGate = {
      stepsNoteCompletions: stepsCompleted,
      requiredStepsNoteCompletions: protocol.smokeGate.requiredStepsNoteCompletions,
      plainNoteCompletions: plainCompleted,
      requiredPlainNoteCompletions: protocol.smokeGate.requiredPlainNoteCompletions,
      stepsNoteMedianRounds: stepsMedianRounds,
      requiredStepsNoteRoundRange: [
        protocol.smokeGate.minimumStepsNoteMedianRounds,
        protocol.smokeGate.maximumStepsNoteMedianRounds,
      ],
      clearCountsValid, clearScheduleValid,
      mechanicalFailures,
      passed: summary.completeGrid && stepsCompleted >= protocol.smokeGate.requiredStepsNoteCompletions &&
        plainCompleted >= protocol.smokeGate.requiredPlainNoteCompletions &&
        stepsMedianRounds >= protocol.smokeGate.minimumStepsNoteMedianRounds &&
        stepsMedianRounds <= protocol.smokeGate.maximumStepsNoteMedianRounds &&
        clearCountsValid && mechanicalFailures <= protocol.smokeGate.maximumMechanicalFailures,
    };
  }
  return summary;
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function prepareRunDirectory({ args, frozen, checks, model }) {
  const outDir = path.join(RUNS, args.runId);
  const protocolPath = path.join(outDir, 'protocol.json');
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(RUNS, { recursive: true });
    fs.mkdirSync(outDir, { recursive: false });
    writeNew(protocolPath, frozen.protocol);
    writeNew(manifestPath, {
      runId: args.runId, startedAt: new Date().toISOString(),
      protocolVersion: frozen.protocol.protocolVersion,
      protocolSha256: sha256(frozen.protocolBytes), model: frozen.protocol.model,
      modelDescriptor: model.resolution.descriptor, modelIdentity: model.identity, preflight: checks,
    });
  } else {
    if (!args.resume) throw new Error(`run directory already exists; use --resume: ${outDir}`);
    if (!fs.existsSync(protocolPath) || !fs.existsSync(manifestPath)) throw new Error('cannot resume incomplete run metadata');
    const existingProtocol = fs.readFileSync(protocolPath);
    if (sha256(existingProtocol) !== sha256(Buffer.from(canonicalJson(frozen.protocol)))) {
      throw new Error('resume refused because the frozen protocol differs');
    }
  }
  return outDir;
}

async function main(argv = process.argv.slice(2)) {
  loadLocalApiKey();
  const args = parseArgs(argv);
  const frozen = loadProtocol(args.protocol, args.runId);
  const checks = await preflight(frozen);
  if (args.preflightOnly) {
    process.stdout.write(canonicalJson({ protocolVersion: frozen.protocol.protocolVersion, checks }));
    return;
  }
  const model = await verifyModel(frozen.protocol);
  const outDir = prepareRunDirectory({ args, frozen, checks, model });
  const callPath = path.join(outDir, 'calls.jsonl');
  const resultPath = path.join(outDir, 'results.jsonl');
  const completePath = path.join(outDir, 'complete.json');
  if (fs.existsSync(completePath)) {
    const summaryPath = path.join(outDir, 'summary.json');
    if (!fs.existsSync(summaryPath)) throw new Error('completion receipt exists without summary');
    process.stdout.write(fs.readFileSync(summaryPath, 'utf8'));
    return;
  }
  const schedule = sessionSchedule(frozen.protocol);
  const rows = readJsonLines(resultPath);
  const completedKeys = new Set(rows.map((row) => `${row.arm}:${row.generationSeed}`));
  const pending = schedule.filter((item) => !completedKeys.has(`${item.arm}:${item.seed}`));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < pending.length) {
      const item = pending[nextIndex++];
      const key = `${item.arm}:${item.seed}`;
      const executionId = crypto.randomUUID();
      appendLine(callPath, { event: 'session_started', executionId, arm: item.arm, generationSeed: item.seed, startedAt: new Date().toISOString() });
      const row = await runSession({
        protocol: frozen.protocol, presentations: frozen.presentations, assets: frozen.assets,
        resolution: model.resolution, arm: item.arm, seed: item.seed, callPath, executionId,
      });
      appendLine(resultPath, row);
      rows.push(row);
      completedKeys.add(key);
      appendLine(callPath, { event: 'session_completed', executionId, arm: item.arm, generationSeed: item.seed, completedAt: new Date().toISOString() });
      if (rows.length % 10 === 0 || rows.length === schedule.length) {
        process.stderr.write(`[${frozen.protocol.task} ${rows.length}/${schedule.length}] completed; latest=${item.arm} test=${row.finalTestFraction.toFixed(3)}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length || 1) }, () => worker()));
  const summary = summarise(frozen.protocol, rows);
  writeCanonicalOrVerify(path.join(outDir, 'summary.json'), summary);
  writeNew(completePath, {
    runId: args.runId, completedAt: new Date().toISOString(), sessions: rows.length,
    resultsSha256: sha256(fs.readFileSync(resultPath)), callsSha256: sha256(fs.readFileSync(callPath)),
  });
  process.stdout.write(canonicalJson(summary));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ARMS, CLEAR_ARMS, compactFeedback, completionCapRetryPrompt, loadProtocol, mergeCandidate,
  firstJsonObject, noteCompressionPrompt, noteInstruction, parseNote,
  noteClearApplied, preflight, repairPrompt, runSession, scheduledNoteClearRounds,
  repairCandidateAccepted, roundFormatRetryPrompt, sessionSchedule, stagePrompt, summarise,
  validateRoundOutput,
};
