from datetime import datetime

from submission import build_summary, compute_refunds, load_records, match_payments, parse_amount, parse_record


def _record(kind, record_id, order_id, amount, timestamp):
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "currency": "USD", "timestamp": timestamp}


def test_h_amount_storage():
    assert parse_amount("0.07") == 7
    assert parse_amount("3") == 300


def test_h_amount_rounding():
    assert parse_amount("2.345") == 235
    assert parse_amount("-2.345") == -235


def test_h_amount_limit():
    assert parse_amount("-10000.00") == -1_000_000
    assert parse_amount("-10000.01") is None


def test_h_amount_syntax():
    assert parse_amount("+1.00") is None
    assert parse_amount("NaN") is None


def test_h_record_schema():
    row = parse_record("Order| O | ORD-Z |0.50|USD|2024-12-31 23:59")
    assert row == {"type": "ORDER", "record_id": "O", "order_id": "ORD-Z", "amount": 50, "currency": "USD", "timestamp": datetime(2024, 12, 31, 23, 59)}


def test_h_record_currency():
    assert parse_record("ORDER|O|ORD-O|1.00|usd|2024-01-01 00:00") is None


def test_h_record_timestamp():
    row = parse_record("PAYMENT|P|ORD-O|1.00|USD|2024-01-01 00:00:01")
    assert row["timestamp"] == datetime(2024, 1, 1, 0, 0, 1)
    assert parse_record("PAYMENT|Q|ORD-O|1.00|USD|2024-01-01T00:00:01") is None


def test_h_record_order_id():
    assert parse_record("ORDER|O|ord-O|1.00|USD|2024-01-01 00:00") is None


def test_h_record_negative_order():
    assert parse_record("ORDER|O|ORD-O|-0.01|USD|2024-01-01 00:00") is None


def test_h_record_refund():
    row = parse_record("PAYMENT|R|ORD-O|-0.50|USD|2024-01-01 00:00:01")
    assert row is not None and row["amount"] == -50


def test_h_load_invalid():
    assert [row["record_id"] for row in load_records("bad\nORDER|O|ORD-O|1.00|USD|2024-01-01 00:00")] == ["O"]


def test_h_load_duplicate():
    rows = load_records("PAYMENT|X|ORD-O|bad|USD|2024-01-01 00:00\nPAYMENT|X|ORD-O|2.00|USD|2024-01-01 00:01\nPAYMENT| X |ORD-O|3.00|USD|2024-01-01 00:02")
    assert len(rows) == 1 and rows[0]["amount"] == 200


def test_h_refund_order_rule():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "R", "ORD-X", -50, datetime(2024, 1, 1))]
    assert compute_refunds(rows) == 0


def test_h_match_window_boundary():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "P", "ORD-O", 9, datetime(2024, 1, 4))]
    assert match_payments(rows)[0]["status"] == "unmatched"


def test_h_match_window_inside():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "P", "ORD-O", 9, datetime(2024, 1, 3, 23, 59))]
    assert match_payments(rows)[0]["amount"] == 9


def test_h_match_candidate_order():
    rows = [
        _record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)),
        _record("PAYMENT", "P1", "ORD-O", 11, datetime(2024, 1, 1, 1)),
        _record("PAYMENT", "P2", "ORD-O", 22, datetime(2024, 1, 1, 1)),
    ]
    assert match_payments(rows)[0]["amount"] == 11


def test_h_match_refund_exclusion():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "R", "ORD-O", -1, datetime(2024, 1, 1))]
    assert match_payments(rows)[0] == {"order_id": "ORD-O", "status": "unmatched", "amount": 0}


def test_h_summary_schema():
    assert set(build_summary([], 9)) == {"total_orders", "matched_count", "refund_total", "net_total", "unmatched_ids"}


def test_h_summary_values():
    matches = [{"order_id": "ORD-O", "status": "matched", "amount": 501}]
    result = build_summary(matches, 1)
    assert (result["refund_total"], result["net_total"]) == (1, 500)


def test_h_summary_floor():
    assert build_summary([], 1)["net_total"] == 0


def test_h_summary_unique():
    matches = [{"order_id": "ORD-Z", "status": "unmatched", "amount": 0}, {"order_id": "ORD-Z", "status": "unmatched", "amount": 0}]
    assert build_summary(matches, 0)["unmatched_ids"] == ["ORD-Z"]


def test_h_pipeline_case():
    records = load_records("\n".join([
        "ORDER|O|ORD-O|2.00|USD|2024-01-01 00:00:00",
        "PAYMENT|P|ORD-O|2.00|USD|2024-01-01 00:01",
        "PAYMENT|R|ORD-O|-0.50|USD|2024-01-01 00:02",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "refund_total": 50,
        "net_total": 150,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."
