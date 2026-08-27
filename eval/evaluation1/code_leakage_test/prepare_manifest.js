#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const E1 = [path.resolve(HERE, '..', 'evaluation1'), path.resolve(HERE, '..')]
  .find((candidate) => fs.existsSync(path.join(candidate, 'tasks', 'normal')));
if (!E1) throw new Error('cannot locate evaluation1');

const RANDOM_SELECTION_SALT = 'evaluation1-code-leakage-random-v1';
const ITEM_SHUFFLE_SALT = 'evaluation1-code-leakage-judge-order-v1';
const TASKS = {
  simple: {
    runId: 'formal-simple-25x2-10students-currentprompt-20260825',
    presentations: 'presentations_formal_25x2.json',
    expectedGuides: 50,
    sessionsPerGuide: 10,
    plantedLeak: [
      '```python',
      'def compute_refunds(records):',
      '    return sum(-record["amount"] for record in records if record["type"] == "PAYMENT" and record["amount"] < 0)',
      '```',
    ].join('\n'),
  },
  normal: {
    runId: 'formal-50x2-20students-currentprompt-v2-20260825',
    presentations: 'presentations_formal_50x2.json',
    expectedGuides: 100,
    sessionsPerGuide: 20,
    plantedLeak: [
      '```python',
      'def compute_refunds(records):',
      '    return sum(-row["amount"] for row in records if row["type"] == "PAYMENT" and row["amount"] < 0)',
      '```',
    ].join('\n'),
  },
  hard: {
    runId: 'formal-hard-25x2-10students-currentprompt-20260825',
    presentations: 'presentations_formal_25x2.json',
    expectedGuides: 50,
    sessionsPerGuide: 10,
    plantedLeak: [
      '```python',
      'def compute_refunds(records):',
      '    order_ids = {record["order_id"] for record in records if record["type"] == "ORDER"}',
      '    return sum(-record["amount"] for record in records if record["type"] == "PAYMENT" and record["amount"] < 0 and record["order_id"] in order_ids)',
      '```',
    ].join('\n'),
  },
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonLines(filename) {
  return fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function guideText(parts) {
  return parts.map((part) => `## ${part.title}\n\n${part.text}`).join('\n\n');
}

function materialStats(rows, presentations, arm) {
  const selected = rows.filter((row) => row.arm === arm);
  const parts = presentations.arms[arm];
  const text = guideText(parts);
  return {
    id: arm,
    generator: presentations.materialClasses[arm],
    sessions: selected.length,
    meanTestFraction: selected.reduce((sum, row) => sum + row.finalTestFraction, 0) / selected.length,
    fullPasses: selected.filter((row) => row.completed).length,
    steps: parts.length,
    words: parts.reduce((sum, part) => sum + part.words, 0),
    materialSha256: sha256(text),
  };
}

function topOrder(left, right) {
  return right.meanTestFraction - left.meanTestFraction ||
    right.fullPasses - left.fullPasses ||
    left.words - right.words || left.id.localeCompare(right.id);
}

function taskSelection(task, config) {
  const runDir = path.join(E1, 'runs', config.runId);
  const resultsPath = path.join(runDir, 'results.jsonl');
  const complete = JSON.parse(fs.readFileSync(path.join(runDir, 'complete.json'), 'utf8'));
  const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health-audit.json'), 'utf8'));
  const resultBytes = fs.readFileSync(resultsPath);
  if (sha256(resultBytes) !== complete.resultsSha256 || health.passed !== true) {
    throw new Error(`${task} source run is not a completed healthy frozen run`);
  }
  const rows = readJsonLines(resultsPath);
  const presentationsPath = path.join(E1, 'tasks', task, config.presentations);
  const presentationBytes = fs.readFileSync(presentationsPath);
  const presentations = JSON.parse(presentationBytes);
  const generatedRows = rows.filter((row) =>
    ['gpt4o_generated', 'luna_generated'].includes(row.materialClass));
  if (generatedRows.some((row) => row.mechanicalFailures !== 0)) {
    throw new Error(`${task} source run includes a non-clean generated-guide row`);
  }
  const arms = [...new Set(generatedRows.map((row) => row.arm))];
  if (arms.length !== config.expectedGuides ||
      arms.some((arm) => generatedRows.filter((row) => row.arm === arm).length !== config.sessionsPerGuide)) {
    throw new Error(`${task} does not contain the expected complete generated-guide grid`);
  }
  const ranked = arms.map((arm) => materialStats(generatedRows, presentations, arm)).sort(topOrder);
  const top = ranked.slice(0, 10).map((row, index) => ({ ...row, selectionRank: index + 1 }));
  const topIds = new Set(top.map((row) => row.id));
  const random = ranked.filter((row) => !topIds.has(row.id)).sort((left, right) =>
    sha256(`${RANDOM_SELECTION_SALT}|${task}|${left.id}`).localeCompare(
      sha256(`${RANDOM_SELECTION_SALT}|${task}|${right.id}`),
    )).slice(0, 10).map((row, index) => ({ ...row, selectionRank: index + 1 }));
  if (new Set([...top, ...random].map((row) => row.id)).size !== 20) {
    throw new Error(`${task} top and random selections overlap`);
  }
  const specification = fs.readFileSync(path.join(E1, 'tasks', task, 'task.md'), 'utf8');
  const humanGuide = guideText(presentations.arms.reference_steps);
  return {
    sourceRun: `runs/${config.runId}`,
    sourceResultsSha256: sha256(resultBytes),
    presentations: `tasks/${task}/${config.presentations}`,
    presentationsSha256: sha256(presentationBytes),
    specification: `tasks/${task}/task.md`,
    specificationSha256: sha256(specification),
    generatedGuidePopulation: config.expectedGuides,
    sessionsPerGuide: config.sessionsPerGuide,
    rankingMetric: 'mean final unseen logical-test fraction across all clean students for the guide',
    rankingTieBreaks: ['full passes descending', 'guide words ascending', 'material id ascending'],
    top,
    random,
    anchors: {
      humanGuidePresentation: 'reference_steps',
      humanGuideSha256: sha256(humanGuide),
      specificationSha256: sha256(specification.replace(/<!--[\s\S]*?-->/g, '').trim()),
      plantedBaseMaterial: top[0].id,
      plantedLeak: config.plantedLeak,
      plantedDetectionNeedles: ['def compute_refunds(records):', 'return sum('],
    },
  };
}

function main() {
  const manifest = {
    protocolVersion: 'evaluation1-code-leakage-top10-random10-v1',
    question: 'Do generated step guides contain executable Python implementation for required task functions?',
    criterion: 'Quote executable solution implementation, but not signatures without bodies, field names, literals, formats, examples, test calls, or prose/pseudocode.',
    judgeModel: 'gpt-5.6-luna',
    judgePromptVersion: 'runnable-required-function-implementation-v3',
    protocolRevision: 'V2 produced two generated-guide verdicts whose only quote was parse_record(line), even though the criterion explicitly excludes a function reference without a body. V3 mechanically rejects a bare required-function reference and retries the judge. The complete V2 artifacts are retained in the recovery archive.',
    randomSelection: {
      method: 'lowest SHA-256 ranks among non-top guides',
      salt: RANDOM_SELECTION_SALT,
      topExcluded: true,
    },
    itemOrder: { method: 'SHA-256 rank', salt: ITEM_SHUFFLE_SALT },
    expected: {
      tasks: 3,
      topGuidesPerTask: 10,
      randomGuidesPerTask: 10,
      generatedGuideJudgments: 60,
      anchorsPerTask: 3,
      totalJudgments: 69,
    },
    tasks: Object.fromEntries(Object.entries(TASKS).map(([task, config]) => [
      task, taskSelection(task, config),
    ])),
  };
  const bytes = canonical(manifest);
  const filename = path.join(HERE, 'manifest.json');
  if (process.argv.includes('--write')) {
    if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') !== bytes) {
      throw new Error('refusing to replace a different frozen manifest');
    }
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes, { flag: 'wx' });
  }
  process.stdout.write(bytes);
}

main();
