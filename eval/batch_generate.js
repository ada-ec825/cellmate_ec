#!/usr/bin/env node
'use strict';

// Generate a frozen batch of decomposition draws.
//
// A safe --run-id is mandatory. Before the first model call this runner writes
// and re-verifies input-manifest.json, binding the complete schedule and every
// source/build/asset file used. Model exchanges and failures are appended to a
// hash-chained ledger which is sealed whether the run completes or aborts.
//
//   node eval/batch_generate.js --run-id plans-20260803-01 \
//     --model <explicit-id> --ex <id1,id2> [--n 6]
//
// --n is the ordered 2K attempt cap, so it must be even. The corresponding K
// is frozen into the input manifest before model call zero.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILES = Object.freeze([
  'eval/batch_generate.js',
  'eval/lib/provenance.js',
  'eval/lib/runProvenance.js',
  'src/decompose.ts',
  'src/schema.ts',
  'src/gitUtils.ts',
  'out/decompose.js',
  'out/schema.js',
  'out/gitUtils.js',
  'package-lock.json',
  'eval/requirements-lock.txt',
]);
// Read project code/build/locks before loading any project module. After the
// requires complete, capturePathRecord must observe these same bytes or module
// startup aborts before a client can be constructed.
const PRE_REQUIRE_SOURCE_BYTES = new Map(
  SOURCE_FILES.map((file) => [file, fs.readFileSync(path.join(ROOT, file))])
);
const axios = require('axios');

const { fillDecomposeTemplate, parseDecomposition } = require('../out/decompose.js');
const {
  UNKNOWN,
  appendLedger,
  canonicalString,
  makeTreeReadOnly,
  sealLedger,
  sha256,
  sha256File,
  writeJsonExclusive,
} = require('./lib/provenance.js');
const {
  assertRunId,
  backendModelMismatchMessage,
  capturePathRecord,
  createRunDirectory,
  deterministicSchedule,
  environmentState,
  repositoryState,
  runtimeState,
  verifyFrozenInputManifest,
  verifyRunOutputManifest,
  writeAndVerifyInputManifest,
} = require('./lib/runProvenance.js');

const RUNS_ROOT = path.join(__dirname, 'runs');
const ENV_ALLOWLIST = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TMPDIR'];
const BOOT_SOURCE_RECORDS = Object.freeze(
  SOURCE_FILES.map((file) => {
    const captured = capturePathRecord(path.join(ROOT, file), ROOT, file);
    if (!captured.buffer.equals(PRE_REQUIRE_SOURCE_BYTES.get(file))) {
      throw new Error(`project source changed while modules were loading: ${file}`);
    }
    return captured.record;
  })
);

function option(argv, name, fallback = null) {
  const positions = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length > 1) throw new Error(`${name} may be supplied only once`);
  if (positions.length === 0) return fallback;
  const index = positions[0];
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function explicitModelIdentifier(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /\s|@|:\/\//.test(value)
  ) {
    throw new Error('model must be an explicit identifier without a URL, credentials or whitespace');
  }
  return value;
}

function readSettings() {
  const settingsPath = path.join(ROOT, '.vscode', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const config = {
    apiUrl: settings['CellMate.apiUrl'],
    apiKey: settings['CellMate.apiKey'],
    modelName: settings['CellMate.modelName'],
  };
  if (!config.apiUrl || !config.apiKey) {
    throw new Error('CellMate.apiUrl/apiKey missing in .vscode/settings.json');
  }
  return config;
}

async function generateFromFrozenTemplate(context, callLLM, template) {
  const basePrompt = fillDecomposeTemplate(template, context);
  let lastReason = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nYour previous answer was rejected: ${lastReason}. ` +
        'Correct this and reply with the raw JSON object only.';
    let raw;
    try {
      raw = await callLLM(prompt);
    } catch (error) {
      return { ok: false, reason: `LLM call failed: ${error.message ?? error}`, attempts: attempt };
    }
    const parsed = parseDecomposition(raw, context.exerciseId);
    if (parsed.ok) return { ok: true, decomposition: parsed.decomposition, attempts: attempt };
    lastReason = parsed.reason;
  }
  return { ok: false, reason: lastReason, attempts: 2 };
}

async function callOllama(config, prompt, decoding) {
  const response = await axios.post(
    config.apiUrl,
    {
      model: config.modelName,
      prompt,
      stream: false,
      options: { temperature: decoding.temperature, seed: decoding.seed },
    },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      timeout: 180_000,
    }
  );
  if (response.data && typeof response.data === 'object' && response.data.response !== undefined) {
    return {
      text: response.data.response,
      metadata: {
        promptTokens: response.data.prompt_eval_count ?? UNKNOWN,
        completionTokens: response.data.eval_count ?? UNKNOWN,
        backendModel: response.data.model ?? UNKNOWN,
      },
    };
  }
  let full = '';
  let promptTokens = UNKNOWN;
  let completionTokens = UNKNOWN;
  let backendModel = UNKNOWN;
  for (const line of String(response.data).split('\n')) {
    try {
      const item = JSON.parse(line);
      if (item.response) full += item.response;
      if (item.prompt_eval_count !== undefined) promptTokens = item.prompt_eval_count;
      if (item.eval_count !== undefined) completionTokens = item.eval_count;
      if (item.model !== undefined) backendModel = item.model;
    } catch {
      // Preserve non-JSON transport material only as a failed parse below.
    }
  }
  if (!full) throw new Error('no response content from model');
  return { text: full, metadata: { promptTokens, completionTokens, backendModel } };
}

function parseConfiguration(argv, dependencies = {}) {
  const runId = assertRunId(option(argv, '--run-id'));
  const n = positiveInteger(option(argv, '--n', '6'), '--n');
  if (n % 2 !== 0) throw new Error('--n must be even because it is the frozen 2K attempt cap');
  const seedBase = positiveInteger(option(argv, '--seed-base', '1'), '--seed-base');
  const scheduleSeed = positiveInteger(option(argv, '--schedule-seed', '20260803'), '--schedule-seed');
  const temperature = finiteNumber(option(argv, '--temperature', '0.7'), '--temperature');
  if (n > 100_000) throw new Error('--n may not exceed 100000');
  const codePathValue = option(argv, '--code', null);
  const codePath = codePathValue ? path.resolve(codePathValue) : null;
  if (codePath && (!fs.existsSync(codePath) || !fs.statSync(codePath).isFile())) {
    throw new Error(`--code is not a regular file: ${codePath}`);
  }

  const exerciseDir = path.join(__dirname, 'exercises');
  const available = fs
    .readdirSync(exerciseDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))
    .sort();
  const filter = option(argv, '--ex', null);
  if (filter === null) throw new Error('--ex must be supplied explicitly');
  const exercises = filter.split(',').map((item) => item.trim()).filter(Boolean);
  if (exercises.length === 0 || new Set(exercises).size !== exercises.length) {
    throw new Error('--ex must select at least one unique exercise');
  }
  for (const exercise of exercises) {
    if (!available.includes(exercise)) throw new Error(`unknown exercise "${exercise}"`);
  }

  const config = (dependencies.readSettings ?? readSettings)();
  const requestedModel = option(argv, '--model', null);
  if (requestedModel === null) throw new Error('--model must be supplied explicitly');
  const modelName = explicitModelIdentifier(requestedModel);
  config.modelName = modelName;
  const templatePath = path.resolve(
    dependencies.templatePath ?? path.join(ROOT, 'prompts', 'decompose.txt')
  );
  if (!fs.existsSync(templatePath) || !fs.statSync(templatePath).isFile()) {
    throw new Error(`decompose template missing: ${templatePath}`);
  }
  const templateCapture = capturePathRecord(templatePath, ROOT, 'prompt:decompose');
  const exerciseCaptures = Object.fromEntries(
    exercises.map((exerciseId) => {
      const captured = capturePathRecord(
        path.join(exerciseDir, `${exerciseId}.md`),
        ROOT,
        `exercise:${exerciseId}`
      );
      return [exerciseId, captured];
    })
  );
  const codeCapture = codePath
    ? capturePathRecord(codePath, ROOT, 'student-code-input')
    : null;
  const templateText = templateCapture.buffer.toString('utf8');
  const exerciseText = Object.fromEntries(
    Object.entries(exerciseCaptures).map(([exerciseId, captured]) => [
      exerciseId,
      captured.buffer.toString('utf8'),
    ])
  );
  const studentCode = codeCapture ? codeCapture.buffer.toString('utf8') : '';

  const scheduleItems = [];
  let seedOffset = 0;
  for (const exerciseId of exercises) {
    for (let draw = 1; draw <= n; draw++) {
      const planSeed = seedBase + seedOffset;
      if (!Number.isSafeInteger(planSeed)) throw new Error('plan seed schedule exceeds safe integer bounds');
      scheduleItems.push({
        drawId: `${exerciseId}.p${draw - 1}`,
        exerciseId,
        draw,
        model: modelName,
        planSeed,
        outputFile: `${exerciseId}/run${draw}.json`,
      });
      seedOffset++;
    }
  }

  return {
    runId,
    n,
    exercises,
    codePath,
    config,
    templatePath,
    templateText,
    exerciseText,
    studentCode,
    assetFileRecords: [
      templateCapture.record,
      ...Object.values(exerciseCaptures).map((captured) => captured.record),
      ...(codeCapture ? [codeCapture.record] : []),
    ],
    temperature,
    seedBase,
    scheduleSeed,
    schedule: deterministicSchedule(scheduleItems, scheduleSeed),
  };
}

function inputManifest(configuration) {
  const records = [...BOOT_SOURCE_RECORDS, ...configuration.assetFileRecords];

  return {
    stage: 'plan-generation',
    runId: configuration.runId,
    repository: repositoryState(ROOT),
    runtime: runtimeState(),
    environment: environmentState(ENV_ALLOWLIST),
    fileRecords: records,
    treeRecords: [],
    runConfiguration: {
      acceptedPlansPerExercise: configuration.n / 2,
      drawsPerExercise: configuration.n,
      exercises: configuration.exercises,
      seedBase: configuration.seedBase,
      studentCode: configuration.codePath ? 'frozen as file record student-code-input' : 'empty string',
    },
    treatmentContract: {
      systemPrompt: 'none; one rendered user prompt per generation attempt',
      generatorSource: 'out/decompose.js',
      retryPolicy: 'at most one schema-correction retry; transport errors are not retried',
      rawPromptAndReplyLedger: true,
      loadedCodeBinding:
        'project source/build files captured at CommonJS module startup and reverified before every model call',
    },
    model: {
      identifier: configuration.config.modelName,
      digest: UNKNOWN,
      backendVersion: UNKNOWN,
      endpointSha256: sha256(configuration.config.apiUrl),
      credentialReference: 'VS Code CellMate API credential (name only; value excluded)',
    },
    decoding: {
      temperature: configuration.temperature,
      seedSource: 'schedule[].planSeed',
      backendEnforcement: UNKNOWN,
      stream: false,
      topP: 'service default; unknown/not captured',
      topK: 'service default; unknown/not captured',
      contextLimit: 'service default; unknown/not captured',
      serviceDefaultsBeyondRecordedOptions: UNKNOWN,
    },
    scheduleSeed: configuration.scheduleSeed,
    schedule: configuration.schedule,
    historicalOrUnavailableFields: {
      modelDigest: UNKNOWN,
      backendVersion: UNKNOWN,
      contextLimit: UNKNOWN,
    },
  };
}

async function runBatch(argv = process.argv.slice(2), dependencies = {}) {
  // Everything through verifyInputManifest is preflight. No model client or
  // injected model function is touched before it succeeds.
  const configuration = parseConfiguration(argv, dependencies);
  const outRoot = createRunDirectory(dependencies.runsRoot ?? RUNS_ROOT, configuration.runId);
  const frozen = writeAndVerifyInputManifest(
    outRoot,
    inputManifest(configuration),
    ROOT,
    dependencies.afterInputManifest
  );

  const ledgerPath = path.join(outRoot, 'generation-ledger.jsonl');
  const modelCall = dependencies.callModel ?? callOllama;
  const generate = dependencies.generateDecomposition ?? ((context, callLLM) =>
    generateFromFrozenTemplate(context, callLLM, configuration.templateText));
  const rows = [];
  let summaryPath = null;
  let failure = null;

  try {
    for (const item of configuration.schedule) {
      const problem = configuration.exerciseText[item.exerciseId];
      const exchanges = [];
      const recordedExchangeErrors = new WeakSet();
      const callLLM = async (prompt) => {
        verifyFrozenInputManifest(frozen, ROOT);
        const attempt = exchanges.length + 1;
        const started = Date.now();
        try {
          const result = await modelCall(configuration.config, prompt, {
            temperature: configuration.temperature,
            seed: item.planSeed,
          });
          const rawReply = typeof result === 'string' ? result : result.text;
          if (typeof rawReply !== 'string') throw new Error('model caller returned a non-string reply');
          const metadata = typeof result === 'string' ? {} : result.metadata ?? {};
          const backendModel = metadata.backendModel ?? UNKNOWN;
          const modelIdentityError =
            backendModel !== UNKNOWN && backendModel !== configuration.config.modelName
              ? backendModelMismatchMessage(configuration.config.modelName, backendModel)
              : null;
          const exchange = {
            attempt,
            latencyMs: Date.now() - started,
            prompt,
            rawReply,
            tokenCounts: {
              prompt: metadata.promptTokens ?? UNKNOWN,
              completion: metadata.completionTokens ?? UNKNOWN,
            },
            backendModel,
            ...(modelIdentityError ? { modelIdentityError } : {}),
          };
          exchanges.push(exchange);
          appendLedger(ledgerPath, {
            type: 'model-exchange',
            role: 'plan-generator',
            drawId: item.drawId,
            decoding: { temperature: configuration.temperature, seed: item.planSeed },
            ...exchange,
          });
          if (modelIdentityError) {
            const mismatch = new Error(modelIdentityError);
            recordedExchangeErrors.add(mismatch);
            throw mismatch;
          }
          return rawReply;
        } catch (error) {
          if (error instanceof Error && recordedExchangeErrors.has(error)) throw error;
          const exchange = {
            attempt,
            latencyMs: Date.now() - started,
            prompt,
            rawReply: null,
            error: error instanceof Error ? error.message : String(error),
            tokenCounts: UNKNOWN,
          };
          exchanges.push(exchange);
          appendLedger(ledgerPath, {
            type: 'model-exchange',
            role: 'plan-generator',
            drawId: item.drawId,
            decoding: { temperature: configuration.temperature, seed: item.planSeed },
            ...exchange,
          });
          throw error;
        }
      };

      const started = Date.now();
      let result;
      try {
        result = await generate(
          { exerciseId: item.exerciseId, problemDescription: problem, code: configuration.studentCode },
          callLLM
        );
      } catch (error) {
        result = { ok: false, reason: `harness: ${error.message}`, attempts: exchanges.length };
      }
      const record = {
        runId: configuration.runId,
        scheduleOrder: item.order,
        exerciseId: item.exerciseId,
        run: item.draw,
        planSeed: item.planSeed,
        model: configuration.config.modelName,
        ok: result.ok,
        attempts: result.attempts,
        durationMs: Date.now() - started,
        ...(result.ok ? { decomposition: result.decomposition } : { reason: result.reason }),
        exchanges,
      };
      const outputPath = path.join(outRoot, item.outputFile);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      writeJsonExclusive(outputPath, record);
      appendLedger(ledgerPath, {
        type: 'plan-draw-result',
        drawId: item.drawId,
        ok: Boolean(result.ok),
        attempts: result.attempts ?? UNKNOWN,
        outputFile: item.outputFile,
        outputSha256: sha256File(outputPath),
        reason: result.ok ? null : result.reason ?? UNKNOWN,
      });
      rows.push({
        exerciseId: item.exerciseId,
        run: item.draw,
        scheduleOrder: item.order,
        planSeed: item.planSeed,
        ok: Boolean(result.ok),
        attempts: result.attempts,
        durationMs: record.durationMs,
        steps: result.ok ? result.decomposition.steps.length : null,
      });
    }

    verifyFrozenInputManifest(frozen, ROOT);
    const summary = {
      runId: configuration.runId,
      stage: 'plan-generation',
      model: configuration.config.modelName,
      n: configuration.n,
      exercises: configuration.exercises,
      scheduleSha256: frozen.manifest.scheduleSha256,
      inputManifestSha256: frozen.manifestFileSha256,
      rows: rows.sort((a, b) => a.scheduleOrder - b.scheduleOrder),
    };
    summaryPath = path.join(outRoot, 'summary.json');
    writeJsonExclusive(summaryPath, summary);
    appendLedger(ledgerPath, {
      type: 'run-summary',
      status: 'complete',
      sessions: rows.length,
      summarySha256: sha256File(summaryPath),
    });
  } catch (error) {
    failure = error;
    appendLedger(ledgerPath, {
      type: 'run-summary',
      status: 'incomplete',
      completedSessions: rows.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const seal = sealLedger(ledgerPath, {
    stage: 'plan-generation',
    runId: configuration.runId,
    status: failure ? 'incomplete' : 'complete',
    inputManifestSha256: frozen.manifestFileSha256,
  });
  const outputManifestPayload = {
    schemaVersion: 'cellmate.provenance.v1',
    kind: 'run-output-manifest',
    stage: 'plan-generation',
    runId: configuration.runId,
    status: failure ? 'incomplete' : 'complete',
    physicalFreeze: {
      method: 'recursive POSIX read-only modes after final write',
      files: '0444',
      directories: '0555',
      limitation:
        'modes deter accidental edits only; local hashes are integrity checks, not signatures; authenticity requires an external immutable anchor',
    },
    inputManifest: { file: 'input-manifest.json', sha256: frozen.manifestFileSha256 },
    ledger: {
      file: 'generation-ledger.jsonl',
      sha256: seal.ledgerSha256,
      entries: seal.entries,
      lastEntryHash: seal.lastEntryHash,
      sealFile: 'generation-ledger.jsonl.seal.json',
      sealSha256: sha256File(`${ledgerPath}.seal.json`),
    },
    summary: !failure && summaryPath ? { file: 'summary.json', sha256: sha256File(summaryPath) } : null,
  };
  const outputManifestPath = path.join(outRoot, 'output-manifest.json');
  writeJsonExclusive(outputManifestPath, {
    ...outputManifestPayload,
    manifestPayloadSha256: sha256(canonicalString(outputManifestPayload)),
  });
  verifyRunOutputManifest(outputManifestPath);
  makeTreeReadOnly(outRoot);

  if (failure) throw failure;
  return { outRoot, rows, inputManifest: frozen.manifest, ledgerSeal: seal };
}

if (require.main === module) {
  runBatch().then(
    ({ outRoot, rows }) => {
      process.stdout.write(`completed ${rows.length} plan draws: ${path.relative(ROOT, outRoot)}\n`);
    },
    (error) => {
      process.stderr.write(`batch failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = { callOllama, inputManifest, parseConfiguration, readSettings, runBatch };
