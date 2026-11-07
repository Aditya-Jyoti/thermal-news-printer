"""Print delivery: render the digest, record it, and send it to the BLE thermal printer.

TNP_PRINTER selects the sink: "ble" (default), "dry" (render + mark printed, no hardware) or
"off" (render + save, mark failed with "printer disabled").
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from PIL import Image

from tnp import db
from tnp.models import DigestItem, PrintRecord, PrintTrigger

log = logging.getLogger(__name__)

EDITIONS = ((5, "Early Edition"), (12, "Morning Edition"), (17, "Afternoon Edition"), (24, "Evening Edition"))


def edition_name(now: datetime) -> str:
    for upto, name in EDITIONS:
        if now.hour < upto:
            return name
    return EDITIONS[-1][1]


def printer_mode() -> str:
    mode = os.environ.get("TNP_PRINTER", "ble").strip().lower()
    return mode if mode in ("ble", "dry", "off") else "ble"


def prints_dir(conn: sqlite3.Connection) -> Path:
    """data/prints next to the SQLite file the connection is attached to."""
    row = conn.execute("PRAGMA database_list").fetchone()
    file = row[2] if row and row[2] else os.environ.get("TNP_DB_PATH", "./data/tnp.sqlite3")
    d = Path(file).resolve().parent / "prints"
    d.mkdir(parents=True, exist_ok=True)
    return d


def print_png_path(conn: sqlite3.Connection, print_id: int) -> Path:
    return prints_dir(conn) / f"{print_id}.png"


def render_items(items: list[DigestItem], *, issue_no: int | None = None) -> Image.Image:
    from tnp.print.render import render_receipt

    now = datetime.now()
    return render_receipt(
        items, edition_date=now, edition_name=edition_name(now), issue_no=issue_no
    )


def _send_ble(img: Image.Image, address: str | None) -> None:
    """Blocking BLE print (kept separate so tests can monkeypatch it)."""
    from tnp.print.catprinter import print_image

    asyncio.run(print_image(img, address))


def deliver(
    conn: sqlite3.Connection, digest: list[DigestItem], trigger: PrintTrigger
) -> PrintRecord | None:
    """Render and print `digest`, returning the stored PrintRecord (None for an empty digest).

    Only a record with status "printed" counts toward deduplication, so a failed print's
    articles are offered again next time.
    """
    if not digest:
        log.info("nothing to print (trigger=%s)", trigger)
        return None

    print_id = db.create_print(conn, trigger, digest)
    mode = printer_mode()
    try:
        img = render_items(digest, issue_no=print_id)
        img.save(print_png_path(conn, print_id))
    except Exception as exc:
        log.exception("rendering print %s failed", print_id)
        db.set_print_status(conn, print_id, "failed", f"render failed: {exc}")
        return db.get_print(conn, print_id)

    if mode == "off":
        db.set_print_status(conn, print_id, "failed", "printer disabled")
    elif mode == "dry":
        log.warning("TNP_PRINTER=dry: print %s rendered but NOT sent to any printer", print_id)
        db.set_print_status(conn, print_id, "printed")
    else:
        try:
            _send_ble(img, db.get_settings(conn).printer_address)
        except Exception as exc:
            log.error("BLE print %s failed: %s", print_id, exc)
            db.set_print_status(conn, print_id, "failed", str(exc) or exc.__class__.__name__)
        else:
            db.set_print_status(conn, print_id, "printed")
    return db.get_print(conn, print_id)
