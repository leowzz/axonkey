// GPL-3.0-only; adapted from the RC003 diagnostic tap. See vendor/frida/SOURCE.md.
const READ_CHARACTERISTIC_IOCTL = 0x80018483;
const EXPECTED_OUTPUT_LENGTH = 9;
const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 1000;

let host = "127.0.0.1";
let port = 30685;
let output = null;
let writeChain = Promise.resolve();
let pendingWrites = 0;
let reconnectTimer = null;
let hookInstalled = false;
let hookListener = null;
let closeListener = null;
let streams = new Map();
let streamSerial = 0;
let allowedDevices = [];
let protocolId = "";
let authToken = "";
let observedHandles = new Set();
let ioctlCount = 0;
let matchedCount = 0;

function detachHook() {
  if (hookListener !== null) hookListener.detach();
  hookListener = null;
  if (closeListener !== null) closeListener.detach();
  closeListener = null;
  streams.clear();
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
  if (++pendingWrites > 128) {
    pendingWrites--;
    markDisconnected(currentOutput);
    return;
  }
  const line = JSON.stringify(payload) + "\n";
  writeChain = writeChain
    .then(() => currentOutput.writeAll(asciiBytes(line)))
    .catch(() => markDisconnected(currentOutput))
    .finally(() => { pendingWrites--; });
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
              if (command.kind === "configure" && authToken.length === 64 && command.auth_token === authToken && Array.isArray(command.devices) &&
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
  const closeTarget = ntdll.findExportByName("NtClose");
  if (closeTarget === null) throw new Error("NtClose unavailable");
  closeListener = Interceptor.attach(closeTarget, {
    onEnter(args) { this.handle = args[0].toString(); },
    onLeave(result) {
      if (result.toUInt32() !== 0) return;
      const stream = streams.get(this.handle);
      if (stream) { streams.delete(this.handle); emit({kind: "stream_closed", stream}); }
    }
  });
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
        const handle = args[0].toString();
        if (this.capture && !streams.has(handle)) {
          if (streams.size >= 128) { this.capture = false; return; }
          streams.set(handle, this.device + ":" + handle + ":" + (++streamSerial));
        }
        this.stream = streams.get(handle);
        const identity = handle + ":" + this.device;
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
            stream: this.stream,
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
    authToken = parameters.auth_token || "";
    await connectToHub();
  }
};
