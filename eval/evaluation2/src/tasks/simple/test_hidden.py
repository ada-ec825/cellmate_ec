from datetime import datetime

from submission import build_summary, compute_refunds, load_records, match_payments, parse_amount, parse_record


def _record(kind, record_id, order_id, amount, timestamp):
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "timestamp": timestamp}


def test_h_amount_scaling():
    assert parse_amount("0.07") == 7
    assert parse_amount("3.4") == 340


def test_h_amount_negative():
    assert parse_amount("-0.01") == -1


def test_h_amount_invalid():
    assert parse_amount("NaN") is None
    assert parse_amount([]) is None


def test_h_record_valid():
    assert parse_record("ORDER|A|A|0|2024-12-31 23:59") == {
        "type": "ORDER", "record_id": "A", "order_id": "A", "amount": 0,
        "timestamp": datetime(2024, 12, 31, 23, 59),
    }


def test_h_record_type_case():
    assert parse_record("payment|P|A|1.00|2024-12-31 23:59")["type"] == "PAYMENT"


def test_h_record_field_shape():
    assert parse_record("ORDER|A|A|1.00|2024-12-31 23:59|extra") is None


def test_h_record_timestamp():
    assert parse_record("ORDER|A|A|1.00|2024-13-31 23:59") is None


def test_h_record_order_id():
    assert parse_record("ORDER|A|B|1.00|2024-12-31 23:59") is None


def test_h_record_negative_order():
    assert parse_record("ORDER|A|A|-0.01|2024-12-31 23:59") is None


def test_h_record_ids():
    assert parse_record("PAYMENT|   |A|1.00|2024-01-01 00:00") is None
    assert parse_record("PAYMENT|P|   |1.00|2024-01-01 00:00") is None
    assert parse_record("PAYMENT| P | A |1.00|2024-01-01 00:00")["order_id"] == "A"


def test_h_load_invalid_rows():
    assert [row["record_id"] for row in load_records("bad\nORDER|B|B|1.00|2024-01-01 00:00")] == ["B"]


def test_h_match_window_boundary():
    records = [_record("ORDER", "A", "A", 500, datetime(2024, 1, 1)), _record("PAYMENT", "P", "A", 500, datetime(2024, 1, 4))]
    assert str(match_payments(records)[0]["status"]).lower() == "matched"


def test_h_match_window_outside():
    records = [_record("ORDER", "A", "A", 500, datetime(2024, 1, 1)), _record("PAYMENT", "P", "A", 500, datetime(2024, 1, 4, 0, 1))]
    assert str(match_payments(records)[0]["status"]).lower() == "unmatched"


def test_h_match_candidate_order():
    early_then_late = [
        _record("ORDER", "A", "A", 500, datetime(2024, 1, 1)),
        _record("PAYMENT", "P1", "A", 700, datetime(2024, 1, 1, 1)),
        _record("PAYMENT", "P2", "A", 800, datetime(2024, 1, 1, 2)),
    ]
    late_then_early = [early_then_late[0], early_then_late[2], early_then_late[1]]
    assert match_payments(early_then_late)[0]["amount"] == 700
    assert match_payments(late_then_early)[0]["amount"] == 700


def test_h_match_refund_exclusion():
    records = [_record("ORDER", "A", "A", 500, datetime(2024, 1, 1)), _record("PAYMENT", "R", "A", -500, datetime(2024, 1, 1, 1))]
    assert match_payments(records)[0]["amount"] == 0


def test_h_refunds_sum():
    records = [_record("PAYMENT", "R", "unknown", -101, datetime(2024, 1, 1))]
    assert compute_refunds(records) == 101


def test_h_refunds_empty():
    assert compute_refunds([_record("PAYMENT", "P", "A", 10, datetime(2024, 1, 1))]) == 0


def test_h_summary_schema_counts():
    result = build_summary([{"order_id": "A", "status": "matched", "amount": 10}], 0)
    assert set(result) == {"total_orders", "matched_count", "net_total", "unmatched_ids"}
    assert (result["total_orders"], result["matched_count"]) == (1, 1)


def test_h_summary_refund_rule():
    assert build_summary([{"order_id": "A", "status": "matched", "amount": 501}], 1)["net_total"] == 500


def test_h_summary_status_case():
    assert build_summary([{"order_id": "A", "status": "MaTcHeD", "amount": 1}], 0)["matched_count"] == 1


def test_h_summary_unmatched_order():
    matches = [{"order_id": "z", "status": "UNMATCHED", "amount": 0}, {"order_id": "a", "status": "unmatched", "amount": 0}]
    assert build_summary(matches, 0)["unmatched_ids"] == ["a", "z"]


def test_h_pipeline_case():
    records = load_records("\n".join([
        "ORDER|A|A|6|2024-01-01 00:00",
        "PAYMENT|P|A|6|2024-01-01 00:01",
        "PAYMENT|R|other|-2|2024-01-01 00:02",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "net_total": 400,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."
