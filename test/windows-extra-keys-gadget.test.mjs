// Exercise the real Gadget script without loading any DLL or touching input.
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../src-tauri/native/windows/rc003_hid_gadget.js', import.meta.url), 'utf8');
const sent = [];
const reads = [];
let callbacks, closeCallbacks, attached = 0, detached = 0, available = false;
let queriedName = '\\Device\\000000ee';
let readReportCount = 0;
const openedHandles = [];
let nextHandle = 10;
let outputCloseWait = null, failOutput = false;
const pointer = value => ({ value, equals(other) { return value === other.value; } });
const protocolId = 'abcdef123456';
const pipeName = '\\\\.\\pipe\\Axonkey.ExtraKeys.gadget.' + protocolId;
const context = vm.createContext({
  Uint8Array, ArrayBuffer, Promise, JSON, String, Error,
  NULL: pointer(0), ptr: pointer,
  setTimeout() { return 1; }, setInterval() { return 1; },
  Process: { id: 42, pointerSize: 8, findModuleByName() { return { findExportByName(name) { return name; } }; } },
  NativeFunction: function (name) {
    if (name !== 'CloseHandle') return () => 0;
    return handle => {
      assert.equal(handle.inputClosed, true);
      if (handle.outputCreated) {
        assert.equal(handle.outputClosed, true, 'both wrappers must drain before closing the handle');
      }
      handle.closes = (handle.closes || 0) + 1;
      assert.equal(handle.closes, 1, 'duplex pipe handle must only close once');
      return 1;
    };
  },
  SystemFunction: function (name) {
    assert.equal(name, 'CreateFileW');
    return (path, access, share, security, disposition, flags) => {
      assert.equal(path, pipeName);
      assert.equal(access, 0x00100003, 'LocalService must not request server creation rights');
      assert.equal(share, 0);
      assert.equal(disposition, 3);
      assert.equal(flags, 0x40100000, 'overlapped I/O and anonymous SQOS');
      if (!available) return {value: pointer(-1), lastError: 2};
      const handle = pointer(nextHandle++);
      openedHandles.push(handle);
      return {value: handle, lastError: 0};
    };
  },
  Win32InputStream: function (handle, options) {
    assert.equal(options.autoClose, false);
    return {
      read() { return new Promise(resolve => reads.push(resolve)); },
      async close() { handle.inputClosed = true; }
    };
  },
  Win32OutputStream: function (handle, options) {
    assert.equal(options.autoClose, false);
    if (failOutput) throw new Error('output wrapper failed');
    handle.outputCreated = true;
    return {
      async writeAll(bytes) { sent.push(JSON.parse(Buffer.from(bytes).toString())); },
      async close() { if (outputCloseWait) await outputCloseWait; handle.outputClosed = true; }
    };
  },
  Memory: { allocUtf16String(text) { return text; }, alloc() { return {
    readU16() { return queriedName.length * 2; },
    add() { return { readPointer() { return { isNull() { return false; }, readUtf16String() { return queriedName; } }; } }; }
  }; } },
  Interceptor: { attach(_target, listeners) { if (_target === "NtClose") closeCallbacks = listeners; else callbacks = listeners; attached++; return { detach() { detached++; } }; } },
  rpc: { exports: {} }
});
vm.runInContext(script, context);
const authToken = 'a'.repeat(64);
await assert.rejects(context.rpc.exports.init(null, { pipe_name: String.raw`\\remote\pipe\capture`, protocol_id: protocolId, auth_token: authToken }), /Invalid local capture pipe/);
await context.rpc.exports.init(null, { pipe_name: pipeName, protocol_id: protocolId, auth_token: authToken });
assert.equal(attached, 0, 'no hook when receiver is absent');
available = true;
await vm.runInContext('connectToHub()', context);
assert.equal(openedHandles.length, 1, 'capture opens a native pipe, without a Socket API');
assert.equal(attached, 0, 'no hook before per-device configuration');
const config = new TextEncoder().encode(JSON.stringify({kind:'configure', auth_token:authToken, devices:['\\device\\000000ee']}) + '\n');
const unauthorized = new TextEncoder().encode(JSON.stringify({kind:'configure', auth_token:'wrong', devices:['\\device\\000000ee']}) + '\n');
reads.shift()(unauthorized.buffer);
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(attached, 0, 'a local listener without the admin-only credential cannot re-enable hooks');
reads.shift()(config.buffer);
const drain = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
await drain();
assert.equal(attached, 2);
const uint = n => ({ toString() { return String(n); }, toUInt32() { return n; } });
const report = {
  isNull() { return false; },
  readByteArray() { readReportCount++; return Uint8Array.from([1,0,0,241,0,128,0,129,0]).buffer; }
};
function invoke({ device=queriedName, ioctl=0x80018483, length=9, status=0 } = {}) {
  queriedName = device;
  const state = {};
  callbacks.onEnter.call(state, [uint(1),null,null,null,null,uint(ioctl),null,null,report,uint(length)]);
  callbacks.onLeave.call(state, uint(status));
}
invoke();
await drain();
assert.equal(sent.filter(item => item.kind === 'gatt_read').length, 1);
assert.equal(sent.at(-1).raw, '010000f10080008100');
assert.equal(sent.at(-1).device, '\\device\\000000ee');
assert.equal(sent.at(-1).protocol_id, protocolId);
invoke({device:'\\Device\\000000ab'}); // Another keyboard in the same WUDFHost.
invoke({device:'\\Device\\000000ee2'}); // Prefix collisions must not match.
invoke({device:'\\Device\\000000ee', ioctl:0x1234});
invoke({length:8});
invoke({status:0x103}); // STATUS_PENDING must never be read as completed data.
await drain();
assert.equal(readReportCount, 1, 'unmatched and incomplete reports were never read');
invoke({device:'\\Device\\UMDFCtrlDev-994dbdab-ab8d-11f1-8320-bcc746e432c3'});
await drain();
assert.equal(readReportCount, 2);
assert.equal(sent.at(-1).scope, 'UMDF_PROXY_UNVERIFIED', 'UMDF proxy must never claim verified RC003 identity');
const oldStream = sent.at(-1).stream;
const closeState = {};
closeCallbacks.onEnter.call(closeState, [uint(1)]);
closeCallbacks.onLeave.call(closeState, uint(0));
await drain();
assert.equal(sent.at(-1).kind, 'stream_closed');
assert.equal(sent.at(-1).stream, oldStream);
invoke();
await drain();
assert.notEqual(sent.at(-1).stream, oldStream, 'reused handles must acquire a new stream identity');
reads.shift()(new ArrayBuffer(0));
await drain();
assert.equal(detached, 2, 'EOF detaches even when no further keys are pressed');
assert.equal(openedHandles[0].closes, 1);
await vm.runInContext('connectToHub()', context);
assert.equal(attached, 2, 'reconnection requires a fresh allowlist');
reads.shift()(config.buffer);
await drain();
assert.equal(attached, 4);
reads.shift()(new ArrayBuffer(0));
await drain();
assert.equal(detached, 4);

const rawConnection = await vm.runInContext('openPipe()', context);
let finishOutputClose;
outputCloseWait = new Promise(resolve => { finishOutputClose = resolve; });
const closing = rawConnection.close();
assert.equal(rawConnection.close(), closing, 'repeated close must share the cleanup');
await drain();
assert.equal(openedHandles.at(-1).closes, undefined, 'handle must outlive pending native I/O');
finishOutputClose();
await closing;
outputCloseWait = null;
assert.equal(openedHandles.at(-1).closes, 1);
failOutput = true;
await assert.rejects(vm.runInContext('openPipe()', context), /output wrapper failed/);
assert.equal(openedHandles.at(-1).closes, 1, 'partial construction must also release the pipe');
failOutput = false;

// Reconnect timers can fire again while Windows is still opening a pipe.
// Exactly one attempt must own the stream on which the helper sends configure.
const pendingConnections = [];
context.openPipe = () => new Promise((resolve, reject) => pendingConnections.push({resolve, reject}));
const attempts = [0, 1, 2].map(() => vm.runInContext('connectToHub()', context));
assert.equal(pendingConnections.length, 1, 'overlapping reconnects must not open competing pipes');

function endpoint() {
  const messages = [], input = [], writes = [];
  let block = false, closed = false;
  return {
    messages, input, writes,
    blockWrites() { block = true; },
    get closed() { return closed; },
    connection: {
      input: { read() { return new Promise(resolve => input.push(resolve)); } },
      output: { async writeAll(bytes) {
        if (block) await new Promise((resolve, reject) => writes.push({resolve, reject}));
        messages.push(JSON.parse(Buffer.from(bytes).toString()));
      } },
      async close() { closed = true; }
    }
  };
}
const first = endpoint();
pendingConnections.shift().resolve(first.connection);
await Promise.all(attempts);
first.input.shift()(config.buffer);
await drain();
assert.equal(first.messages.at(-1).kind, 'ready');

// A write stuck on the previous pipe must not block the next connection.
first.blockWrites();
vm.runInContext('emit({kind:"heartbeat", hook_installed:true})', context);
await drain();
assert.equal(first.writes.length, 1);
first.input.shift()(new ArrayBuffer(0));
await drain();
assert.equal(first.closed, true, 'disconnect closes its pipe');
const reconnect = vm.runInContext('connectToHub()', context);
const second = endpoint();
pendingConnections.shift().resolve(second.connection);
await reconnect;
second.input.shift()(config.buffer);
await drain();
assert.equal(second.messages.at(-1)?.kind, 'ready', 'new readiness must not wait for old writes');
const detachedBeforeStaleWrite = detached;
first.writes.shift().reject(new Error('old pipe closed'));
await drain();
assert.equal(detached, detachedBeforeStaleWrite, 'stale write failure must not detach the new hook');
vm.runInContext('emit({kind:"heartbeat", hook_installed:true})', context);
await drain();
assert.equal(second.messages.at(-1).kind, 'heartbeat');
second.input.shift()(new ArrayBuffer(0));
await drain();
console.log('PASS: Gadget device isolation, completed-report filtering, receiver handshake, idle detach and reconnect.');
