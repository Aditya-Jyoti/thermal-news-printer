"""Minimal synchronous GATT client over a raw Linux LE L2CAP ATT socket (stdlib only).

Why: dual-mode (BR/EDR + LE) printers make BlueZ's Device1.Connect() pick the BR/EDR bearer
(`ProfileUnavailable`), so bleak cannot connect. Opening the fixed ATT channel (CID 4) directly
forces an LE link. Single-threaded: notifications are collected whenever we wait for a
response or call `pump()`.
"""
from __future__ import annotations

import logging
import select
import socket
import struct
import time
from collections import deque
from typing import Callable

log = logging.getLogger(__name__)

ATT_CID = 4
DEFAULT_MTU = 23
BASE_UUID_FMT = "0000{:04x}-0000-1000-8000-00805f9b34fb"

OP_ERROR = 0x01
OP_MTU_REQ, OP_MTU_RSP = 0x02, 0x03
OP_FIND_INFO_REQ, OP_FIND_INFO_RSP = 0x04, 0x05
OP_READ_TYPE_REQ, OP_READ_TYPE_RSP = 0x08, 0x09
OP_WRITE_REQ, OP_WRITE_RSP = 0x12, 0x13
OP_NOTIFY = 0x1B
OP_INDICATE, OP_CONFIRM = 0x1D, 0x1E
OP_WRITE_CMD = 0x52

ERR_REQUEST_NOT_SUPPORTED = 0x06
ERR_ATTRIBUTE_NOT_FOUND = 0x0A

UUID_CHARACTERISTIC = 0x2803
UUID_CCCD = 0x2902


class AttError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def uuid128(short: int) -> str:
    return BASE_UUID_FMT.format(short)


def short_uuid(raw: bytes) -> int | str:
    """16-bit UUID as int; 128-bit UUID as str."""
    if len(raw) == 2:
        return struct.unpack("<H", raw)[0]
    h = raw[::-1].hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def pdu_mtu_req(mtu: int) -> bytes:
    return struct.pack("<BH", OP_MTU_REQ, mtu)


def pdu_read_by_type(start: int, end: int, uuid16: int) -> bytes:
    return struct.pack("<BHHH", OP_READ_TYPE_REQ, start, end, uuid16)


def pdu_find_info(start: int, end: int) -> bytes:
    return struct.pack("<BHH", OP_FIND_INFO_REQ, start, end)


def pdu_write(op: int, handle: int, value: bytes) -> bytes:
    return struct.pack("<BH", op, handle) + value


def parse_characteristics(pdu: bytes) -> list[dict]:
    """Parse a Read By Type response for 0x2803 into dicts(decl, props, value_handle, uuid)."""
    if len(pdu) < 2 or pdu[0] != OP_READ_TYPE_RSP:
        raise AttError(f"unexpected PDU {pdu[:1].hex()} in characteristic discovery")
    size = pdu[1]
    out = []
    for off in range(2, len(pdu) - size + 1, size):
        rec = pdu[off : off + size]
        decl, props, vh = struct.unpack("<HBH", rec[:5])
        out.append({"decl": decl, "props": props, "value_handle": vh, "uuid": short_uuid(rec[5:])})
    return out


def parse_find_info(pdu: bytes) -> list[tuple[int, int | str]]:
    usize = 2 if pdu[1] == 1 else 16
    out = []
    for off in range(2, len(pdu) - (2 + usize) + 1, 2 + usize):
        handle = struct.unpack("<H", pdu[off : off + 2])[0]
        out.append((handle, short_uuid(pdu[off + 2 : off + 2 + usize])))
    return out


class AttClient:
    def __init__(self, sock: socket.socket, timeout: float = 5.0):
        self.sock = sock
        self.timeout = timeout
        self.mtu = DEFAULT_MTU
        self.notifications: deque[tuple[int, bytes]] = deque()
        self.on_notification: Callable[[int, bytes], None] | None = None

    # -- connection -------------------------------------------------------------
    @classmethod
    def connect(
        cls, address: str, *, timeout: float = 10.0, random_address: bool = False
    ) -> "AttClient":
        atype = socket.BDADDR_LE_RANDOM if random_address else socket.BDADDR_LE_PUBLIC
        s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET, socket.BTPROTO_L2CAP)
        try:
            s.bind(("00:00:00:00:00:00", 0, ATT_CID, socket.BDADDR_LE_PUBLIC))  # required
            s.settimeout(timeout)
            s.connect((address, 0, ATT_CID, atype))
        except OSError:
            s.close()
            raise
        return cls(s, timeout)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self) -> "AttClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- low level --------------------------------------------------------------
    def _send(self, pdu: bytes) -> None:
        self.sock.send(pdu)

    def _recv(self, timeout: float) -> bytes | None:
        r, _, _ = select.select([self.sock], [], [], max(0.0, timeout))
        if not r:
            return None
        data = self.sock.recv(max(self.mtu, 512))
        if not data:
            raise AttError("connection closed by printer")
        return data

    def _handle_async(self, pdu: bytes) -> bool:
        """Handle PDUs that are not responses to our request. True if consumed."""
        op = pdu[0]
        if op in (OP_NOTIFY, OP_INDICATE) and len(pdu) >= 3:
            handle = struct.unpack("<H", pdu[1:3])[0]
            self.notifications.append((handle, pdu[3:]))
            if self.on_notification:
                self.on_notification(handle, pdu[3:])
            if op == OP_INDICATE:
                self._send(bytes([OP_CONFIRM]))
            return True
        if op == OP_MTU_REQ:  # server-initiated MTU exchange
            self._send(struct.pack("<BH", OP_MTU_RSP, self.mtu))
            return True
        if op % 2 == 0 and not op & 0x40:
            # Any other server-initiated request (even opcode, not a command): not supported.
            handle = struct.unpack("<H", pdu[1:3])[0] if len(pdu) >= 3 else 0
            self._send(struct.pack("<BBHB", OP_ERROR, op, handle, ERR_REQUEST_NOT_SUPPORTED))
            return True
        return False

    def request(self, pdu: bytes, expect: int) -> bytes:
        """Send a request and return the response PDU (ATT error -> AttError)."""
        self._send(pdu)
        deadline = time.monotonic() + self.timeout
        while True:
            rsp = self._recv(deadline - time.monotonic())
            if rsp is None:
                raise AttError(f"timeout waiting for response to opcode 0x{pdu[0]:02x}")
            if rsp[0] == OP_ERROR and len(rsp) >= 5 and rsp[1] == pdu[0]:
                code = rsp[4]
                raise AttError(f"ATT error 0x{code:02x} for opcode 0x{pdu[0]:02x}", code)
            if rsp[0] == expect:
                return rsp
            if not self._handle_async(rsp):
                log.debug("ignoring PDU %s", rsp.hex())

    def pump(self, duration: float = 0.0) -> None:
        """Read and process incoming PDUs (collecting notifications) for `duration` seconds."""
        deadline = time.monotonic() + duration
        while True:
            pdu = self._recv(deadline - time.monotonic())
            if pdu is None:
                return
            if not self._handle_async(pdu):
                log.debug("ignoring PDU %s", pdu.hex())

    # -- GATT operations --------------------------------------------------------
    def exchange_mtu(self, client_mtu: int = 247) -> int:
        rsp = self.request(pdu_mtu_req(client_mtu), OP_MTU_RSP)
        server = struct.unpack("<H", rsp[1:3])[0]
        self.mtu = max(DEFAULT_MTU, min(client_mtu, server))
        return self.mtu

    def discover_characteristics(self) -> list[dict]:
        out: list[dict] = []
        start = 1
        while start <= 0xFFFF:
            try:
                rsp = self.request(
                    pdu_read_by_type(start, 0xFFFF, UUID_CHARACTERISTIC), OP_READ_TYPE_RSP
                )
            except AttError as exc:
                if exc.code == ERR_ATTRIBUTE_NOT_FOUND:
                    break
                raise
            chars = parse_characteristics(rsp)
            if not chars:
                break
            out.extend(chars)
            start = chars[-1]["decl"] + 1
        return out

    @staticmethod
    def find_characteristic(chars: list[dict], short: int) -> dict:
        for c in chars:
            if c["uuid"] == short or c["uuid"] == uuid128(short):
                return c
        raise AttError(f"characteristic 0x{short:04x} not found")

    @staticmethod
    def next_decl_after(chars: list[dict], decl: int) -> int | None:
        later = [c["decl"] for c in chars if c["decl"] > decl]
        return min(later) if later else None

    def find_cccd(self, value_handle: int, next_decl: int | None = None) -> int:
        """Handle of the CCCD following `value_handle` (falls back to value_handle + 1)."""
        end = (next_decl - 1) if next_decl else min(value_handle + 3, 0xFFFF)
        try:
            rsp = self.request(
                pdu_find_info(value_handle + 1, max(end, value_handle + 1)), OP_FIND_INFO_RSP
            )
            for handle, uuid in parse_find_info(rsp):
                if uuid == UUID_CCCD:
                    return handle
        except AttError as exc:
            log.debug("find information failed: %s", exc)
        return value_handle + 1

    def enable_notifications(self, value_handle: int, next_decl: int | None = None) -> int:
        cccd = self.find_cccd(value_handle, next_decl)
        self.request(pdu_write(OP_WRITE_REQ, cccd, b"\x01\x00"), OP_WRITE_RSP)
        return cccd

    def write_command(self, handle: int, value: bytes) -> None:
        if len(value) > self.mtu - 3:
            raise ValueError(f"value of {len(value)} bytes exceeds MTU-3 ({self.mtu - 3})")
        self._send(pdu_write(OP_WRITE_CMD, handle, value))
