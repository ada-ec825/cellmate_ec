'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(ROOT, file)} is not valid JSON: ${error.message}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireFile(file, label = path.relative(ROOT, file)) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`missing ${label}: ${path.relative(ROOT, file)}`);
  }
  return file;
}

function verifyHash(file, expected, label) {
  requireFile(file, label);
  const actual = sha256(file);
  if (actual !== expected) {
    fail(`${label} hash mismatch: expected ${expected}, got ${actual}`);
  }
}

function jsonlRows(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      JSON.parse(lines[index]);
    } catch (error) {
      fail(`${path.relative(ROOT, file)}:${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  return lines.length;
}

function findFiles(directory, basename, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) findFiles(file, basename, found);
    else if (entry.name === basename) found.push(file);
  }
  return found;
}

function verifyCompletedRuns() {
  const runRoots = [
    path.join(ROOT, 'eval', 'evaluation1', 'runs'),
    path.join(ROOT, 'eval', 'evaluation2', 'runs'),
  ];
  const completions = runRoots.flatMap((directory) => findFiles(directory, 'complete.json')).sort();
  if (completions.length !== 12) fail(`expected 12 completed formal runs, found ${completions.length}`);

  let sessions = 0;
  for (const completionFile of completions) {
    const runDirectory = path.dirname(completionFile);
    const completion = readJson(completionFile);
    const results = path.join(runDirectory, 'results.jsonl');
    verifyHash(results, completion.resultsSha256, `${completion.runId} results`);
    const rows = jsonlRows(results);
    if (rows !== completion.sessions) {
      fail(`${completion.runId} has ${rows} result rows but completion records ${completion.sessions}`);
    }

    if (completion.healthAuditSha256) {
      verifyHash(
        path.join(runDirectory, 'health-audit.json'),
        completion.healthAuditSha256,
        `${completion.runId} health audit`
      );
    }
    sessions += completion.sessions;
  }
  return { runs: completions.length, sessions };
}

function verifyLeakageAudit() {
  const directory = path.join(ROOT, 'eval', 'evaluation1', 'code_leakage_test');
  const completion = readJson(path.join(directory, 'complete.json'));
  verifyHash(path.join(directory, 'manifest.json'), completion.manifestSha256, 'leakage manifest');
  verifyHash(path.join(directory, 'results.jsonl'), completion.resultsSha256, 'leakage results');
  verifyHash(path.join(directory, 'calls.jsonl'), completion.callsSha256, 'leakage calls');
  verifyHash(path.join(directory, 'summary.json'), completion.summarySha256, 'leakage summary');
  const rows = jsonlRows(path.join(directory, 'results.jsonl'));
  if (rows !== completion.judgments) {
    fail(`leakage audit has ${rows} result rows but completion records ${completion.judgments}`);
  }
  return rows;
}

function main() {
  const completed = verifyCompletedRuns();
  const leakageJudgments = verifyLeakageAudit();
  console.log(
    `Verified ${completed.runs} completed runs (${completed.sessions} accepted sessions) ` +
    `and ${leakageJudgments} leakage judgments.`
  );
}

try {
  main();
} catch (error) {
  console.error(`Evaluation verification failed: ${error.message}`);
  process.exitCode = 1;
}
