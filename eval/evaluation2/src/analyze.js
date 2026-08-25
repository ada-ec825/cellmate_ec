#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TASKS = ['simple', 'normal', 'hard'];
const ARMS = ['equal_note', 'equal_note_clear', 'steps_note', 'steps_note_clear'];

function readRows(task) {
  return fs.readFileSync(path.join(DATA, `${task}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
}
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}
function interval(values) { return [percentile(values, 0.025), percentile(values, 0.975)]; }
function rounded(value) { return Number(value.toFixed(6)); }
function randomGenerator(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function contrasts(values) {
  return {
    stepsEffectNoClear: values.steps_note - values.equal_note,
    stepsEffectClear: values.steps_note_clear - values.equal_note_clear,
    clearEffectEqual: values.equal_note_clear - values.equal_note,
    clearEffectSteps: values.steps_note_clear - values.steps_note,
    interaction: (values.steps_note_clear - values.steps_note) -
      (values.equal_note_clear - values.equal_note),
  };
}

function analyzeTask(task, bootstrapSeed) {
  const rows = readRows(task);
  const keys = new Set(rows.map((row) => `${row.arm}:${row.generationSeed}`));
  if (rows.length !== 100 || keys.size !== 100 ||
      ARMS.some((arm) => rows.filter((row) => row.arm === arm).length !== 25) ||
      rows.some((row) => row.task !== task || row.mechanicalFailures !== 0)) {
    throw new Error(`${task} data is not a clean 4 x 25 grid`);
  }

  const groups = Object.fromEntries(ARMS.map((arm) => [arm, rows.filter((row) => row.arm === arm)]));
  const observedMeans = Object.fromEntries(ARMS.map((arm) => [arm,
    mean(groups[arm].map((row) => row.finalHidden)),
  ]));
  const observedContrasts = contrasts(observedMeans);
  const random = randomGenerator(bootstrapSeed);
  const armSamples = Object.fromEntries(ARMS.map((arm) => [arm, []]));
  const contrastSamples = Object.fromEntries(Object.keys(observedContrasts).map((key) => [key, []]));

  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const sampledMeans = Object.fromEntries(ARMS.map((arm) => {
      const source = groups[arm];
      const sample = Array.from({ length: 25 }, () =>
        source[Math.floor(random() * source.length)].finalHidden);
      return [arm, mean(sample)];
    }));
    for (const arm of ARMS) armSamples[arm].push(sampledMeans[arm]);
    for (const [key, value] of Object.entries(contrasts(sampledMeans))) contrastSamples[key].push(value);
  }

  return {
    task,
    sessions: 100,
    byArm: Object.fromEntries(ARMS.map((arm) => {
      const selected = groups[arm];
      const repairAttempts = selected.reduce((sum, row) => sum + row.repairAttempts, 0);
      return [arm, {
        n: 25,
        meanFinalHidden: rounded(observedMeans[arm]),
        meanFinalHiddenBootstrap95: interval(armSamples[arm]).map(rounded),
        completed: selected.filter((row) => row.completed).length,
        visibleOnlyStops: selected.filter((row) => row.finalVisible === 1 && row.finalHidden < 1).length,
        meanTotalRounds: rounded(mean(selected.map((row) => row.totalRounds))),
        meanPreRepairHidden: rounded(mean(selected.map((row) => row.preRepairHidden))),
        repeatedFailedRepairRate: repairAttempts
          ? rounded(selected.reduce((sum, row) => sum + row.repeatedFailedRepairs, 0) / repairAttempts)
          : 0,
        noteClears: selected.reduce((sum, row) => sum + row.noteClears, 0),
      }];
    })),
    contrasts: Object.fromEntries(Object.entries(observedContrasts).map(([key, value]) => [key, {
      estimate: rounded(value),
      bootstrap95: interval(contrastSamples[key]).map(rounded),
    }])),
  };
}

function main() {
  const output = {
    model: 'gpt-4o-mini-2024-07-18',
    design: 'equal chunks / project steps x note retained / cleared',
    sessions: 300,
    bootstrap: { resamples: 10_000, unit: 'independent session' },
    tasks: TASKS.map((task, index) => analyzeTask(task, 824001 + index)),
    conclusion: 'Project steps improve final hidden-test accuracy across all three task difficulties; note clearing and its interaction with presentation are not stable.',
    claimBoundary: 'LLM-agent mechanism experiment; not an estimate of effects on human students or people with ADHD.',
  };
  fs.writeFileSync(path.join(DATA, 'analysis.json'), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
