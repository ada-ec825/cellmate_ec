"""Reference implementation for the detailed reconciliation task."""

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
    if len(parts) > 2 or not parts[0].isdigit() or (len(parts) == 2 and (not parts[1].isdigit() or len(parts[1]) > 3)):
        return None
    try:
        cents = int((Decimal(value) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return None
    return cents if abs(cents) <= 1_000_000 else None


def _parse_timestamp(value):
    for pattern in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, pattern)
        except (TypeError, ValueError):
            pass
    return None


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
    timestamp = _parse_timestamp(fields[5].strip())
    if kind not in {"ORDER", "PAYMENT"} or not record_id or not order_id.startswith("ORD-"):
        return None
    if amount is None or currency != "USD" or timestamp is None or (kind == "ORDER" and amount < 0):
        return None
    return {"type": kind, "record_id": record_id, "order_id": order_id, "amount": amount, "currency": currency, "timestamp": timestamp}


def load_records(text):
    if not isinstance(text, str):
        return []
    result = []
    seen = set()
    for line in text.splitlines():
        record = parse_record(line)
        if record is None or record["record_id"] in seen:
            continue
        seen.add(record["record_id"])
        result.append(record)
    return result


def compute_refunds(records):
    order_ids = {record["order_id"] for record in records if record["type"] == "ORDER"}
    return sum(-record["amount"] for record in records if record["type"] == "PAYMENT" and record["amount"] < 0 and record["order_id"] in order_ids)


def match_payments(records):
    orders = [record for record in records if record["type"] == "ORDER"]
    payments = [record for record in records if record["type"] == "PAYMENT" and record["amount"] >= 0]
    result = []
    for order in orders:
        candidates = [payment for payment in payments if payment["order_id"] == order["order_id"] and order["timestamp"] <= payment["timestamp"] < order["timestamp"] + timedelta(hours=72)]
        chosen = min(enumerate(candidates), key=lambda item: (item[1]["timestamp"], item[0]), default=None)
        payment = chosen[1] if chosen else None
        result.append({"order_id": order["order_id"], "status": "matched" if payment else "unmatched", "amount": payment["amount"] if payment else 0})
    return result


def build_summary(matches, refund_total):
    matched_total = sum(item["amount"] for item in matches if item["status"] == "matched")
    return {
        "total_orders": len(matches),
        "matched_count": sum(item["status"] == "matched" for item in matches),
        "refund_total": refund_total,
        "net_total": max(0, matched_total - refund_total),
        "unmatched_ids": sorted({item["order_id"] for item in matches if item["status"] == "unmatched"}),
    }
