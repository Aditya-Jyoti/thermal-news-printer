"""BLE transport for cat printers: raw LE ATT socket (Linux default) or `bleak`.

TNP_BLE_TRANSPORT=att|bleak|auto (default auto: raw ATT on Linux, bleak elsewhere, and a
fallback to raw ATT if bleak hits BlueZ's BR/EDR bearer). TNP_BLE_PACING overrides the
delay between chunks (seconds).

Transport details (service/characteristic UUIDs, MTU workaround, "printer ready" notification)
follow https://github.com/rbaron/catprinter (MIT License, (c) 2021 rbaron). This module cannot
be exercised without hardware; the byte stream it sends is produced by `protocol.py`.
"""
from __future__ import annotations

import asyncio
import errno
import logging
import os
import re
import subprocess
import sys
import time

from PIL import Image

from tnp.print.catprinter import att, protocol

log = logging.getLogger(__name__)

# bleak reports 0xaf30 on some macOS versions and 0xae30 elsewhere.
SERVICE_UUIDS = (
    "0000ae30-0000-1000-8000-00805f9b34fb",
    "0000af30-0000-1000-8000-00805f9b34fb",
)
TX_CHARACTERISTIC_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"
RX_CHARACTERISTIC_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"
TX_SHORT, RX_SHORT = 0xAE01, 0xAE02
PRINTER_READY_NOTIFICATION = b"\x51\x78\xae\x01\x01\x00\x00\x00\xff"

KNOWN_NAME_RE = re.compile(r"^(SC0\d|GB0[1-4]|GT0[1-3]|MX0\d|MX1\d|YT0\d|JX0\d|X\d{1,2}|PD\d|Cat ?Printer)", re.I)

SCAN_TIMEOUT_S = 10.0
WAIT_AFTER_EACH_CHUNK_S = 0.02
DONE_TIMEOUT_S = 30.0
DEFAULT_MTU_PAYLOAD = 20
CONNECT_ATTEMPTS = 4
MAX_CHUNK = 100  # the reference negotiates ~104 MTU; larger writes can overrun the printer


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


def transport_mode() -> str:
    mode = os.environ.get("TNP_BLE_TRANSPORT", "auto").strip().lower()
    return mode if mode in ("att", "bleak", "auto") else "auto"


def _is_bredr_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}"
    return "ProfileUnavailable" in text or "BREDR" in text


def _pacing() -> float:
    try:
        return float(os.environ.get("TNP_BLE_PACING", WAIT_AFTER_EACH_CHUNK_S))
    except ValueError:
        return WAIT_AFTER_EACH_CHUNK_S


def _max_chunk() -> int:
    try:
        return max(1, int(os.environ.get("TNP_BLE_MAX_CHUNK", MAX_CHUNK)))
    except ValueError:
        return MAX_CHUNK


def _use_att_first(mode: str) -> bool:
    return mode == "att" or (mode == "auto" and sys.platform.startswith("linux"))


STATE_REPLY_PREFIX = b"\x51\x78\xa3\x01"


def is_job_done(payload: bytes, received: list[bytes]) -> bool:
    """The reference's 'ready' notification, or (SC03h, which never sends it) the reply to the
    trailing get-device-state command, i.e. the 2nd state reply of a job."""
    if payload == PRINTER_READY_NOTIFICATION:
        return True
    return payload.startswith(STATE_REPLY_PREFIX) and sum(
        p.startswith(STATE_REPLY_PREFIX) for p in received
    ) >= 2


def _bluetoothctl_disconnect(address: str) -> None:
    try:
        subprocess.run(["bluetoothctl", "disconnect", address], capture_output=True, timeout=10)
        time.sleep(1.0)
    except (OSError, subprocess.SubprocessError):
        log.debug("bluetoothctl disconnect failed", exc_info=True)


def _att_session(address: str, data: bytes | None, *, timeout: float, pacing: float,
                 done_timeout: float, random_address: bool = False) -> list[bytes]:
    """Blocking raw-ATT session: connect, enable notifications, optionally stream `data`.

    Returns the list of notification payloads received on the RX characteristic.
    """
    client = None
    last: OSError | None = None
    for attempt in range(CONNECT_ATTEMPTS):
        try:
            client = att.AttClient.connect(address, timeout=timeout, random_address=random_address)
            break
        except OSError as exc:
            last = exc
            log.info("raw ATT connect attempt %d failed: %s", attempt + 1, exc)
            if exc.errno == errno.EBUSY:
                # A stale BlueZ-managed link blocks the LE connect; drop it (runtime only).
                _bluetoothctl_disconnect(address)
            else:
                time.sleep(1.0)
    if client is None:
        raise PrinterError(f"raw ATT connect to {address} failed: {last}") from last
    received: list[bytes] = []
    try:
        mtu = client.exchange_mtu()
        chars = client.discover_characteristics()
        tx = client.find_characteristic(chars, TX_SHORT)
        rx = client.find_characteristic(chars, RX_SHORT)
        client.enable_notifications(rx["value_handle"], client.next_decl_after(chars, rx["decl"]))
        log.info("connected via raw ATT; mtu=%d tx=%d rx=%d", mtu, tx["value_handle"], rx["value_handle"])
        ready = False

        def on_notify(handle: int, payload: bytes) -> None:
            nonlocal ready
            log.info("notification on handle %d: %s", handle, payload.hex())
            received.append(payload)
            if is_job_done(payload, received):
                ready = True

        client.on_notification = on_notify
        if data is None:  # probe: just ask for the device state
            client.write_command(tx["value_handle"], protocol.cmd_get_dev_state())
            client.pump(2.0)
            return received
        chunk = max(DEFAULT_MTU_PAYLOAD, min(mtu - 3, _max_chunk()))
        log.info("sending %d bytes in %d-byte chunks", len(data), chunk)
        for part in chunkify(data, chunk):
            client.write_command(tx["value_handle"], part)
            client.pump(pacing)
        deadline = time.monotonic() + done_timeout
        while not ready and time.monotonic() < deadline:
            client.pump(0.5)
        if ready:
            client.pump(1.0)  # grace for any trailing notification
        else:
            log.warning("printer did not confirm completion within %ss", done_timeout)
        return received
    except (att.AttError, OSError) as exc:
        raise PrinterError(f"raw ATT printing failed: {exc}") from exc
    finally:
        client.close()


async def _send_bleak(data: bytes, address: str, timeout: float) -> None:
    bleak = _bleak()
    done = asyncio.Event()

    def on_notify(_sender, payload: bytearray) -> None:
        if bytes(payload) == PRINTER_READY_NOTIFICATION:
            done.set()

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
        pacing = _pacing()
        for part in chunkify(data, chunk):
            await client.write_gatt_char(TX_CHARACTERISTIC_UUID, part)
            await asyncio.sleep(pacing)
        try:
            await asyncio.wait_for(done.wait(), DONE_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("printer did not confirm completion within %ss", DONE_TIMEOUT_S)


async def _run(data: bytes | None, address: str, timeout: float) -> list[bytes]:
    """Run a session with the configured transport; returns notifications (att only)."""
    mode = transport_mode()
    kw = dict(timeout=timeout, pacing=_pacing(), done_timeout=DONE_TIMEOUT_S)
    if _use_att_first(mode):
        return await asyncio.to_thread(_att_session, address, data, **kw)
    if data is None:
        raise PrinterError("probe is only supported with the raw ATT transport")
    try:
        await _send_bleak(data, address, timeout)
    except Exception as exc:
        if mode == "auto" and _is_bredr_error(exc) and sys.platform.startswith("linux"):
            log.warning("bleak hit the BR/EDR bearer (%s); falling back to raw ATT", exc)
            return await asyncio.to_thread(_att_session, address, data, **kw)
        raise
    return []


async def send(data: bytes, address: str | None = None, *, timeout: float = SCAN_TIMEOUT_S) -> None:
    """Connect (auto-discovering if `address` is empty) and stream `data` to the printer."""
    address = address or await find_address(timeout)
    try:
        await _run(data, address, timeout)
    except PrinterError:
        raise
    except Exception as exc:
        raise PrinterError(f"printing over BLE failed: {exc}") from exc


async def probe(address: str | None = None, *, timeout: float = SCAN_TIMEOUT_S) -> list[bytes]:
    """Connect, enable notifications, send get-device-state; return notification payloads."""
    address = address or await find_address(timeout)
    return await _run(None, address, timeout)


async def print_image(
    img: Image.Image,
    address: str | None = None,
    energy: int = protocol.DEFAULT_ENERGY,
) -> None:
    """Print `img` (384px wide, black = ink). Auto-discovers the printer if no address."""
    await send(protocol.encode_image(img, energy=energy), address)
