"""Minimal 5-field cron validator (minute hour day-of-month month day-of-week)."""
from __future__ import annotations

import re
from datetime import datetime

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


def _expand(field: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in field.split(","):
        m = _ATOM.match(part)
        assert m, part
        start, end, step = m.groups()
        if start is None:  # '*' or '*/n'
            a, b = lo, hi
        else:
            a = int(start)
            b = int(end) if end is not None else (hi if step is not None else a)
        out.update(range(a, b + 1, int(step) if step else 1))
    return out


def cron_matches(expr: str, when: datetime) -> bool:
    """True if the 5-field cron `expr` fires during the minute of `when` (naive local time).

    Standard dow 0-7 (0 and 7 = Sunday). When both day-of-month and day-of-week are restricted
    (do not start with '*'), either matching suffices (Vixie cron); otherwise both must match.
    """
    minute, hour, dom, month, dow = validate_cron(expr).split()
    if when.minute not in _expand(minute, 0, 59) or when.hour not in _expand(hour, 0, 23):
        return False
    if when.month not in _expand(month, 1, 12):
        return False
    dow_set = {d % 7 for d in _expand(dow, 0, 7)}
    dom_ok = when.day in _expand(dom, 1, 31)
    dow_ok = (when.isoweekday() % 7) in dow_set
    if not dom.startswith("*") and not dow.startswith("*"):
        return dom_ok or dow_ok
    return dom_ok and dow_ok
