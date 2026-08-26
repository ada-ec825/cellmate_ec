# Luna guide used by the normal-task model comparison

This is a local copy of Evaluation 1's `formal_luna_28` guide. The experiment
shows only the text under each step; the time shares below are provenance
metadata and are not added to the student prompt.

## Step 1 of 6 — Parse monetary amounts

Recommended time share: 15%

Implement `parse_amount(s)` so valid decimal text becomes integer cents.
- A non-string input returns `None`.
- Valid text contains digits, at most one decimal point, and an optional leading minus sign only.
- Scientific notation and every other numeric notation are invalid and return `None`.
- More than three fractional digits is invalid and returns `None`.
- Round a third fractional digit to cents using **round-half-up**, preserving the sign.
- Return the result as an integer number of cents.
- Invalid input returns `None` without raising, printing, mutating input, or using global state.

## Step 2 of 6 — Parse individual records

Recommended time share: 20%

Implement `parse_record(line)` to return one valid parsed-record dictionary or `None`.
- The line must have exactly six `|`-separated fields in `TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP` order.
- `TYPE` is case-insensitive `ORDER` or `PAYMENT`, then stored uppercase.
- Trim both identifiers; they must be non-empty, and an `ORDER` requires equal `RECORD_ID` and `ORDER_ID`.
- Currency is trimmed and must be exactly `USD`.
- Parse `AMOUNT` with `parse_amount(s)`; a negative `ORDER` is invalid, while a negative `PAYMENT` is a refund.
- `TIMESTAMP` must exactly match `2024-03-15 14:30` format, use valid calendar values, and become a naive `datetime` representing UTC without timezone conversion.
- Return an ordinary dictionary with exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`; invalid fields return `None` silently.
- Do not mutate input, print, or use global state.

## Step 3 of 6 — Load valid records

Recommended time share: 15%

Implement `load_records(text)` to produce the retained parsed records in source-line order.
- Parse every input line with `parse_record(line)`.
- Silently skip lines that cannot be parsed or do not satisfy the format; do not raise or print warnings.
- If the same trimmed `RECORD_ID` occurs more than once, retain the first valid occurrence and skip later valid occurrences.
- An invalid occurrence does not reserve its record ID.
- Return records as ordinary dictionaries with exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`.
- Amounts remain integer cents, currencies are `USD`, and timestamps are naive UTC `datetime` values.
- Do not mutate an input object or use global state.

## Step 4 of 6 — Match payments to orders

Recommended time share: 20%

Implement `match_payments(records)` with one result for every order.
- Read parsed records through dictionary keys; records are ordinary dictionaries and retained source order is significant.
- For each order, consider only non-negative `PAYMENT` records with the same `order_id`.
- A payment qualifies when its naive UTC timestamp is at or after the order timestamp and at or before exactly 72 hours after it; both endpoints are included.
- Negative payments are refunds and never qualify as matched payments.
- Choose the qualifying payment with the earliest timestamp; break exact timestamp ties by retained source order.
- Return results in retained order-record order, each an ordinary dictionary with exactly `order_id`, `status`, and `amount`.
- Status is exactly lowercase `matched` or `unmatched`; unmatched amounts are `0`.
- Amounts are integer cents, and the function does not mutate inputs, print, or use global state.

## Step 5 of 6 — Compute refund totals

Recommended time share: 10%

Implement `compute_refunds(records)` to calculate the positive refund total in cents.
- Read each parsed record by dictionary keys.
- Include every negative `PAYMENT` amount, even when no order with its `order_id` exists.
- Add the absolute value of each included negative amount.
- Ignore orders and non-negative payments.
- Return `0` when there are no refunds.
- Return the total as an integer number of cents without mutating inputs, printing, raising for valid parsed records, or using global state.

## Step 6 of 6 — Build the final summary

Recommended time share: 20%

Implement `build_summary(matches, refund_total)` as the final reconciliation summary.
- Every item in `matches` is an ordinary result dictionary with exactly `order_id`, `status`, and `amount`.
- Return one ordinary dictionary with exactly `total_orders`, `matched_count`, `net_total`, and `unmatched_ids`.
- `total_orders` is the number of order results in `matches`.
- `matched_count` is the number of results whose status is exactly `matched`.
- **`net_total` is the sum of matched payment amounts minus the positive `refund_total`; this overrides the earlier rule excluding refunds.**
- `unmatched_ids` contains unmatched order IDs in ascending lexicographic order, using the already-trimmed IDs from parsed records.
- Monetary values are integer cents; do not mutate inputs, print, or use global state.
