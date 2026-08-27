## Step 1 of 6 — Parse monetary amounts

Implement `parse_amount(s)` for exact integer-cent monetary values.
- Accept digits with at most one decimal point and an optional leading minus sign.
- Reject empty, malformed, scientific-notation, and other nonconforming amounts by returning `None`.
- Accept at most three fractional digits; round a third fractional digit to cents using **round-half-up**.
- Preserve a negative result; negative values represent refunds when used for payments.
- Apply the absolute-value limit after conversion to cents: amounts above `1,000,000` cents are invalid and return `None`.
- Return the amount as an integer number of cents.
- Do not print, raise for bad input, mutate inputs, or use global state.

## Step 2 of 6 — Parse individual records

Implement `parse_record(line)` for one complete input row.
- The row must contain exactly six `|`-separated fields in this order: `TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP`.
- `TYPE` is case-insensitive `ORDER` or `PAYMENT` and is returned uppercase.
- Trim `RECORD_ID` and `ORDER_ID`; both must remain non-empty, and every `ORDER_ID` must start with exact prefix `ORD-`.
- Accept only currency `USD`.
- Parse the amount with `parse_amount(s)`; negative orders are invalid.
- Accept timestamps only in `YYYY-MM-DD HH:MM` or `YYYY-MM-DD HH:MM:SS`, with valid calendar values; represent them as values suitable for chronological comparison.
- Return a dictionary with exactly `type`, `record_id`, `order_id`, `amount`, `currency`, and `timestamp`, or return `None` for any invalid row.
- **Bad input is silently rejected: never raise or print.** Do not mutate input or use global state.

## Step 3 of 6 — Load valid records

Implement `load_records(text)` to create the retained record collection.
- Treat each input line as a possible `TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP` record and validate it through `parse_record(line)`.
- Silently skip every invalid row; never raise or print for bad input.
- Preserve the input order of valid records.
- `RECORD_ID` and `ORDER_ID` are already trimmed and validated by parsing; records must contain integer cents and only `USD`.
- For duplicate record IDs, keep the first valid occurrence; an invalid occurrence does not block a later valid one.
- Return all retained record dictionaries in retained input order.
- Do not mutate input objects or store global state.

## Step 4 of 6 — Compute qualifying refunds

Implement `compute_refunds(records)` and return the refund total in integer cents.
- Consider only retained `USD` payment records whose amounts are negative; negative payments are refunds.
- A refund qualifies only when its `order_id` belongs to an existing order in `records`.
- Exclude negative payments for unknown order IDs and exclude orders from the refund total.
- Return the positive sum of the absolute values of all qualifying negative payment amounts.
- Records use integer cents, and invalid records are not part of the input collection.
- Do not mutate input objects, print, raise for bad input, or use global state.

## Step 5 of 6 — Match payments to orders

Implement `match_payments(records)` with one result for every retained order, in retained order-record order.
- A non-refund payment qualifies for an order only when its `order_id` matches and its timestamp is from the order timestamp through **strictly less than 72 hours after** that timestamp; the order timestamp itself is included, and exactly 72 hours later is excluded.
- Refunds never match.
- If several payments qualify, choose the earliest payment timestamp; for an exact timestamp tie, choose the payment with earlier retained source order.
- Each result has exactly `order_id`, `status`, and `amount`.
- Use lowercase status `matched` with the selected payment's integer-cent amount, or lowercase status `unmatched` with amount `0`.
- Records are valid retained `USD` records with integer-cent amounts; do not mutate them, print, raise, or use global state.

## Step 6 of 6 — Build the final summary

Implement `build_summary(matches, refund_total)` with exactly five keys: `total_orders`, `matched_count`, `refund_total`, `net_total`, and `unmatched_ids`.
- `total_orders` is the number of results in `matches`.
- `matched_count` counts only results whose status is exactly lowercase `matched`.
- `refund_total` is the supplied positive integer-cent refund total.
- `net_total` is matched payment amounts minus `refund_total`, reported as `0` when that calculation is below zero.
- `unmatched_ids` contains a deduplicated ascending lexicographic list of order IDs from results whose status is exactly lowercase `unmatched`.
- Keep all amounts as integer cents; do not mutate `matches`, print, raise for ordinary input, or use global state.
