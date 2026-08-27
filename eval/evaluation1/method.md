# Evaluation 1 method

## Question

For the order-and-payment reconciliation task in `tasks/normal/task.md`, how do classes of independently generated CellMate step guides compare with the hand-written reference step guide and plain source-order controls?

## Materials

- Each generator class contains independently generated guides produced through the project engine in `src/decompose.ts`, using the repository's current `prompts/decompose.txt` template and empty starter code.
- The provided reference guide is the local `reference_steps` arm in `tasks/normal/task_assets/controls.json`.
- The source-order controls are the local `plain_6parts` and `plain_5parts` arms in `tasks/normal/task_assets/controls.json`, built from `tasks/normal/task_assets/task_6parts.md` and `tasks/normal/task_assets/task_5parts.md`. Both contain the same 717-word task body.
- Generated `checkHint` values are retained in the JSON audit files but hidden from the simulated student, matching `src/guidePanel.ts`. Time-share metadata is retained for audit but not inserted into the experimental task prose, so it does not create an extra cue absent from the two comparison materials.

## Session protocol

- Student model: `gpt-4o-mini-2024-07-18` through the OpenAI Responses API using Evaluation 1's local runtime and task assets.
- Each material is repeated over the configured student seeds. The same task assets, starter, visible tests, hidden tests, stable interface, note format, decoding parameters, and scoring code are used for every material.
- Each material is shown one step or plain source part per reading round, then the session stops immediately. There are no post-presentation repair rounds: a natural 5-step guide uses five rounds and a 6-step guide uses six.
- The structured source-note is retained throughout; there is no note clearing. Code is cumulative. Hidden tests are scored after every round but never shown to the student.
- Session order is deterministically shuffled. The comparison unit is one session/material, not an API call or test assertion.

## Outcomes and comparison

- Primary outcome: final hidden-test accuracy immediately after the last presented step or plain source part.
- Supporting outcomes: final visible accuracy, completion, natural step count, per-step and total word count, hidden-accuracy trajectory during presentation, note capture, and mechanical failures.
- Each guide first averages its student-seed sessions; generator-class means then give every independently generated guide equal weight. Reference and plain source parts remain single-material descriptive controls.
- Generator comparisons use guide as the inferential unit. Student-session repeats reduce response noise but are not counted as additional independently generated guides.

## Claim boundary

This is a small LLM-agent mechanism comparison. It does not estimate effects on human learners, and the seven-session result is descriptive rather than confirmatory.
