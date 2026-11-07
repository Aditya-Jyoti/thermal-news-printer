"""Raw ATT client + transport selection tests (no hardware; AF_UNIX seqpacket stands in)."""
from __future__ import annotations

import asyncio
import socket
import struct

import pytest

from tnp.print.catprinter import att, ble


@pytest.fixture
def pair():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    client = att.AttClient(a, timeout=0.5)
    yield client, b
    a.close()
    b.close()


def char_rsp(*chars, size=7):
    out = bytes([att.OP_READ_TYPE_RSP, size])
    for decl, props, vh, u in chars:
        out += struct.pack("<HBHH", decl, props, vh, u)
    return out


def err(op, handle, code):
    return struct.pack("<BBHB", att.OP_ERROR, op, handle, code)


def test_mtu_exchange(pair):
    c, srv = pair
    srv.send(struct.pack("<BH", att.OP_MTU_RSP, 247))
    assert c.exchange_mtu(247) == 247 and c.mtu == 247
    assert srv.recv(64) == struct.pack("<BH", att.OP_MTU_REQ, 247)


def test_mtu_never_below_default(pair):
    c, srv = pair
    srv.send(struct.pack("<BH", att.OP_MTU_RSP, 5))
    assert c.exchange_mtu() == att.DEFAULT_MTU


def test_discovery_multi_page_and_not_found(pair):
    c, srv = pair
    srv.send(char_rsp((2, 0x0A, 3, 0x2A00), (5, 0x04, 6, 0xAE01)))
    srv.send(char_rsp((7, 0x10, 8, 0xAE02)))
    srv.send(err(att.OP_READ_TYPE_REQ, 8, att.ERR_ATTRIBUTE_NOT_FOUND))
    chars = c.discover_characteristics()
    assert [x["decl"] for x in chars] == [2, 5, 7]
    reqs = [srv.recv(64) for _ in range(3)]
    assert [struct.unpack("<H", r[1:3])[0] for r in reqs] == [1, 6, 8]  # continues after last decl
    tx = att.AttClient.find_characteristic(chars, 0xAE01)
    assert tx["value_handle"] == 6 and tx["props"] == 4
    assert att.AttClient.next_decl_after(chars, 5) == 7
    assert att.AttClient.next_decl_after(chars, 7) is None
    with pytest.raises(att.AttError):
        att.AttClient.find_characteristic(chars, 0x1234)


def test_parse_128bit_uuid():
    raw = bytes.fromhex("0000ae01-0000-1000-8000-00805f9b34fb".replace("-", ""))[::-1]
    pdu = bytes([att.OP_READ_TYPE_RSP, 21]) + struct.pack("<HBH", 2, 4, 3) + raw
    assert att.parse_characteristics(pdu)[0]["uuid"] == att.uuid128(0xAE01)


def test_enable_notifications_via_find_info(pair):
    c, srv = pair
    srv.send(bytes([att.OP_FIND_INFO_RSP, 1]) + struct.pack("<HH", 9, att.UUID_CCCD))
    srv.send(bytes([att.OP_WRITE_RSP]))
    assert c.enable_notifications(8, next_decl=10) == 9
    assert srv.recv(64) == struct.pack("<BHH", att.OP_FIND_INFO_REQ, 9, 9)
    assert srv.recv(64) == struct.pack("<BH", att.OP_WRITE_REQ, 9) + b"\x01\x00"


def test_cccd_falls_back_to_value_handle_plus_one(pair):
    c, srv = pair
    srv.send(err(att.OP_FIND_INFO_REQ, 9, att.ERR_ATTRIBUTE_NOT_FOUND))
    assert c.find_cccd(8) == 9


def test_error_response_raises_with_code(pair):
    c, srv = pair
    srv.send(err(att.OP_WRITE_REQ, 9, 0x03))
    with pytest.raises(att.AttError) as ei:
        c.request(att.pdu_write(att.OP_WRITE_REQ, 9, b"\x01\x00"), att.OP_WRITE_RSP)
    assert ei.value.code == 0x03


def test_request_timeout(pair):
    c, _ = pair
    c.timeout = 0.05
    with pytest.raises(att.AttError, match="timeout"):
        c.request(att.pdu_mtu_req(23), att.OP_MTU_RSP)


def test_notifications_collected_during_request_and_pump(pair):
    c, srv = pair
    srv.send(struct.pack("<BH", att.OP_NOTIFY, 8) + b"\xaa\xbb")
    srv.send(bytes([att.OP_WRITE_RSP]))
    got = []
    c.on_notification = lambda h, v: got.append((h, v))
    c.request(att.pdu_write(att.OP_WRITE_REQ, 9, b"\x01\x00"), att.OP_WRITE_RSP)
    srv.send(struct.pack("<BH", att.OP_NOTIFY, 8) + b"\xcc")
    c.pump(0.05)
    assert got == [(8, b"\xaa\xbb"), (8, b"\xcc")]


def test_server_requests_are_answered(pair):
    c, srv = pair
    srv.send(struct.pack("<BHH", att.OP_READ_TYPE_REQ, 1, 5) + b"\x00\x28")
    srv.send(struct.pack("<BH", att.OP_MTU_REQ, 100))
    c.pump(0.05)
    assert srv.recv(64) == err(att.OP_READ_TYPE_REQ, 1, att.ERR_REQUEST_NOT_SUPPORTED)
    assert srv.recv(64) == struct.pack("<BH", att.OP_MTU_RSP, att.DEFAULT_MTU)


def test_write_command_encoding_and_mtu_limit(pair):
    c, srv = pair
    c.mtu = 10
    c.write_command(6, b"1234567")
    assert srv.recv(64) == b"\x52\x06\x00" + b"1234567"
    with pytest.raises(ValueError):
        c.write_command(6, b"12345678")


def test_connection_closed_raises(pair):
    c, srv = pair
    srv.close()
    with pytest.raises(att.AttError, match="closed"):
        c.pump(0.1)


# ---- transport selection -------------------------------------------------------------
def test_transport_mode_env(monkeypatch):
    monkeypatch.delenv("TNP_BLE_TRANSPORT", raising=False)
    assert ble.transport_mode() == "auto"
    monkeypatch.setenv("TNP_BLE_TRANSPORT", "BLEAK")
    assert ble.transport_mode() == "bleak"
    monkeypatch.setenv("TNP_BLE_TRANSPORT", "nonsense")
    assert ble.transport_mode() == "auto"


def test_use_att_first(monkeypatch):
    monkeypatch.setattr(ble.sys, "platform", "linux")
    assert ble._use_att_first("auto") and ble._use_att_first("att")
    assert not ble._use_att_first("bleak")
    monkeypatch.setattr(ble.sys, "platform", "darwin")
    assert not ble._use_att_first("auto") and ble._use_att_first("att")


def test_bredr_error_detection():
    assert ble._is_bredr_error(RuntimeError("org.bluez.Error.BREDR.ProfileUnavailable: x"))
    assert not ble._is_bredr_error(RuntimeError("timeout"))


def _patch(monkeypatch, bleak_exc):
    calls = []

    async def fake_bleak(data, address, timeout):
        calls.append("bleak")
        if bleak_exc:
            raise bleak_exc

    def fake_att(address, data, **kw):
        calls.append("att")
        return [b"x"]

    monkeypatch.setattr(ble.sys, "platform", "linux")
    monkeypatch.setattr(ble, "_send_bleak", fake_bleak)
    monkeypatch.setattr(ble, "_att_session", fake_att)
    return calls


def test_linux_auto_uses_att_directly(monkeypatch):
    monkeypatch.delenv("TNP_BLE_TRANSPORT", raising=False)
    calls = _patch(monkeypatch, None)
    asyncio.run(ble.send(b"abc", "AA:BB:CC:DD:EE:FF"))
    assert calls == ["att"]


def test_bleak_first_falls_back_on_bredr(monkeypatch):
    monkeypatch.setenv("TNP_BLE_TRANSPORT", "auto")
    calls = _patch(monkeypatch, RuntimeError("BREDR.ProfileUnavailable"))
    monkeypatch.setattr(ble, "_use_att_first", lambda m: False)  # simulate bleak-first
    asyncio.run(ble.send(b"abc", "AA:BB:CC:DD:EE:FF"))
    assert calls == ["bleak", "att"]


def test_no_fallback_for_other_errors_or_explicit_bleak(monkeypatch):
    monkeypatch.setenv("TNP_BLE_TRANSPORT", "auto")
    calls = _patch(monkeypatch, RuntimeError("something else"))
    monkeypatch.setattr(ble, "_use_att_first", lambda m: False)
    with pytest.raises(ble.PrinterError):
        asyncio.run(ble.send(b"abc", "AA:BB:CC:DD:EE:FF"))
    assert calls == ["bleak"]
    monkeypatch.setenv("TNP_BLE_TRANSPORT", "bleak")
    calls = _patch(monkeypatch, RuntimeError("BREDR.ProfileUnavailable"))
    monkeypatch.setattr(ble, "_use_att_first", lambda m: False)
    with pytest.raises(ble.PrinterError):
        asyncio.run(ble.send(b"abc", "AA:BB:CC:DD:EE:FF"))
    assert calls == ["bleak"]


class FakeClient:
    mtu = 50

    def __init__(self):
        self.writes = []
        self.on_notification = None
        self.closed = False

    def exchange_mtu(self):
        return self.mtu

    def discover_characteristics(self):
        return [
            {"decl": 5, "props": 4, "value_handle": 6, "uuid": 0xAE01},
            {"decl": 7, "props": 0x10, "value_handle": 8, "uuid": 0xAE02},
        ]

    find_characteristic = staticmethod(att.AttClient.find_characteristic)
    next_decl_after = staticmethod(att.AttClient.next_decl_after)

    def enable_notifications(self, vh, nd=None):
        return vh + 1

    def write_command(self, h, v):
        self.writes.append((h, v))

    def pump(self, d=0.0):
        if self.on_notification and len(self.writes) >= 3:
            self.on_notification(8, ble.PRINTER_READY_NOTIFICATION)

    def close(self):
        self.closed = True


def test_att_session_chunks_to_mtu_minus_3_and_completes(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(att.AttClient, "connect", classmethod(lambda cls, *a, **k: fake))
    data = bytes(range(100))
    ble._att_session("AA:BB:CC:DD:EE:FF", data, timeout=1, pacing=0, done_timeout=1)
    assert all(h == 6 for h, _ in fake.writes)
    assert [len(v) for _, v in fake.writes] == [47, 47, 6]
    assert b"".join(v for _, v in fake.writes) == data and fake.closed


def test_job_done_detection():
    state = b"\x51\x78\xa3\x01\x03\x00\x00\x00\x02\x28\xff"
    assert ble.is_job_done(ble.PRINTER_READY_NOTIFICATION, [])
    assert not ble.is_job_done(state, [state])
    assert ble.is_job_done(state, [state, state])
