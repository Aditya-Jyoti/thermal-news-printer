"""BLE transport for cat printers, built on `bleak`.

Transport details (service/characteristic UUIDs, MTU workaround, "printer ready" notification)
follow https://github.com/rbaron/catprinter (MIT License, (c) 2021 rbaron). This module cannot
be exercised without hardware; the byte stream it sends is produced by `protocol.py`.
"""
from __future__ import annotations

import asyncio
import logging
import re

from PIL import Image

from tnp.print.catprinter import protocol

log = logging.getLogger(__name__)

# bleak reports 0xaf30 on some macOS versions and 0xae30 elsewhere.
SERVICE_UUIDS = (
    "0000ae30-0000-1000-8000-00805f9b34fb",
    "0000af30-0000-1000-8000-00805f9b34fb",
)
TX_CHARACTERISTIC_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"
RX_CHARACTERISTIC_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"
PRINTER_READY_NOTIFICATION = b"\x51\x78\xae\x01\x01\x00\x00\x00\xff"

KNOWN_NAME_RE = re.compile(r"^(GB0[1-4]|GT0[1-3]|MX0\d|MX1\d|YT0\d|JX0\d|X\d{1,2}|PD\d|Cat ?Printer)", re.I)

SCAN_TIMEOUT_S = 10.0
WAIT_AFTER_EACH_CHUNK_S = 0.02
DONE_TIMEOUT_S = 30.0
DEFAULT_MTU_PAYLOAD = 20


class PrinterError(RuntimeError):
    """Communication with the printer failed."""


class PrinterNotFound(PrinterError):
    """No printer was found in range (or bluetooth is unavailable)."""


def is_printer(name: str | None, service_uuids: list[str] | None) -> bool:
    if service_uuids and any(u.lower() in SERVICE_UUIDS for u in service_uuids):
        return True
    return bool(name and KNOWN_NAME_RE.match(name))


def chunkify(data: bytes, size: int) -> list[bytes]:
    if size <= 0:
        raise ValueError("chunk size must be positive")
    return [data[i : i + size] for i in range(0, len(data), size)]


def _bleak():
    try:
        import bleak
    except ImportError as exc:  # pragma: no cover
        raise PrinterError("the 'bleak' package is not installed") from exc
    return bleak


async def scan(timeout: float = SCAN_TIMEOUT_S) -> list[tuple[str, str]]:
    """Return [(name, address)] of nearby cat printers."""
    bleak = _bleak()
    try:
        found = await bleak.BleakScanner.discover(timeout=timeout, return_adv=True)
    except Exception as exc:  # bleak raises backend-specific errors (no adapter, BlueZ, ...)
        raise PrinterError(f"bluetooth scan failed: {exc}") from exc
    out: list[tuple[str, str]] = []
    for device, adv in found.values():
        name = device.name or adv.local_name
        if is_printer(name, list(adv.service_uuids or [])):
            out.append((name or "(unknown)", device.address))
    return out


async def find_address(timeout: float = SCAN_TIMEOUT_S) -> str:
    printers = await scan(timeout)
    if not printers:
        raise PrinterNotFound("no cat printer found; is it switched on and in range?")
    name, address = printers[0]
    log.info("auto-discovered printer %s (%s)", name, address)
    return address


async def send(data: bytes, address: str | None = None, *, timeout: float = SCAN_TIMEOUT_S) -> None:
    """Connect (auto-discovering if `address` is empty) and stream `data` to the printer."""
    bleak = _bleak()
    address = address or await find_address(timeout)
    done = asyncio.Event()

    def on_notify(_sender, payload: bytearray) -> None:
        if bytes(payload) == PRINTER_READY_NOTIFICATION:
            done.set()

    try:
        async with bleak.BleakClient(address, timeout=timeout) as client:
            # BlueZ reports a fixed MTU of 23 until it is negotiated explicitly.
            acquire = getattr(client._backend, "_acquire_mtu", None)
            if acquire is not None:
                try:
                    await acquire()
                except Exception:  # best effort
                    log.debug("MTU acquisition failed", exc_info=True)
            chunk = max(DEFAULT_MTU_PAYLOAD, int(client.mtu_size) - 3)
            log.info("connected to %s; sending %d bytes in %d-byte chunks", address, len(data), chunk)
            await client.start_notify(RX_CHARACTERISTIC_UUID, on_notify)
            for part in chunkify(data, chunk):
                await client.write_gatt_char(TX_CHARACTERISTIC_UUID, part)
                await asyncio.sleep(WAIT_AFTER_EACH_CHUNK_S)
            try:
                await asyncio.wait_for(done.wait(), DONE_TIMEOUT_S)
            except asyncio.TimeoutError:
                log.warning("printer did not confirm completion within %ss", DONE_TIMEOUT_S)
    except PrinterError:
        raise
    except Exception as exc:
        raise PrinterError(f"printing over BLE failed: {exc}") from exc


async def print_image(
    img: Image.Image,
    address: str | None = None,
    energy: int = protocol.DEFAULT_ENERGY,
) -> None:
    """Print `img` (384px wide, black = ink). Auto-discovers the printer if no address."""
    await send(protocol.encode_image(img, energy=energy), address)
