"""Printer protocol + delivery tests. No hardware, no network."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import tnp.print as printing
from tnp import db
from tnp.api.app import create_app
from tnp.models import DigestItem
from tnp.print.catprinter import ble, protocol
from tnp.print.samples import sample_items


# --- protocol --------------------------------------------------------------------------

def test_crc8_known_values():
    # Vectors taken from the reference implementation's constants (rbaron/catprinter).
    assert protocol.crc8(b"") == 0
    assert protocol.crc8(bytes([0x30, 0x00])) == 0xF9      # CMD_SET_PAPER
    assert protocol.crc8(bytes([0x19])) == 0x4F            # feed paper 25
    lattice = [0xAA, 0x55, 0x17, 0x38, 0x44, 0x5F, 0x5F, 0x5F, 0x44, 0x38, 0x2C]
    assert protocol.crc8(lattice) == 0xA1                  # CMD_LATTICE_START
    assert protocol.CRC8_TABLE[:4] == (0, 7, 14, 9)


def test_known_command_bytes():
    assert protocol.cmd_set_paper().hex() == "5178a1000200" "3000f9ff"
    assert protocol.cmd_feed_paper(25).hex() == "5178bd000100194fff"
    assert protocol.cmd_lattice_start().hex() == "5178a6000b00aa55173844" "5f5f5f4438" "2ca1ff"
    assert protocol.cmd_get_dev_state().hex() == "5178a300010000" "00ff"
    assert protocol.cmd_set_quality_200dpi().hex() == "5178a4000100329eff"


def test_frame_structure():
    f = protocol.frame(0xA2, b"\x01\x02\x03")
    assert f[:2] == b"\x51\x78"
    assert f[2] == 0xA2 and f[3] == 0
    assert f[4:6] == b"\x03\x00"
    assert f[6:9] == b"\x01\x02\x03"
    assert f[9] == protocol.crc8(b"\x01\x02\x03")
    assert f[10] == 0xFF and len(f) == 11


def test_pack_row_bit_order_lsb_first():
    row = [0] * 384
    row[0] = 1      # bit 0 of byte 0
    row[9] = 1      # bit 1 of byte 1
    row[383] = 1    # bit 7 of byte 47
    packed = protocol.pack_row(row)
    assert len(packed) == 48
    assert packed[0] == 0x01 and packed[1] == 0x02 and packed[47] == 0x80
    assert sum(packed) == 0x01 + 0x02 + 0x80


def test_rle():
    assert protocol.run_length_encode([0] * 384) == [0x7F, 0x7F, 0x7F, 0x03]
    assert protocol.run_length_encode([1] * 384) == [0xFF, 0xFF, 0xFF, 0x83]
    assert protocol.run_length_encode([1, 1, 0, 1]) == [0x82, 0x01, 0x81]


def test_blank_row_uses_rle_and_noisy_row_uses_raw():
    blank = protocol.cmd_print_row([0] * 384)
    assert blank[2] == protocol.CMD_PRINT_ROW_RLE
    noisy = protocol.cmd_print_row([x % 2 for x in range(384)])
    assert noisy[2] == protocol.CMD_PRINT_ROW_RAW
    assert noisy[4:6] == b"\x30\x00"  # 48 payload bytes
    assert noisy[6:54] == b"\xaa" * 48  # pixel 1,3,5.. burn -> bits 1,3,5,7
    assert len(noisy) == 6 + 48 + 2


def test_row_must_be_384_wide():
    with pytest.raises(ValueError):
        protocol.cmd_print_row([0] * 100)


def test_image_to_rows_black_pixel_is_one():
    img = Image.new("1", (384, 3), 1)  # white
    img.putpixel((0, 0), 0)
    img.putpixel((383, 2), 0)
    rows = protocol.image_to_rows(img)
    assert len(rows) == 3 and all(len(r) == 384 for r in rows)
    assert rows[0][0] == 1 and sum(rows[0]) == 1
    assert sum(rows[1]) == 0
    assert rows[2][383] == 1 and sum(rows[2]) == 1


def test_image_to_rows_resizes_other_widths():
    rows = protocol.image_to_rows(Image.new("L", (192, 10), 0))
    assert len(rows[0]) == 384 and len(rows) == 20
    assert all(all(r) for r in rows)


def test_encode_job_envelope():
    rows = [[0] * 384, [1] * 384]
    job = protocol.encode_print_job(rows)
    assert job.startswith(protocol.cmd_get_dev_state() + protocol.cmd_set_quality_200dpi())
    assert protocol.cmd_lattice_start() in job
    assert protocol.cmd_print_row(rows[1]) in job
    assert job.endswith(protocol.cmd_lattice_end() + protocol.cmd_get_dev_state())
    assert job.index(protocol.cmd_lattice_start()) < job.index(protocol.cmd_feed_paper(25))
    assert protocol.cmd_set_energy(0x1234)[6:8] == b"\x12\x34"


def test_chunkify_and_printer_matching():
    assert ble.chunkify(b"abcdefg", 3) == [b"abc", b"def", b"g"]
    with pytest.raises(ValueError):
        ble.chunkify(b"x", 0)
    assert ble.is_printer("GB02", None) and ble.is_printer("GT01", [])
    assert ble.is_printer(None, ["0000AE30-0000-1000-8000-00805f9b34fb"])
    assert not ble.is_printer("JBL Speaker", ["0000180f-0000-1000-8000-00805f9b34fb"])
    assert issubclass(ble.PrinterNotFound, ble.PrinterError)


# --- delivery --------------------------------------------------------------------------

def _article_digest(conn, n=2) -> list[DigestItem]:
    """Create real articles + summaries so print_items FK/dedup behave like production."""
    feed = db.list_feeds(conn)[0]
    items = []
    for i in range(n):
        aid = db.insert_article(
            conn, feed_id=feed.id, guid=f"g{i}", url=f"https://x.test/{i}", title=f"T{i}",
            fingerprint=f"fp{i}", content_text="body", is_political=False,
        )
        db.upsert_summary(conn, aid, f"Summary number {i} about things.", "m")
        items.append(DigestItem(article_id=aid, position=i, category_slug="products",
                                tldr=f"Summary number {i} about things."))
    return items


@pytest.fixture
def digest(conn):
    return _article_digest(conn)


def test_deliver_empty_returns_none(conn):
    assert printing.deliver(conn, [], "manual") is None
    assert db.list_prints(conn)[1] == 0


def test_deliver_dry_marks_printed_and_saves_png(conn, digest, monkeypatch):
    monkeypatch.setenv("TNP_PRINTER", "dry")
    monkeypatch.setattr(printing, "_send_ble", lambda *a, **k: pytest.fail("BLE used in dry mode"))
    rec = printing.deliver(conn, digest, "manual")
    assert rec.status == "printed" and rec.error is None and len(rec.items) == 2
    png = printing.print_png_path(conn, rec.id)
    assert png.exists()
    with Image.open(png) as im:
        assert im.width == 384 and im.mode == "1"


def test_deliver_off_marks_failed(conn, digest, monkeypatch):
    monkeypatch.setenv("TNP_PRINTER", "off")
    rec = printing.deliver(conn, digest, "schedule")
    assert rec.status == "failed" and rec.error == "printer disabled"
    assert printing.print_png_path(conn, rec.id).exists()
    # a failed print must not consume its articles: they are offered again
    assert not (db.get_printed_article_ids(conn) & {i.article_id for i in digest})


def test_deliver_ble_success_and_failure(conn, digest, monkeypatch):
    monkeypatch.setenv("TNP_PRINTER", "ble")
    db.update_settings(conn, printer_address="AA:BB:CC:DD:EE:FF")
    seen = []
    monkeypatch.setattr(printing, "_send_ble", lambda img, addr: seen.append((img.size, addr)))
    rec = printing.deliver(conn, digest, "manual")
    assert rec.status == "printed" and seen[0][0][0] == 384 and seen[0][1] == "AA:BB:CC:DD:EE:FF"

    def boom(img, addr):
        raise ble.PrinterNotFound("no cat printer found")

    monkeypatch.setattr(printing, "_send_ble", boom)
    rec2 = printing.deliver(conn, digest, "manual")
    assert rec2.status == "failed" and "no cat printer" in rec2.error


# --- API -------------------------------------------------------------------------------

@pytest.fixture
def client(tmp_path):
    path = str(tmp_path / "api.sqlite3")
    with TestClient(create_app(path)) as c:
        c.db_path = path
        yield c


def _real_digest(client) -> list[DigestItem]:
    c = db.connect(client.db_path)
    try:
        return _article_digest(c, 1)
    finally:
        c.close()


def test_api_preview_empty_digest_is_png_384(client):
    r = client.get("/print/preview.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    import io
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.width == 384 and im.mode == "1"


def test_api_print_nothing_new_is_409(client):
    r = client.post("/print")
    assert r.status_code == 409 and r.json()["detail"] == "Nothing new to print"


def test_api_print_failure_is_502(client, monkeypatch):
    monkeypatch.setenv("TNP_PRINTER", "off")
    items = _real_digest(client)
    monkeypatch.setattr("tnp.api.app.build_digest", lambda conn: items)
    r = client.post("/print")
    assert r.status_code == 502 and "printer disabled" in r.json()["detail"]


def test_api_print_ok_and_preview_by_id(client, monkeypatch):
    monkeypatch.setenv("TNP_PRINTER", "dry")
    items = _real_digest(client)
    monkeypatch.setattr("tnp.api.app.build_digest", lambda conn: items)
    r = client.post("/print")
    assert r.status_code == 200 and r.json()["status"] == "printed"
    pid = r.json()["id"]
    p = client.get(f"/print/preview.png?print_id={pid}")
    assert p.status_code == 200 and p.headers["content-type"] == "image/png"
    assert client.get("/print/preview.png?print_id=9999").status_code == 404
