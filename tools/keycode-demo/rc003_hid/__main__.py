"""Axonkey diagnostic runner. GPL-3.0-only; see SOURCE.md.

Only --capture attaches to a host. --probe and --self-test never inject.
stdout is a UTF-8, tab-separated protocol consumed by the WinForms demo.
"""
from __future__ import annotations

import argparse
import ctypes
import os
import sys
import threading
import time
import unittest

from . import frida_compat as compat
from . import frida_hid_tap_runtime as runtime


_output_lock = threading.Lock()


def emit(kind: str, text: str) -> None:
    with _output_lock:
        print(kind + "\t" + text.replace("\r", " ").replace("\n", " "), flush=True)


def is_elevated() -> bool:
    return os.name == "nt" and bool(ctypes.windll.shell32.IsUserAnAdmin())


class DiagnosticTap(compat.RC003HidReportTap):
    def __init__(self, sink=emit, **kwargs):
        self.sink = sink
        self.report_count = 0
        self.states_by_device: dict[str, set[int]] = {}
        super().__init__(lambda _report_id, _payload: None,
                         status_handler=self.report_status, **kwargs)

    def report_status(self, status: str, detail: str) -> None:
        self.sink("FRIDA_STATUS", status + ("; " + detail if detail else ""))

    def _handle_ioctl_output(self, data: bytes) -> None:
        self._handle_scoped_ioctl_output(data, "RC003", "synthetic-test")

    def _handle_scoped_ioctl_output(self, data: bytes, scope: str, device: str) -> None:
        payload = compat.decode_rc003_ioctl_output(data)
        if payload is None:
            self.sink("FRIDA_REJECTED", "unexpected_report=" + data.hex(" ").upper())
            return
        active = compat.payload_usages(payload)  # Retain unknown usages for learning.
        with self._state_lock:
            previous = self.states_by_device.get(device, set())
            self.states_by_device[device] = set(active)
            self.active_usages = set().union(*self.states_by_device.values())
        self.report_count += 1
        source = "device=" + ("RC003" if scope == "RC003" else "UNKNOWN") + " scope=" + scope + " object=" + device
        self.sink("FRIDA_HID", source + " report_id=1 page=0x0007 hex=" +
                  data.hex(" ").upper() + " usages=[" +
                  ",".join("0x%04X" % value for value in sorted(active)) + "]")
        for edge, values in (("DOWN", active - previous), ("UP", previous - active)):
            for value in sorted(values):
                self.sink("FRIDA_KEY", "%s %s page=0x0007 usage=0x%04X button=%s" %
                          (edge, source, value, compat.TAP_USAGE_TO_BUTTON.get(value, "UNKNOWN")))

    def _release_active(self) -> None:
        with self._state_lock:
            previous = self.active_usages
            self.active_usages = set()
            self.states_by_device.clear()
        if previous:
            # A disconnect is not a physical key-up report.
            self.sink("FRIDA_RESET", "capture_ended; cleared_usages=" +
                      ",".join("0x%04X" % value for value in sorted(previous)))


class ProtocolTests(unittest.TestCase):
    def test_physical_edges_combinations_unknown_and_reset(self):
        records = []
        tap = DiagnosticTap(sink=lambda kind, text: records.append((kind, text)), enabled=False)
        tap._handle_ioctl_output(bytes.fromhex("010000f10080008100"))
        self.assertEqual(tap.active_usages, {0xF1, 0x80, 0x81})
        self.assertEqual(sum(kind == "FRIDA_KEY" for kind, _ in records), 3)
        tap._handle_ioctl_output(bytes.fromhex("0100008100f1008000"))
        self.assertEqual(sum(kind == "FRIDA_KEY" for kind, _ in records), 3)
        tap._handle_ioctl_output(bytes.fromhex("010000f100ee000000"))
        edges = [text for kind, text in records if kind == "FRIDA_KEY"]
        self.assertTrue(any("usage=0x00EE button=UNKNOWN" in text for text in edges))
        self.assertEqual(sum(text.startswith("UP ") for text in edges), 2)
        tap._handle_ioctl_output(bytes.fromhex("010000000000000000"))
        self.assertEqual(tap.active_usages, set())
        self.assertEqual(sum(kind == "FRIDA_KEY" for kind, _ in records), 8)
        tap._handle_ioctl_output(bytes.fromhex("010000f10000000000"))
        edge_count = sum(kind == "FRIDA_KEY" for kind, _ in records)
        tap._release_active()
        self.assertEqual(records[-1][0], "FRIDA_RESET")
        self.assertEqual(sum(kind == "FRIDA_KEY" for kind, _ in records), edge_count)

    def test_invalid_reports_do_not_release_held_keys(self):
        tap = DiagnosticTap(sink=lambda *_: None, enabled=False)
        tap._handle_ioctl_output(bytes.fromhex("010000f10000000000"))
        for raw in (b"", bytes.fromhex("010000"), bytes.fromhex("020000800000000000")):
            tap._handle_ioctl_output(raw)
        self.assertEqual(tap.active_usages, {0xF1})

    def test_scoped_subprocess_and_gadget(self):
        self.assertEqual(compat.build_injector_command(123, frozen=False, executable="python"),
                         ["python", "-m", "rc003_hid", "--rc003-hid-injector", "--pid", "123"])
        self.assertTrue(30000 <= runtime.HID_TAP_PORT < 50000)
        self.assertIn(runtime.SCRIPT_ID, runtime.GADGET_DLL_NAME)

    def test_proxy_sources_are_unverified_and_have_separate_key_state(self):
        records = []
        tap = DiagnosticTap(sink=lambda *record: records.append(record), enabled=False)
        for device in ("proxy-a", "proxy-b"):
            tap._handle_scoped_ioctl_output(bytes.fromhex("010000f10000000000"), "UMDF_PROXY_UNVERIFIED", device)
        tap._handle_scoped_ioctl_output(bytes.fromhex("010000000000000000"), "UMDF_PROXY_UNVERIFIED", "proxy-a")
        edges = [text for kind, text in records if kind == "FRIDA_KEY"]
        self.assertEqual(len(edges), 3)
        self.assertTrue(all("device=UNKNOWN" in text for text in edges))
        self.assertIn("object=proxy-a", edges[-1])
        self.assertEqual(tap.active_usages, {0xF1})


def main() -> int:
    if "--rc003-hid-injector" in sys.argv:
        from . import frida_hid_tap_injector
        index = sys.argv.index("--rc003-hid-injector")
        return frida_hid_tap_injector.main(sys.argv[index + 1:])
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--probe", action="store_true")
    group.add_argument("--capture", action="store_true")
    group.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ProtocolTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    try:
        pid = runtime.find_rc003_hidogatt_host_pid()
        emit("FRIDA_INFO", "elevated=%s host_pid=%s gadget_verified=%s pointer_bytes=%s" %
             (is_elevated(), pid, compat.verify_asset(runtime.gadget_archive_path()), ctypes.sizeof(ctypes.c_void_p)))
        if pid is not None:
            emit("FRIDA_DEVICE", "RC003 NT device allowlist=" + repr(runtime.resolve_rc003_device_names()))
        if args.probe:
            return 0
        if ctypes.sizeof(ctypes.c_void_p) != 8:
            raise RuntimeError("64-bit Python is required")
        if not is_elevated():
            raise PermissionError("Run the Frida demo as administrator to attach to the RC003 host")
        stop = threading.Event()
        def read_commands():
            # EOF also handles the GUI crashing or being killed.
            for line in sys.stdin:
                if line.strip() == "stop":
                    break
            stop.set()
        threading.Thread(target=read_commands, daemon=True).start()
        tap = DiagnosticTap()
        if not tap.start():
            raise RuntimeError("Frida Gadget unavailable: " + tap.status)
        try:
            while not stop.wait(0.2):
                if tap.status in (compat.HidTapState.FAILED.value, compat.HidTapState.UNHEALTHY.value):
                    return 1
        finally:
            tap.stop()
        return 0
    except (OSError, RuntimeError, ValueError) as error:
        emit("FRIDA_ERROR", str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
