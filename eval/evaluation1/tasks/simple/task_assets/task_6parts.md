# Simple Order and Payment Reconciliation

## Part 1 of 6 — Amounts

Implement `parse_amount(s)`. Store and calculate every amount as an integer number of cents: `"12.30"` becomes `1230`, `"3"` becomes `300`, and `"-2.00"` becomes `-200`. Inputs use ordinary decimal notation with at most two fractional digits. Return `None` for malformed or non-string input without raising or printing.

## Part 2 of 6 — Records

Implement `parse_record(line)`. Every line has exactly five `|`-separated fields:

```text
TYPE|RECORD_ID|ORDER_ID|AMOUNT|TIMESTAMP
```

`TYPE` is `ORDER` or `PAYMENT`, matched case-insensitively and stored uppercase. Trim both identifiers and reject the row if either becomes empty. For an `ORDER`, `RECORD_ID` and `ORDER_ID` must be equal. Record IDs are unique in the input. Parse `AMOUNT` with `parse_amount`; a negative order is invalid, while a negative payment is a refund. `TIMESTAMP` uses `YYYY-MM-DD HH:MM` and is stored as a naive `datetime`.

Return an ordinary dictionary with exactly `type`, `record_id`, `order_id`, `amount`, and `timestamp`, or `None` for any invalid row. Invalid rows are handled silently.

## Part 3 of 6 — Loading

Implement `load_records(text)`. Parse each line with `parse_record`, silently skip invalid rows, and preserve source order. Empty or non-string input returns an empty list. Do not mutate inputs or store global state.

## Part 4 of 6 — Refunds

Implement `compute_refunds(records)`. A refund is a `PAYMENT` with a negative integer-cent amount. Return the positive sum of the absolute values of all refunds. A refund counts even when no order has the same order ID. Return `0` when there are no refunds.

## Part 5 of 6 — Matching

Implement `match_payments(records)`. Produce one result for every `ORDER`, following order-record source order. Associate non-negative payments by `order_id`. A payment qualifies only when its timestamp is at or after the order timestamp and no later than exactly 72 hours afterward; both endpoints are included. If several payments qualify, choose the earliest timestamp and retain source order for an exact tie. Refunds never match.

Each result is a dictionary with exactly `order_id`, `status`, and `amount`. Status communicates `matched` or `unmatched` without a case requirement. A matched result uses the chosen payment amount; an unmatched result uses amount `0`.

## Part 6 of 6 — Summary

Implement `build_summary(matches, refund_total)`. Return exactly four keys: `total_orders`, `matched_count`, `net_total`, and `unmatched_ids`. Interpret each status case-insensitively. `total_orders` is the number of results, `matched_count` counts matched results, and `net_total` is the sum of matched amounts minus `refund_total`. `unmatched_ids` contains unmatched order IDs in ascending lexicographic order.
