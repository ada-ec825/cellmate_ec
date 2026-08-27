# Detailed Order and Payment Reconciliation

## Part 1 of 5 — Background and global conventions

Implement a reconciliation tool for an e-commerce settlement team. These rules apply throughout the tool:

- Store every amount as integer cents and process only `USD` records.
- Silently skip invalid records; never raise or print for bad input.
- An amount whose absolute value exceeds `1,000,000` cents (`$10,000.00`) is invalid.
- A timestamp may use either `YYYY-MM-DD HH:MM` or `YYYY-MM-DD HH:MM:SS`, with valid calendar values. Other formats are invalid.
- Trim both identifiers. Every `ORDER_ID` must start with the exact prefix `ORD-`.

## Part 2 of 5 — Data and release-wide rules

Each line has six `|`-separated fields:

```text
TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP
```

`TYPE` is case-insensitive `ORDER` or `PAYMENT` and is stored uppercase. IDs must remain non-empty after trimming. Amounts contain digits and at most one decimal point, with an optional leading minus sign. Scientific notation is invalid. At most three fractional digits are accepted; round a third digit to cents using round-half-up. Negative orders are invalid and negative payments are refunds. Duplicate record IDs keep the first valid occurrence.

Only refunds whose `order_id` belongs to an existing order count toward the refund total. Final unmatched order IDs must be unique. Final `net_total` cannot be negative and is reported as `0` when the calculation is below zero. The final summary includes a key named exactly `refund_total`.

## Part 3 of 5 — Summary report and payment matching

`build_summary(matches, refund_total)` returns exactly five keys: `total_orders`, `matched_count`, `refund_total`, `net_total`, and `unmatched_ids`. Count results whose status is exactly lowercase `matched`. `net_total` is matched payment amounts minus `refund_total`, with the zero lower bound stated earlier. `unmatched_ids` is a deduplicated ascending lexicographic list.

`match_payments(records)` returns one result per order in retained order-record order. A non-refund payment initially qualifies from the order timestamp through exactly 72 hours later, subject to the release clarification in Part 5. If several qualify, choose the earliest timestamp and break an exact tie by retained source order. Refunds never match. Each result has exactly `order_id`, `status`, and `amount`; status is lowercase `matched` or `unmatched`, and unmatched amount is `0`.

## Part 4 of 5 — Parsing, loading, and refunds

`parse_amount(s)` applies all amount syntax, rounding, and limit rules; negative values remain negative because payment refunds need them. Apply the `1,000,000` limit after conversion to cents. `parse_record(line)` applies the six-field format, ID, currency, timestamp, and negative-order rules and returns a dictionary with exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`, or `None`. `load_records(text)` silently skips invalid rows, preserves input order, and keeps the first valid duplicate record ID. `compute_refunds(records)` returns the positive sum of qualifying negative payment amounts under the existing-order rule.

Functions do not mutate input objects or store global state.

## Part 5 of 5 — Release clarification

The released matching window changes the endpoint stated in Part 3: a payment must occur **strictly less than 72 hours** after the order. A payment at exactly 72 hours is outside the window. The order timestamp itself remains included. No other rule changes.
