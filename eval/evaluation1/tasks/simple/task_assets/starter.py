"""Blank starter for the simple reconciliation task."""

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation


def parse_amount(s):
    raise NotImplementedError


def parse_record(line):
    raise NotImplementedError


def load_records(text):
    raise NotImplementedError


def match_payments(records):
    raise NotImplementedError


def compute_refunds(records):
    raise NotImplementedError


def build_summary(matches, refund_total):
    raise NotImplementedError
