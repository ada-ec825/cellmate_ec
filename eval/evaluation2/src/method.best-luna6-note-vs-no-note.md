# Best six-step Luna guide: note versus no-note model comparison

Simple and Hard each use the highest-scoring six-step Luna guide from the clean
evaluation1 formal run for the same task. Selection is made by mean final logical
test fraction across the guide's ten GPT-4o-mini students; ties are broken by
full-pass count, then lower guide word count, then material ID.

Each task uses the same factorial design as the retained Normal experiment:

- student models: GPT-4o-mini and GPT-5.6-Luna;
- presentations: six-part plain task text or the selected six-step guide;
- memory treatments: note enabled or note disabled;
- 25 fixed seeds per model/presentation/memory cell, for 200 sessions per task;
- exactly six reading/coding rounds and no repair rounds;
- no task or test prose is repeated after the sixth round;
- tests remain unseen by the student in every condition;
- each logical test passes only when both paired case variants pass;
- checkpoints are emitted every ten accepted clean sessions.

The Hard task keeps GPT-4o-mini at 1,800 maximum output tokens and raises only
GPT-5.6-Luna to 5,000. The original 1,800-token Hard pilot repeatedly hit the
completion cap because the required cumulative program is longer; those Luna
pilot rows are excluded. Raising the ceiling does not require the model to use
all available tokens and avoids paying for discarded six-round attempts.

The note-enabled conditions require both a complete replacement note and Python
code in every round. The no-note conditions require code and retain no prose
memory. Cumulative code is visible in both treatments. A mechanically invalid
attempt is discarded and retried rather than entering the result set.
