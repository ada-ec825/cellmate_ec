# Normal-task note versus no-note comparison

The normal reconciliation task is tested with two student models:
`gpt-4o-mini-2024-07-18` and `gpt-5.6-luna`.

Each model runs the same 25 generation seeds in four conditions:

- plain source-order parts with a retained source note;
- plain source-order parts with no note area;
- the locally copied six-step `formal_luna_28` guide with a retained source note; and
- that guide with no note area.

There is no probabilistic clear treatment. In a with-note condition, every
accepted round reply must contain `NOTE:` followed by one valid JSON object
with exactly the `rules` and `checks` arrays, followed by exactly one Python
code block containing at least one complete public function definition. In a
no-note condition, every accepted reply must contain exactly one Python code
block containing at least one complete public function definition. The prompt
does not create or display a note area in no-note conditions.

A reply missing required output is rejected transactionally. Neither its note
nor its code is retained, and the same round is retried with explicit format
feedback. A round receives at most two format retries. If it still lacks the
required output, the whole session attempt is a mechanical failure, is excluded
from results, and is rerun under the same model, condition, and generation
seed. These retries enforce measurement integrity and are recorded separately
from the six experimental presentation rounds.

Rounds 1–6 show one plain task part or one guide step. The session stops
immediately after round 6. There are no repair rounds and pytest feedback is
never returned to the student. Every clean session therefore uses
exactly six experimental rounds.

GPT-4o-mini uses temperature 0.2; the Responses API does not accept a
temperature field for GPT-5.6-Luna, so Luna uses the API default. Both use a
1,800-token maximum response budget. Both isolated test suites are unseen by
the model. Their 52 case variants form 26 one-to-one semantic pairs according
to `requirements.json`. A logical test passes only when both case variants in
its pair pass, so repeated coverage of the same requirement is not counted
twice. The primary descriptive outcome is the fraction of these 26 logical
tests passed at the end of round 6; strict 26/26 completion is also reported.

The retained 200-session formal dataset was originally collected with optional
post-presentation repair. It was converted without rerunning students by
reconstructing each accepted round-6 code state, independently rescoring that
code, removing every later repair row and repair call, and treating the
round-6 score as final. The complete pre-transformation run is retained outside
the evaluation2 directory in the recovery archive named by the transformed
run's provenance record.

Interim summaries are written after every ten clean sessions in completion
order. They are monitoring statistics, not stopping rules.
