#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const MAX_PLAN_ATTEMPTS = 3;
const MAX_API_ATTEMPTS = 12;
const TASK_IDS = new Set(['normal', 'simple', 'hard']);

function taskLayout(task) {
  const taskRoot = path.join(ROOT, 'tasks', task);
  return {
    taskRoot,
    taskFile: path.join(taskRoot, 'task.md'),
    assetsDir: path.join(taskRoot, 'task_assets'),
    guideDir: path.join(taskRoot, 'guides'),
    dataDir: path.join(taskRoot, 'data'),
    exerciseId: `evaluation1_${task}_order_payment_reconciliation`,
  };
}

function resolveOutput(relativePath) {
  const resolved = path.resolve(ROOT, relativePath);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`output must stay inside evaluation1: ${relativePath}`);
  }
  return resolved;
}

function parseArgs(argv) {
  const result = {
    task: 'normal',
    model: 'gpt-4o',
    transport: 'chat-completions',
    prefix: 'generated',
    materialClass: 'generated',
    basePrefix: null,
    baseClass: null,
    presentationVersion: 'evaluation1-seven-materials-v1',
    presentationOutput: null,
    receiptOutput: null,
    callLog: null,
    guideCount: 5,
    concurrency: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--task') result.task = argv[++index];
    else if (value === '--model') result.model = argv[++index];
    else if (value === '--transport') result.transport = argv[++index];
    else if (value === '--prefix') result.prefix = argv[++index];
    else if (value === '--material-class') result.materialClass = argv[++index];
    else if (value === '--base-prefix') result.basePrefix = argv[++index];
    else if (value === '--base-class') result.baseClass = argv[++index];
    else if (value === '--presentation-version') result.presentationVersion = argv[++index];
    else if (value === '--presentation-output') result.presentationOutput = argv[++index];
    else if (value === '--receipt-output') result.receiptOutput = argv[++index];
    else if (value === '--call-log') result.callLog = argv[++index];
    else if (value === '--guide-count') result.guideCount = Number.parseInt(argv[++index], 10);
    else if (value === '--concurrency') result.concurrency = Number.parseInt(argv[++index], 10);
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!TASK_IDS.has(result.task)) {
    throw new Error('--task must be normal, simple, or hard');
  }
  if (!result.model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.model)) {
    throw new Error('--model must be a non-empty model id');
  }
  if (!['chat-completions', 'responses'].includes(result.transport)) {
    throw new Error('--transport must be chat-completions or responses');
  }
  for (const [name, value] of [
    ['--prefix', result.prefix],
    ['--material-class', result.materialClass],
    ['--presentation-version', result.presentationVersion],
  ]) {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
      throw new Error(`${name} must be a safe non-empty identifier`);
    }
  }
  if ((result.basePrefix === null) !== (result.baseClass === null)) {
    throw new Error('--base-prefix and --base-class must be supplied together');
  }
  if (!Number.isInteger(result.guideCount) || result.guideCount < 1 || result.guideCount > 100) {
    throw new Error('--guide-count must be an integer from 1 to 100');
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  if (result.basePrefix && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(result.basePrefix) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(result.baseClass))) {
    throw new Error('--base-prefix and --base-class must be safe identifiers');
  }
  const taskPrefix = `tasks/${result.task}/`;
  result.presentationOutput = resolveOutput(
    result.presentationOutput ?? `${taskPrefix}presentations.json`,
  );
  result.receiptOutput = resolveOutput(
    result.receiptOutput ?? `${taskPrefix}data/guide_generation_receipt.json`,
  );
  result.callLog = resolveOutput(
    result.callLog ?? `${taskPrefix}data/guide_generation_calls.jsonl`,
  );
  return result;
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function renderGuide(plan, ordinal, model) {
  const lines = [
    `# ${model} step guide ${ordinal}`,
    '',
    `- Exercise: \`${plan.exerciseId}\``,
    `- Source: \`${plan.source}\``,
    `- Steps: ${plan.steps.length}`,
    '',
  ];
  for (const step of plan.steps) {
    lines.push(`## Step ${step.index} — ${step.label}`);
    lines.push('');
    if (typeof step.timeShare === 'number') {
      lines.push(`Recommended time share: ${step.timeShare}%`);
      lines.push('');
    }
    lines.push(step.intent.trim());
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function presentationFromPlan(plan) {
  return plan.steps.map((step) => ({
    title: `Step ${step.index} of ${plan.steps.length} — ${step.label}`,
    words: wordCount(step.intent),
    text: step.intent.trim(),
    timeShare: step.timeShare ?? null,
  }));
}

function ensureProjectPrompt() {
  const source = path.join(REPO_ROOT, 'prompts', 'decompose.txt');
  const target = path.join(os.tmpdir(), 'promptfolio_repo', 'prompts', 'decompose.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return { source, target, sha256: sha256(fs.readFileSync(source)) };
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string' && content.text.trim()) return content.text;
    }
  }
  return null;
}

async function callProjectTransport(prompt, ordinal, planAttempt, args) {
  const baseUrl = String(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const startedAt = new Date().toISOString();
  const request = args.transport === 'responses'
    ? {
      url: `${baseUrl}/responses`,
      body: {
        model: args.model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      },
    }
    : {
      url: `${baseUrl}/chat/completions`,
      body: {
        model: args.model,
        messages: [{ role: 'user', content: prompt }],
      },
    };
  let response = null;
  for (let apiAttempt = 1; apiAttempt <= MAX_API_ATTEMPTS; apiAttempt += 1) {
    try {
      response = await axios.post(request.url, request.body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 300_000,
      });
      break;
    } catch (error) {
      const status = error?.response?.status ?? null;
      const retryable = status === 429 || (Number.isInteger(status) && status >= 500);
      if (!retryable || apiAttempt === MAX_API_ATTEMPTS) throw error;
      const retryAfterSeconds = Number.parseFloat(error?.response?.headers?.['retry-after']);
      const fallbackMilliseconds = status === 429
        ? Math.min(65_000, 15_000 * apiAttempt)
        : Math.min(30_000, 2_000 * apiAttempt);
      const delayMilliseconds = Number.isFinite(retryAfterSeconds)
        ? Math.max(1_000, Math.ceil(retryAfterSeconds * 1000))
        : fallbackMilliseconds;
      appendJsonLine(args.callLog, {
        event: 'guide_generation_api_retry', ordinal, planAttempt, apiAttempt,
        status, delayMilliseconds, at: new Date().toISOString(),
      });
      process.stderr.write(
        `[guide ${ordinal}/${args.guideCount}] API ${status}; retry ${apiAttempt}/${MAX_API_ATTEMPTS} ` +
        `after ${Math.ceil(delayMilliseconds / 1000)}s\n`,
      );
      await sleep(delayMilliseconds);
    }
  }
  const raw = args.transport === 'responses'
    ? responseText(response.data)
    : response.data?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`OpenAI returned no ${args.transport} text output`);
  }
  appendJsonLine(args.callLog, {
    event: 'guide_generation_response',
    ordinal,
    planAttempt,
    startedAt,
    receivedAt: new Date().toISOString(),
    transport: args.transport,
    modelRequested: args.model,
    modelReturned: response.data?.model ?? null,
    responseId: response.data?.id ?? null,
    requestId: response.headers?.['x-request-id'] ?? response.headers?.['request-id'] ?? null,
    promptSha256: sha256(prompt),
    raw,
    usage: response.data?.usage ?? null,
    finishReason: response.data?.choices?.[0]?.finish_reason ?? response.data?.status ?? null,
  });
  return raw;
}

function groupMaterialIds(prefix, guideCount) {
  return Array.from({ length: guideCount }, (_, index) =>
    `${prefix}_${String(index + 1).padStart(2, '0')}`);
}

function buildPresentations(args, layout) {
  const controls = JSON.parse(fs.readFileSync(
    path.join(layout.assetsDir, 'controls.json'),
    'utf8',
  ));
  const arms = {
    plain_6parts: controls.arms.plain_6parts,
    plain_5parts: controls.arms.plain_5parts,
    reference_steps: controls.arms.reference_steps,
  };
  const groups = [];
  if (args.basePrefix) groups.push({ prefix: args.basePrefix, materialClass: args.baseClass });
  if (!groups.some((group) => group.prefix === args.prefix)) {
    groups.push({ prefix: args.prefix, materialClass: args.materialClass });
  }
  for (const group of groups) {
    for (const key of groupMaterialIds(group.prefix, args.guideCount)) {
      const plan = JSON.parse(fs.readFileSync(path.join(layout.guideDir, `${key}.json`), 'utf8'));
      if (plan.steps.length < 3 || plan.steps.length > 8) {
        throw new Error(`${key} has ${plan.steps.length} steps; expected the project schema range 3..8`);
      }
      arms[key] = presentationFromPlan(plan);
    }
  }
  const taskBytes = fs.readFileSync(layout.taskFile);
  const materialOrder = [
    ...groups.flatMap((group) => groupMaterialIds(group.prefix, args.guideCount)),
    'reference_steps',
    'plain_6parts',
    'plain_5parts',
  ];
  const materialClasses = Object.fromEntries([
    ...groups.flatMap((group) => groupMaterialIds(group.prefix, args.guideCount)
      .map((id) => [id, group.materialClass])),
    ['reference_steps', 'reference'],
    ['plain_6parts', 'plain_6parts'],
    ['plain_5parts', 'plain_5parts'],
  ]);
  const presentation = {
    version: args.presentationVersion,
    taskSha256: sha256(taskBytes),
    sourceDocumentWords: wordCount(taskBytes.toString('utf8')),
    generatorGroups: groups,
    materialOrder,
    materialClasses,
    arms,
  };
  fs.mkdirSync(path.dirname(args.presentationOutput), { recursive: true });
  fs.writeFileSync(args.presentationOutput, canonicalJson(presentation));
  return presentation;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const layout = taskLayout(args.task);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is unavailable; source the supplied .env.local first');
  }
  if (!fs.existsSync(layout.taskFile) || !fs.existsSync(layout.assetsDir)) {
    throw new Error(`missing local evaluation1 task assets for ${args.task}`);
  }
  fs.mkdirSync(layout.guideDir, { recursive: true });
  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(args.callLog), { recursive: true });
  fs.mkdirSync(path.dirname(args.receiptOutput), { recursive: true });
  const prompt = ensureProjectPrompt();
  const { generateDecomposition } = require(path.join(REPO_ROOT, 'out', 'decompose.js'));
  const context = {
    exerciseId: layout.exerciseId,
    problemDescription: fs.readFileSync(layout.taskFile, 'utf8'),
    code: '',
  };

  let nextOrdinal = 1;
  async function worker() {
    while (nextOrdinal <= args.guideCount) {
      const ordinal = nextOrdinal++;
    const key = `${args.prefix}_${String(ordinal).padStart(2, '0')}`;
    const jsonPath = path.join(layout.guideDir, `${key}.json`);
    if (fs.existsSync(jsonPath)) {
      process.stderr.write(`[guide ${ordinal}/${args.guideCount}] existing validated output retained\n`);
      continue;
    }
    let accepted = null;
    for (let planAttempt = 1; planAttempt <= MAX_PLAN_ATTEMPTS; planAttempt += 1) {
      process.stderr.write(
        `[guide ${ordinal}/${args.guideCount}] requesting ${args.model}; plan attempt ${planAttempt}/${MAX_PLAN_ATTEMPTS}\n`,
      );
      const result = await generateDecomposition(
        context,
        (modelPrompt) => callProjectTransport(modelPrompt, ordinal, planAttempt, args),
      );
      if (!result.ok) {
        appendJsonLine(args.callLog, {
          event: 'guide_generation_rejected', ordinal, planAttempt,
          rejectedAt: new Date().toISOString(), reason: result.reason,
          projectParserAttempts: result.attempts,
        });
        if (planAttempt < MAX_PLAN_ATTEMPTS) await sleep(2000 * planAttempt);
        continue;
      }
      accepted = { ...result, planAttempt };
      break;
    }
    if (!accepted) {
      throw new Error(`guide ${ordinal} did not yield a project-valid plan`);
    }
    fs.writeFileSync(jsonPath, canonicalJson(accepted.decomposition));
    fs.writeFileSync(
      path.join(layout.guideDir, `${key}.md`),
      renderGuide(accepted.decomposition, ordinal, args.model),
    );
    process.stderr.write(
      `[guide ${ordinal}/${args.guideCount}] ${accepted.decomposition.steps.length} steps; ` +
      `planAttempt=${accepted.planAttempt}; parserAttempts=${accepted.attempts}\n`,
    );
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, args.guideCount) }, () => worker()));

  const presentations = buildPresentations(args, layout);
  const receipt = {
    completedAt: new Date().toISOString(),
    generatorModel: args.model,
    generatorTransport: `OpenAI ${args.transport}`,
    task: args.task,
    projectEngine: 'out/decompose.js generated from src/decompose.ts',
    promptSource: path.relative(REPO_ROOT, prompt.source),
    promptSha256: prompt.sha256,
    inclusionRule: 'project structural validation only; natural 3..8 step count retained without manual repair',
    guideCount: args.guideCount,
    guidePrefix: args.prefix,
    materialClass: args.materialClass,
    comparisonGroups: presentations.generatorGroups,
    guides: groupMaterialIds(args.prefix, args.guideCount).map((item) => ({
      id: item,
      steps: presentations.arms[item].length,
      words: presentations.arms[item].reduce((sum, row) => sum + row.words, 0),
      sha256: sha256(fs.readFileSync(path.join(layout.guideDir, `${item}.json`))),
    })),
    presentationsPath: path.relative(REPO_ROOT, args.presentationOutput),
    presentationsSha256: sha256(fs.readFileSync(args.presentationOutput)),
  };
  receipt.stepCountDistribution = Object.fromEntries([...new Set(receipt.guides.map((guide) => guide.steps))]
    .sort((left, right) => left - right)
    .map((steps) => [steps, receipt.guides.filter((guide) => guide.steps === steps).length]));
  receipt.nonFiveOrSixStepGuides = receipt.guides
    .filter((guide) => ![5, 6].includes(guide.steps))
    .map((guide) => guide.id);
  fs.writeFileSync(args.receiptOutput, canonicalJson(receipt));
  process.stdout.write(canonicalJson(receipt));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
