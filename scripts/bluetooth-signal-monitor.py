#!/usr/bin/env python3
"""Local-only RC003 signal dashboard; retains numeric metrics in memory only."""
from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import signal
import subprocess
import threading
import time

RETENTION_MS = 10 * 60 * 1000
MAX_POINTS = 1200
PAGE = Path(__file__).resolve().parent.parent / "public" / "bluetooth-signal.html"
AUDIO_LOG = Path.home() / "Library/Logs/com.axonkey.app/axonkey.log"
# The parser additionally requires an authenticated VID/PID-to-handle mapping.
BLUETOOTH_PREDICATE = ('process == "bluetoothd" AND ((eventMessage BEGINSWITH "Le [" AND '
                       'eventMessage CONTAINS[c] "rssi") OR eventMessage CONTAINS "HID Latency Statistics" '
                       'OR eventMessage CONTAINS "Le topology -" OR eventMessage CONTAINS "Device disconnected -")')


def now_ms():
    return int(time.time() * 1000)


def timestamp_ms(value):
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def parse_audio(line):
    if "macOS RC003 audio diagnostics:" not in line:
        return None
    match = re.match(r"^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]", line)
    if not match:
        return None
    stamp = timestamp_ms(match[1] + "T" + match[2])
    fields = dict(re.findall(r"\b(window_ms|rx_packets|underruns|streaming|session_id)=([^\s]+)", line))
    try:
        window = float(fields["window_ms"])
        packets = int(fields["rx_packets"])
        underruns = int(fields["underruns"])
        session = int(fields["session_id"])
        streaming = fields["streaming"] in ("1", "true")
        if not math.isfinite(window) or window <= 0 or packets < 0 or underruns < 0 or session < 0 or stamp is None or fields["streaming"] not in ("0", "1", "false", "true"):
            return None
    except (KeyError, ValueError):
        return None
    return {"t": stamp, "pps": packets * 1000.0 / window, "underruns": underruns,
            "streaming": streaming, "sessionId": session}


class MetricStore:
    def __init__(self, clock=now_ms):
        self.clock = clock
        self.started_at = clock()
        self.lock = threading.RLock()
        self.bluetooth = deque(maxlen=MAX_POINTS)
        self.audio = deque(maxlen=MAX_POINTS)
        self.bluetooth_error = None
        self.audio_error = None
        self.identity_known = False
        self.connected = False
        self.connection_since = None

    def add(self, source, point):
        with self.lock:
            values = getattr(self, source)
            # History and the live stream may overlap; only advance real event time.
            if values and (point["t"] < values[-1]["t"] or point == values[-1]):
                return
            if point["t"] > self.clock() + 5000:
                return
            values.append(point)
            setattr(self, source + "_error", None)
            self._prune(values)

    def _prune(self, values):
        cutoff = self.clock() - RETENTION_MS
        while values and values[0]["t"] < cutoff:
            values.popleft()

    def snapshot(self):
        with self.lock:
            now = self.clock()
            self._prune(self.bluetooth)
            self._prune(self.audio)
            bt = list(self.bluetooth)
            audio = list(self.audio)
            bt_last = bt[-1]["t"] if bt else None
            audio_last = audio[-1]["t"] if audio else None
            if self.bluetooth_error:
                bt_status, bt_message = "error", self.bluetooth_error
            elif not self.identity_known:
                bt_status, bt_message = "waiting", "等待系统日志确认遥控器身份；不会使用其他蓝牙设备的数据。"
            elif not self.connected:
                bt_status, bt_message = "waiting", "遥控器已断开，等待重新连接。"
            elif bt_last is None or (self.connection_since is not None and bt_last < self.connection_since):
                bt_status, bt_message = "waiting", "已识别遥控器，等待系统提供信号强度。"
            elif now - bt_last > 5000:
                bt_status, bt_message = "stale", "系统暂未提供新的信号强度，图中为历史数据。"
            else:
                bt_status, bt_message = "live", "正在接收遥控器信号强度。"
            if self.audio_error:
                audio_status, audio_message = "error", self.audio_error
            elif not audio or now - audio_last > 10000 or not audio[-1]["streaming"]:
                audio_status, audio_message = "idle", "等待按住语音键；停止后不会延续上次收包速率。"
            elif now - audio_last > 5000:
                audio_status, audio_message = "stale", "暂未收到新的音频统计，图中为历史数据。"
            else:
                audio_status, audio_message = "live", "正在接收音频统计。"
            return {"now": now, "startedAt": self.started_at,
                    "bluetooth": {"status": bt_status, "message": bt_message,
                                  "lastSampleAt": bt_last, "device": "小米蓝牙语音遥控器", "samples": bt},
                    "audio": {"status": audio_status, "message": audio_message,
                              "lastSampleAt": audio_last, "samples": audio}}


class BluetoothParser:
    """Attribute samples only after target VID/PID authenticates a live handle."""
    HANDLE = re.compile(r"\b(?:handle|lmhandle|connectionHandle|connHandle)\s*(?:[:=]\s*|\s+)(0x[0-9a-f]+|[0-9]+)\b", re.I)
    LE_HANDLE = re.compile(r"^Le\s*\[(0x[0-9a-f]+)\]", re.I)
    VENDOR = re.compile(r"\b(?:VID|Vendor(?:ID)?)\s*[:=]?\s*(0x[0-9a-f]+|[0-9]+)\b", re.I)
    PRODUCT = re.compile(r"\b(?:PID|Product(?:ID)?)\s*[:=]?\s*(0x[0-9a-f]+|[0-9]+)\b", re.I)
    RSSI = re.compile(r"\bRSSI\s*[:=]?\s*(-?[0-9]+)\b", re.I)

    def __init__(self, store):
        self.store = store
        self.current_handle = None
        self.identity_at = -1
        self.lifecycle = {}
        self.boot_uuid = None
        self.last_event_at = -1

    @staticmethod
    def number(value):
        return int(value, 16 if value.lower().startswith("0x") else 10)

    def feed(self, line):
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            return
        if not isinstance(event, dict):
            return
        process = str(event.get("process", event.get("processImagePath", "")))
        if process and process.rsplit("/", 1)[-1] != "bluetoothd":
            return
        t = timestamp_ms(event.get("timestamp"))
        message = event.get("eventMessage")
        if t is None or not isinstance(message, str):
            return
        boot = event.get("bootUUID")
        if boot and self.boot_uuid and boot != self.boot_uuid:
            if t <= self.last_event_at:
                return
            self.current_handle = None
            self.identity_at = -1
            self.lifecycle.clear()
            with self.store.lock:
                self.store.identity_known = self.store.connected = False
        if boot:
            self.boot_uuid = boot
        self.last_event_at = max(self.last_event_at, t)
        h = self.HANDLE.search(message) or self.LE_HANDLE.search(message)
        if not h:
            return
        handle = self.number(h[1])
        if t < self.lifecycle.get(handle, -1):
            return
        vendor, product = self.VENDOR.search(message), self.PRODUCT.search(message)
        disconnect = re.search(r"\b(?:disconnected|disconnect(?:ion)?(?:\s+complete)?)\b", message, re.I)
        # CONNECTED/LE_READY_IDLE topology is a repeated state snapshot, not
        # proof of a newly allocated handle. Only a connection-complete event
        # invalidates a handle awaiting fresh identity evidence.
        connection = re.search(r"\b(?:new\s+connection|connection\s+complete|LE_READY_CONNECTION_COMPLETE)\b", message, re.I)
        if disconnect:
            self.lifecycle[handle] = t
            if handle == self.current_handle:
                self.current_handle = None
                with self.store.lock:
                    self.store.connected = False
            return
        if vendor and product:
            self.lifecycle[handle] = t
            is_target = self.number(vendor[1]) == 0x2717 and self.number(product[1]) == 0x32B8
            if is_target and t >= self.identity_at:
                changed = handle != self.current_handle
                self.current_handle, self.identity_at = handle, t
                with self.store.lock:
                    self.store.identity_known = True
                    self.store.connected = True
                    if changed:
                        self.store.connection_since = t
            elif handle == self.current_handle:
                self.current_handle = None
                with self.store.lock:
                    self.store.connected = False
            return
        if connection:
            self.lifecycle[handle] = t
            if handle == self.current_handle:
                self.current_handle = None
                with self.store.lock:
                    self.store.connected = False
            return
        rssi = self.RSSI.search(message) if self.LE_HANDLE.search(message) else None
        if rssi and handle == self.current_handle and t >= self.identity_at:
            value = int(rssi[1])
            # HCI 127 is the unavailable sentinel; valid radio strength is negative.
            if -127 <= value <= 0:
                self.store.add("bluetooth", {"t": t, "rssi": value})


class AudioTail:
    """Poll a bounded tail and reopen on replacement/truncation without replay."""
    def __init__(self, path, store):
        self.path, self.store = Path(path), store
        self.identity = None
        self.offset = 0
        self.pending = b""

    def poll(self):
        try:
            info = self.path.stat()
            identity = (info.st_dev, info.st_ino)
            initial = self.identity is None
            if identity != self.identity or info.st_size < self.offset:
                self.identity = identity
                self.offset = max(0, info.st_size - 2 * 1024 * 1024) if initial else 0
                self.pending = b""
            with self.path.open("rb") as stream:
                stream.seek(self.offset)
                chunk = stream.read(2 * 1024 * 1024)
                self.offset = stream.tell()
            data = self.pending + chunk
            lines = data.split(b"\n")
            self.pending = lines.pop()[-65536:]
            for line in lines:
                sample = parse_audio(line.decode("utf-8", errors="replace"))
                if sample:
                    self.store.add("audio", sample)
            with self.store.lock:
                self.store.audio_error = None
        except FileNotFoundError:
            with self.store.lock:
                self.store.audio_error = "暂未找到 Axonkey 音频日志，请保持 Axonkey 运行。"
        except OSError:
            with self.store.lock:
                self.store.audio_error = "无法读取 Axonkey 音频日志。"


class Monitor:
    def __init__(self, store, log_path=AUDIO_LOG):
        self.store = store
        self.parser = BluetoothParser(store)
        self.audio = AudioTail(log_path, store)
        self.stop_event = threading.Event()
        self.processes = set()
        self.process_lock = threading.Lock()

    def _process(self, args):
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", errors="replace")
        with self.process_lock:
            self.processes.add(process)
        return process

    def _history(self, minutes):
        process = self._process(["/usr/bin/log", "show", "--style", "ndjson", "--last", str(minutes) + "m",
                                 "--info", "--debug", "--predicate", BLUETOOTH_PREDICATE])
        # A watchdog bounds log queries; no raw output is retained or printed.
        timer = threading.Timer(20, process.terminate)
        timer.start()
        try:
            for line in process.stdout:
                if self.stop_event.is_set():
                    break
                self.parser.feed(line)
            process.wait(timeout=2)
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            with self.process_lock:
                self.processes.discard(process)
        return process.returncode == 0

    def _bluetooth(self):
        try:
            # Start streaming before querying history. The pipe preserves the
            # intervening events; timestamps deduplicate overlap on replay.
            process = self._process(["/usr/bin/log", "stream", "--style", "ndjson", "--level", "debug",
                                     "--predicate", BLUETOOTH_PREDICATE])
            self._history(5)
            if not self.store.identity_known and not self.stop_event.is_set():
                self._history(30)
            if self.stop_event.is_set():
                return
            for line in process.stdout:
                if self.stop_event.is_set():
                    break
                self.parser.feed(line)
            if not self.stop_event.is_set():
                with self.store.lock:
                    self.store.bluetooth_error = "系统蓝牙日志流已停止；请重新启动此监测页面的本地服务。"
            process.wait(timeout=2)
        except (OSError, subprocess.SubprocessError):
            if not self.stop_event.is_set():
                with self.store.lock:
                    self.store.bluetooth_error = "无法读取系统蓝牙日志；未更改蓝牙或系统权限。"

    def _audio(self):
        while not self.stop_event.is_set():
            self.audio.poll()
            self.stop_event.wait(0.5)

    def start(self):
        threading.Thread(target=self._bluetooth, name="bluetooth-metrics", daemon=True).start()
        threading.Thread(target=self._audio, name="audio-metrics", daemon=True).start()

    def close(self):
        self.stop_event.set()
        with self.process_lock:
            processes = list(self.processes)
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


def make_handler(store, port, page=PAGE):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.headers.get("Host", "") not in {"127.0.0.1:" + str(port), "localhost:" + str(port)}:
                self.send_error(403, "Local host required")
                return
            if self.path == "/api/state":
                body = json.dumps(store.snapshot(), ensure_ascii=False, allow_nan=False).encode("utf-8")
                mime = "application/json; charset=utf-8"
            elif self.path == "/":
                try:
                    body = page.read_bytes()
                except OSError:
                    self.send_error(503, "Dashboard is not ready")
                    return
                mime = "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be 1..65535")
    store = MetricStore()
    monitor = Monitor(store)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, args.port))
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    monitor.start()
    print("Bluetooth signal dashboard: http://127.0.0.1:" + str(args.port), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        monitor.close()


if __name__ == "__main__":
    main()
