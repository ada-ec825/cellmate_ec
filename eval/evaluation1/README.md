# Evaluation 1: minimal reproducible experiment

This directory contains the complete inputs, generated guides, execution code,
and accepted results for the Normal, Simple, and Hard guide-quality
experiments. It does not depend on files from `evaluation2`.

## What is retained

- `tasks/normal`: Normal task assets, controls, 100 generated guide JSON files,
  and frozen presentations.
- `tasks/simple`, `tasks/hard`: copied task assets, provided guides, generated
  guide JSON, guide-generation call logs/receipts, and frozen presentations.
- `runs/`: completed result bundles. Each keeps the frozen protocol,
  presentations, manifest, accepted result rows, score-policy provenance,
  summary, and completion hashes. Bulky raw call logs are recoverably stored
  under `eval_archive/result_bundle_cleanup_20260826/`; their hashes still
  match the `callsSha256` values in each completion receipt.
- `generate_guides.js`, `run_experiment.js`, `runtime/`: generation and session
  execution code.
- `build_wholetext_presentations.js`: reproducibly concatenates each task's
  frozen `plain_6parts` into the one-round and six-repetition whole-text
  controls.
- `code_leakage_test/`: the three-task supplementary audit of the top ten and
  a deterministic random ten generated guides per task, including its frozen
  selection, judge calls, accepted verdicts, summary, and completion hashes.

Generated guide Markdown files were removed because every word is already in
the corresponding canonical JSON. Derived notebooks/reports/caches were also
removed because they are reconstructible from `results.jsonl`.

## Environment

The recorded environment was Node.js with `axios 1.9.0` and Python 3.14.6
with the exact packages in `requirements.txt`.

From the repository root:

```bash
npm install --prefix eval/evaluation1
python3.14 -m venv eval/evaluation1/.venv
eval/evaluation1/.venv/bin/python -m pip install -r eval/evaluation1/requirements.txt
npm run compile
```

Guide generation also requires the repository-owned `prompts/decompose.txt`
and compiled `out/decompose.js`; their hashes are recorded in the generation
receipts. Load `OPENAI_API_KEY` before API calls.

## Re-run the frozen presentations

```bash
node eval/evaluation1/run_experiment.js \
  --task normal \
  --presentations eval/evaluation1/tasks/normal/presentations_formal_50x2.json \
  --seeds 78001,78002,78003,78004,78005,78006,78007,78008,78009,78010,78011,78012,78013,78014,78015,78016,78017,78018,78019,78020 \
  --run-id reproduce-normal --concurrency 8

node eval/evaluation1/run_experiment.js \
  --task simple \
  --presentations eval/evaluation1/tasks/simple/presentations_formal_25x2.json \
  --seeds 80001,80002,80003,80004,80005,80006,80007,80008,80009,80010 \
  --run-id reproduce-simple --concurrency 8

node eval/evaluation1/run_experiment.js \
  --task hard \
  --presentations eval/evaluation1/tasks/hard/presentations_formal_25x2.json \
  --seeds 80001,80002,80003,80004,80005,80006,80007,80008,80009,80010 \
  --run-id reproduce-hard --concurrency 8
```

Every session stops after the final source part or guide step. There are no
repair rounds. Each task has one `task_assets/test_unseen.py`; tests are never
shown to the student. Every logical test runs two case variants and passes only
when both variants pass.

The one-round whole-text controls are frozen as
`tasks/{normal,simple,hard}/presentations_wholetext_1round.json`. Their accepted
runs are `wholetext-1round-normal-20students-20260826`,
`wholetext-1round-simple-10students-20260826`, and
`wholetext-1round-hard-10students-20260826`.

The six-repetition whole-text runs are
`wholetext-6round-normal-20students-20260826`,
`wholetext-6round-simple-10students-20260826`, and
`wholetext-6round-hard-10students-20260826`. Each contains a durable
`trajectory.json` derived from its round-level result rows.

## Validate runnable inputs

```bash
node eval/evaluation1/run_experiment.js \
  --task normal \
  --presentations eval/evaluation1/tasks/normal/presentations_formal_50x2.json \
  --preflight-only
node eval/evaluation1/code_leakage_test/judge.js --preflight-only
node eval/evaluation1/code_leakage_test/judge.js
```

`CLEANUP_MANIFEST.json` records the earlier minimal-reproduction cleanup.
Retired analysis, audit, and one-time score-transformation scripts are retained
under `eval_archive/script_cleanup_20260826/evaluation1/`.
Former split-test sources, completed-run raw calls, and filesystem metadata are
inventoried under `eval_archive/result_bundle_cleanup_20260826/`.
