#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TASKS = {
  normal: 'presentations_formal_50x2.json',
  simple: 'presentations_formal_25x2.json',
  hard: 'presentations_formal_25x2.json',
};

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function writeCanonicalOrVerify(filename, value) {
  const bytes = canonicalJson(value);
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, bytes, { flag: 'wx' });
  } else if (fs.readFileSync(filename, 'utf8') !== bytes) {
    throw new Error(`existing presentation differs: ${filename}`);
  }
}

for (const [task, sourceName] of Object.entries(TASKS)) {
  const taskDir = path.join(ROOT, 'tasks', task);
  const source = JSON.parse(fs.readFileSync(path.join(taskDir, sourceName), 'utf8'));
  const plain5 = source.arms?.plain_5parts;
  const plain6 = source.arms?.plain_6parts;
  if (!Array.isArray(plain5) || !Array.isArray(plain6) || plain6.length !== 6) {
    throw new Error(`${task} has no valid frozen plain controls`);
  }
  const plain5Words = plain5.reduce((sum, item) => sum + item.words, 0);
  const plain6Words = plain6.reduce((sum, item) => sum + item.words, 0);
  if (plain5Words !== plain6Words) throw new Error(`${task} plain controls differ in word count`);
  const text = plain6.map((item) => item.text.trim()).join('\n\n');
  if (wordCount(text) !== plain6Words) throw new Error(`${task} concatenation changed word count`);
  const oneRoundMaterial = 'plain_wholetext_1round';
  const shared = {
    taskSha256: source.taskSha256,
    sourceDocumentWords: source.sourceDocumentWords,
    generatorGroups: [],
  };
  const oneRound = {
    version: `evaluation1-${task}-wholetext-one-round-v1`,
    ...shared,
    materialOrder: [oneRoundMaterial],
    materialClasses: { [oneRoundMaterial]: 'plain-wholetext-1round' },
    arms: {
      [oneRoundMaterial]: [{
        title: 'Complete plain task in one round',
        words: plain6Words,
        text,
      }],
      plain_5parts: plain5,
      plain_6parts: plain6,
    },
  };
  const sixRoundMaterial = 'plain_wholetext_6rounds';
  const sixRound = {
    version: `evaluation1-${task}-wholetext-six-round-v1`,
    ...shared,
    materialOrder: [sixRoundMaterial],
    materialClasses: { [sixRoundMaterial]: 'plain-wholetext-6rounds' },
    arms: {
      [sixRoundMaterial]: Array.from({ length: 6 }, (_, index) => ({
        title: `Complete plain task — repetition ${index + 1} of 6`,
        words: plain6Words,
        text,
      })),
      plain_5parts: plain5,
      plain_6parts: plain6,
    },
  };
  const oneRoundDestination = path.join(taskDir, 'presentations_wholetext_1round.json');
  const sixRoundDestination = path.join(taskDir, 'presentations_wholetext_6rounds.json');
  writeCanonicalOrVerify(oneRoundDestination, oneRound);
  writeCanonicalOrVerify(sixRoundDestination, sixRound);
  process.stdout.write(
    `${task}\t${plain6Words}\t${path.relative(ROOT, sixRoundDestination)}\n`,
  );
}
