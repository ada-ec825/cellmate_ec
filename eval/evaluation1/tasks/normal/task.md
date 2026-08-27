<!-- prompt:problem_description -->
# Order and Payment Reconciliation Tool

Implement a small reconciliation tool for an e-commerce settlement team. Each day, the team exports one mixed text file containing both order and payment records. The tool parses the file, matches payments to orders, and produces a summary.

The following conventions apply everywhere:

- Store and calculate every monetary amount internally as an integer number of cents. For example, `"12.30"` becomes `1230`.
- Silently skip records that cannot be parsed or do not satisfy the format. Do not raise an exception and do not print a warning.
- Process only records whose currency is exactly `USD` after surrounding whitespace is removed. Treat every other currency as invalid.
- Treat every timestamp as UTC. Do not perform timezone conversion.


The input contains one record per line. Every line has exactly six fields separated by `|`:

```text
TYPE|RECORD_ID|ORDER_ID|AMOUNT|CURRENCY|TIMESTAMP
```

- `TYPE` is `ORDER` or `PAYMENT`, matched without regard to case and normalised to uppercase.
- Trim surrounding whitespace from both identifiers. Both must then be non-empty. For an `ORDER`, `RECORD_ID` and `ORDER_ID` must be equal.
- `AMOUNT` is an ordinary decimal string with at most three fractional digits. It may contain only digits and at most one decimal point, with an optional leading minus sign; scientific notation and every other numeric notation are invalid. Round a third fractional digit to cents using round-half-up; more than three fractional digits is invalid. A negative `PAYMENT` is a refund. A negative `ORDER` is invalid.
- `TIMESTAMP` must have the exact format `2024-03-15 14:30`. Invalid calendar values or other formats are invalid.
- If the same trimmed `RECORD_ID` occurs more than once, retain the first valid occurrence and skip later occurrences.

A parsed record is an ordinary dictionary, never a tuple. It has exactly the keys `"type"`, `"record_id"`, `"order_id"`, `"amount"`, `"currency"`, and `"timestamp"`; fields are read by those key names, for example `record["type"]`. `amount` is integer cents, `currency` is `"USD"`, and `timestamp` is a naive Python `datetime` representing UTC.


`build_summary(matches, refund_total)` returns one dictionary with exactly four keys:

- `"total_orders"`: number of valid orders;
- `"matched_count"`: number of results whose status is matched;
- `"net_total"`: sum of the amounts of matched payments, in cents, not including refunds under the initial rule in this part; and
- `"unmatched_ids"`: unmatched order IDs in ascending lexicographic order.

Every item in `matches` is the result dictionary specified in Part 4, not a tuple. The exact key spellings and the lowercase status value described later are part of the contract. A release clarification in Part 6 may override one detail in this initial rule.


`match_payments(records)` associates payments with orders by `order_id`.

- A non-refund payment qualifies only when its timestamp is at or after the order timestamp and no later than exactly 72 hours after it. Both endpoints are included.
- If several payments qualify, use the one with the earliest timestamp. Break an exact timestamp tie by retained source order.
- Negative payments are refunds and never qualify as matched payments.
- Return one result for every order, following retained order-record order. Each result is an ordinary dictionary, never a tuple, with exactly `"order_id"`, `"status"`, and `"amount"`. Read these fields by key name, for example `result["order_id"]`. Status is exactly lowercase `"matched"` or `"unmatched"`. An unmatched result has amount `0`.


- `parse_amount(s)` returns integer cents for a valid amount string and `None` otherwise. It follows the syntax, precision, and round-half-up rules in Part 2. A non-string input is invalid and returns `None`.
- `parse_record(line)` returns the exact parsed-record dictionary described in Part 2, or `None` when any field is invalid.
- `load_records(text)` parses all lines, silently skips invalid lines, and applies the first-valid-record duplicate rule. An invalid occurrence does not reserve its record ID.
- `compute_refunds(records)` returns the positive sum, in cents, of the absolute values of all negative `PAYMENT` amounts. A refund counts even if no order with its `order_id` exists.

None of these functions mutates an input object, prints output, or stores global state.

The released calculation changes one sentence in Part 3: `net_total` must subtract `refund_total`. It is therefore the sum of matched payment amounts minus the positive refund total. This clarification overrides only the earlier statement that refunds were not included.

After trimming, an empty record ID is invalid. The order IDs placed in `unmatched_ids` are the same already-trimmed IDs stored in parsed records.
