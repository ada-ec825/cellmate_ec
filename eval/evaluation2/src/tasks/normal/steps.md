# Project steps

Readable copy of the six project steps used in the experiment.

## Step 1 of 6 — Implement parse_amount(s)

Convert an amount string to an integer number of cents, so 12.30 becomes 1230. The input must be a string containing only digits and at most one decimal point, with an optional leading minus sign; scientific notation and every other numeric notation are invalid. One or two fractional digits are scaled normally. A third fractional digit is rounded to cents using round-half-up, including for negative values; more than three fractional digits is invalid. Return None for malformed, non-string, or non-finite input. Negative amounts remain negative at this stage because a negative PAYMENT represents a refund, while a negative ORDER is rejected in the next step.

## Step 2 of 6 — Implement parse_record(line)

Parse one line containing exactly six | separated fields in this order: TYPE, RECORD_ID, ORDER_ID, AMOUNT, CURRENCY, TIMESTAMP. TYPE is case-insensitive ORDER or PAYMENT and is stored uppercase. Trim both identifiers and reject the line if either becomes empty. An ORDER requires equal record and order IDs and cannot have a negative amount; a negative PAYMENT is valid. Apply all parse_amount rules to AMOUNT. CURRENCY must be exactly USD after trimming. TIMESTAMP must use the exact format 2024-03-15 14:30 and represents UTC without conversion. Return None for any invalid field without raising or printing. Otherwise return an ordinary dictionary, never a tuple, with exactly type, record_id, order_id, amount, currency, and timestamp. Read fields by key name, for example record["type"]. amount is integer cents and timestamp is a naive Python datetime.

## Step 3 of 6 — Implement load_records(text)

Parse the input one line at a time with parse_record and preserve retained source order. Silently skip every invalid line. Compare record IDs after trimming. For a repeated record ID, retain the first valid occurrence and skip later valid occurrences; an invalid occurrence does not reserve that ID. Return an empty list for non-string or empty input. Do not mutate inputs, print output, or store global state.

## Step 4 of 6 — Implement compute_refunds(records)

A refund is any PAYMENT record whose integer-cent amount is negative. Return the positive sum of the absolute amounts of all refunds. A refund counts even when no order has the same order ID. Non-negative payments and ORDER records contribute nothing, and no refund returns 0. Do not mutate records or store global state.

## Step 5 of 6 — Implement match_payments(records)

Produce one result for every ORDER, following retained order-record order. Associate non-negative PAYMENT records by order_id. A payment qualifies only when its timestamp is at or after the order timestamp and no later than exactly 72 hours afterward; both endpoints are included. If several payments qualify, choose the earliest timestamp and break an exact timestamp tie by retained source order. Negative payments are refunds and never match. Each result is an ordinary dictionary, never a tuple, with exactly order_id, status, and amount. Read fields by key name, for example result["order_id"]. Status is exactly lowercase matched or unmatched. A matched result uses the chosen payment amount; an unmatched result uses amount 0.

## Step 6 of 6 — Implement build_summary(matches, refund_total)

Every item in matches is the result dictionary from Step 5, never a tuple; read order_id, status, and amount by their exact key names. Return a dictionary with exactly four keys. total_orders is len(matches). matched_count counts results whose status is exactly lowercase matched. net_total follows the released rule: sum the amounts of matched results and subtract the positive refund_total; this overrides the earlier draft that excluded refunds. unmatched_ids contains the already-trimmed order_id from every result whose status is exactly lowercase unmatched, sorted in ascending lexicographic order. With empty matches, the counts are 0, unmatched_ids is empty, and net_total still subtracts refund_total.
