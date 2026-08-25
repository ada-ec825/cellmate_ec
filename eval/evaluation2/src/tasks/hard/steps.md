# Project steps

## Step 1 of 6 — Implement `parse_amount(s)`

Convert an amount string to integer cents. Allow digits, at most one decimal point, and an optional leading minus sign; negative values remain negative for refunds. Reject scientific notation. Accept at most three fractional digits and round a third digit with round-half-up (`"0.005"` becomes `1`; `"-0.005"` becomes `-1`). After conversion, reject `abs(cents) > 1,000,000`. Return `None` silently for malformed or non-string input.

## Step 2 of 6 — Implement `parse_record(line)`

Parse exactly `TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP`. Type is case-insensitive `ORDER` or `PAYMENT` and stored uppercase. Trim both non-empty IDs; every order ID must start with exact prefix `ORD-`. Use `parse_amount`; negative orders are invalid, while negative payments are valid refunds. Currency must be `USD`. Accept exactly `YYYY-MM-DD HH:MM` or `YYYY-MM-DD HH:MM:SS` with valid values: attempt the minute format, then the seconds format. Return exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`, or `None` silently.

## Step 3 of 6 — Implement `load_records(text)`

Parse each line with `parse_record`, silently skip invalid rows, and preserve input order. For duplicate trimmed record IDs, keep the first valid occurrence; an invalid occurrence does not reserve the ID. Empty or non-string input returns an empty list.

## Step 4 of 6 — Implement `compute_refunds(records)`

A refund is a negative `PAYMENT`. Count it only when its `order_id` belongs to at least one existing `ORDER`. Return the positive sum of qualifying refund amounts, or `0`. Do not mutate records.

## Step 5 of 6 — Implement `match_payments(records)`

Return one result per order in order-record order. A non-negative payment qualifies when the order ID matches and its time is at or after the order time but **strictly less than 72 hours later**; exactly 72 hours is outside the released window. Choose the earliest qualifying payment and retain source order for a timestamp tie. Refunds never match. Return exactly `order_id`, `status`, and `amount`, using lowercase `matched` or `unmatched`; unmatched amount is `0`.

## Step 6 of 6 — Implement `build_summary(matches, refund_total)`

Return exactly `total_orders`, `matched_count`, `refund_total`, `net_total`, and `unmatched_ids`. Count lowercase `matched` results. `net_total` is matched amounts minus the positive refund total, but report `0` rather than a negative value. Deduplicate unmatched order IDs and sort them lexicographically.
