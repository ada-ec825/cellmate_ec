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


def test_h_amount_scaling():
    assert parse_amount("0.07") == 7
    assert parse_amount("3") == 300
    assert parse_amount("3.4") == 340


def test_h_amount_negative():
    assert parse_amount("-0.01") == -1


def test_h_amount_rounding():
    assert parse_amount("0.005") == 1
    assert parse_amount("-0.005") == -1


def test_h_amount_precision():
    assert parse_amount("2.3456") is None


def test_h_amount_syntax():
    assert parse_amount("2E3") is None
    assert parse_amount("+0.50") is None
    assert parse_amount("NaN") is None


def test_h_amount_input_type():
    assert parse_amount(7) is None


def test_h_record_valid():
    assert parse_record("ORDER|A|A|0|USD|2024-12-31 23:59") == {
        "type": "ORDER",
        "record_id": "A",
        "order_id": "A",
        "amount": 0,
        "currency": "USD",
        "timestamp": datetime(2024, 12, 31, 23, 59),
    }


def test_h_record_type_case():
    assert parse_record("Order|A|A|1|USD|2024-12-31 23:59")["type"] == "ORDER"


def test_h_record_field_shape():
    assert parse_record("ORDER|A|A|1|USD|2024-12-31 23:59|extra") is None


def test_h_record_currency():
    assert parse_record("ORDER|A|A|1|usd|2024-12-31 23:59") is None


def test_h_record_timestamp():
    assert parse_record("ORDER|A|A|1|USD|2024/12/31 23:59") is None


def test_h_record_order_constraints():
    assert parse_record("ORDER|A|B|1|USD|2024-12-31 23:59") is None
    assert parse_record("ORDER|A|A|-1|USD|2024-12-31 23:59") is None


def test_h_load_invalid_rows():
    records = load_records("ORDER|A|A|1|USD|bad\nORDER|B|B|1|USD|2024-01-01 00:00")
    assert [row["record_id"] for row in records] == ["B"]


def test_h_load_first_valid_duplicate():
    records = load_records("\n".join([
        "PAYMENT|D|O|bad|USD|2024-01-01 00:00",
        "PAYMENT|D|O|3|USD|2024-01-01 00:01",
        "PAYMENT| D |O|8|USD|2024-01-01 00:02",
    ]))
    assert len(records) == 1
    assert records[0]["amount"] == 300


def test_h_load_trimmed_ids():
    records = load_records("PAYMENT| Q | Z |1|USD|2024-01-01 00:00")
    assert (records[0]["record_id"], records[0]["order_id"]) == ("Q", "Z")


def test_h_load_empty_ids():
    assert load_records("PAYMENT|Q|   |1|USD|2024-01-01 00:00") == []


def test_h_match_window_boundary():
    records = [
        _record("ORDER", "A", "A", 500, datetime(2024, 1, 1, 0, 0)),
        _record("PAYMENT", "P", "A", 500, datetime(2024, 1, 4, 0, 0)),
    ]
    assert match_payments(records) == [{"order_id": "A", "status": "matched", "amount": 500}]


def test_h_match_window_outside():
    records = [
        _record("ORDER", "A", "A", 500, datetime(2024, 1, 1, 0, 0)),
        _record("PAYMENT", "P", "A", 500, datetime(2024, 1, 4, 0, 1)),
    ]
    assert match_payments(records) == [{"order_id": "A", "status": "unmatched", "amount": 0}]


def test_h_match_candidate_order():
    records = [
        _record("ORDER", "A", "A", 500, datetime(2024, 1, 1, 0, 0)),
        _record("PAYMENT", "P1", "A", 700, datetime(2024, 1, 1, 1, 0)),
        _record("PAYMENT", "P2", "A", 800, datetime(2024, 1, 1, 1, 0)),
        _record("PAYMENT", "P0", "A", 900, datetime(2024, 1, 1, 2, 0)),
    ]
    assert match_payments(records)[0]["amount"] == 700


def test_h_match_refund_exclusion():
    records = [
        _record("ORDER", "A", "A", 500, datetime(2024, 1, 1, 0, 0)),
        _record("PAYMENT", "R", "A", -500, datetime(2024, 1, 1, 1, 0)),
    ]
    assert match_payments(records) == [{"order_id": "A", "status": "unmatched", "amount": 0}]


def test_h_refunds_sum():
    records = [
        _record("PAYMENT", "R1", "unknown", -101, datetime(2024, 1, 1, 0, 0)),
        _record("PAYMENT", "R2", "A", -200, datetime(2024, 1, 1, 1, 0)),
    ]
    assert compute_refunds(records) == 301


def test_h_refunds_empty():
    assert compute_refunds([]) == 0


def test_h_summary_schema_counts():
    result = build_summary([
        {"order_id": "A", "status": "unmatched", "amount": 0},
        {"order_id": "B", "status": "matched", "amount": 10},
        {"order_id": "C", "status": "matched", "amount": 20},
    ], 0)
    assert set(result) == {"total_orders", "matched_count", "net_total", "unmatched_ids"}
    assert (result["total_orders"], result["matched_count"]) == (3, 2)


def test_h_summary_refund_rule():
    matches = [{"order_id": "A", "status": "matched", "amount": 501}]
    assert build_summary(matches, 1)["net_total"] == 500


def test_h_summary_unmatched_order():
    matches = [
        {"order_id": "x 2", "status": "unmatched", "amount": 0},
        {"order_id": "x 10", "status": "unmatched", "amount": 0},
    ]
    assert build_summary(matches, 0)["unmatched_ids"] == ["x 10", "x 2"]


def test_h_pipeline_case():
    records = load_records("\n".join([
        "ORDER|A|A|6|USD|2024-01-01 00:00",
        "PAYMENT|P|A|6|USD|2024-01-01 00:01",
        "PAYMENT|R|other|-2|USD|2024-01-01 00:02",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "net_total": 400,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."
