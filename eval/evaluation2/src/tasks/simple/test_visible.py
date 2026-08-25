from datetime import datetime

from submission import build_summary, compute_refunds, load_records, match_payments, parse_amount, parse_record


def _record(kind, record_id, order_id, amount, timestamp):
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "timestamp": timestamp}


def test_amount_scaling():
    assert parse_amount("12.30") == 1230
    assert parse_amount("3") == 300


def test_amount_negative():
    assert parse_amount("-2.00") == -200


def test_amount_invalid():
    assert parse_amount("bad") is None
    assert parse_amount(None) is None


def test_record_valid():
    assert parse_record("PAYMENT| P1 | ORD-1 |12.30|2024-03-15 14:30") == {
        "type": "PAYMENT", "record_id": "P1", "order_id": "ORD-1", "amount": 1230,
        "timestamp": datetime(2024, 3, 15, 14, 30),
    }


def test_record_type_case():
    assert parse_record("Order|O1|O1|1.00|2024-03-15 14:30")["type"] == "ORDER"


def test_record_field_shape():
    assert parse_record("ORDER|O1|O1|1.00") is None


def test_record_timestamp():
    assert parse_record("ORDER|O1|O1|1.00|2024/03/15 14:30") is None


def test_record_order_id():
    assert parse_record("ORDER|O1|OTHER|1.00|2024-03-15 14:30") is None


def test_record_negative_order():
    assert parse_record("ORDER|O1|O1|-1.00|2024-03-15 14:30") is None


def test_record_ids():
    assert parse_record("PAYMENT|   |O1|1.00|2024-03-15 14:30") is None
    assert parse_record("PAYMENT|P1|   |1.00|2024-03-15 14:30") is None
    assert parse_record("PAYMENT| P1 | O1 |1.00|2024-03-15 14:30")["record_id"] == "P1"


def test_load_invalid_rows():
    records = load_records("broken\nORDER|O1|O1|2.00|2024-03-15 14:30")
    assert [row["record_id"] for row in records] == ["O1"]


def test_match_window_boundary():
    records = [_record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9)), _record("PAYMENT", "P1", "O1", 400, datetime(2024, 3, 4, 9))]
    result = match_payments(records)[0]
    assert result["order_id"] == "O1" and str(result["status"]).lower() == "matched" and result["amount"] == 400


def test_match_window_outside():
    records = [_record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9)), _record("PAYMENT", "P1", "O1", 400, datetime(2024, 3, 4, 9, 1))]
    result = match_payments(records)[0]
    assert str(result["status"]).lower() == "unmatched" and result["amount"] == 0


def test_match_candidate_order():
    late_then_early = [
        _record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9)),
        _record("PAYMENT", "P2", "O1", 900, datetime(2024, 3, 1, 11)),
        _record("PAYMENT", "P1", "O1", 500, datetime(2024, 3, 1, 10)),
    ]
    early_then_late = [late_then_early[0], late_then_early[2], late_then_early[1]]
    assert match_payments(late_then_early)[0]["amount"] == 500
    assert match_payments(early_then_late)[0]["amount"] == 500


def test_match_refund_exclusion():
    records = [_record("ORDER", "O1", "O1", 400, datetime(2024, 3, 1, 9)), _record("PAYMENT", "R1", "O1", -400, datetime(2024, 3, 1, 10))]
    assert str(match_payments(records)[0]["status"]).lower() == "unmatched"


def test_refunds_sum():
    records = [_record("PAYMENT", "R1", "missing", -250, datetime(2024, 3, 1, 9)), _record("PAYMENT", "R2", "O1", -125, datetime(2024, 3, 1, 10))]
    assert compute_refunds(records) == 375


def test_refunds_empty():
    assert compute_refunds([]) == 0


def test_summary_schema_counts():
    matches = [{"order_id": "O1", "status": "matched", "amount": 500}, {"order_id": "O2", "status": "unmatched", "amount": 0}]
    result = build_summary(matches, 0)
    assert set(result) == {"total_orders", "matched_count", "net_total", "unmatched_ids"}
    assert (result["total_orders"], result["matched_count"]) == (2, 1)


def test_summary_refund_rule():
    assert build_summary([{"order_id": "O1", "status": "matched", "amount": 500}], 125)["net_total"] == 375


def test_summary_status_case():
    matches = [{"order_id": "O1", "status": "MATCHED", "amount": 100}, {"order_id": "O2", "status": "UnMaTcHeD", "amount": 0}]
    assert build_summary(matches, 0)["matched_count"] == 1


def test_summary_unmatched_order():
    matches = [{"order_id": "x 2", "status": "unmatched", "amount": 0}, {"order_id": "x 10", "status": "unmatched", "amount": 0}]
    assert build_summary(matches, 0)["unmatched_ids"] == ["x 10", "x 2"]


def test_pipeline_case():
    """Checks one complete path; a failure may come from any public function."""
    records = load_records("\n".join([
        "ORDER|O1|O1|5|2024-03-01 09:00",
        "PAYMENT|P1|O1|5|2024-03-01 10:00",
        "PAYMENT|R1|missing|-1|2024-03-01 11:00",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "net_total": 400,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."
