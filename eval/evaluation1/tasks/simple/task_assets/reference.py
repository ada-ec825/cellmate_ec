"""Reference implementation for the simple reconciliation task."""

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation


def parse_amount(s):
    if not isinstance(s, str):
        return None
    value = s.strip()
    if not value:
        return None
    unsigned = value[1:] if value.startswith("-") else value
    parts = unsigned.split(".")
    if len(parts) > 2 or not parts[0].isdigit() or (len(parts) == 2 and (not parts[1].isdigit() or len(parts[1]) > 2)):
        return None
    try:
        return int(Decimal(value) * 100)
    except (InvalidOperation, ValueError):
        return None


def parse_record(line):
    if not isinstance(line, str):
        return None
    fields = line.split("|")
    if len(fields) != 5:
        return None
    kind = fields[0].strip().upper()
    record_id = fields[1].strip()
    order_id = fields[2].strip()
    amount = parse_amount(fields[3])
    try:
        timestamp = datetime.strptime(fields[4].strip(), "%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return None
    if kind not in {"ORDER", "PAYMENT"} or not record_id or not order_id or amount is None:
        return None
    if kind == "ORDER" and (record_id != order_id or amount < 0):
        return None
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "timestamp": timestamp}


def load_records(text):
    if not isinstance(text, str):
        return []
    result = []
    for line in text.splitlines():
        record = parse_record(line)
        if record is not None:
            result.append(record)
    return result


def match_payments(records):
    orders = [record for record in records if record["type"] == "ORDER"]
    payments = [record for record in records if record["type"] == "PAYMENT" and record["amount"] >= 0]
    result = []
    for order in orders:
        candidates = [
            (index, payment) for index, payment in enumerate(payments)
            if payment["order_id"] == order["order_id"]
            and order["timestamp"] <= payment["timestamp"] <= order["timestamp"] + timedelta(hours=72)
        ]
        chosen = min(candidates, key=lambda item: (item[1]["timestamp"], item[0]), default=None)
        payment = chosen[1] if chosen else None
        result.append({
            "order_id": order["order_id"],
            "status": "matched" if payment else "unmatched",
            "amount": payment["amount"] if payment else 0,
        })
    return result


def compute_refunds(records):
    return sum(-record["amount"] for record in records if record["type"] == "PAYMENT" and record["amount"] < 0)


def build_summary(matches, refund_total):
    matched = [item for item in matches if str(item["status"]).lower() == "matched"]
    unmatched = [item for item in matches if str(item["status"]).lower() == "unmatched"]
    return {
        "total_orders": len(matches),
        "matched_count": len(matched),
        "net_total": sum(item["amount"] for item in matched) - refund_total,
        "unmatched_ids": sorted(item["order_id"] for item in unmatched),
    }
