#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const RUNTIME = path.join(ROOT, 'runtime');
const LOCAL_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
if (!process.env.CELLMATE_EVAL_PYTHON && fs.existsSync(LOCAL_PYTHON)) {
  process.env.CELLMATE_EVAL_PYTHON = LOCAL_PYTHON;
}

const { runSession } = require(path.join(RUNTIME, 'run.js'));
const { gradeLogical, testNames } = require(path.join(RUNTIME, 'lib', 'grader.js'));
const { inspectResolvedModel, resolveModelSpec } = require(path.join(RUNTIME, 'lib', 'model.js'));

const MODEL_SPEC = 'openai-responses:gpt-4o-mini-2024-07-18';
const DEFAULT_GENERATION_SEEDS = [76001];
const MAX_CLEAN_SESSION_ATTEMPTS = 5;
const TASK_IDS = new Set(['normal', 'simple', 'hard']);

function taskLayout(task) {
  const taskRoot = path.join(ROOT, 'tasks', task);
  return {
    task,
    taskRoot,
    taskAssets: path.join(taskRoot, 'task_assets'),
    statement: path.join(taskRoot, 'task.md'),
  };
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function appendJsonLine(filename, value) {
  fs.appendFileSync(filename, `${JSON.stringify(value)}\n`);
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function parseArgs(argv) {
  const result = {
    task: 'normal',
    runId: null,
    concurrency: 2,
    resume: false,
    preflightOnly: false,
    presentations: null,
    seeds: DEFAULT_GENERATION_SEEDS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--task') result.task = argv[++index];
    else if (value === '--run-id') result.runId = argv[++index];
    else if (value === '--concurrency') result.concurrency = Number.parseInt(argv[++index], 10);
    else if (value === '--presentations') result.presentations = path.resolve(argv[++index]);
    else if (value === '--seeds') {
      result.seeds = argv[++index].split(',').map((item) => Number.parseInt(item, 10));
    }
    else if (value === '--resume') result.resume = true;
    else if (value === '--preflight-only') result.preflightOnly = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!TASK_IDS.has(result.task)) {
    throw new Error('--task must be normal, simple, or hard');
  }
  if (result.presentations === null) {
    result.presentations = path.join(ROOT, 'tasks', result.task, 'presentations.json');
  }
  if (!result.preflightOnly && (!result.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(result.runId))) {
    throw new Error('provide --run-id SAFE_VALUE');
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  if (result.presentations !== ROOT && !result.presentations.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('--presentations must resolve inside evaluation1');
  }
  if (result.seeds.length < 1 || result.seeds.length > 20 ||
      result.seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) ||
      new Set(result.seeds).size !== result.seeds.length) {
    throw new Error('--seeds must contain 1 to 20 unique non-negative 32-bit integers');
  }
  return result;
}

function readAssets(layout) {
  const read = (name) => fs.readFileSync(path.join(layout.taskAssets, name), 'utf8');
  const requirementTestMap = read('requirements.json');
  return {
    statement: fs.readFileSync(layout.statement, 'utf8'),
    requirementTestMap,
    starter: read('starter.py'),
    reference: read('reference.py'),
    unseenTests: read('test_unseen.py'),
  };
}

function comparableTaskText(value) {
  return String(value)
    .replace(/<!--\s*prompt:[^>]+-->/g, '')
    .replace(/^## Part \d+ of \d+[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function preflight(presentations, assets, layout = taskLayout('normal')) {
  const pythonPath = process.env.CELLMATE_EVAL_PYTHON ?? LOCAL_PYTHON;
  if (!path.isAbsolute(pythonPath) || !fs.existsSync(pythonPath)) {
    throw new Error(`missing absolute experiment Python: ${pythonPath}`);
  }
  const assetTask = fs.readFileSync(path.join(layout.taskAssets, 'task_6parts.md'), 'utf8');
  if (comparableTaskText(assetTask) !== comparableTaskText(assets.statement)) {
    throw new Error('evaluation1 task contract differs from its local task assets');
  }
  const expected = presentations.materialOrder;
  if (!Array.isArray(expected) || expected.length < 1 || new Set(expected).size !== expected.length) {
    throw new Error('presentations must define at least one unique material');
  }
  for (const material of expected) {
    const rows = presentations.arms?.[material];
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 8 ||
        rows.some((row) => !row?.title || (row.noteOnly === true
          ? row.text !== '' || row.words !== 0
          : !row?.text)) || !presentations.materialClasses?.[material]) {
      throw new Error(`${material} must contain 1..8 valid installments and a class`);
    }
    for (const row of rows) {
      const actualWords = wordCount(row.text);
      if (row.words !== actualWords) {
        throw new Error(`${material} has stale word metadata: declared ${row.words}, actual ${actualWords}`);
      }
    }
  }
  const plain5Words = presentations.arms?.plain_5parts?.reduce((sum, row) => sum + row.words, 0);
  const plain6Words = presentations.arms?.plain_6parts?.reduce((sum, row) => sum + row.words, 0);
  if (!Number.isFinite(plain5Words) || !Number.isFinite(plain6Words) || plain5Words !== plain6Words) {
    throw new Error(`${layout.task} plain_5parts and plain_6parts must have identical word counts`);
  }
  const requirementMap = JSON.parse(assets.requirementTestMap);
  const logicalTestCount = Object.keys(requirementMap).length;
  const [referenceTest, starterTest] = await Promise.all([
    gradeLogical(assets.reference, assets.unseenTests, logicalTestCount),
    gradeLogical(assets.starter, assets.unseenTests, logicalTestCount),
  ]);
  const expectedNames = new Set(Object.keys(requirementMap).map((name) => `test_${name}`));
  const collectedNames = testNames(referenceTest);
  if (referenceTest.fraction !== 1 || referenceTest.total !== logicalTestCount ||
      collectedNames.length !== expectedNames.size ||
      collectedNames.some((name) => !expectedNames.has(name))) {
    throw new Error('reference does not establish exact logical coverage of the unseen suite');
  }
  if (starterTest.fraction !== 0 || starterTest.total !== logicalTestCount) {
    throw new Error('starter test baseline is outside the expected range');
  }
  return {
    referenceTest: referenceTest.fraction,
    starterTest: starterTest.fraction,
    logicalUnseenTests: referenceTest.total,
    underlyingCaseVariants: logicalTestCount * 2,
    materials: expected.length,
    stagesPerMaterial: Object.fromEntries(expected.map((id) => [id, presentations.arms[id].length])),
    repairRoundsPerMaterial: Object.fromEntries(expected.map((id) => [id, 0])),
    totalRoundsPerMaterial: Object.fromEntries(expected.map((id) => [id, presentations.arms[id].length])),
    stopAfterPresentation: true,
    task: layout.task,
    plainControlWords: { plain_5parts: plain5Words, plain_6parts: plain6Words },
    presentationWords: Object.fromEntries(expected.map((id) => [
      id,
      presentations.arms[id].reduce((sum, row) => sum + row.words, 0),
    ])),
  };
}

function protocolFor(presentations, seeds, task = 'normal') {
  const materials = presentations.materialOrder;
  const logicalTestCount = task === 'normal' ? 26 : 22;
  const starterImports = task === 'simple'
    ? 'datetime, timedelta, Decimal, and InvalidOperation'
    : 'datetime, timedelta, Decimal, InvalidOperation, and ROUND_HALF_UP';
  return {
    protocolVersion: 'evaluation1-guide-only-v4-unseen-deduplicated',
    presentationVersion: presentations.version,
    task: 'reconciliation',
    ...(task === 'normal' ? {} : { taskVariant: task }),
    model: { spec: MODEL_SPEC, snapshot: 'gpt-4o-mini-2024-07-18' },
    arms: materials,
    seeds,
    cellDefinitions: Object.fromEntries(materials.map((id) => [
      id,
      {
        presentation: id,
        numberOfStages: presentations.arms[id].length,
        maximumFinalRepairRounds: 0,
        noteClear: false,
      },
    ])),
    functionNames: [
      'parse_amount', 'parse_record', 'load_records',
      'match_payments', 'compute_refunds', 'build_summary',
    ],
    stableInterfaceLines: [
      '- parse_amount(s)',
      '- parse_record(line) -> dictionary or None',
      '- load_records(text) -> list of record dictionaries',
      '- match_payments(records) -> list of result dictionaries',
      '- compute_refunds(records)',
      '- build_summary(matches, refund_total)',
      `Record and result fields use the exact string keys stated in the current task part. The starter already imports ${starterImports}.`,
    ].join('\n'),
    generationSeedSalt: task === 'normal'
      ? 'evaluation1-multimaterial-student-v2'
      : `evaluation1-${task}-multimaterial-student-v1`,
    scheduleSalt: task === 'normal'
      ? 'evaluation1-multimaterial-schedule-v2'
      : `evaluation1-${task}-multimaterial-schedule-v1`,
    numberOfStages: Math.max(...materials.map((id) => presentations.arms[id].length)),
    presentationStages: Object.fromEntries(materials.map((id) => [id, presentations.arms[id].length])),
    maximumFinalRepairRounds: 0,
    testPolicy: {
      visibility: 'unseen',
      aggregation: 'paired_semantic_tests_all_case_variants_must_pass',
      logicalTestCount,
      underlyingCaseVariantCount: logicalTestCount * 2,
    },
    maximumNoteCharacters: 3000,
    maximumNoteWords: 300,
    noteInstructionVersion: 'source-note',
    temperature: 0.2,
    repeatRepairTemperature: 0.4,
    numPredict: 1800,
    maximumTransportAttempts: 6,
    maximumCompletionCapRetries: 1,
    rules: {
      completeNoteReplacesPreviousNoteEveryRound: true,
      noteUsesAtomicSourceRules: true,
      hardNoteWordLimit: 300,
      repeatPartsAfterFirstPass: false,
      stopAfterPresentation: true,
    },
  };
}

function shuffledSessions(protocol) {
  return protocol.arms.flatMap((arm) => protocol.seeds.map((seed) => ({ arm, seed })))
    .sort((left, right) =>
      sha256(`${protocol.scheduleSalt}|${left.arm}|${left.seed}`)
        .localeCompare(sha256(`${protocol.scheduleSalt}|${right.arm}|${right.seed}`)));
}

function prepareRunDirectory(args, protocol, presentations, checks, resolution, identity) {
  const runsRoot = path.join(ROOT, 'runs');
  const outDir = path.join(runsRoot, args.runId);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(runsRoot, { recursive: true });
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'protocol.json'), canonicalJson(protocol));
    fs.writeFileSync(path.join(outDir, 'presentations.json'), canonicalJson(presentations));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), canonicalJson({
      runId: args.runId,
      startedAt: new Date().toISOString(),
      protocolSha256: sha256(canonicalJson(protocol)),
      presentationsPath: path.relative(REPO_ROOT, args.presentations),
      presentationsSha256: sha256(canonicalJson(presentations)),
      modelDescriptor: resolution.descriptor,
      modelIdentity: identity,
      generationSeeds: args.seeds,
      preflight: checks,
    }));
  } else if (!args.resume) {
    throw new Error(`run directory exists; use --resume: ${outDir}`);
  } else {
    const storedProtocol = fs.readFileSync(path.join(outDir, 'protocol.json'), 'utf8');
    const storedPresentations = fs.readFileSync(path.join(outDir, 'presentations.json'), 'utf8');
    if (storedProtocol !== canonicalJson(protocol) || storedPresentations !== canonicalJson(presentations)) {
      throw new Error('resume inputs differ from the frozen run protocol or presentations');
    }
  }
  return outDir;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const layout = taskLayout(args.task);
  const presentations = JSON.parse(fs.readFileSync(args.presentations, 'utf8'));
  const assets = readAssets(layout);
  const checks = await preflight(presentations, assets, layout);
  if (args.preflightOnly) {
    process.stdout.write(canonicalJson(checks));
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is unavailable; source the supplied .env.local first');
  }
  let protocol = protocolFor(presentations, args.seeds, args.task);
  const existingProtocolPath = path.join(ROOT, 'runs', args.runId ?? '', 'protocol.json');
  if (args.resume && fs.existsSync(existingProtocolPath)) {
    protocol = JSON.parse(fs.readFileSync(existingProtocolPath, 'utf8'));
  }
  const resolution = resolveModelSpec(MODEL_SPEC);
  const identity = await inspectResolvedModel(resolution, { timeoutMs: 30_000 });
  if (identity?.id !== protocol.model.snapshot) {
    throw new Error(`resolved student model mismatch: ${identity?.id ?? 'unknown'}`);
  }
  const outDir = prepareRunDirectory(args, protocol, presentations, checks, resolution, identity);
  const callsPath = path.join(outDir, 'calls.jsonl');
  const resultsPath = path.join(outDir, 'results.jsonl');
  const rows = readJsonLines(resultsPath);
  const completed = new Set(rows.map((row) => `${row.arm}:${row.generationSeed}`));
  const pending = shuffledSessions(protocol)
    .filter((item) => !completed.has(`${item.arm}:${item.seed}`));
  const expectedSessions = protocol.arms.length * protocol.seeds.length;
  let next = 0;

  async function worker() {
    while (next < pending.length) {
      const { arm, seed } = pending[next++];
      let row = null;
      for (let sessionAttempt = 1; sessionAttempt <= MAX_CLEAN_SESSION_ATTEMPTS; sessionAttempt += 1) {
        const executionId = crypto.randomUUID();
        appendJsonLine(callsPath, {
          event: 'session_started', executionId, arm, sessionAttempt,
          generationSeed: seed, startedAt: new Date().toISOString(),
        });
        const candidate = await runSession({
          protocol,
          presentations,
          assets,
          resolution,
          arm,
          seed,
          callPath: callsPath,
          executionId,
        });
        if (candidate.mechanicalFailures > 0) {
          appendJsonLine(callsPath, {
            event: 'session_discarded_mechanical_failure', executionId, arm, sessionAttempt,
            generationSeed: seed, mechanicalFailures: candidate.mechanicalFailures,
            discardedAt: new Date().toISOString(),
          });
          process.stderr.write(
            `[retry] ${arm} seed=${seed}: mechanicalFailures=${candidate.mechanicalFailures}; ` +
            `clean session attempt ${sessionAttempt}/${MAX_CLEAN_SESSION_ATTEMPTS}\n`,
          );
          continue;
        }
        row = candidate;
        appendJsonLine(callsPath, {
          event: 'session_completed', executionId, arm, sessionAttempt,
          generationSeed: seed, completedAt: new Date().toISOString(),
        });
        break;
      }
      if (!row) {
        throw new Error(`${arm} seed=${seed} did not produce a mechanically clean session`);
      }
      row.materialClass = presentations.materialClasses[arm];
      row.materialWords = checks.presentationWords[arm];
      appendJsonLine(resultsPath, row);
      rows.push(row);
      completed.add(`${arm}:${seed}`);
      process.stderr.write(
        `[${rows.length}/${expectedSessions}] ${arm} seed=${seed}: ` +
        `test=${(row.finalTestFraction ?? row.finalHidden).toFixed(3)} rounds=${row.totalRounds}\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length || 1) }, () => worker()));
  if (rows.length !== expectedSessions ||
      new Set(rows.map((row) => `${row.arm}:${row.generationSeed}`)).size !== expectedSessions) {
    throw new Error('run did not produce one unique session for every material and seed');
  }
  const orderedRows = presentations.materialOrder.flatMap((id) =>
    protocol.seeds.map((seed) => rows.find((row) => row.arm === id && row.generationSeed === seed)));
  fs.writeFileSync(path.join(outDir, 'summary.json'), canonicalJson({
    runId: args.runId,
    completedAt: new Date().toISOString(),
    sessions: orderedRows.length,
    generationSeeds: protocol.seeds,
    stopAfterPresentation: true,
    totalRoundsByMaterial: checks.totalRoundsPerMaterial,
    materialOrder: presentations.materialOrder,
    results: orderedRows.map((row) => ({
      material: row.arm,
      generationSeed: row.generationSeed,
      materialClass: row.materialClass,
      ...(row.finalTestFraction !== undefined ? {
        finalTestPassed: row.finalTestPassed,
        finalTestTotal: row.finalTestTotal,
        finalTestFraction: row.finalTestFraction,
        preRepairTestFraction: row.preRepairTestFraction,
      } : {
        finalHidden: row.finalHidden,
        finalVisible: row.finalVisible,
        preRepairHidden: row.preRepairHidden,
      }),
      completed: row.completed,
      totalRounds: row.totalRounds,
      mechanicalFailures: row.mechanicalFailures,
    })),
  }));
  fs.writeFileSync(path.join(outDir, 'complete.json'), canonicalJson({
    runId: args.runId,
    completedAt: new Date().toISOString(),
    sessions: orderedRows.length,
    resultsSha256: sha256(fs.readFileSync(resultsPath)),
    callsSha256: sha256(fs.readFileSync(callsPath)),
  }));
  process.stdout.write(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, preflight, protocolFor, readAssets, taskLayout };
