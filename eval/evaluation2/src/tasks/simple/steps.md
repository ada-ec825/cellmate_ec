## Step 1 of 6 — Parse monetary amounts

Implement `parse_amount(s)` so decimal text becomes integer cents.
- Accept string inputs in ordinary decimal notation with at most two fractional digits.
- Store and return every amount as an integer number of cents: `12.30` becomes 1230, `3` becomes 300, and `-2.00` becomes -200.
- **Return `None` for every malformed or non-string input.**
- Do not raise an exception or print anything for invalid input.

## Step 2 of 6 — Parse individual records

Implement `parse_record(line)` to validate one record line and produce its specified dictionary.
- The line must have exactly five `|`-separated fields: `TYPE|RECORD_ID|ORDER_ID|AMOUNT|TIMESTAMP`.
- `TYPE` must be `ORDER` or `PAYMENT`, matched case-insensitively and stored uppercase.
- Trim both identifiers; reject the row if either is empty. For an `ORDER`, `RECORD_ID` and `ORDER_ID` must be equal.
- Parse `AMOUNT` with `parse_amount`; a negative order is invalid, while a negative payment is a refund. Amounts are integer cents.
- `TIMESTAMP` must use `YYYY-MM-DD HH:MM` and be stored as a naive `datetime`.
- **Return `None` silently for every invalid row, without raising or printing.**
- A valid row returns an ordinary dictionary with exactly `type`, `record_id`, `order_id`, `amount`, and `timestamp`.

## Step 3 of 6 — Load records in order

Implement `load_records(text)` to create the ordered collection of valid parsed records.
- A non-string or empty `text` returns an empty list.
- Parse each line with `parse_record`.
- **Silently skip invalid rows** and preserve the source order of all valid rows.
- Each accepted item is the dictionary returned by `parse_record`, with integer-cent amounts and a naive `datetime` timestamp.
- Record IDs are unique in the input.
- Do not mutate the input and do not store global state.

## Step 4 of 6 — Compute refund totals

Implement `compute_refunds(records)` to total all refunds in parsed records.
- A refund is a record whose `type` is `PAYMENT` and whose amount is a negative integer number of cents.
- Return the positive sum of the absolute values of all refunds.
- **Count a refund even when no order has the same `order_id`.**
- Return `0` when there are no refunds.

## Step 5 of 6 — Match payments to orders

Implement `match_payments(records)` to produce reconciliation results for parsed records.
- Produce one result for every `ORDER`, following order-record source order.
- Associate only non-negative `PAYMENT` records by `order_id`; refunds never match.
- A payment qualifies only when its timestamp is at or after the order timestamp and no later than exactly 72 hours afterward; both endpoints are included.
- If several payments qualify, choose the earliest timestamp and retain source order for an exact timestamp tie.
- Each result is a dictionary with exactly `order_id`, `status`, and `amount`.
- Status must communicate `matched` or `unmatched`, with no case requirement.
- A matched result uses the chosen payment amount; an unmatched result uses amount `0`. All amounts are integer cents.

## Step 6 of 6 — Build the summary

Implement `build_summary(matches, refund_total)` to return the final reconciliation summary.
- Return exactly four keys: `total_orders`, `matched_count`, `net_total`, and `unmatched_ids`.
- Interpret each status case-insensitively.
- `total_orders` is the number of results in `matches`.
- `matched_count` counts results whose status is matched.
- `net_total` is the sum of matched amounts minus `refund_total`; amounts are integer cents.
- `unmatched_ids` contains unmatched order IDs in ascending lexicographic order.
