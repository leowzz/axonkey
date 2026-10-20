import importlib.util
from datetime import datetime, timezone
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

SPEC = importlib.util.spec_from_file_location("signal_monitor", Path(__file__).resolve().parents[1] / "scripts/bluetooth-signal-monitor.py")
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)

BASE = 1791954000000


def event(t, message, boot="test-boot"):
    return json.dumps({"timestamp": datetime.fromtimestamp(t/1000, timezone.utc).isoformat(),
                       "eventMessage": message, "processImagePath": "/usr/sbin/bluetoothd", "bootUUID": boot})


def identity(handle="0x005d", vendor="10007 (0x2717)", product="12984 (0x32b8)"):
    return "HID Latency Statistics events indicated HID lag issue is detected on connection handle " + handle + ", vid = " + vendor + ", pid = " + product


def radio(handle="0x5d", rssi=-43):
    return "Le [" + handle + "]: time   0, coex   1, rssi " + str(rssi) + ", tx [S=  0:F=  0], rx [S=  0:F=  0], 1M {rx 0, tx 0}"


def topology(handle="0x5D", state="CONNECTED", ready="LE_READY_IDLE"):
    return "Le topology - {adv-addr: [omitted], lmhandle: " + handle + ", interval: 15 ms, latency: 0, state: " + state + ", ready-state: " + ready + "}"


def audio_line(t, packets=49, window=999, streaming=1, session=104, underruns=8):
    stamp = datetime.fromtimestamp(t/1000).strftime("[%Y-%m-%d][%H:%M:%S]")
    return stamp + "[INFO][axonkey::audio] macOS RC003 audio diagnostics: window_ms=" + str(window) + " rx_packets=" + str(packets) + " streaming=" + str(streaming) + " session_id=" + str(session) + " underruns=" + str(underruns) + "\n"


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.now = BASE + 3000
        self.store = monitor.MetricStore(lambda: self.now)
        self.parser = monitor.BluetoothParser(self.store)

    def feed(self, t, text, boot="test-boot"):
        self.parser.feed(event(t, text, boot))

    def test_real_format_requires_identity_and_normalizes_handle(self):
        self.feed(BASE, radio())
        self.assertEqual(self.store.snapshot()["bluetooth"]["status"], "waiting")
        self.feed(BASE+100, identity())
        self.feed(BASE+200, radio("0x005D", -51))
        self.feed(BASE+300, radio("0x42", -90))
        bt = self.store.snapshot()["bluetooth"]
        self.assertEqual(bt["samples"], [{"t": BASE+200, "rssi": -51}])
        self.assertEqual(bt["status"], "live")
        self.assertNotIn("0x005d", json.dumps(bt))

    def test_unknown_or_non_target_identity_is_not_attributed(self):
        self.feed(BASE, identity(vendor="1452 (0x05ac)"))
        self.feed(BASE+100, radio())
        self.assertEqual(list(self.store.bluetooth), [])
        self.feed(BASE+200, "vendor=0x2717 product=0x32b8 handle=0x77")
        self.feed(BASE+300, radio("0x77", -44))
        self.assertEqual(len(self.store.bluetooth), 1)

    def test_reconnect_ignores_old_handle_and_old_events(self):
        self.feed(BASE, identity("0x4d"))
        self.feed(BASE+100, radio("0x4d"))
        self.feed(BASE+200, topology("0x4d", "DISCONNECTED"))
        self.feed(BASE+300, radio("0x4d"))
        self.feed(BASE+400, identity("0x5d"))
        self.assertEqual(self.store.snapshot()["bluetooth"]["status"], "waiting")
        self.feed(BASE+500, radio("0x5d", -50))
        self.feed(BASE+600, radio("0x4d", -20))
        self.feed(BASE+50, identity("0x4d"))
        self.feed(BASE+700, radio("0x4d", -10))
        self.assertEqual([p["rssi"] for p in self.store.bluetooth], [-43, -50])

    def test_handle_reuse_requires_fresh_identity(self):
        self.feed(BASE, identity())
        self.feed(BASE+100, radio())
        self.feed(BASE+200, topology(ready="LE_READY_CONNECTION_COMPLETE"))
        self.feed(BASE+300, radio(rssi=-10))
        self.feed(BASE+400, identity(vendor="1452"))
        self.feed(BASE+500, radio(rssi=-10))
        self.assertEqual(len(self.store.bluetooth), 1)
        self.feed(BASE+600, identity())
        self.feed(BASE+700, radio(rssi=-70))
        self.assertEqual(len(self.store.bluetooth), 2)

    def test_connected_idle_snapshot_does_not_clear_mapping(self):
        self.feed(BASE, identity())
        self.feed(BASE+100, topology())
        self.feed(BASE+200, radio())
        self.assertEqual(len(self.store.bluetooth), 1)
        self.feed(BASE+300, "Device disconnected - {lmHandle: 0x5d, result: 0}")
        self.feed(BASE+400, radio())
        self.assertEqual(len(self.store.bluetooth), 1)
        self.assertEqual(self.store.snapshot()["bluetooth"]["status"], "waiting")

    def test_invalid_radio_and_wrong_process_are_rejected(self):
        self.feed(BASE, identity())
        for n, value in enumerate([127, 1, -128]):
            self.feed(BASE+100+n, radio(rssi=value))
        self.feed(BASE+200, "other diagnostic handle=0x5d RSSI=-40")
        wrong = json.loads(event(BASE+300, radio()))
        wrong["processImagePath"] = "/usr/bin/unrelated"
        self.parser.feed(json.dumps(wrong))
        self.parser.feed("malformed")
        self.assertEqual(len(self.store.bluetooth), 0)

    def test_boot_change_requires_new_identity(self):
        self.feed(BASE, identity())
        self.feed(BASE+100, radio())
        self.feed(BASE+200, radio(), boot="new-boot")
        self.feed(BASE+50, identity(), boot="test-boot")
        self.feed(BASE+300, radio(), boot="new-boot")
        self.assertEqual(len(self.store.bluetooth), 1)
        self.assertFalse(self.store.identity_known)

    def test_stale_and_retention_are_based_on_log_time(self):
        self.feed(BASE, identity())
        self.feed(BASE+100, radio())
        self.now = BASE+6000
        bt = self.store.snapshot()["bluetooth"]
        self.assertEqual(bt["status"], "stale")
        self.assertEqual(bt["lastSampleAt"], BASE+100)
        self.now = BASE+monitor.RETENTION_MS+101
        self.assertEqual(self.store.snapshot()["bluetooth"]["samples"], [])

    def test_audio_rate_uses_actual_window_and_rejects_invalid(self):
        parsed = monitor.parse_audio(audio_line(BASE, packets=49, window=999))
        self.assertAlmostEqual(parsed["pps"], 49*1000/999)
        self.assertTrue(parsed["streaming"])
        self.assertEqual(parsed["sessionId"], 104)
        for window in (0, -1, "nan", "inf"):
            self.assertIsNone(monitor.parse_audio(audio_line(BASE, window=window)))
        self.assertIsNone(monitor.parse_audio("unrelated log"))

    def test_audio_stops_and_expires_without_extending_last_rate(self):
        self.store.add("audio", monitor.parse_audio(audio_line(BASE)))
        self.assertEqual(self.store.snapshot()["audio"]["status"], "live")
        self.now = BASE+6000
        self.assertEqual(self.store.snapshot()["audio"]["status"], "stale")
        self.now = BASE+11000
        self.assertEqual(self.store.snapshot()["audio"]["status"], "idle")
        self.assertEqual(self.store.snapshot()["audio"]["lastSampleAt"], BASE)
        self.now = BASE+12000
        self.store.add("audio", monitor.parse_audio(audio_line(BASE+12000, streaming=0)))
        self.assertEqual(self.store.snapshot()["audio"]["status"], "idle")

    def test_bounded_samples_and_duplicate_history(self):
        for n in range(1300):
            self.store.add("bluetooth", {"t": BASE+n, "rssi": -40})
        self.assertEqual(len(self.store.bluetooth), 1200)
        self.store.add("bluetooth", {"t": BASE+1299, "rssi": -40})
        self.store.add("bluetooth", {"t": BASE+1200, "rssi": -30})
        self.assertEqual(self.store.bluetooth[-1], {"t": BASE+1299, "rssi": -40})

    def test_audio_tail_handles_partial_lines_rotation_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"axonkey.log"
            path.write_text(audio_line(BASE))
            tail = monitor.AudioTail(path, self.store)
            tail.poll(); tail.poll()
            self.assertEqual(len(self.store.audio), 1)
            line = audio_line(BASE+1000, packets=50)
            with path.open("a") as stream:
                stream.write(line[:70])
            tail.poll()
            self.assertEqual(len(self.store.audio), 1)
            with path.open("a") as stream:
                stream.write(line[70:])
            tail.poll()
            self.assertEqual(len(self.store.audio), 2)
            path.rename(Path(directory)/"old.log")
            path.write_text(audio_line(BASE+2000, packets=60))
            tail.poll()
            self.assertEqual(self.store.audio[-1]["pps"], 60*1000/999)
            path.write_text("\n")
            tail.poll()
            with path.open("a") as stream:
                stream.write(audio_line(BASE+3000, packets=65))
            tail.poll()
            self.assertEqual(len(self.store.audio), 4)


class HTTPTests(unittest.TestCase):
    def test_local_hosts_only_fixed_routes_and_json(self):
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory)/"page.html"
            page.write_text("<!doctype html><title>signal</title>")
            store = monitor.MetricStore()
            server = ThreadingHTTPServer(("127.0.0.1", 0), monitor.make_handler(store, 1, page))
            port = server.server_address[1]
            server.RequestHandlerClass = monitor.make_handler(store, port, page)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port)
                connection.request("GET", "/api/state")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn("bluetooth", json.loads(response.read()))
                connection.request("GET", "/", headers={"Host": "attacker.invalid"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403); response.read()
                connection.request("GET", "/../scripts/bluetooth-signal-monitor.py")
                response = connection.getresponse()
                self.assertEqual(response.status, 404); response.read()
                connection.close()
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
