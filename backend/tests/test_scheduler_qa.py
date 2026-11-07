"""QA: Scheduler.due / tick with a fixed clock, tmp DB, and an injected cycle (no real pipeline)."""
import subprocess
import sys
import threading
import time
from datetime import datetime

import pytest

import tnp.api.app  # noqa: F401  -- import order works around the tnp.scheduler <-> tnp.api circular import
from tnp import db
from tnp.scheduler import Scheduler
from tnp.seed import seed_defaults


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "sched.sqlite3")
    c = db.connect(path)
    db.init_db(c)
    seed_defaults(c)  # default schedule: "0 8 * * *"
    c.close()
    return path


def _wait_unlocked(sched, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if sched._running.acquire(blocking=False):
            sched._running.release()
            return True
        time.sleep(0.005)
    return False


def test_due_matches_seeded_default_schedule(db_path):
    s = Scheduler(db_path, cycle=lambda *a, **k: None)
    assert s.due(datetime(2026, 11, 9, 8, 0))
    assert not s.due(datetime(2026, 11, 9, 8, 1))
    assert not s.due(datetime(2026, 11, 9, 7, 59))


def test_due_ignores_disabled_schedules(db_path):
    c = db.connect(db_path)
    sid = db.list_schedules(c)[0].id
    db.update_schedule(c, sid, enabled=False)
    c.close()
    s = Scheduler(db_path, cycle=lambda *a, **k: None)
    assert not s.due(datetime(2026, 11, 9, 8, 0))


def test_due_with_multiple_schedules_any_match_counts(db_path):
    c = db.connect(db_path)
    db.create_schedule(c, "30 12 * * 1-5", label="Lunch")
    db.create_schedule(c, "0 18 * * *", label="Evening", enabled=False)
    c.close()
    s = Scheduler(db_path, cycle=lambda *a, **k: None)
    assert s.due(datetime(2026, 11, 9, 12, 30))  # Monday lunch
    assert not s.due(datetime(2026, 11, 7, 12, 30))  # Saturday, weekdays only
    assert not s.due(datetime(2026, 11, 9, 18, 0))  # disabled


def test_tick_no_match_does_not_run_cycle(db_path):
    calls = []
    s = Scheduler(db_path, cycle=lambda *a, **k: calls.append(1))
    assert s.tick(datetime(2026, 11, 9, 9, 0)) is False
    time.sleep(0.05)
    assert calls == []


def test_tick_match_runs_cycle_once_with_schedule_trigger(db_path):
    ran = threading.Event()
    seen = {}

    def cycle(conn, *, trigger):
        seen["trigger"] = trigger
        seen["conn"] = conn is not None
        ran.set()

    s = Scheduler(db_path, cycle=cycle)
    assert s.tick(datetime(2026, 11, 9, 8, 0)) is True
    assert ran.wait(5)
    assert seen == {"trigger": "schedule", "conn": True}


def test_tick_uses_injected_clock_when_no_argument(db_path):
    ran = threading.Event()
    s = Scheduler(db_path, cycle=lambda conn, *, trigger: ran.set(),
                  now=lambda: datetime(2026, 11, 9, 8, 0))
    assert s.tick() is True
    assert ran.wait(5)


def test_no_overlapping_runs_while_cycle_in_progress(db_path):
    started, release = threading.Event(), threading.Event()
    count = {"n": 0}

    def slow_cycle(conn, *, trigger):
        count["n"] += 1
        started.set()
        release.wait(5)

    s = Scheduler(db_path, cycle=slow_cycle)
    when = datetime(2026, 11, 9, 8, 0)
    assert s.tick(when) is True
    assert started.wait(5)
    assert s.tick(when) is False  # still running -> skipped, not queued
    release.set()
    assert _wait_unlocked(s)
    assert s.tick(when) is True  # free again for the next minute
    assert _wait_unlocked(s)
    assert count["n"] == 2


def test_failing_cycle_is_contained_and_releases_lock(db_path):
    def boom(conn, *, trigger):
        raise RuntimeError("cycle exploded")

    s = Scheduler(db_path, cycle=boom)
    assert s.tick(datetime(2026, 11, 9, 8, 0)) is True
    assert _wait_unlocked(s)
    # lock released: a later match can start again
    done = threading.Event()
    s._cycle = lambda conn, *, trigger: done.set()
    assert s.tick(datetime(2026, 11, 9, 8, 0)) is True
    assert done.wait(5)


def test_unreadable_db_returns_false_instead_of_raising(tmp_path):
    s = Scheduler(str(tmp_path), cycle=lambda *a, **k: None)  # a directory is not a database
    assert s.tick(datetime(2026, 11, 9, 8, 0)) is False


def test_stop_without_start_is_harmless(db_path):
    s = Scheduler(db_path, cycle=lambda *a, **k: None)
    s.stop()
    assert s._stop.is_set()


def test_scheduler_module_imports_in_fresh_interpreter():
    proc = subprocess.run(
        [sys.executable, "-c", "from tnp.scheduler import Scheduler"],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr[-500:]
