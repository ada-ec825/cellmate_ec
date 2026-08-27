"""Reference implementation for the reconciliation task."""

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


def parse_amount(s):
    if not isinstance(s, str):
        return None
    value = s.strip()
    if not value:
        return None
    unsigned = value[1:] if value.startswith("-") else value
    parts = unsigned.split(".")
    if (
        len(parts) > 2
        or not parts[0].isdigit()
        or (len(parts) == 2 and (not parts[1].isdigit() or len(parts[1]) > 3))
    ):
        return None
    try:
        amount = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def parse_record(line):
    if not isinstance(line, str):
        return None
    fields = line.split("|")
    if len(fields) != 6:
        return None
    kind = fields[0].strip().upper()
    record_id = fields[1].strip()
    order_id = fields[2].strip()
    amount = parse_amount(fields[3])
    currency = fields[4].strip()
    try:
        timestamp = datetime.strptime(fields[5].strip(), "%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return None
    if kind not in {"ORDER", "PAYMENT"} or not record_id or not order_id or amount is None or currency != "USD":
        return None
    if kind == "ORDER" and (record_id != order_id or amount < 0):
        return None
    return {
        "type": kind,
        "record_id": record_id,
        "order_id": order_id,
        "amount": amount,
        "currency": "USD",
        "timestamp": timestamp,
    }


def load_records(text):
    if not isinstance(text, str):
        return []
    records = []
    seen = set()
    for line in text.splitlines():
        record = parse_record(line)
        if record is None or record["record_id"] in seen:
            continue
        seen.add(record["record_id"])
        records.append(record)
    return records


def match_payments(records):
    payments = [(index, row) for index, row in enumerate(records) if row["type"] == "PAYMENT" and row["amount"] >= 0]
    results = []
    for order in (row for row in records if row["type"] == "ORDER"):
        candidates = [
            (index, payment) for index, payment in payments
            if payment["order_id"] == order["order_id"]
            and order["timestamp"] <= payment["timestamp"] <= order["timestamp"] + timedelta(hours=72)
        ]
        if candidates:
            _, payment = min(candidates, key=lambda item: (item[1]["timestamp"], item[0]))
            results.append({"order_id": order["order_id"], "status": "matched", "amount": payment["amount"]})
        else:
            results.append({"order_id": order["order_id"], "status": "unmatched", "amount": 0})
    return results


def compute_refunds(records):
    return sum(-row["amount"] for row in records if row["type"] == "PAYMENT" and row["amount"] < 0)


def build_summary(matches, refund_total):
    return {
        "total_orders": len(matches),
        "matched_count": sum(row["status"] == "matched" for row in matches),
        "net_total": sum(row["amount"] for row in matches if row["status"] == "matched") - refund_total,
        "unmatched_ids": sorted(row["order_id"] for row in matches if row["status"] == "unmatched"),
    }
