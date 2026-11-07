"""Print delivery seam. Phase 3 (Pillow renderer + BLE printer) replaces `deliver()`."""
from __future__ import annotations

import logging
import sqlite3

from tnp.models import DigestItem, PrintRecord, PrintTrigger

log = logging.getLogger(__name__)


def deliver(
    conn: sqlite3.Connection, digest: list[DigestItem], trigger: PrintTrigger
) -> PrintRecord | None:
    """Render and print `digest`, returning the stored PrintRecord.

    Placeholder: logs and returns None WITHOUT creating a print record, so the articles are
    not marked as printed and will be offered again next cycle.
    """
    log.warning("printer not implemented; %d item(s) not printed (trigger=%s)", len(digest), trigger)
    return None
