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
let noDelayConnections = 0;
const context = vm.createContext({
  Uint8Array, ArrayBuffer, Promise, JSON, String, Error,
  setTimeout() { return 1; }, setInterval() { return 1; },
  Process: { id: 42, pointerSize: 8, findModuleByName() { return { findExportByName(name) { return name; } }; } },
  NativeFunction: function () { return () => 0; },
  Memory: { alloc() { return {
    readU16() { return queriedName.length * 2; },
    add() { return { readPointer() { return { isNull() { return false; }, readUtf16String() { return queriedName; } }; } }; }
  }; } },
  Interceptor: { attach(_target, listeners) { if (_target === "NtClose") closeCallbacks = listeners; else callbacks = listeners; attached++; return { detach() { detached++; } }; } },
  Socket: { async connect() {
    if (!available) throw new Error('receiver absent');
    return {
      async setNoDelay(enabled) { assert.equal(enabled, true); noDelayConnections++; },
      output: { async writeAll(bytes) { sent.push(JSON.parse(Buffer.from(bytes).toString())); } },
      input: { read() { return new Promise(resolve => reads.push(resolve)); } },
      async close() {}
    };
  } },
  rpc: { exports: {} }
});
vm.runInContext(script, context);
const authToken = 'a'.repeat(64);
await context.rpc.exports.init(null, { port: 30685, protocol_id: 'test-revision', auth_token: authToken });
assert.equal(attached, 0, 'no hook when receiver is absent');
available = true;
await vm.runInContext('connectToHub()', context);
assert.equal(noDelayConnections, 1, 'disable TCP packet coalescing before activating capture');
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
assert.equal(sent.at(-1).protocol_id, 'test-revision');
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
await vm.runInContext('connectToHub()', context);
assert.equal(attached, 2, 'reconnection requires a fresh allowlist');
reads.shift()(config.buffer);
await drain();
assert.equal(attached, 4);
reads.shift()(new ArrayBuffer(0));
await drain();
assert.equal(detached, 4);

// Reconnect timers can fire again while Windows is still opening a socket.
// Exactly one attempt must own the stream on which the helper sends configure.
const pendingConnections = [];
context.Socket.connect = () => new Promise((resolve, reject) => pendingConnections.push({resolve, reject}));
const attempts = [0, 1, 2].map(() => vm.runInContext('connectToHub()', context));
assert.equal(pendingConnections.length, 1, 'overlapping reconnects must not open competing sockets');

function endpoint() {
  const messages = [], input = [], writes = [];
  let block = false, closed = false, noDelay = false;
  return {
    messages, input, writes,
    blockWrites() { block = true; },
    get closed() { return closed; },
    connection: {
      async setNoDelay(enabled) { assert.equal(enabled, true); noDelay = true; },
      input: { read() { return new Promise(resolve => input.push(resolve)); } },
      output: { async writeAll(bytes) {
        assert.equal(noDelay, true, 'every replacement socket must send small reports immediately');
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

// A write stuck on the previous socket must not block the next connection.
first.blockWrites();
vm.runInContext('emit({kind:"heartbeat", hook_installed:true})', context);
await drain();
assert.equal(first.writes.length, 1);
first.input.shift()(new ArrayBuffer(0));
await drain();
assert.equal(first.closed, true, 'disconnect closes its socket');
const reconnect = vm.runInContext('connectToHub()', context);
const second = endpoint();
pendingConnections.shift().resolve(second.connection);
await reconnect;
second.input.shift()(config.buffer);
await drain();
assert.equal(second.messages.at(-1)?.kind, 'ready', 'new readiness must not wait for old writes');
const detachedBeforeStaleWrite = detached;
first.writes.shift().reject(new Error('old socket closed'));
await drain();
assert.equal(detached, detachedBeforeStaleWrite, 'stale write failure must not detach the new hook');
vm.runInContext('emit({kind:"heartbeat", hook_installed:true})', context);
await drain();
assert.equal(second.messages.at(-1).kind, 'heartbeat');
second.input.shift()(new ArrayBuffer(0));
await drain();
console.log('PASS: Gadget device isolation, completed-report filtering, receiver handshake, idle detach and reconnect.');
