from datetime import datetime

from submission import (
    build_summary,
    compute_refunds,
    load_records,
    match_payments,
    parse_amount,
    parse_record,
)


def _record(kind, record_id, order_id, amount, timestamp):
    """Construct the exact dictionary schema produced by load_records."""
    return {
        "type": kind,
        "record_id": record_id,
        "order_id": order_id,
        "amount": amount,
        "currency": "USD",
        "timestamp": timestamp,
    }


def test_amount_scaling():
    """Checks ordinary decimal-to-cent scaling."""
    assert parse_amount("12.30") == 1230
    assert parse_amount("12") == 1200
    assert parse_amount("12.3") == 1230


def test_amount_negative():
    """Checks that a leading minus sign is retained."""
    assert parse_amount("-2.50") == -250


def test_amount_rounding():
    """Checks round-half-up at the third fractional digit."""
    assert parse_amount("1.235") == 124
    assert parse_amount("-1.225") == -123


def test_amount_precision():
    """Checks rejection beyond the stated fractional precision."""
    assert parse_amount("1.2345") is None


def test_amount_syntax():
    """Checks the stated ordinary-decimal syntax."""
    assert parse_amount("1e2") is None
    assert parse_amount("+1.00") is None
    assert parse_amount("bad") is None


def test_amount_input_type():
    """Checks rejection of non-string input."""
    assert parse_amount(12.3) is None


def test_record_valid():
    """Checks the exact parsed-record schema for a valid line."""
    assert parse_record("PAYMENT|P1|O1|2.50|USD|2024-03-15 14:30") == {
        "type": "PAYMENT",
        "record_id": "P1",
        "order_id": "O1",
        "amount": 250,
        "currency": "USD",
        "timestamp": datetime(2024, 3, 15, 14, 30),
    }


def test_record_type_case():
    """Checks case-insensitive record types and uppercase storage."""
    assert parse_record("payment|P1|O1|2|USD|2024-03-15 14:30")["type"] == "PAYMENT"


def test_record_field_shape():
    """Checks the six-field record shape."""
    assert parse_record("PAYMENT|P1|O1|2|USD") is None


def test_record_currency():
    """Checks the exact accepted currency."""
    assert parse_record("PAYMENT|P1|O1|2|EUR|2024-03-15 14:30") is None


def test_record_timestamp():
    """Checks timestamp format and calendar validity."""
    assert parse_record("PAYMENT|P1|O1|2|USD|2024-02-30 14:30") is None


def test_record_order_constraints():
    """Checks constraints that apply specifically to order records."""
    assert parse_record("ORDER|O1|O2|2|USD|2024-03-15 14:30") is None
    assert parse_record("ORDER|O1|O1|-2|USD|2024-03-15 14:30") is None


def test_load_invalid_rows():
    """Checks silent filtering of malformed rows."""
    records = load_records("broken\nORDER|O1|O1|2|USD|2024-03-15 14:30")
    assert [row["record_id"] for row in records] == ["O1"]


def test_load_first_valid_duplicate():
    """Checks that the first valid occurrence owns a record ID."""
    records = load_records("\n".join([
        "PAYMENT|P1|O1|bad|USD|2024-03-15 14:30",
        "PAYMENT|P1|O1|2|USD|2024-03-15 14:31",
        "PAYMENT|P1|O1|9|USD|2024-03-15 14:32",
    ]))
    assert len(records) == 1
    assert records[0]["amount"] == 200


def test_load_trimmed_ids():
    """Checks identifier trimming before storage."""
    records = load_records("PAYMENT| P1 | O1 |2|USD|2024-03-15 14:30")
    assert (records[0]["record_id"], records[0]["order_id"]) == ("P1", "O1")


def test_load_empty_ids():
    """Checks rejection of identifiers empty after trimming."""
    assert load_records("PAYMENT|   | O1 |2|USD|2024-03-15 14:30") == []


def test_match_window_boundary():
    """Checks inclusion of the stated time-window endpoint."""
    records = [
        _record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9, 0)),
        _record("PAYMENT", "P1", "O1", 400, datetime(2024, 3, 4, 9, 0)),
    ]
    assert match_payments(records) == [{"order_id": "O1", "status": "matched", "amount": 400}]


def test_match_window_outside():
    """Checks rejection outside the stated time window."""
    records = [
        _record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9, 0)),
        _record("PAYMENT", "P1", "O1", 400, datetime(2024, 3, 4, 9, 1)),
    ]
    assert match_payments(records) == [{"order_id": "O1", "status": "unmatched", "amount": 0}]


def test_match_candidate_order():
    """Checks earliest-payment selection and retained-order tie breaking."""
    records = [
        _record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9, 0)),
        _record("PAYMENT", "P2", "O1", 500, datetime(2024, 3, 1, 10, 0)),
        _record("PAYMENT", "P1", "O1", 400, datetime(2024, 3, 1, 10, 0)),
        _record("PAYMENT", "P3", "O1", 300, datetime(2024, 3, 1, 11, 0)),
    ]
    assert match_payments(records)[0]["amount"] == 500


def test_match_refund_exclusion():
    """Checks that refunds cannot satisfy a payment match."""
    records = [
        _record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9, 0)),
        _record("PAYMENT", "R1", "O1", -400, datetime(2024, 3, 1, 10, 0)),
    ]
    assert match_payments(records) == [{"order_id": "O1", "status": "unmatched", "amount": 0}]


def test_refunds_sum():
    """Checks positive summation of all refund amounts."""
    records = [
        _record("PAYMENT", "R1", "O1", -250, datetime(2024, 3, 1, 9, 0)),
        _record("PAYMENT", "R2", "missing", -125, datetime(2024, 3, 1, 10, 0)),
    ]
    assert compute_refunds(records) == 375


def test_refunds_empty():
    """Checks the no-refund result."""
    records = [_record("PAYMENT", "P1", "O1", 200, datetime(2024, 3, 1, 9, 0))]
    assert compute_refunds(records) == 0


def test_summary_schema_counts():
    """Checks exact keys and order-status counts."""
    matches = [
        {"order_id": "O1", "status": "matched", "amount": 500},
        {"order_id": "O2", "status": "unmatched", "amount": 0},
    ]
    result = build_summary(matches, 0)
    assert set(result) == {"total_orders", "matched_count", "net_total", "unmatched_ids"}
    assert (result["total_orders"], result["matched_count"]) == (2, 1)


def test_summary_refund_rule():
    """Checks the released net-total clarification."""
    matches = [{"order_id": "O1", "status": "matched", "amount": 500}]
    assert build_summary(matches, 125)["net_total"] == 375


def test_summary_unmatched_order():
    """Checks lexicographic ordering of unmatched identifiers."""
    matches = [
        {"order_id": "x 2", "status": "unmatched", "amount": 0},
        {"order_id": "A", "status": "matched", "amount": 1},
        {"order_id": "x 10", "status": "unmatched", "amount": 0},
    ]
    assert build_summary(matches, 0)["unmatched_ids"] == ["x 10", "x 2"]


def test_pipeline_case():
    """Checks one deliberately cross-function end-to-end path."""
    records = load_records("\n".join([
        "ORDER|O1|O1|5|USD|2024-03-01 09:00",
        "PAYMENT|P1|O1|5|USD|2024-03-01 10:00",
        "PAYMENT|R1|missing|-1|USD|2024-03-01 11:00",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "net_total": 400,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."
