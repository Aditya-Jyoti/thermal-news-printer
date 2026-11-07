"""QA: 5-field cron validation and matching (api/cron.py)."""
from datetime import datetime

import pytest

from tnp.api.cron import cron_matches, validate_cron


def at(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi)


# Calendar: 2026-11-01 is a Sunday, 2026-11-02 Monday, 2026-11-03 Tuesday, 2026-11-07 Saturday.


@pytest.mark.parametrize("when", [at(2026, 11, 2, 0, 0), at(2026, 11, 7, 23, 59)])
def test_all_stars_matches_every_minute(when):
    assert cron_matches("* * * * *", when)


def test_fixed_time_matches_only_that_minute():
    assert cron_matches("0 8 * * *", at(2026, 11, 9, 8, 0))
    assert not cron_matches("0 8 * * *", at(2026, 11, 9, 8, 1))
    assert not cron_matches("0 8 * * *", at(2026, 11, 9, 7, 0))


def test_lists():
    expr = "0,30 9,17 * * *"
    assert cron_matches(expr, at(2026, 11, 9, 9, 30))
    assert cron_matches(expr, at(2026, 11, 9, 17, 0))
    assert not cron_matches(expr, at(2026, 11, 9, 9, 15))


def test_ranges_and_range_steps():
    assert cron_matches("0 9-17 * * *", at(2026, 11, 9, 17, 0))
    assert not cron_matches("0 9-17 * * *", at(2026, 11, 9, 18, 0))
    expr = "10-30/10 * * * *"  # minutes 10, 20, 30
    assert all(cron_matches(expr, at(2026, 11, 9, 5, m)) for m in (10, 20, 30))
    assert not any(cron_matches(expr, at(2026, 11, 9, 5, m)) for m in (0, 15, 40))


def test_step_on_star_and_single_value_step():
    assert cron_matches("*/15 * * * *", at(2026, 11, 9, 5, 45))
    assert not cron_matches("*/15 * * * *", at(2026, 11, 9, 5, 44))
    assert cron_matches("5/20 * * * *", at(2026, 11, 9, 5, 25))  # 5, 25, 45
    assert not cron_matches("5/20 * * * *", at(2026, 11, 9, 5, 30))


def test_month_restriction():
    assert cron_matches("0 0 * 11 *", at(2026, 11, 9, 0, 0))
    assert not cron_matches("0 0 * 12 *", at(2026, 11, 9, 0, 0))


@pytest.mark.parametrize("sunday", ["0", "7"])
def test_day_of_week_zero_and_seven_both_mean_sunday(sunday):
    expr = f"0 10 * * {sunday}"
    assert cron_matches(expr, at(2026, 11, 1, 10, 0))  # Sunday
    assert not cron_matches(expr, at(2026, 11, 2, 10, 0))  # Monday


def test_weekday_range_and_seven_inside_range():
    assert cron_matches("0 8 * * 1-5", at(2026, 11, 2, 8, 0))  # Monday
    assert not cron_matches("0 8 * * 1-5", at(2026, 11, 7, 8, 0))  # Saturday
    assert cron_matches("0 8 * * 5-7", at(2026, 11, 7, 8, 0))  # Saturday via 6
    assert cron_matches("0 8 * * 5-7", at(2026, 11, 1, 8, 0))  # Sunday via 7


def test_dom_and_dow_both_restricted_use_or():
    expr = "0 12 1 * 1"  # 1st of month OR Monday
    assert cron_matches(expr, at(2026, 11, 1, 12, 0))  # Sunday the 1st
    assert cron_matches(expr, at(2026, 11, 2, 12, 0))  # Monday the 2nd
    assert not cron_matches(expr, at(2026, 11, 3, 12, 0))  # Tuesday the 3rd


def test_dom_restricted_dow_star_requires_dom_only():
    expr = "0 12 15 * *"
    assert cron_matches(expr, at(2026, 11, 15, 12, 0))
    assert not cron_matches(expr, at(2026, 11, 16, 12, 0))


def test_dow_restricted_dom_star_requires_weekday_only():
    expr = "0 12 * * 6"  # Saturdays
    assert cron_matches(expr, at(2026, 11, 7, 12, 0))
    assert not cron_matches(expr, at(2026, 11, 2, 12, 0))


def test_star_dom_with_step_is_treated_as_unrestricted_and_ands():
    # '*/2' starts with '*', so day-of-month is not "restricted": both fields must match.
    expr = "0 12 */2 * 1"
    # */2 expands to odd days 1,3,5...: Monday the 2nd (even) fails the AND, Monday the 9th (odd) passes.
    assert not cron_matches(expr, at(2026, 11, 2, 12, 0))
    assert cron_matches(expr, at(2026, 11, 9, 12, 0))


@pytest.mark.parametrize(
    "expr",
    [
        "* * * *",            # only 4 fields
        "* * * * * *",        # 6 fields
        "60 * * * *",         # minute out of range
        "* 24 * * *",         # hour out of range
        "* * 0 * *",          # dom starts at 1
        "* * * 13 *",         # month > 12
        "* * * * 8",          # dow > 7
        "abc * * * *",        # garbage token
        "1- * * * *",         # dangling range
        "5-3 * * * *",        # inverted range
        "*/0 * * * *",        # zero step
        "-5 * * * *",         # leading dash
        "1,,2 * * * *",       # empty list element
        "*-5 * * * *",        # star range
    ],
)
def test_validate_rejects_bad_expressions(expr):
    with pytest.raises(ValueError):
        validate_cron(expr)


def test_validate_normalizes_whitespace_and_accepts_valid():
    assert validate_cron("  0   8 * * *  ") == "0 8 * * *"
    assert validate_cron("0 0 1 1 7") == "0 0 1 1 7"
    assert validate_cron("0-59/5 0-23 1-31 1-12 0-7") == "0-59/5 0-23 1-31 1-12 0-7"


def test_cron_matches_rejects_invalid_expression():
    with pytest.raises(ValueError):
        cron_matches("61 * * * *", at(2026, 11, 9, 8, 0))
