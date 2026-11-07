"""Background cron scheduler: fires run_cycle for any enabled schedule matching the current minute."""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta
from typing import Callable

from tnp import db
from tnp.api.cron import cron_matches

log = logging.getLogger(__name__)


class Scheduler:
    """Wakes at the start of each minute and re-reads schedules from the DB every time."""

    def __init__(
        self, db_path: str, *, cycle: Callable[..., object] | None = None,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.db_path = db_path
        self._cycle = cycle
        self._now = now
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = threading.Lock()  # guards against overlapping cycles

    def due(self, when: datetime) -> bool:
        conn = db.connect(self.db_path)
        try:
            return any(
                s.enabled and cron_matches(s.cron, when) for s in db.list_schedules(conn)
            )
        finally:
            conn.close()

    def tick(self, when: datetime | None = None) -> bool:
        """Run a cycle if a schedule matches `when`. Returns True if one was started."""
        when = when or self._now()
        try:
            if not self.due(when):
                return False
        except Exception:  # noqa: BLE001
            log.exception("scheduler: failed reading schedules")
            return False
        if not self._running.acquire(blocking=False):
            log.warning("scheduler: previous cycle still running; skipping %s", when)
            return False
        threading.Thread(target=self._run, name="tnp-cycle", daemon=True).start()
        return True

    def _run(self) -> None:
        conn = db.connect(self.db_path)
        try:
            cycle = self._cycle
            if cycle is None:
                from tnp.pipeline import run_cycle as cycle
            cycle(conn, trigger="schedule")
        except Exception:  # noqa: BLE001
            log.exception("scheduler: cycle failed")
        finally:
            conn.close()
            self._running.release()

    def _loop(self) -> None:
        while not self._stop.is_set():
            now = self._now()
            nxt = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
            if self._stop.wait(max(0.0, (nxt - now).total_seconds())):
                return
            self.tick(nxt)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="tnp-scheduler", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
