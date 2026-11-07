"""Pure (hardware-free) encoder for the "cat printer" (GB01/GB02/GB03/GT01/MX05...) protocol.

Protocol knowledge from https://github.com/rbaron/catprinter (MIT License, (c) 2021 rbaron),
which reverse-engineered the vendor app. This is a clean reimplementation.

Frame layout:  0x51 0x78 | cmd | 0x00 | len_lo len_hi | payload... | crc8(payload) | 0xff
Image rows are 384 pixels; a set bit means "burn" (black). Bits are packed LSB-first.
A row is sent run-length encoded (cmd 0xBF) when that is short, else raw (cmd 0xA2, 48 bytes).
"""
from __future__ import annotations

from typing import Iterable, Sequence

from PIL import Image

PRINT_WIDTH = 384
ROW_BYTES = PRINT_WIDTH // 8  # 48
DEFAULT_ENERGY = 0xFFFF

CMD_GET_DEV_STATE = 0xA3
CMD_SET_QUALITY = 0xA4
CMD_PRINT_ROW_RAW = 0xA2
CMD_PRINT_ROW_RLE = 0xBF
CMD_FEED_PAPER = 0xBD
CMD_SET_PAPER = 0xA1
CMD_LATTICE = 0xA6
CMD_SET_ENERGY = 0xAF
CMD_APPLY_ENERGY = 0xBE


def _build_crc_table() -> tuple[int, ...]:
    table = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
        table.append(c)
    return tuple(table)


CRC8_TABLE = _build_crc_table()  # CRC-8, poly 0x07, init 0, no reflection


def crc8(data: bytes | Sequence[int]) -> int:
    c = 0
    for b in data:
        c = CRC8_TABLE[c ^ b]
    return c


def frame(cmd: int, payload: bytes | Sequence[int] = b"") -> bytes:
    """Wrap `payload` in a command frame (header, length, CRC8, trailer)."""
    payload = bytes(payload)
    n = len(payload)
    return bytes([0x51, 0x78, cmd, 0x00, n & 0xFF, (n >> 8) & 0xFF]) + payload + bytes(
        [crc8(payload), 0xFF]
    )


def cmd_get_dev_state() -> bytes:
    return frame(CMD_GET_DEV_STATE, [0x00])


def cmd_set_quality_200dpi() -> bytes:
    return frame(CMD_SET_QUALITY, [0x32])


def cmd_set_energy(val: int) -> bytes:
    return frame(CMD_SET_ENERGY, [(val >> 8) & 0xFF, val & 0xFF])


def cmd_apply_energy() -> bytes:
    return frame(CMD_APPLY_ENERGY, [0x01])


def cmd_lattice_start() -> bytes:
    return frame(CMD_LATTICE, [0xAA, 0x55, 0x17, 0x38, 0x44, 0x5F, 0x5F, 0x5F, 0x44, 0x38, 0x2C])


def cmd_lattice_end() -> bytes:
    return frame(CMD_LATTICE, [0xAA, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17])


def cmd_feed_paper(amount: int) -> bytes:
    return frame(CMD_FEED_PAPER, [amount & 0xFF])


def cmd_set_paper() -> bytes:
    return frame(CMD_SET_PAPER, [0x30, 0x00])


def _rle_run(count: int, val: int) -> list[int]:
    out = []
    while count > 0x7F:
        out.append(0x7F | (val << 7))
        count -= 0x7F
    if count > 0:
        out.append((val << 7) | count)
    return out


def run_length_encode(row: Sequence[int]) -> list[int]:
    """Each byte: bit7 = pixel value, bits0-6 = run length (1..127)."""
    out: list[int] = []
    run, last = 0, None
    for v in row:
        v = 1 if v else 0
        if v == last:
            run += 1
        else:
            if last is not None:
                out += _rle_run(run, last)
            run, last = 1, v
    if last is not None:
        out += _rle_run(run, last)
    return out


def pack_row(row: Sequence[int]) -> bytes:
    """Pack pixels (1 = burn) into bytes, LSB-first (first pixel = bit 0 of byte 0)."""
    out = bytearray()
    for start in range(0, len(row), 8):
        byte = 0
        for bit in range(8):
            if start + bit < len(row) and row[start + bit]:
                byte |= 1 << bit
        out.append(byte)
    return bytes(out)


def cmd_print_row(row: Sequence[int]) -> bytes:
    if len(row) != PRINT_WIDTH:
        raise ValueError(f"row must be {PRINT_WIDTH} pixels wide, got {len(row)}")
    rle = run_length_encode(row)
    if len(rle) > ROW_BYTES:  # compression not worth it
        return frame(CMD_PRINT_ROW_RAW, pack_row(row))
    return frame(CMD_PRINT_ROW_RLE, rle)


def image_to_rows(img: Image.Image) -> list[list[int]]:
    """Convert a PIL image to rows of 0/1 (1 = black/burn), 384 px wide.

    A mode-"1" image of the right width is used as-is; anything else is resized to 384px
    wide and Floyd-Steinberg dithered.
    """
    if img.width != PRINT_WIDTH:
        h = max(1, round(img.height * PRINT_WIDTH / img.width))
        img = img.convert("L").resize((PRINT_WIDTH, h), Image.LANCZOS)
    img = img.convert("1")  # PIL dithers (FS) when coming from grey; no-op for mode "1"
    px = img.load()
    return [[0 if px[x, y] else 1 for x in range(img.width)] for y in range(img.height)]


def encode_print_job(
    rows: Iterable[Sequence[int]], energy: int = DEFAULT_ENERGY, feed: int = 25
) -> bytes:
    """The full byte stream for one print: setup, every row, feed paper, finish."""
    parts = [
        cmd_get_dev_state(),
        cmd_set_quality_200dpi(),
        cmd_set_energy(energy),
        cmd_apply_energy(),
        cmd_lattice_start(),
    ]
    parts.extend(cmd_print_row(r) for r in rows)
    parts += [
        cmd_feed_paper(feed),
        cmd_set_paper(),
        cmd_set_paper(),
        cmd_set_paper(),
        cmd_lattice_end(),
        cmd_get_dev_state(),
    ]
    return b"".join(parts)


def encode_image(img: Image.Image, energy: int = DEFAULT_ENERGY, feed: int = 25) -> bytes:
    return encode_print_job(image_to_rows(img), energy=energy, feed=feed)
