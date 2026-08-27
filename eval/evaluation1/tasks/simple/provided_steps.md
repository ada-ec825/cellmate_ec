# Project steps

## Step 1 of 6 — Implement `parse_amount(s)`

Convert an ordinary decimal amount string to integer cents: `"12.30"` becomes `1230`, `"3"` becomes `300`, and `"-2.00"` becomes `-200`. Inputs use at most two fractional digits. Return `None` for malformed or non-string input without raising or printing. Preserve negative values because a negative `PAYMENT` represents a refund; negative orders are rejected in Step 2.

## Step 2 of 6 — Implement `parse_record(line)`

Parse exactly five `|`-separated fields: `TYPE|RECORD_ID|ORDER_ID|AMOUNT|TIMESTAMP`. Type is case-insensitive `ORDER` or `PAYMENT` and is stored uppercase. Trim both identifiers and reject an empty result. For an order, record ID and order ID must be equal. Record IDs are unique. Use `parse_amount`; reject a negative order but retain a negative payment. Parse `YYYY-MM-DD HH:MM` into a naive `datetime`. Return `None` silently for any invalid field. Otherwise return a dictionary with exactly `type`, `record_id`, `order_id`, `amount`, and `timestamp`.

## Step 3 of 6 — Implement `load_records(text)`

Parse each line with `parse_record`, silently skip every invalid row, and preserve source order. Return an empty list for empty or non-string input. Do not mutate inputs, print, or store global state.

## Step 4 of 6 — Implement `compute_refunds(records)`

A refund is a `PAYMENT` with a negative integer-cent amount. Return the positive sum of the absolute values of all refunds. A refund counts even without a matching order. Non-negative payments and orders contribute nothing. Return `0` when there are no refunds and do not mutate records.

## Step 5 of 6 — Implement `match_payments(records)`

Produce one result for every `ORDER` in order-record source order. Associate non-negative payments by `order_id`. A payment qualifies from the order timestamp through exactly 72 hours later, including both endpoints. If several qualify, choose the earliest timestamp and retain source order for a tie. Refunds never match. Return a dictionary per order with exactly `order_id`, `status`, and `amount`. Status may use any capitalization of `matched` or `unmatched`. A matched result uses the selected payment amount; an unmatched result uses `0`.

## Step 6 of 6 — Implement `build_summary(matches, refund_total)`

Read every result dictionary by the keys `order_id`, `status`, and `amount`, interpreting status case-insensitively. Return exactly `total_orders`, `matched_count`, `net_total`, and `unmatched_ids`. `total_orders` is `len(matches)`. Count matched results. Sum their amounts and subtract `refund_total` for `net_total`. Sort unmatched order IDs in ascending lexicographic order. Empty matches gives zero counts and an empty ID list.
