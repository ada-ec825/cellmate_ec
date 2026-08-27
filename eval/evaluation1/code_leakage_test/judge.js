#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HERE = __dirname;
const E1 = [path.resolve(HERE, '..', 'evaluation1'), path.resolve(HERE, '..')]
  .find((candidate) => fs.existsSync(path.join(candidate, 'tasks', 'normal')));
if (!E1) throw new Error('cannot locate evaluation1');

const RULE = `You are auditing a step guide for leaked Python solution code.

A leak is executable Python implementation of logic for one or more functions
required by the specification: a function body, statement, expression, or
operation chain that could be pasted into the student's solution.

Do NOT count any of the following as leakage:
- a function name or signature without a body;
- dictionary keys, field names, literal values, data formats, or prose;
- examples or test calls that merely show expected input/output;
- pseudocode that is not valid Python implementation.

In particular, the bare required-function reference parse_record(line) is not
leakage. It has no implementation body.

Quote every leaking fragment verbatim from the guide, one fragment per line,
with no bullets, labels, explanation, or added punctuation. Every output line
must be an exact substring of the guide. If there is no leak, reply with
exactly: NONE

=== SPECIFICATION ===
{{spec}}

=== STEP GUIDE ===
{{guide}}`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function appendJsonLine(filename, value) {
  fs.appendFileSync(filename, `${JSON.stringify(value)}\n`);
}

function guideText(parts) {
  return parts.map((part) => `## ${part.title}\n\n${part.text}`).join('\n\n');
}

function keyFor(item) {
  return `${item.task}:${item.group}:${item.id}`;
}

function loadItems(manifest) {
  const items = [];
  for (const [task, frozen] of Object.entries(manifest.tasks)) {
    const resultBytes = fs.readFileSync(path.join(E1, frozen.sourceRun, 'results.jsonl'));
    const presentationBytes = fs.readFileSync(path.join(E1, frozen.presentations));
    const specificationBytes = fs.readFileSync(path.join(E1, frozen.specification));
    if (sha256(resultBytes) !== frozen.sourceResultsSha256 ||
        sha256(presentationBytes) !== frozen.presentationsSha256 ||
        sha256(specificationBytes) !== frozen.specificationSha256) {
      throw new Error(`${task} source evidence no longer matches the frozen manifest`);
    }
    const presentations = JSON.parse(presentationBytes);
    const specification = specificationBytes.toString('utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (sha256(specification) !== frozen.anchors.specificationSha256) {
      throw new Error(`${task} cleaned specification hash mismatch`);
    }
    for (const group of ['top', 'random']) {
      for (const material of frozen[group]) {
        const text = guideText(presentations.arms[material.id]);
        if (sha256(text) !== material.materialSha256) {
          throw new Error(`${task}/${material.id} material hash mismatch`);
        }
        items.push({ task, group, id: material.id, text, specification, material });
      }
    }
    const humanGuide = guideText(presentations.arms[frozen.anchors.humanGuidePresentation]);
    if (sha256(humanGuide) !== frozen.anchors.humanGuideSha256) {
      throw new Error(`${task} human-guide anchor hash mismatch`);
    }
    const plantedBase = items.find((item) =>
      item.task === task && item.id === frozen.anchors.plantedBaseMaterial).text;
    items.push({ task, group: 'anchor', id: 'human_guide', text: humanGuide, specification });
    items.push({ task, group: 'anchor', id: 'specification', text: specification, specification });
    items.push({
      task,
      group: 'anchor',
      id: 'planted_leak',
      text: `${plantedBase}\n\n## Leakage calibration\n\n${frozen.anchors.plantedLeak}`,
      specification,
      detectionNeedles: frozen.anchors.plantedDetectionNeedles,
    });
  }
  const keys = items.map(keyFor);
  if (items.length !== manifest.expected.totalJudgments || new Set(keys).size !== items.length) {
    throw new Error('constructed item grid is incomplete or not unique');
  }
  return items.sort((left, right) => sha256(
    `${manifest.itemOrder.salt}|${keyFor(left)}`,
  ).localeCompare(sha256(`${manifest.itemOrder.salt}|${keyFor(right)}`)));
}

function parseArgs(argv) {
  const result = { concurrency: 8, preflightOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--concurrency') result.concurrency = Number.parseInt(argv[++index], 10);
    else if (argv[index] === '--preflight-only') result.preflightOnly = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 16) {
    throw new Error('--concurrency must be an integer from 1 to 16');
  }
  return result;
}

function parseVerdict(reply, item) {
  const value = String(reply ?? '').trim();
  if (/^NONE\.?$/i.test(value)) {
    if (item.id === 'planted_leak') {
      return { valid: false, error: 'planted implementation was not detected' };
    }
    return { valid: true, clean: true, quotes: [] };
  }
  const quotes = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (quotes.length === 0) return { valid: false, error: 'empty non-NONE verdict' };
  const nonVerbatim = quotes.filter((quote) => !item.text.includes(quote));
  if (nonVerbatim.length > 0) {
    return { valid: false, error: 'one or more output lines are not exact guide substrings' };
  }
  const bareRequiredFunction = /^(?:`)?(?:parse_amount|parse_record|load_records|match_payments|compute_refunds|build_summary)\(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*\)(?:`)?$/;
  if (quotes.some((quote) => bareRequiredFunction.test(quote))) {
    return { valid: false, error: 'a bare required-function reference has no implementation body' };
  }
  if (item.id === 'planted_leak' && !quotes.some((quote) =>
    item.detectionNeedles.some((needle) => quote.includes(needle)))) {
    return { valid: false, error: 'verdict did not quote the planted implementation' };
  }
  return { valid: true, clean: false, quotes };
}

function safeApiError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.response ? 'judge API request failed' : String(error?.message ?? 'judge request failed'),
    status: error?.response?.status ?? null,
    code: error?.code ?? null,
    requestId: error?.response?.headers?.['x-request-id'] ?? null,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function judgeItem(item, manifest, apiKey, callsPath) {
  const prompt = RULE.replace('{{spec}}', item.specification).replace('{{guide}}', item.text);
  let correction = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const requestedAt = new Date().toISOString();
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: manifest.judgeModel,
          messages: [
            { role: 'system', content: 'Apply the leakage rule literally and obey the exact output format.' },
            { role: 'user', content: `${prompt}${correction}` },
          ],
        },
        {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          timeout: 300_000,
        },
      );
      const reply = response.data.choices?.[0]?.message?.content?.trim() ?? '';
      const parsed = parseVerdict(reply, item);
      appendJsonLine(callsPath, {
        event: parsed.valid ? 'judge_response_accepted' : 'judge_response_rejected',
        key: keyFor(item), attempt, requestedAt, receivedAt: new Date().toISOString(),
        model: manifest.judgeModel, requestId: response.headers?.['x-request-id'] ?? null,
        usage: response.data.usage ?? null, reply, validationError: parsed.valid ? null : parsed.error,
      });
      if (parsed.valid) return { ...parsed, reply, attempts: attempt };
      correction = `\n\nYour preceding answer was rejected: ${parsed.error}. ` +
        'Try again. Output exact guide substrings only, or exactly NONE.';
    } catch (error) {
      appendJsonLine(callsPath, {
        event: 'judge_transport_error', key: keyFor(item), attempt, requestedAt,
        failedAt: new Date().toISOString(), error: safeApiError(error),
      });
      if (attempt < 4) await sleep(1000 * attempt);
      else throw new Error(`${keyFor(item)} exhausted judge attempts after transport errors`);
    }
  }
  throw new Error(`${keyFor(item)} exhausted judge attempts after invalid verdicts`);
}

function groupStats(rows) {
  return {
    judgments: rows.length,
    clean: rows.filter((row) => row.clean).length,
    leaking: rows.filter((row) => !row.clean).length,
    quotedFragments: rows.reduce((sum, row) => sum + row.quotes.length, 0),
  };
}

function buildSummary(manifest, rows, calls) {
  const byTask = {};
  for (const task of Object.keys(manifest.tasks)) {
    byTask[task] = Object.fromEntries(['top', 'random', 'anchor'].map((group) => [
      group, groupStats(rows.filter((row) => row.task === task && row.group === group)),
    ]));
  }
  const keys = rows.map((row) => row.key);
  const plantedDetected = Object.keys(manifest.tasks).every((task) => {
    const row = rows.find((item) => item.task === task && item.id === 'planted_leak');
    return row && !row.clean;
  });
  const health = {
    expectedJudgments: manifest.expected.totalJudgments,
    acceptedJudgments: rows.length,
    uniqueKeys: new Set(keys).size,
    transportErrors: calls.filter((row) => row.event === 'judge_transport_error').length,
    invalidVerdictRetries: calls.filter((row) => row.event === 'judge_response_rejected').length,
    plantedAnchorsDetected: plantedDetected,
  };
  health.passed = rows.length === manifest.expected.totalJudgments &&
    health.uniqueKeys === manifest.expected.totalJudgments && plantedDetected;
  return {
    protocolVersion: manifest.protocolVersion,
    judgeModel: manifest.judgeModel,
    generated: {
      overall: groupStats(rows.filter((row) => ['top', 'random'].includes(row.group))),
      top: groupStats(rows.filter((row) => row.group === 'top')),
      random: groupStats(rows.filter((row) => row.group === 'random')),
    },
    byTask,
    health,
  };
}

function verifyCompleted(manifestBytes, resultsPath, callsPath, summaryPath, completePath) {
  const complete = JSON.parse(fs.readFileSync(completePath, 'utf8'));
  const checks = {
    manifest: sha256(manifestBytes) === complete.manifestSha256,
    results: sha256(fs.readFileSync(resultsPath)) === complete.resultsSha256,
    calls: sha256(fs.readFileSync(callsPath)) === complete.callsSha256,
    summary: sha256(fs.readFileSync(summaryPath)) === complete.summarySha256,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`completed audit hash mismatch: ${JSON.stringify(checks)}`);
  }
  process.stdout.write(fs.readFileSync(summaryPath, 'utf8'));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestPath = path.join(HERE, 'manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const items = loadItems(manifest);
  if (args.preflightOnly) {
    process.stdout.write(canonical({
      protocolVersion: manifest.protocolVersion,
      tasks: Object.keys(manifest.tasks),
      generatedItems: items.filter((item) => item.group !== 'anchor').length,
      anchors: items.filter((item) => item.group === 'anchor').length,
      totalItems: items.length,
      sourceAndMaterialHashesValid: true,
    }));
    return;
  }
  const resultsPath = path.join(HERE, 'results.jsonl');
  const callsPath = path.join(HERE, 'calls.jsonl');
  const summaryPath = path.join(HERE, 'summary.json');
  const completePath = path.join(HERE, 'complete.json');
  if (fs.existsSync(completePath)) {
    verifyCompleted(manifestBytes, resultsPath, callsPath, summaryPath, completePath);
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const rows = readJsonLines(resultsPath);
  const expected = new Map(items.map((item) => [keyFor(item), item]));
  if (new Set(rows.map((row) => row.key)).size !== rows.length ||
      rows.some((row) => !expected.has(row.key) || row.materialSha256 !== sha256(expected.get(row.key).text))) {
    throw new Error('existing result rows are duplicate or do not match the frozen item grid');
  }
  const completed = new Set(rows.map((row) => row.key));
  const pending = items.filter((item) => !completed.has(keyFor(item)));
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const item = pending[next++];
      const verdict = await judgeItem(item, manifest, apiKey, callsPath);
      const row = {
        key: keyFor(item), task: item.task, group: item.group, id: item.id,
        generator: item.material?.generator ?? null,
        selectionRank: item.material?.selectionRank ?? null,
        meanTestFraction: item.material?.meanTestFraction ?? null,
        materialSha256: sha256(item.text),
        clean: verdict.clean, quotes: verdict.quotes, reply: verdict.reply,
        judgeAttempts: verdict.attempts, judgedAt: new Date().toISOString(),
      };
      appendJsonLine(resultsPath, row);
      rows.push(row);
      process.stdout.write(
        `[${rows.length}/${manifest.expected.totalJudgments}] ${row.key} ` +
        `${row.clean ? 'clean' : `${row.quotes.length} quoted`}\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length || 1) }, () => worker()));
  const calls = readJsonLines(callsPath);
  const summary = buildSummary(manifest, rows, calls);
  fs.writeFileSync(summaryPath, canonical(summary), { flag: 'wx' });
  if (!summary.health.passed) throw new Error(`final audit failed: ${JSON.stringify(summary.health)}`);
  const summaryBytes = fs.readFileSync(summaryPath);
  fs.writeFileSync(completePath, canonical({
    protocolVersion: manifest.protocolVersion,
    completedAt: new Date().toISOString(),
    judgments: rows.length,
    manifestSha256: sha256(manifestBytes),
    resultsSha256: sha256(fs.readFileSync(resultsPath)),
    callsSha256: sha256(fs.readFileSync(callsPath)),
    summarySha256: sha256(summaryBytes),
  }), { flag: 'wx' });
  process.stdout.write(canonical(summary));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { RULE, buildSummary, guideText, loadItems, parseVerdict };
