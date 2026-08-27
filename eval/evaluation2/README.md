# Evaluation 2: six-round note versus no-note experiment

This directory retains the completed Simple, Normal, and Hard experiments that
compare plain task parts with six-step guides under note-enabled and no-note
conditions. Older clear, repair, smoke, and 12-round designs are stored in
`eval_archive/evaluation2/`.

## Retained design

- Student models: GPT-4o-mini and GPT-5.6-Luna.
- Four cells per model and task: `plain_note`, `plain_no_note`, `guide_note`,
  and `guide_no_note`.
- 25 fixed seeds per cell: 200 clean sessions per task, 600 in total.
- Exactly six presentation/coding rounds; no repair rounds.
- Tests are never shown to the student. Normal has 52 case variants scored as
  26 logical requirements; Simple and Hard each have 44 variants scored as 22
  logical requirements.
- Mechanically invalid attempts are discarded and retried under the same cell
  and seed; they are not accepted result rows.

The retained run directories are:

- `runs/formal-simple-best-luna6-note-vs-no-note-6round-2models-200-20260826`
- `runs/formal-normal-luna28-note-vs-no-note-6round-2models-200-20260825`
- `runs/formal-hard-best-luna6-note-vs-no-note-6round-2models-200-luna5000-20260826`

Each run contains its frozen protocol and presentations, accepted results,
health audit, summary, and completion hashes. Transformation or migration
receipts are retained where applicable. Bulky raw call logs and progress-only
checkpoints are recoverably stored under
`eval_archive/result_bundle_cleanup_20260826/`; every archived call-log hash
matches the `callsSha256` value in its retained completion receipt.

The one-time migration, metric-transformation, task-preparation, presentation
synchronisation, and regression-test scripts are recoverably archived under
`eval_archive/script_cleanup_20260826/evaluation2/`. They are not required to
launch the retained formal protocols; all resulting data and provenance
receipts remain in place.

## Runtime and inputs

`src/run_formal_note_comparison.js` is the formal experiment orchestrator and
`src/run.js` is its shared per-session engine. `src/lib/` contains extraction,
model, sandbox, and grading logic. `src/tasks/{simple,normal,hard}/` contains
the task assets, selected guide, frozen presentations, active protocol, and one
physical `test_unseen.py` suite. The former visible/hidden source split is only
retained in the recovery archive.

The active protocols are:

- `tasks/simple/protocol.best-luna6-note-vs-no-note.json`
- `tasks/normal/protocol.luna28-note-vs-no-note.json`
- `tasks/hard/protocol.best-luna6-note-vs-no-note.json`

## Validate the retained inputs

From `eval/evaluation2/src`:

```bash
npm install
node run_formal_note_comparison.js --protocol tasks/simple/protocol.best-luna6-note-vs-no-note.json --preflight-only
node run_formal_note_comparison.js --protocol tasks/normal/protocol.luna28-note-vs-no-note.json --preflight-only
node run_formal_note_comparison.js --protocol tasks/hard/protocol.best-luna6-note-vs-no-note.json --preflight-only
```

Formal protocols pin their original run IDs. To collect a fresh independent
replication, copy an active protocol, assign a new `formalRun.requiredRunId`,
and pass that same ID with `--run-id`. API calls require `OPENAI_API_KEY`.
