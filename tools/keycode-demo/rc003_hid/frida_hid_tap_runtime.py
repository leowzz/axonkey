"""Verified x64 Frida Gadget runtime for the RC003 HID-over-GATT tap.

The normal Windows keyboard path drops several RC003 usages.  The upstream
remote-bridge-hub implementation observes the completed HID read inside the
RC003 WUDF host instead.  This module contains only the verified runtime
preparation and the small Gadget script; button policy stays in the app.
"""

from __future__ import annotations

import hashlib
import ctypes
from ctypes import wintypes
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

try:
    import winreg
except ImportError:  # pragma: no cover - import smoke on non-Windows hosts
    winreg = None  # type: ignore[assignment]


GADGET_VERSION = "17.15.3"
GADGET_ARCHIVE_NAME = "frida-gadget-17.15.3-windows-x86_64.dll.xz"
GADGET_ARCHIVE_SHA256 = (
    "b566d70189b6d551ad8f4e0bea24de08a3d4c0f559bb35b2bdb67d45182240c2"
)
GADGET_DLL_SHA256 = (
    "6fca4007b2284c765a6c15c967a741f536b5865bf83867326a54029a3b752748"
)
GADGET_SCRIPT_NAME = "rc003_hid_gadget.js"

BTHLE_ENUM_KEY = r"SYSTEM\CurrentControlSet\Enum\BTHLEDevice"
HID_SERVICE_PREFIX = "{00001812-0000-1000-8000-00805f9b34fb}"
RC003_HARDWARE_TOKEN = "dev_vid&012717_pid&32b8_rev&00a4"
WUDF_DIAGNOSTIC_SUFFIX = r"Device Parameters\WUDFDiagnosticInfo"


# Frida Gadget is loaded into the WUDF host, not into this Python process.
# The script observes the completed HidOverGatt read and sends only metadata
# and the nine-byte output buffer to the local, loopback-only tap server.
GADGET_SCRIPT = r"""
const READ_CHARACTERISTIC_IOCTL = 0x80018483;
const EXPECTED_OUTPUT_LENGTH = 9;
const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 1000;

let host = "127.0.0.1";
let port = 30685;
let output = null;
let writeChain = Promise.resolve();
let reconnectTimer = null;
let hookInstalled = false;
let hookListener = null;
let allowedDevices = [];
let protocolId = "";
let observedHandles = new Set();
let ioctlCount = 0;
let matchedCount = 0;

function detachHook() {
  if (hookListener !== null) hookListener.detach();
  hookListener = null;
  hookInstalled = false;
}

function asciiBytes(text) {
  const result = [];
  for (let index = 0; index < text.length; index++) {
    result.push(text.charCodeAt(index) & 0xff);
  }
  return result;
}

function hex(pointer, length) {
  if (pointer.isNull() || length <= 0) return "";
  const bytes = new Uint8Array(pointer.readByteArray(length));
  let result = "";
  for (let index = 0; index < bytes.length; index++) {
    result += bytes[index].toString(16).padStart(2, "0");
  }
  return result;
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToHub();
  }, RECONNECT_DELAY_MS);
}

function markDisconnected(currentOutput) {
  if (output !== currentOutput) return;
  output = null;
  detachHook();
  scheduleReconnect();
}

function emit(payload) {
  payload.protocol_id = protocolId;
  const currentOutput = output;
  if (currentOutput === null) {
    scheduleReconnect();
    return;
  }
  const line = JSON.stringify(payload) + "\n";
  writeChain = writeChain
    .then(() => currentOutput.writeAll(asciiBytes(line)))
    .catch(() => markDisconnected(currentOutput));
}

async function connectToHub() {
  if (output !== null) return;
  try {
    const connection = await Socket.connect({
      family: "ipv4",
      host: host,
      port: port
    });
    output = connection.output;
    const currentOutput = output;
    // Wait for the receiver's current RC003 device name before attaching.
    // Also observe EOF while idle so Pause really removes the hook.
    (async () => {
      try {
        let line = "";
        while (true) {
          const chunk = new Uint8Array(await connection.input.read(4096));
          if (chunk.byteLength === 0) break;
          for (const value of chunk) {
            if (value === 10) {
              const command = JSON.parse(line);
              line = "";
              if (command.kind === "configure" && Array.isArray(command.devices) &&
                  command.devices.length === 1 && typeof command.devices[0] === "string" &&
                  command.devices[0].toLowerCase().startsWith("\\device\\")) {
                allowedDevices = command.devices.map(name => name.toLowerCase());
                installHook();
                emit({ kind: "ready", pid: Process.id, hook_installed: hookInstalled });
              }
            } else {
              line += String.fromCharCode(value);
              if (line.length > 8192) throw new Error("oversized control message");
            }
          }
        }
      } catch (_error) {}
      markDisconnected(currentOutput);
      try { await connection.close(); } catch (_error) {}
    })();
  } catch (_error) {
    output = null;
    scheduleReconnect();
  }
}

function installHook() {
  if (hookInstalled) return;
  const ntdll = Process.findModuleByName("ntdll.dll");
  const target = ntdll ? ntdll.findExportByName("NtDeviceIoControlFile") : null;
  const queryTarget = ntdll ? ntdll.findExportByName("NtQueryObject") : null;
  if (target === null || queryTarget === null) {
    emit({ kind: "error", message: "NtDeviceIoControlFile export not found" });
    return;
  }
  const queryObject = new NativeFunction(queryTarget, "int", ["pointer", "uint", "pointer", "uint", "pointer"]);
  function deviceName(handle) {
    const buffer = Memory.alloc(4096);
    const length = Memory.alloc(4);
    if (queryObject(handle, 1, buffer, 4096, length) !== 0) return "";
    const byteLength = buffer.readU16();
    const address = buffer.add(Process.pointerSize).readPointer();
    if (address.isNull() || byteLength === 0 || byteLength > 4000) return "";
    return address.readUtf16String(byteLength / 2).toLowerCase();
  }
  hookListener = Interceptor.attach(target, {
    onEnter(args) {
      this.capture = args[5].toUInt32() === READ_CHARACTERISTIC_IOCTL;
      if (this.capture) {
        ioctlCount++;
        // One WUDFHost can contain several unrelated Bluetooth HID devices.
        // Check the actual handle on every call; handle values can be reused.
        this.device = deviceName(args[0]);
        const direct = allowedDevices.includes(this.device);
        const proxy = /^\\device\\umdfctrldev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(this.device);
        this.scope = direct ? "RC003" : "UMDF_PROXY_UNVERIFIED";
        this.capture = direct || proxy;
        const identity = args[0].toString() + ":" + this.device;
        if (!observedHandles.has(identity) && observedHandles.size < 32) {
          observedHandles.add(identity);
          emit({kind: "handle_scope", device: this.device, matched: this.capture,
                output_length: args[9].toUInt32()});
        }
      }
      if (this.capture) {
        matchedCount++;
        this.output = args[8];
        this.outputLength = args[9].toUInt32();
      }
    },
    onLeave(retval) {
      if (!this.capture || retval.toUInt32() !== 0 || this.output.isNull()) return;
      try {
        if (this.outputLength === EXPECTED_OUTPUT_LENGTH) {
          emit({
            kind: "gatt_read",
            device: this.device,
            scope: this.scope,
            raw: hex(this.output, this.outputLength)
          });
        }
      } catch (error) {
        emit({ kind: "error", message: String(error) });
      }
    }
  });
  hookInstalled = true;
}

setInterval(() => {
  if (output === null) {
    scheduleReconnect();
  } else {
    emit({ kind: "heartbeat", pid: Process.id, hook_installed: hookInstalled,
           ioctl_count: ioctlCount, matched_count: matchedCount });
  }
}, HEARTBEAT_INTERVAL_MS);

rpc.exports = {
  async init(_stage, parameters) {
    host = parameters.host || host;
    port = parameters.port || port;
    protocolId = parameters.protocol_id || "";
    await connectToHub();
  }
};
""".strip() + "\n"

# Old Gadget modules stay loaded in WUDFHost. Give revisions separate endpoints
# and names so a previous revision cannot silently win the new TCP connection.
SCRIPT_ID = hashlib.sha256(GADGET_SCRIPT.encode()).hexdigest()[:12]
GADGET_DLL_NAME = f"AxonkeyRC003HidTap_{SCRIPT_ID}.dll"
GADGET_CONFIG_NAME = f"AxonkeyRC003HidTap_{SCRIPT_ID}.config"
HID_TAP_PORT = 30000 + int(SCRIPT_ID[:4], 16) % 20000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def gadget_archive_path() -> Path:
    return Path(__file__).resolve().with_name("frida_assets") / GADGET_ARCHIVE_NAME


def secure_runtime_directory() -> Path:
    program_data = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))
    return (
        program_data
        / "Axonkey"
        / "hid-tap"
        / f"{GADGET_VERSION}-x64-{hashlib.sha256(GADGET_SCRIPT.encode()).hexdigest()[:12]}"
    )


def gadget_config_text() -> str:
    return (
        json.dumps(
            {
                "interaction": {
                    "type": "script",
                    "path": GADGET_SCRIPT_NAME,
                    "parameters": {"host": "127.0.0.1", "port": HID_TAP_PORT, "protocol_id": SCRIPT_ID},
                    "on_change": "ignore",
                },
                "runtime": "qjs",
                "teardown": "minimal",
            },
            indent=2,
        )
        + "\n"
    )


def _write_verified_text(path: Path, content: str) -> None:
    encoded = content.encode("utf-8")
    if path.is_file():
        try:
            if path.read_bytes() == encoded:
                return
        except OSError:
            pass
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _lock_runtime_acl(path: Path) -> None:
    def apply(target: Path, *, directory: bool) -> None:
        suffix = "(OI)(CI)" if directory else ""
        command = [
            "icacls.exe",
            str(target),
            "/inheritance:r",
            "/grant:r",
            f"*S-1-5-18:{suffix}F",
            f"*S-1-5-32-544:{suffix}F",
            f"*S-1-5-32-545:{suffix}RX",
            "/C",
            "/Q",
        ]
        creationflags = 0
        if sys.platform == "win32":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            creationflags=creationflags,
        )
        if completed.returncode != 0:
            raise OSError(
                f"failed to secure Gadget runtime ACL: {completed.stdout.strip()}"
            )

    apply(path, directory=True)
    for child in path.rglob("*"):
        apply(child, directory=child.is_dir())


def prepare_secure_runtime() -> Path:
    archive = gadget_archive_path()
    if not archive.is_file():
        raise FileNotFoundError(archive)
    archive_hash = sha256_file(archive)
    if archive_hash != GADGET_ARCHIVE_SHA256:
        raise RuntimeError(f"Gadget archive hash mismatch: {archive_hash}")

    destination = secure_runtime_directory()
    destination.mkdir(parents=True, exist_ok=True)
    _lock_runtime_acl(destination)
    dll_path = destination / GADGET_DLL_NAME
    if not dll_path.is_file() or sha256_file(dll_path) != GADGET_DLL_SHA256:
        temporary = dll_path.with_suffix(f".dll.{os.getpid()}.tmp")
        try:
            with lzma.open(archive, "rb") as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            dll_hash = sha256_file(temporary)
            if dll_hash != GADGET_DLL_SHA256:
                raise RuntimeError(f"Gadget DLL hash mismatch: {dll_hash}")
            os.replace(temporary, dll_path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    _write_verified_text(destination / GADGET_CONFIG_NAME, gadget_config_text())
    _write_verified_text(destination / GADGET_SCRIPT_NAME, GADGET_SCRIPT)
    _lock_runtime_acl(destination)
    return dll_path


def find_rc003_hidogatt_host_pid() -> int | None:
    """Locate the WUDFHost assigned to the paired RC003 HID service."""

    if os.name != "nt" or winreg is None:
        return None
    candidates = []
    hid_hosts: dict[int, set[str]] = {}
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, BTHLE_ENUM_KEY) as root:
            service_index = 0
            while True:
                try:
                    service_name = winreg.EnumKey(root, service_index)
                except OSError:
                    break
                service_index += 1
                folded = service_name.casefold()
                if not folded.startswith(HID_SERVICE_PREFIX):
                    continue
                with winreg.OpenKey(root, service_name) as service_key:
                    instance_index = 0
                    while True:
                        try:
                            instance_name = winreg.EnumKey(service_key, instance_index)
                        except OSError:
                            break
                        instance_index += 1
                        diagnostic_path = (
                            f"{service_name}\\{instance_name}\\{WUDF_DIAGNOSTIC_SUFFIX}"
                        )
                        try:
                            with winreg.OpenKey(root, diagnostic_path) as diagnostic_key:
                                value, _ = winreg.QueryValueEx(diagnostic_key, "HostPid")
                            pid = int(value)
                            if pid > 0:
                                identity = f"{service_name}\\{instance_name}"
                                hid_hosts.setdefault(pid, set()).add(identity)
                                if RC003_HARDWARE_TOKEN in folded:
                                    candidates.append((pid, identity))
                        except (OSError, TypeError, ValueError):
                            continue
    except OSError:
        return None
    if not candidates:
        return None
    if len(candidates) != 1:
        raise RuntimeError("Multiple RC003 HID instances found; refusing an ambiguous target")
    pid, identity = candidates[0]
    return pid


def resolve_rc003_device_names() -> list[str]:
    """Resolve live RC003 HID service interfaces to NT object names, without opening them."""
    api = ctypes.WinDLL("kernel32", use_last_error=True).QueryDosDeviceW
    api.argtypes = (wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD)
    api.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(262144)
    count = api(None, buffer, len(buffer))
    if not count:
        raise ctypes.WinError(ctypes.get_last_error())
    targets = set()
    for name in buffer[:count].split("\0"):
        folded = name.casefold()
        if not folded.startswith("bthledevice#" + HID_SERVICE_PREFIX):
            continue
        if RC003_HARDWARE_TOKEN not in folded:
            continue
        target = ctypes.create_unicode_buffer(4096)
        if api(name, target, len(target)):
            targets.add(target.value.casefold())
    if len(targets) != 1:
        raise RuntimeError("Expected one live RC003 HID device object, found " + str(len(targets)))
    return sorted(targets)
