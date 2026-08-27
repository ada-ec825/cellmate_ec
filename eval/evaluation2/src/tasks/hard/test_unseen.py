from datetime import datetime

from submission import build_summary, compute_refunds, load_records, match_payments, parse_amount, parse_record


def _record(kind, record_id, order_id, amount, timestamp):
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "currency": "USD", "timestamp": timestamp}


def case_a_test_amount_storage():
    assert parse_amount("12.30") == 1230
    assert parse_amount("-2.00") == -200


def case_a_test_amount_rounding():
    assert parse_amount("0.005") == 1
    assert parse_amount("-0.005") == -1


def case_a_test_amount_limit():
    assert parse_amount("10000.00") == 1_000_000
    assert parse_amount("10000.01") is None


def case_a_test_amount_syntax():
    assert parse_amount("1e2") is None
    assert parse_amount("1.2345") is None


def case_a_test_record_schema():
    assert parse_record("payment| P1 | ORD-1 |12.30|USD|2024-03-15 14:30") == {
        "type": "PAYMENT", "record_id": "P1", "order_id": "ORD-1", "amount": 1230,
        "currency": "USD", "timestamp": datetime(2024, 3, 15, 14, 30),
    }


def case_a_test_record_currency():
    assert parse_record("PAYMENT|P1|ORD-1|1.00|EUR|2024-03-15 14:30") is None


def case_a_test_record_timestamp():
    row = parse_record("PAYMENT|P1|ORD-1|1.00|USD|2024-03-15 14:30:45")
    assert row is not None and row["timestamp"].second == 45
    assert parse_record("PAYMENT|P2|ORD-1|1.00|USD|2024/03/15 14:30") is None


def case_a_test_record_order_id():
    assert parse_record("PAYMENT|P1|1|1.00|USD|2024-03-15 14:30") is None


def case_a_test_record_negative_order():
    assert parse_record("ORDER|O1|ORD-1|-1.00|USD|2024-03-15 14:30") is None


def case_a_test_record_refund():
    row = parse_record("PAYMENT|R1|ORD-1|-1.00|USD|2024-03-15 14:30")
    assert row is not None and row["amount"] == -100


def case_a_test_load_invalid():
    rows = load_records("bad\nORDER|O1|ORD-1|2.00|USD|2024-03-15 14:30")
    assert [row["record_id"] for row in rows] == ["O1"]


def case_a_test_load_duplicate():
    rows = load_records("PAYMENT|P1|ORD-1|1.00|USD|2024-03-15 14:30\nPAYMENT| P1 |ORD-1|9.00|USD|2024-03-15 14:31")
    assert len(rows) == 1 and rows[0]["amount"] == 100


def case_a_test_refund_order_rule():
    rows = [
        _record("ORDER", "O1", "ORD-1", 500, datetime(2024, 3, 1)),
        _record("PAYMENT", "R1", "ORD-1", -200, datetime(2024, 3, 1, 1)),
        _record("PAYMENT", "R2", "ORD-X", -300, datetime(2024, 3, 1, 2)),
    ]
    assert compute_refunds(rows) == 200


def case_a_test_match_window_boundary():
    rows = [_record("ORDER", "O", "ORD-1", 1, datetime(2024, 3, 1)), _record("PAYMENT", "P", "ORD-1", 9, datetime(2024, 3, 4))]
    assert match_payments(rows)[0] == {"order_id": "ORD-1", "status": "unmatched", "amount": 0}


def case_a_test_match_window_inside():
    rows = [_record("ORDER", "O", "ORD-1", 1, datetime(2024, 3, 1)), _record("PAYMENT", "P", "ORD-1", 9, datetime(2024, 3, 3, 23, 59, 59))]
    assert match_payments(rows)[0]["status"] == "matched"


def case_a_test_match_candidate_order():
    rows = [
        _record("ORDER", "O", "ORD-1", 1, datetime(2024, 3, 1)),
        _record("PAYMENT", "late", "ORD-1", 20, datetime(2024, 3, 1, 2)),
        _record("PAYMENT", "early", "ORD-1", 10, datetime(2024, 3, 1, 1)),
    ]
    assert match_payments(rows)[0]["amount"] == 10


def case_a_test_match_refund_exclusion():
    rows = [_record("ORDER", "O", "ORD-1", 1, datetime(2024, 3, 1)), _record("PAYMENT", "R", "ORD-1", -9, datetime(2024, 3, 1, 1))]
    assert match_payments(rows)[0]["status"] == "unmatched"


def case_a_test_summary_schema():
    result = build_summary([], 0)
    assert set(result) == {"total_orders", "matched_count", "refund_total", "net_total", "unmatched_ids"}


def case_a_test_summary_values():
    matches = [{"order_id": "ORD-1", "status": "matched", "amount": 500}]
    assert build_summary(matches, 125)["net_total"] == 375
    assert build_summary(matches, 125)["refund_total"] == 125


def case_a_test_summary_floor():
    matches = [{"order_id": "ORD-1", "status": "matched", "amount": 100}]
    assert build_summary(matches, 150)["net_total"] == 0


def case_a_test_summary_unique():
    matches = [
        {"order_id": "ORD-B", "status": "unmatched", "amount": 0},
        {"order_id": "ORD-B", "status": "unmatched", "amount": 0},
        {"order_id": "ORD-A", "status": "unmatched", "amount": 0},
    ]
    assert build_summary(matches, 0)["unmatched_ids"] == ["ORD-A", "ORD-B"]


def case_a_test_pipeline_case():
    """Checks one complete path; a failure may come from any public function."""
    records = load_records("\n".join([
        "ORDER|O1|ORD-1|5.00|USD|2024-03-01 09:00",
        "PAYMENT|P1|ORD-1|5.00|USD|2024-03-01 10:00:30",
        "PAYMENT|R1|ORD-1|-1.00|USD|2024-03-01 11:00",
    ]))
    assert build_summary(match_payments(records), compute_refunds(records)) == {
        "total_orders": 1,
        "matched_count": 1,
        "refund_total": 100,
        "net_total": 400,
        "unmatched_ids": [],
    }, "Integration test: this checks the complete pipeline, so the fault may be in any public function."

from datetime import datetime

from submission import build_summary, compute_refunds, load_records, match_payments, parse_amount, parse_record


def _record(kind, record_id, order_id, amount, timestamp):
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "currency": "USD", "timestamp": timestamp}


def case_b_test_h_amount_storage():
    assert parse_amount("0.07") == 7
    assert parse_amount("3") == 300


def case_b_test_h_amount_rounding():
    assert parse_amount("2.345") == 235
    assert parse_amount("-2.345") == -235


def case_b_test_h_amount_limit():
    assert parse_amount("-10000.00") == -1_000_000
    assert parse_amount("-10000.01") is None


def case_b_test_h_amount_syntax():
    assert parse_amount("+1.00") is None
    assert parse_amount("NaN") is None


def case_b_test_h_record_schema():
    row = parse_record("Order| O | ORD-Z |0.50|USD|2024-12-31 23:59")
    assert row == {"type": "ORDER", "record_id": "O", "order_id": "ORD-Z", "amount": 50, "currency": "USD", "timestamp": datetime(2024, 12, 31, 23, 59)}


def case_b_test_h_record_currency():
    assert parse_record("ORDER|O|ORD-O|1.00|usd|2024-01-01 00:00") is None


def case_b_test_h_record_timestamp():
    row = parse_record("PAYMENT|P|ORD-O|1.00|USD|2024-01-01 00:00:01")
    assert row["timestamp"] == datetime(2024, 1, 1, 0, 0, 1)
    assert parse_record("PAYMENT|Q|ORD-O|1.00|USD|2024-01-01T00:00:01") is None


def case_b_test_h_record_order_id():
    assert parse_record("ORDER|O|ord-O|1.00|USD|2024-01-01 00:00") is None


def case_b_test_h_record_negative_order():
    assert parse_record("ORDER|O|ORD-O|-0.01|USD|2024-01-01 00:00") is None


def case_b_test_h_record_refund():
    row = parse_record("PAYMENT|R|ORD-O|-0.50|USD|2024-01-01 00:00:01")
    assert row is not None and row["amount"] == -50


def case_b_test_h_load_invalid():
    assert [row["record_id"] for row in load_records("bad\nORDER|O|ORD-O|1.00|USD|2024-01-01 00:00")] == ["O"]


def case_b_test_h_load_duplicate():
    rows = load_records("PAYMENT|X|ORD-O|bad|USD|2024-01-01 00:00\nPAYMENT|X|ORD-O|2.00|USD|2024-01-01 00:01\nPAYMENT| X |ORD-O|3.00|USD|2024-01-01 00:02")
    assert len(rows) == 1 and rows[0]["amount"] == 200


def case_b_test_h_refund_order_rule():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "R", "ORD-X", -50, datetime(2024, 1, 1))]
    assert compute_refunds(rows) == 0


def case_b_test_h_match_window_boundary():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "P", "ORD-O", 9, datetime(2024, 1, 4))]
    assert match_payments(rows)[0]["status"] == "unmatched"


def case_b_test_h_match_window_inside():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "P", "ORD-O", 9, datetime(2024, 1, 3, 23, 59))]
    assert match_payments(rows)[0]["amount"] == 9


def case_b_test_h_match_candidate_order():
    rows = [
        _record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)),
        _record("PAYMENT", "P1", "ORD-O", 11, datetime(2024, 1, 1, 1)),
        _record("PAYMENT", "P2", "ORD-O", 22, datetime(2024, 1, 1, 1)),
    ]
    assert match_payments(rows)[0]["amount"] == 11


def case_b_test_h_match_refund_exclusion():
    rows = [_record("ORDER", "O", "ORD-O", 1, datetime(2024, 1, 1)), _record("PAYMENT", "R", "ORD-O", -1, datetime(2024, 1, 1))]
    assert match_payments(rows)[0] == {"order_id": "ORD-O", "status": "unmatched", "amount": 0}


def case_b_test_h_summary_schema():
    assert set(build_summary([], 9)) == {"total_orders", "matched_count", "refund_total", "net_total", "unmatched_ids"}


def case_b_test_h_summary_values():
    matches = [{"order_id": "ORD-O", "status": "matched", "amount": 501}]
    result = build_summary(matches, 1)
    assert (result["refund_total"], result["net_total"]) == (1, 500)


def case_b_test_h_summary_floor():
    assert build_summary([], 1)["net_total"] == 0


def case_b_test_h_summary_unique():
    matches = [{"order_id": "ORD-Z", "status": "unmatched", "amount": 0}, {"order_id": "ORD-Z", "status": "unmatched", "amount": 0}]
    assert build_summary(matches, 0)["unmatched_ids"] == ["ORD-Z"]


def case_b_test_h_pipeline_case():
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

def test_amount_storage():
    case_a_test_amount_storage()
    case_b_test_h_amount_storage()

def test_amount_rounding():
    case_a_test_amount_rounding()
    case_b_test_h_amount_rounding()

def test_amount_limit():
    case_a_test_amount_limit()
    case_b_test_h_amount_limit()

def test_amount_syntax():
    case_a_test_amount_syntax()
    case_b_test_h_amount_syntax()

def test_record_schema():
    case_a_test_record_schema()
    case_b_test_h_record_schema()

def test_record_currency():
    case_a_test_record_currency()
    case_b_test_h_record_currency()

def test_record_timestamp():
    case_a_test_record_timestamp()
    case_b_test_h_record_timestamp()

def test_record_order_id():
    case_a_test_record_order_id()
    case_b_test_h_record_order_id()

def test_record_negative_order():
    case_a_test_record_negative_order()
    case_b_test_h_record_negative_order()

def test_record_refund():
    case_a_test_record_refund()
    case_b_test_h_record_refund()

def test_load_invalid():
    case_a_test_load_invalid()
    case_b_test_h_load_invalid()

def test_load_duplicate():
    case_a_test_load_duplicate()
    case_b_test_h_load_duplicate()

def test_refund_order_rule():
    case_a_test_refund_order_rule()
    case_b_test_h_refund_order_rule()

def test_match_window_boundary():
    case_a_test_match_window_boundary()
    case_b_test_h_match_window_boundary()

def test_match_window_inside():
    case_a_test_match_window_inside()
    case_b_test_h_match_window_inside()

def test_match_candidate_order():
    case_a_test_match_candidate_order()
    case_b_test_h_match_candidate_order()

def test_match_refund_exclusion():
    case_a_test_match_refund_exclusion()
    case_b_test_h_match_refund_exclusion()

def test_summary_schema():
    case_a_test_summary_schema()
    case_b_test_h_summary_schema()

def test_summary_values():
    case_a_test_summary_values()
    case_b_test_h_summary_values()

def test_summary_floor():
    case_a_test_summary_floor()
    case_b_test_h_summary_floor()

def test_summary_unique():
    case_a_test_summary_unique()
    case_b_test_h_summary_unique()

def test_pipeline():
    case_a_test_pipeline_case()
    case_b_test_h_pipeline_case()
