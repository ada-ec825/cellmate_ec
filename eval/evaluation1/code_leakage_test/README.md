# Evaluation 1 code-leakage supplement

This audit checks generated step guides for executable Python implementation
of required task functions. It covers all three Evaluation 1 tasks.

For each task, the frozen selection contains:

- the ten generated guides with the highest mean final unseen logical-test
  fraction across that guide's clean student sessions;
- ten guides selected by deterministic SHA-256 ranking from the remaining
  generated guides, with the top ten excluded; and
- three unlabelled calibration materials: the provided human guide, the task
  specification, and a top guide with a short reference implementation planted
  into it.

Thus the judge evaluates 60 generated guides and 9 anchors, for 69 judgments.
`manifest.json` freezes source hashes, ranking statistics, selections, random
salt, material hashes, anchors, and judge model.

Protocol V3 also rejects a judge reply whose only claimed evidence is a bare
required-function reference such as `parse_record(line)`: this is explicitly a
signature/call reference without an implementation body, not leaked solution
code. The archived V2 run is retained because it exposed this false-positive
case.

## Result

| Task | Top 10 clean | Random 10 clean |
|---|---:|---:|
| Simple | 10/10 | 10/10 |
| Normal | 10/10 | 10/10 |
| Hard | 10/10 | 10/10 |
| **Total** | **30/30** | **30/30** |

All 60 generated guides were clean under the frozen criterion. All three
planted-code anchors were detected. The three specification anchors were
clean; the human-guide anchors produced code-like fragments in Simple and
Normal and none in Hard, so anchors are retained as calibration evidence and
are not included in the generated-guide rate.

The completed run contains 69 unique accepted judgments, zero transport
errors, one invalid-format retry, and a passing health check.

## Reproduce

From the repository root:

```bash
node eval/evaluation1/code_leakage_test/prepare_manifest.js
node eval/evaluation1/code_leakage_test/judge.js --preflight-only
export OPENAI_API_KEY=...
node eval/evaluation1/code_leakage_test/judge.js --concurrency 8
```

The first command prints the selection implied by the retained Evaluation 1
data and refuses to overwrite a different frozen manifest when `--write` is
used. The judge is resumable: accepted rows are keyed by task, selection group,
and material ID. Every non-`NONE` output line must be an exact substring of the
audited guide. Transport failures and invalid-format retries are recorded in
`calls.jsonl`.

## Contents

```text
prepare_manifest.js  deterministic ranking and random selection
judge.js             judge runner, resume logic, and integrity checks
manifest.json        frozen source evidence and material grid
calls.jsonl          judge responses and retry metadata
results.jsonl        one accepted verdict per material
summary.json         results by task and selection group
complete.json        completion and artifact hashes
```
