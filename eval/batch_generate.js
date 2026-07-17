#!/usr/bin/env node
// Batch driver for the decomposition engine.
//
// Generates N plans per exercise offline, reusing the compiled engine
// (out/decompose.js) and the seeded prompt template. Stores every raw
// exchange, parsed plan, attempt count and timing — the raw material for
// stability tables, judge scoring and gold alignment.
//
// Usage:
//   npm run compile
//   node eval/batch_generate.js [--n 5] [--ex id1,id2] [--code path.py]
//
// Exercises are defined by eval/exercises/<id>.md (the problem statement).
// Output goes to eval/runs/<timestamp>/<id>/run<k>.json plus summary.json.
// Runs are sequential on purpose: be kind to the shared model service.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { generateDecomposition } = require('../out/decompose.js');
const { LOCAL_REPO_PATH } = require('../out/gitUtils.js');

const ROOT = path.resolve(__dirname, '..');

function readSettings() {
  const p = path.join(ROOT, '.vscode', 'settings.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg = {
    apiUrl: s['CellMate.apiUrl'],
    apiKey: s['CellMate.apiKey'],
    modelName: s['CellMate.modelName'],
  };
  if (!cfg.apiUrl || !cfg.apiKey || !cfg.modelName) {
    throw new Error('CellMate.apiUrl/apiKey/modelName missing in .vscode/settings.json');
  }
  return cfg;
}

async function callOllama(cfg, prompt) {
  const resp = await axios.post(
    cfg.apiUrl,
    { model: cfg.modelName, prompt, stream: false },
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      timeout: 180_000,
    }
  );
  if (resp.data && typeof resp.data === 'object' && resp.data.response !== undefined) {
    return resp.data.response;
  }
  // Fallback: NDJSON stream despite stream:false.
  let full = '';
  for (const line of String(resp.data).split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.response) full += j.response;
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (!full) throw new Error('no response content from model');
  return full;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const n = parseInt(arg('--n', '5'), 10);
  const exFilter = arg('--ex', null);
  const codePath = arg('--code', null);
  const studentCode = codePath ? fs.readFileSync(codePath, 'utf8') : '';

  const cfg = readSettings();

  const templatePath = path.join(LOCAL_REPO_PATH, 'prompts', 'decompose.txt');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`decompose template not seeded at ${templatePath} — copy prompts/decompose.txt there first`);
  }

  const exDir = path.join(__dirname, 'exercises');
  const available = fs
    .readdirSync(exDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  const exercises = exFilter ? exFilter.split(',') : available;
  for (const ex of exercises) {
    if (!available.includes(ex)) throw new Error(`unknown exercise "${ex}" (have: ${available.join(', ')})`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outRoot = path.join(__dirname, 'runs', stamp);
  fs.mkdirSync(outRoot, { recursive: true });

  console.log(`batch: ${exercises.length} exercise(s) x ${n} run(s), model=${cfg.modelName}`);
  console.log(`output: ${path.relative(ROOT, outRoot)}`);

  const rows = [];
  for (const ex of exercises) {
    const problem = fs.readFileSync(path.join(exDir, `${ex}.md`), 'utf8');
    const exOut = path.join(outRoot, ex);
    fs.mkdirSync(exOut, { recursive: true });

    for (let k = 1; k <= n; k++) {
      // Capture every raw exchange so failures stay analysable.
      const exchanges = [];
      const callLLM = async (p) => {
        const t0 = Date.now();
        const response = await callOllama(cfg, p);
        exchanges.push({ ms: Date.now() - t0, prompt: p, response });
        return response;
      };

      const t0 = Date.now();
      let result;
      try {
        result = await generateDecomposition(
          { exerciseId: ex, problemDescription: problem, code: studentCode },
          callLLM
        );
      } catch (e) {
        result = { ok: false, reason: `harness: ${e.message}`, attempts: exchanges.length };
      }
      const durationMs = Date.now() - t0;

      const record = {
        exerciseId: ex,
        run: k,
        model: cfg.modelName,
        ok: result.ok,
        attempts: result.attempts,
        durationMs,
        ...(result.ok ? { decomposition: result.decomposition } : { reason: result.reason }),
        exchanges,
      };
      fs.writeFileSync(path.join(exOut, `run${k}.json`), JSON.stringify(record, null, 2));

      const steps = result.ok ? result.decomposition.steps.length : null;
      const shareSum = result.ok
        ? result.decomposition.steps.reduce((a, s) => a + (s.timeShare ?? 0), 0)
        : null;
      rows.push({ exerciseId: ex, run: k, ok: result.ok, attempts: result.attempts, durationMs, steps, shareSum });
      console.log(
        `[${ex}] ${k}/${n}: ${result.ok ? 'OK ' : 'FAIL'} attempts=${result.attempts} ` +
          `steps=${steps ?? '-'} shares=${shareSum ?? '-'} ${(durationMs / 1000).toFixed(0)}s` +
          (result.ok ? '' : ` reason=${String(result.reason).slice(0, 140)}`)
      );
    }
  }

  // Per-exercise aggregation for the stability table.
  const byEx = {};
  for (const r of rows) {
    const b = (byEx[r.exerciseId] ??= { runs: 0, ok: 0, firstPass: 0, durations: [], stepCounts: [] });
    b.runs++;
    if (r.ok) {
      b.ok++;
      if (r.attempts === 1) b.firstPass++;
      b.stepCounts.push(r.steps);
    }
    b.durations.push(r.durationMs);
  }
  const aggregate = Object.fromEntries(
    Object.entries(byEx).map(([ex, b]) => [
      ex,
      {
        runs: b.runs,
        ok: b.ok,
        firstPass: b.firstPass,
        meanSeconds: Math.round(b.durations.reduce((a, x) => a + x, 0) / b.durations.length / 1000),
        stepCounts: b.stepCounts,
      },
    ])
  );

  fs.writeFileSync(
    path.join(outRoot, 'summary.json'),
    JSON.stringify({ stamp, model: cfg.modelName, n, studentCode: codePath ?? '(empty)', rows, aggregate }, null, 2)
  );

  console.log('\n=== summary ===');
  for (const [ex, a] of Object.entries(aggregate)) {
    console.log(
      `${ex}: ok ${a.ok}/${a.runs}, first-pass ${a.firstPass}/${a.runs}, ` +
        `mean ${a.meanSeconds}s, step counts [${a.stepCounts.join(', ')}]`
    );
  }
  console.log(`\nwritten: ${path.relative(ROOT, path.join(outRoot, 'summary.json'))}`);
}

main().catch((e) => {
  console.error('batch failed:', e.message);
  process.exit(1);
});
