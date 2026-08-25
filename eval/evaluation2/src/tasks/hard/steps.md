# Project steps

## Step 1 of 6 — Implement `parse_amount(s)`

Convert an amount string to integer cents. The input must contain only digits and at most one decimal point, with an optional leading minus sign; scientific notation and every other numeric notation are invalid, so a leading `+` is rejected. Negative values remain negative for refunds. One or two fractional digits are scaled normally; a third fractional digit is rounded to cents with round-half-up (`"0.005"` becomes `1`; `"-0.005"` becomes `-1`), and more than three fractional digits is invalid. After conversion, reject `abs(cents) > 1,000,000`. Return `None` silently for malformed or non-string input.

## Step 2 of 6 — Implement `parse_record(line)`

Parse exactly `TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP`. Type is case-insensitive `ORDER` or `PAYMENT` and stored uppercase. Trim both non-empty IDs; every order ID must start with exact prefix `ORD-`. Use `parse_amount`; negative orders are invalid, while negative payments are valid refunds. Currency must be exactly `USD` after trimming. Accept exactly `YYYY-MM-DD HH:MM` or `YYYY-MM-DD HH:MM:SS` with valid values: attempt the minute format, then the seconds format. Otherwise return an ordinary dictionary, with exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`; return `None` silently for anything invalid.

## Step 3 of 6 — Implement `load_records(text)`

Parse each line with `parse_record`, silently skip invalid rows, and preserve input order. For duplicate trimmed record IDs, keep the first valid occurrence; an invalid occurrence does not reserve the ID. Empty or non-string input returns an empty list.

## Step 4 of 6 — Implement `compute_refunds(records)`

A refund is a negative `PAYMENT`. Count it only when its `order_id` belongs to at least one existing `ORDER`. Return the positive sum of qualifying refund amounts, or `0`. Do not mutate records.

## Step 5 of 6 — Implement `match_payments(records)`

Return one result per order in order-record order. A non-negative payment qualifies when the order ID matches and its time is at or after the order time but **strictly less than 72 hours later**; exactly 72 hours is outside the released window. Choose the earliest qualifying payment and retain source order for a timestamp tie. Refunds never match. Each result is an ordinary dictionary, with exactly `order_id`, `status`, and `amount`; read fields by key name. Status is lowercase `matched` or `unmatched`. A matched result uses the chosen payment amount; an unmatched result uses amount `0`.

## Step 6 of 6 — Implement `build_summary(matches, refund_total)`

Every item in `matches` is the result dictionary from Step 5; read `order_id`, `status`, and `amount` by their exact key names. Return a dictionary with exactly `total_orders`, `matched_count`, `refund_total`, `net_total`, and `unmatched_ids`. `total_orders` is `len(matches)`, counting every result including repeated order IDs. Count lowercase `matched` results. `net_total` is matched amounts minus the positive refund total, but report `0` rather than a negative value. Deduplicate unmatched order IDs and sort them lexicographically.
