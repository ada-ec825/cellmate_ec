#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { runSession } = require('./run.js');
const { gradeLogical, testNames } = require('./lib/grader.js');
const { inspectResolvedModel, resolveModelSpec } = require('./lib/model.js');

const ROOT = __dirname;
const RUNS = path.join(ROOT, '..', 'runs');
const DEFAULT_PROTOCOL = path.join(ROOT, 'tasks', 'normal', 'protocol.luna28-note-vs-no-note.json');

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashOrder(value) {
  return sha256(value);
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonLine(filename, value) {
  fs.appendFileSync(filename, `${JSON.stringify(value)}\n`);
}

function writeNew(filename, value) {
  fs.writeFileSync(filename, typeof value === 'string' ? value : canonicalJson(value), { flag: 'wx' });
}

function writeCanonicalOrVerify(filename, value) {
  const bytes = canonicalJson(value);
  if (!fs.existsSync(filename)) return writeNew(filename, bytes);
  if (fs.readFileSync(filename, 'utf8') !== bytes) {
    throw new Error(`existing artifact differs: ${filename}`);
  }
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function parseArgs(argv) {
  const result = {
    protocol: DEFAULT_PROTOCOL,
    runId: null,
    concurrency: 8,
    resume: false,
    preflightOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--protocol') result.protocol = path.resolve(argv[++index]);
    else if (value === '--run-id') result.runId = argv[++index];
    else if (value === '--concurrency') result.concurrency = Number.parseInt(argv[++index], 10);
    else if (value === '--resume') result.resume = true;
    else if (value === '--preflight-only') result.preflightOnly = true;
    else throw new Error(`unknown argument ${value}`);
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 16) {
    throw new Error('--concurrency must be an integer from 1 to 16');
  }
  if (!result.preflightOnly && (!result.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(result.runId))) {
    throw new Error('provide --run-id SAFE_VALUE');
  }
  if (result.protocol !== ROOT && !result.protocol.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('--protocol must resolve inside evaluation2/src');
  }
  return result;
}

function loadFrozen(filename, runId = null) {
  const protocolBytes = fs.readFileSync(filename);
  const protocol = JSON.parse(protocolBytes.toString('utf8'));
  const taskKey = protocol.taskKey ?? 'normal';
  const expectedModels = {
    '4omini': {
      label: 'GPT-4o-mini',
      spec: 'openai-responses:gpt-4o-mini-2024-07-18',
      snapshot: 'gpt-4o-mini-2024-07-18',
      reasoningEffort: 'not-applicable',
      temperature: 0.2,
      repeatRepairTemperature: 0.4,
      maxOutputTokens: 1800,
    },
    luna: {
      label: 'GPT-5.6-Luna',
      spec: 'openai-responses:gpt-5.6-luna',
      snapshot: 'gpt-5.6-luna',
      reasoningEffort: 'model-default-medium',
      temperature: null,
      repeatRepairTemperature: null,
      maxOutputTokens: 1800,
    },
  };
  if (taskKey === 'hard') expectedModels.luna.maxOutputTokens = 5000;
  const expectedArms = ['plain_note', 'plain_no_note', 'guide_note', 'guide_no_note'];
  const expectedCells = {
    plain_note: { label: 'plain with note', presentation: 'plain', noteEnabled: true },
    plain_no_note: { label: 'plain no note', presentation: 'plain', noteEnabled: false },
    guide_note: { label: 'guide with note', presentation: 'project_steps', noteEnabled: true },
    guide_no_note: { label: 'guide no note', presentation: 'project_steps', noteEnabled: false },
  };
  const taskDesigns = {
    normal: {
      protocolVersion: 'evaluation2-normal-luna28-note-vs-no-note-v5-round6-unseen-deduplicated',
      designSource: 'method.normal-luna28-note-vs-no-note.md',
      logicalTestCount: 26,
      underlyingCaseVariantCount: 52,
      guideMaterialId: null,
      guideWords: 657,
    },
    simple: {
      protocolVersion: 'evaluation2-simple-best-luna6-note-vs-no-note-v1-round6-unseen-deduplicated',
      designSource: 'method.best-luna6-note-vs-no-note.md',
      logicalTestCount: 22,
      underlyingCaseVariantCount: 44,
      guideMaterialId: 'formal_luna_12',
      guideWords: 505,
    },
    hard: {
      protocolVersion: 'evaluation2-hard-best-luna6-note-vs-no-note-v2-round6-luna5000-unseen-deduplicated',
      designSource: 'method.best-luna6-note-vs-no-note.md',
      logicalTestCount: 22,
      underlyingCaseVariantCount: 44,
      guideMaterialId: 'formal_luna_06',
      guideWords: 660,
    },
  };
  const taskDesign = taskDesigns[taskKey];
  if (
    !taskDesign ||
    protocol.protocolVersion !== taskDesign.protocolVersion ||
    protocol.status !== 'frozen' ||
    protocol.designSource !== taskDesign.designSource ||
    protocol.task !== 'reconciliation' ||
    JSON.stringify(protocol.studentModels) !== JSON.stringify(expectedModels) ||
    JSON.stringify(protocol.arms) !== JSON.stringify(expectedArms) ||
    JSON.stringify(protocol.cellDefinitions) !== JSON.stringify(expectedCells) ||
    protocol.seeds?.length !== 25 || new Set(protocol.seeds).size !== 25 ||
    protocol.seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) ||
    protocol.numberOfStages !== 6 || protocol.maximumFinalRepairRounds !== 0 ||
    protocol.noteClearProbability !== undefined || protocol.noteClearSeedSalt !== undefined ||
    protocol.maximumNoteCharacters !== 3000 || protocol.maximumNoteWords !== 300 ||
    protocol.noteInstructionVersion !== 'source-note' ||
    protocol.temperature !== undefined || protocol.repeatRepairTemperature !== undefined ||
    protocol.numPredict !== undefined || protocol.maximumTransportAttempts !== 3 ||
    protocol.maximumCompletionCapRetries !== 1 || protocol.maximumRoundFormatRetries !== 2 ||
    protocol.maximumCleanSessionAttempts !== 5 ||
    protocol.rules?.maximumTotalRounds !== 6 || protocol.rules?.repair !== false ||
    protocol.rules?.repeatPartsAfterFirstPass !== false || protocol.rules?.requireRoundCode !== true ||
    protocol.rules?.requireNoteBeforeCodeWhenEnabled !== true ||
    protocol.testPolicy?.visibility !== 'unseen' ||
    protocol.testPolicy?.aggregation !== 'paired_semantic_tests_all_case_variants_must_pass' ||
    protocol.testPolicy?.logicalTestCount !== taskDesign.logicalTestCount ||
    protocol.testPolicy?.underlyingCaseVariantCount !== taskDesign.underlyingCaseVariantCount ||
    protocol.testPolicy?.pairMappingAsset !== 'requirements.json' ||
    (taskDesign.guideMaterialId !== null &&
      protocol.guideProvenance?.materialId !== taskDesign.guideMaterialId) ||
    protocol.guideProvenance?.steps !== 6 ||
    protocol.guideProvenance?.presentationWords !== taskDesign.guideWords ||
    protocol.formalRun?.sessionsPerCell !== 25 || protocol.formalRun?.expectedSessions !== 200 ||
    protocol.formalRun?.checkpointEveryCleanSessions !== 10
  ) {
    throw new Error('protocol settings do not match the frozen model-comparison design');
  }
  if (runId && runId !== protocol.formalRun.requiredRunId) {
    throw new Error(`run id must be ${protocol.formalRun.requiredRunId}`);
  }
  const readRoot = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const assets = Object.fromEntries(Object.entries(protocol.assets).map(([key, relative]) => [key, readRoot(relative)]));
  const presentations = JSON.parse(assets.presentations);
  if (presentations.version !== 'presentations' ||
      presentations.numberOfStages !== protocol.numberOfStages ||
      presentations.arms?.plain?.length !== protocol.numberOfStages ||
      presentations.arms?.project_steps?.length !== protocol.numberOfStages) {
    throw new Error(`${taskKey} presentation material must match the frozen stage count`);
  }
  for (const presentation of ['plain', 'project_steps']) {
    for (const row of presentations.arms[presentation]) {
      if (row.words !== wordCount(row.text)) throw new Error(`${presentation} has a stale word count for ${row.title}`);
    }
  }
  const guideWords = presentations.arms.project_steps.reduce((sum, row) => sum + row.words, 0);
  if (guideWords !== protocol.guideProvenance.presentationWords) {
    throw new Error(`guide word count ${guideWords} does not match frozen provenance`);
  }
  return { protocol, protocolBytes, presentations, assets };
}

function protocolForModel(protocol, model) {
  return {
    ...protocol,
    model: { spec: model.spec, snapshot: model.snapshot },
    temperature: model.temperature,
    repeatRepairTemperature: model.repeatRepairTemperature,
    numPredict: model.maxOutputTokens,
    cellDefinitions: Object.fromEntries(Object.entries(protocol.cellDefinitions).map(([arm, definition]) => [
      arm,
      {
        presentation: definition.presentation,
        noteEnabled: definition.noteEnabled,
        noteClear: false,
        numberOfStages: protocol.numberOfStages,
        maximumFinalRepairRounds: protocol.maximumFinalRepairRounds,
      },
    ])),
  };
}

async function preflight(frozen) {
  const requirementMap = JSON.parse(frozen.assets.requirementTestMap);
  const logicalTestCount = Object.keys(requirementMap).length;
  const [referenceTest, starterTest] = await Promise.all([
    gradeLogical(frozen.assets.reference, frozen.assets.unseenTests, logicalTestCount),
    gradeLogical(frozen.assets.starter, frozen.assets.unseenTests, logicalTestCount),
  ]);
  const expectedNames = new Set(Object.keys(requirementMap).map((name) => `test_${name}`));
  const collectedNames = testNames(referenceTest);
  if (referenceTest.fraction !== 1 || referenceTest.total !== logicalTestCount ||
      collectedNames.length !== expectedNames.size ||
      collectedNames.some((name) => !expectedNames.has(name))) {
    throw new Error('reference does not establish exact logical coverage of the unseen suite');
  }
  if (starterTest.fraction !== 0 || starterTest.total !== logicalTestCount) {
    throw new Error('starter baseline is outside the expected range');
  }
  const design = fs.readFileSync(path.join(ROOT, frozen.protocol.designSource), 'utf8');
  const secretScan = `${frozen.protocolBytes.toString('utf8')}\n${design}\n${frozen.assets.steps}`;
  if (/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/.test(secretScan) || /"(?:apiKey|authorization)"\s*:/i.test(secretScan)) {
    throw new Error('secret-shaped material found in experiment inputs');
  }
  return {
    studentModelCalls: 0,
    referenceTest: referenceTest.fraction,
    starterTest: starterTest.fraction,
    logicalUnseenTests: referenceTest.total,
    underlyingCaseVariants: logicalTestCount * 2,
    scheduledSessions: frozen.protocol.formalRun.expectedSessions,
    maximumRounds: frozen.protocol.numberOfStages + frozen.protocol.maximumFinalRepairRounds,
    presentationWords: Object.fromEntries(['plain', 'project_steps'].map((key) => [
      key, frozen.presentations.arms[key].reduce((sum, row) => sum + row.words, 0),
    ])),
    assetSha256: Object.fromEntries(Object.entries(frozen.assets).map(([key, value]) => [key, sha256(value)])),
  };
}

function schedule(protocol) {
  return Object.keys(protocol.studentModels).flatMap((studentModelKey) =>
    protocol.arms.flatMap((arm) => protocol.seeds.map((seed) => ({ studentModelKey, arm, seed }))))
    .sort((left, right) => hashOrder(
      `${protocol.scheduleSalt}|${left.studentModelKey}|${left.arm}|${left.seed}`,
    ).localeCompare(hashOrder(
      `${protocol.scheduleSalt}|${right.studentModelKey}|${right.arm}|${right.seed}`,
    )));
}

function rowKey(row) {
  return `${row.studentModelKey}:${row.arm}:${row.generationSeed}`;
}

function actualClearRounds(row) {
  return [
    ...row.stageRows.filter((item) => item.noteClearApplied).map((item) => item.stage),
    ...row.repairRows.filter((item) => item.noteClearApplied).map((item) => item.absoluteRound),
  ];
}

function groupStats(rows) {
  return {
    sessions: rows.length,
    meanRound6Test: mean(rows.map((row) => row.finalTestFraction)),
    meanFinalTest: mean(rows.map((row) => row.finalTestFraction)),
    testFullPasses: rows.filter((row) => row.completed).length,
    testFullPassRate: rows.length ? rows.filter((row) => row.completed).length / rows.length : null,
    meanTotalRounds: mean(rows.map((row) => row.totalRounds)),
    roundFormatRetries: rows.reduce((sum, row) => sum +
      row.stageRows.reduce((inner, item) => inner + (item.roundFormatRetries ?? 0), 0) +
      row.repairRows.reduce((inner, item) => inner + (item.roundFormatRetries ?? 0), 0), 0),
  };
}

function checkpointSummary(protocol, rows, callRows, sessionCount) {
  const selected = rows.slice(0, sessionCount);
  const byModelAndArm = {};
  for (const [modelKey, model] of Object.entries(protocol.studentModels)) {
    byModelAndArm[modelKey] = { label: model.label };
    for (const arm of protocol.arms) {
      byModelAndArm[modelKey][arm] = groupStats(
        selected.filter((row) => row.studentModelKey === modelKey && row.arm === arm),
      );
    }
  }
  return {
    sessionCount,
    expectedSessions: protocol.formalRun.expectedSessions,
    generatedAt: new Date().toISOString(),
    overall: groupStats(selected),
    byModelAndArm,
    health: {
      transportErrors: callRows.filter((row) => row.event === 'response_error').length,
      discardedMechanicalSessionAttempts: callRows.filter((row) => row.event === 'session_discarded_mechanical_failure').length,
      roundFormatRetries: callRows.filter((row) => row.event === 'round_format_retry_scheduled').length,
      cleanResultMechanicalFailures: selected.reduce((sum, row) => sum + row.mechanicalFailures, 0),
    },
  };
}

function formatPercent(value) {
  return value === null ? '—' : `${(100 * value).toFixed(1)}%`;
}

function printCheckpoint(protocol, checkpoint) {
  const cells = [];
  for (const modelKey of Object.keys(protocol.studentModels)) {
    for (const arm of protocol.arms) {
      const stat = checkpoint.byModelAndArm[modelKey][arm];
      cells.push(`${modelKey}/${protocol.cellDefinitions[arm].label} n=${stat.sessions} ` +
        `test=${formatPercent(stat.meanFinalTest)} ` +
        `full=${stat.testFullPasses}/${stat.sessions}`);
    }
  }
  process.stderr.write(
    `[checkpoint ${checkpoint.sessionCount}/${checkpoint.expectedSessions}] ${cells.join(' | ')} | ` +
    `transportErrors=${checkpoint.health.transportErrors} ` +
    `discardedMechanical=${checkpoint.health.discardedMechanicalSessionAttempts} ` +
    `formatRetries=${checkpoint.health.roundFormatRetries}\n`,
  );
}

function writeMissingCheckpoints(protocol, rows, calls, checkpointPath) {
  const existing = readJsonLines(checkpointPath);
  const counts = new Set(existing.map((item) => item.sessionCount));
  const every = protocol.formalRun.checkpointEveryCleanSessions;
  for (let count = every; count <= rows.length; count += every) {
    if (counts.has(count)) continue;
    const checkpoint = checkpointSummary(protocol, rows, calls, count);
    appendJsonLine(checkpointPath, checkpoint);
    printCheckpoint(protocol, checkpoint);
  }
}

function safeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.safeForLog ? error.message : 'session attempt failed',
    status: error?.status ?? null,
    code: error?.code ?? null,
    requestId: error?.requestId ?? null,
  };
}

function prepareRunDirectory(args, frozen, checks, resolvedModels) {
  const outDir = path.join(RUNS, args.runId);
  const protocolPath = path.join(outDir, 'protocol.json');
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(RUNS, { recursive: true });
    fs.mkdirSync(outDir);
    writeNew(protocolPath, frozen.protocol);
    writeNew(path.join(outDir, 'presentations.json'), frozen.presentations);
    writeNew(manifestPath, {
      runId: args.runId,
      startedAt: new Date().toISOString(),
      protocolVersion: frozen.protocol.protocolVersion,
      protocolSha256: sha256(frozen.protocolBytes),
      modelDescriptors: Object.fromEntries(Object.entries(resolvedModels).map(([key, value]) => [
        key, value.resolution.descriptor,
      ])),
      modelIdentities: Object.fromEntries(Object.entries(resolvedModels).map(([key, value]) => [
        key, value.identity,
      ])),
      preflight: checks,
    });
  } else {
    if (!args.resume) throw new Error(`run directory exists; use --resume: ${outDir}`);
    if (!fs.existsSync(protocolPath) || !fs.existsSync(manifestPath)) {
      throw new Error('cannot resume incomplete run metadata');
    }
    if (fs.readFileSync(protocolPath, 'utf8') !== canonicalJson(frozen.protocol)) {
      throw new Error('resume refused because the frozen protocol differs');
    }
    if (fs.readFileSync(path.join(outDir, 'presentations.json'), 'utf8') !== canonicalJson(frozen.presentations)) {
      throw new Error('resume refused because the frozen presentations differ');
    }
  }
  return outDir;
}

async function independentlyRegrade(rows, assets, logicalTestCount, concurrency = 8) {
  const mismatches = [];
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const score = await gradeLogical(
        row.finalCode, assets.unseenTests, logicalTestCount,
      );
      if (score.passed !== row.finalTestPassed || score.total !== row.finalTestTotal ||
          score.fraction !== row.finalTestFraction) {
        mismatches.push({
          key: rowKey(row),
          recorded: [row.finalTestPassed, row.finalTestTotal, row.finalTestFraction],
          rescored: [score.passed, score.total, score.fraction],
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));
  return mismatches;
}

async function finalAudit(protocol, rows, calls, assets) {
  const keys = rows.map(rowKey);
  const expectedPerCell = protocol.formalRun.sessionsPerCell;
  const cellCounts = {};
  for (const modelKey of Object.keys(protocol.studentModels)) {
    cellCounts[modelKey] = Object.fromEntries(protocol.arms.map((arm) => [
      arm, rows.filter((row) => row.studentModelKey === modelKey && row.arm === arm).length,
    ]));
  }
  const clearScheduleMismatches = rows.filter((row) => {
    const expected = row.scheduledNoteClearRounds.filter((round) => round <= row.totalRounds);
    return JSON.stringify(expected) !== JSON.stringify(actualClearRounds(row));
  }).map(rowKey);
  const roundViolations = rows.filter((row) =>
    row.stageRows.length !== protocol.numberOfStages ||
    row.repairRows.length > protocol.maximumFinalRepairRounds ||
    row.totalRounds !== row.stageRows.length + row.repairRows.length ||
    row.totalRounds < protocol.numberOfStages ||
    row.totalRounds > protocol.rules.maximumTotalRounds).map(rowKey);
  const repairRegressions = rows.filter((row) => row.repairRows.some((repair, index) => {
    const preceding = index === 0 ? row.preRepairVisible : row.repairRows[index - 1].visibleFraction;
    return repair.visibleFraction < preceding ||
      (repair.candidateVisibleFraction < preceding && repair.repairAccepted);
  })).map(rowKey);
  const noteTreatmentViolations = rows.filter((row) => {
    const expected = protocol.cellDefinitions[row.arm].noteEnabled;
    const rounds = [...row.stageRows, ...row.repairRows];
    if (row.noteEnabled !== expected || rounds.some((item) => item.noteEnabled !== expected)) return true;
    if (expected) return rounds.some((item) => !item.noteFound);
    return rounds.some((item) => item.noteFound || item.noteBeforeClearWords !== 0 ||
      (item.noteAfterStageWords ?? item.noteAfterRoundWords) !== 0);
  }).map(rowKey);
  const formatIntegrityViolations = rows.filter((row) =>
    [...row.stageRows, ...row.repairRows].some((item) =>
      (item.roundFormatValidationErrors ?? []).length > 0)).map(rowKey);
  const testSchemaViolations = rows.filter((row) =>
    ['preRepairVisible', 'preRepairHidden', 'finalVisible', 'finalHidden'].some(
      (field) => Object.hasOwn(row, field),
    ) || row.finalTestTotal !== protocol.testPolicy.logicalTestCount ||
    row.stageRows.some((stage) => Object.hasOwn(stage, 'visibleFraction') ||
      Object.hasOwn(stage, 'hiddenFraction') ||
      stage.testTotal !== protocol.testPolicy.logicalTestCount)).map(rowKey);
  const testScoreViolations = rows.filter((row) =>
    row.finalTestFraction !== row.finalTestPassed / row.finalTestTotal ||
    row.stageRows.at(-1).testPassed !== row.finalTestPassed ||
    row.stageRows.at(-1).testFraction !== row.finalTestFraction ||
    row.completed !== (row.finalTestPassed === row.finalTestTotal)).map(rowKey);
  const independentRescoreMismatches = await independentlyRegrade(
    rows, assets, protocol.testPolicy.logicalTestCount,
  );
  const audit = {
    expectedSessions: protocol.formalRun.expectedSessions,
    cleanSessions: rows.length,
    uniqueSessionKeys: new Set(keys).size,
    cellCounts,
    allCellsComplete: Object.values(cellCounts).every((model) =>
      Object.values(model).every((count) => count === expectedPerCell)),
    cleanResultMechanicalFailures: rows.reduce((sum, row) => sum + row.mechanicalFailures, 0),
    transportErrors: calls.filter((row) => row.event === 'response_error').length,
    discardedMechanicalSessionAttempts: calls.filter((row) => row.event === 'session_discarded_mechanical_failure').length,
    roundFormatRetries: calls.filter((row) => row.event === 'round_format_retry_scheduled').length,
    clearScheduleMismatches,
    roundViolations,
    repairRegressions,
    noteTreatmentViolations,
    formatIntegrityViolations,
    testSchemaViolations,
    testScoreViolations,
    independentRescoreMismatches,
  };
  audit.passed = audit.cleanSessions === audit.expectedSessions &&
    audit.uniqueSessionKeys === audit.expectedSessions && audit.allCellsComplete &&
    audit.cleanResultMechanicalFailures === 0 && clearScheduleMismatches.length === 0 &&
    roundViolations.length === 0 && repairRegressions.length === 0 &&
    noteTreatmentViolations.length === 0 && formatIntegrityViolations.length === 0 &&
    testSchemaViolations.length === 0 && testScoreViolations.length === 0 &&
    independentRescoreMismatches.length === 0;
  return audit;
}

function finalSummary(protocol, rows, audit) {
  const byModelAndArm = {};
  for (const [modelKey, model] of Object.entries(protocol.studentModels)) {
    byModelAndArm[modelKey] = { label: model.label };
    for (const arm of protocol.arms) {
      byModelAndArm[modelKey][arm] = groupStats(
        rows.filter((row) => row.studentModelKey === modelKey && row.arm === arm),
      );
    }
  }
  return {
    protocolVersion: protocol.protocolVersion,
    sessions: rows.length,
    expectedSessions: protocol.formalRun.expectedSessions,
    completeGrid: audit.allCellsComplete,
    overall: groupStats(rows),
    byModelAndArm,
    health: audit,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const frozen = loadFrozen(args.protocol, args.runId);
  const checks = await preflight(frozen);
  if (args.preflightOnly) {
    process.stdout.write(canonicalJson({ protocolVersion: frozen.protocol.protocolVersion, checks }));
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is unavailable; source the supplied .env.local first');
  }

  const resolvedModels = {};
  for (const [modelKey, model] of Object.entries(frozen.protocol.studentModels)) {
    const resolution = resolveModelSpec(model.spec);
    const identity = await inspectResolvedModel(resolution, { timeoutMs: 30_000 });
    if (identity?.id !== model.snapshot) {
      throw new Error(`${modelKey} resolved as ${String(identity?.id)} instead of ${model.snapshot}`);
    }
    resolvedModels[modelKey] = { resolution, identity, protocol: protocolForModel(frozen.protocol, model) };
  }

  const outDir = prepareRunDirectory(args, frozen, checks, resolvedModels);
  const callsPath = path.join(outDir, 'calls.jsonl');
  const resultsPath = path.join(outDir, 'results.jsonl');
  const checkpointsPath = path.join(outDir, 'checkpoints.jsonl');
  const completePath = path.join(outDir, 'complete.json');
  if (fs.existsSync(completePath)) {
    process.stdout.write(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    return;
  }

  const rows = readJsonLines(resultsPath);
  const initialKeys = rows.map(rowKey);
  if (new Set(initialKeys).size !== initialKeys.length || rows.some((row) => row.mechanicalFailures !== 0)) {
    throw new Error('resume refused: existing results are not unique clean sessions');
  }
  writeMissingCheckpoints(frozen.protocol, rows, readJsonLines(callsPath), checkpointsPath);
  const completedKeys = new Set(initialKeys);
  const pending = schedule(frozen.protocol).filter((item) =>
    !completedKeys.has(`${item.studentModelKey}:${item.arm}:${item.seed}`));
  let next = 0;

  async function worker() {
    while (next < pending.length) {
      const item = pending[next++];
      let accepted = null;
      for (let attempt = 1; attempt <= frozen.protocol.maximumCleanSessionAttempts; attempt += 1) {
        const executionId = crypto.randomUUID();
        appendJsonLine(callsPath, {
          event: 'session_started', executionId, studentModelKey: item.studentModelKey,
          studentModel: frozen.protocol.studentModels[item.studentModelKey].snapshot,
          arm: item.arm, generationSeed: item.seed, cleanSessionAttempt: attempt,
          startedAt: new Date().toISOString(),
        });
        let candidate;
        try {
          candidate = await runSession({
            protocol: resolvedModels[item.studentModelKey].protocol,
            presentations: frozen.presentations,
            assets: frozen.assets,
            resolution: resolvedModels[item.studentModelKey].resolution,
            arm: item.arm,
            seed: item.seed,
            callPath: callsPath,
            executionId,
          });
        } catch (error) {
          appendJsonLine(callsPath, {
            event: 'session_attempt_error', executionId, studentModelKey: item.studentModelKey,
            arm: item.arm, generationSeed: item.seed, cleanSessionAttempt: attempt,
            error: safeError(error), failedAt: new Date().toISOString(),
          });
          process.stderr.write(`[retry] ${item.studentModelKey}/${item.arm} seed=${item.seed} ` +
            `attempt=${attempt}: session attempt error\n`);
          continue;
        }
        if (candidate.mechanicalFailures > 0) {
          appendJsonLine(callsPath, {
            event: 'session_discarded_mechanical_failure', executionId,
            studentModelKey: item.studentModelKey, arm: item.arm,
            generationSeed: item.seed, cleanSessionAttempt: attempt,
            mechanicalFailures: candidate.mechanicalFailures,
            discardedAt: new Date().toISOString(),
          });
          process.stderr.write(`[retry] ${item.studentModelKey}/${item.arm} seed=${item.seed} ` +
            `attempt=${attempt}: mechanicalFailures=${candidate.mechanicalFailures}\n`);
          continue;
        }
        accepted = {
          ...candidate,
          studentModelKey: item.studentModelKey,
          studentModel: frozen.protocol.studentModels[item.studentModelKey].snapshot,
          cleanSessionAttempt: attempt,
          completedAt: new Date().toISOString(),
        };
        break;
      }
      if (!accepted) {
        throw new Error(`could not obtain a clean session for ${item.studentModelKey}/${item.arm}/${item.seed}`);
      }
      appendJsonLine(resultsPath, accepted);
      rows.push(accepted);
      completedKeys.add(rowKey(accepted));
      appendJsonLine(callsPath, {
        event: 'session_completed', studentModelKey: item.studentModelKey,
        arm: item.arm, generationSeed: item.seed, completedAt: accepted.completedAt,
      });
      writeMissingCheckpoints(frozen.protocol, rows, readJsonLines(callsPath), checkpointsPath);
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length || 1) }, () => worker()));
  const calls = readJsonLines(callsPath);
  const audit = await finalAudit(frozen.protocol, rows, calls, frozen.assets);
  writeCanonicalOrVerify(path.join(outDir, 'health-audit.json'), audit);
  if (!audit.passed) throw new Error('final health audit failed');
  const summary = finalSummary(frozen.protocol, rows, audit);
  writeCanonicalOrVerify(path.join(outDir, 'summary.json'), summary);
  writeNew(completePath, {
    runId: args.runId,
    completedAt: new Date().toISOString(),
    sessions: rows.length,
    resultsSha256: sha256(fs.readFileSync(resultsPath)),
    callsSha256: sha256(fs.readFileSync(callsPath)),
    healthAuditSha256: sha256(canonicalJson(audit)),
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
  checkpointSummary, finalAudit, groupStats, loadFrozen, protocolForModel, schedule,
};
