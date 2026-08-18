# Course result release

Implement only the six named functions in the provided scaffold. Do not rename them. Do not add top-level test or print statements.

## `result_record(student_id, components, approved)`

Return a dictionary with exactly the keys `"student"`, `"total"`, `"band"`, and `"status"`. Their values must respectively be the supplied student id, the course total for `components`, the grade band for that total, and the release decision for `components` and `approved`. Obtain the computed values through the named helper functions.

## `release_decision(components, approved)`

- `approved` is a boolean. Return `"held"` when it is `False`.
- Otherwise compute `course_total(components)` and return `"review"` when `grade_band(total)` is `"F"`.
- Otherwise return `"released"`.

## `grade_band(total)`

Return `"A"` for totals at least 70, `"B"` for totals at least 60, `"C"` for totals at least 50, and `"F"` otherwise.

## `course_total(components)`

`components` is a list of `(score, weight)` pairs. Return the sum of `weighted_score(score, weight)` for every pair, rounded to two decimal places. An empty list returns `0.0`.

## `weighted_score(score, weight)`

Return `normalise_score(score) * weight`, rounded to two decimal places. Scores and weights are numeric, and a weight is non-negative.

## `normalise_score(score)`

`score` is numeric. Return `0` below the range and `100` above it. Return an in-range value unchanged, without converting its numeric type.
