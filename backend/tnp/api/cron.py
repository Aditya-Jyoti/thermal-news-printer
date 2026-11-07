"""Minimal 5-field cron validator (minute hour day-of-month month day-of-week)."""
from __future__ import annotations

import re

_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_ATOM = re.compile(r"^(?:\*|(\d+)(?:-(\d+))?)(?:/(\d+))?$")


def _valid_field(field: str, lo: int, hi: int) -> bool:
    for part in field.split(","):
        m = _ATOM.match(part)
        if not m:
            return False
        start, end, step = m.groups()
        if start is not None:
            if not lo <= int(start) <= hi:
                return False
            if end is not None and not (int(start) <= int(end) <= hi):
                return False
        elif end is not None:
            return False
        if step is not None and int(step) < 1:
            return False
    return True


def validate_cron(expr: str) -> str:
    """Return the normalized expression or raise ValueError."""
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError("cron must have exactly 5 fields (minute hour day month weekday)")
    for field, (lo, hi), name in zip(
        fields, _RANGES, ("minute", "hour", "day-of-month", "month", "day-of-week")
    ):
        if not _valid_field(field, lo, hi):
            raise ValueError(f"invalid cron {name} field: '{field}'")
    return " ".join(fields)
