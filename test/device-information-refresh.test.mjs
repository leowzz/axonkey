import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const source = ts.transpileModule(readFileSync(new URL('../src/devices/integration/useDeviceInstances.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const emptySnapshot = () => ({
  store: { version: 1, revision: 0, instances: [] },
  discovered: [], runtime: {}, error: null, scanError: null, scanning: false,
})
const remote = (id = 'one', extra = {}) => ({
  id, kind: 'rc003', name: id, transport: 'Bluetooth', identityQuality: 'serial',
  vendorId: 0x2717, productId: 0x32b8, connected: true, paired: true,
  bluetoothAddress: `AA:BB:CC:DD:EE:${id === 'one' ? '01' : '02'}`,
  deviceInfo: { status: 'pending', batteryLevel: null }, ...extra,
})
const snapshotWith = (...discovered) => ({ ...emptySnapshot(), discovered })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness({ invoke, listen, native = true, saved } = {}) {
  let controller, listener, view, stops = 0
  const calls = []
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: timer => globalThis.clearTimeout(timer),
    localStorage: { getItem: () => saved ?? null },
    require(name) {
      if (name === 'react') return React
      if (name === './model') return { emptySnapshot }
      if (name === '@tauri-apps/api/core') return { invoke: (command, args) => {
        calls.push([command, args])
        return invoke(command, args)
      } }
      if (name === '@tauri-apps/api/event') return { listen: (name, callback) => {
        assert.equal(name, 'axonkey-device-information')
        listener = callback
        return listen ? listen(() => { stops++ }) : Promise.resolve(() => { stops++ })
      } }
      throw new Error(name)
    },
  })
  function Host() { controller = exports.useDeviceInstances(native); return null }
  return {
    calls,
    get controller() { return controller },
    get stops() { return stops },
    async mount() { await act(async () => { view = Renderer.create(React.createElement(Host)) }) },
    emit(device, deviceInfo) {
      act(() => listener({ payload: { id: device.id, bluetoothAddress: device.bluetoothAddress, deviceInfo } }))
    },
    async unmount() { await act(async () => view.unmount()) },
  }
}

test('device information events show partial battery immediately and do not query a snapshot per field', async () => {
  const first = remote(), second = remote('two')
  const initial = snapshotWith(first, second)
  const host = harness({ invoke: async () => initial })
  await host.mount()
  try {
    const partial = { status: 'pending', batteryLevel: 0, bluetoothName: 'Remote' }
    host.emit(first, partial)
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, partial)
    assert.equal(host.controller.snapshot.discovered[1], second)
    assert.equal(host.controller.snapshot.store, initial.store)
    for (let level = 1; level <= 100; level++) host.emit(first, { ...partial, batteryLevel: level })
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo.batteryLevel, 100)
    assert.equal(host.calls.length, 1, 'events directly update the device without starting snapshot requests')
    const finished = { ...partial, status: 'ready', manufacturer: 'Maker' }
    host.emit(first, finished)
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, finished)
  } finally { await host.unmount() }
})

test('an event received before the initial snapshot survives that snapshot response', async () => {
  const first = remote(), request = deferred()
  const host = harness({ invoke: () => request.promise })
  await host.mount()
  try {
    const partial = { status: 'pending', batteryLevel: 54 }
    host.emit(first, partial)
    assert.equal(host.controller.loaded, false)
    await act(async () => request.resolve(snapshotWith(first)))
    assert.equal(host.controller.loaded, true)
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, partial)
  } finally { await host.unmount() }
})

test('snapshots replay only information events received during their request', async () => {
  const first = remote(), second = remote('two')
  let next = Promise.resolve(snapshotWith(first, second))
  const host = harness({ invoke: () => next })
  await host.mount()
  try {
    const request = deferred()
    next = request.promise
    let refresh
    act(() => { refresh = host.controller.refresh() })
    host.emit(first, { status: 'pending', batteryLevel: 76 })
    const finished = { status: 'ready', batteryLevel: 76, firmwareRevision: '1.2' }
    host.emit(first, finished)
    await act(async () => { request.resolve(snapshotWith(first, second)); await refresh })
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, finished)
    assert.equal(host.controller.snapshot.discovered[1], second)
    const latest = { ...first, deviceInfo: { status: 'retrying', batteryLevel: 75, error: 'temporarily unavailable' } }
    next = Promise.resolve(snapshotWith(latest, second))
    await act(async () => host.controller.refresh())
    assert.equal(host.controller.snapshot.discovered[0], latest, 'a later snapshot can supply new data without an old event overlay')
  } finally { await host.unmount() }
})

test('manual refresh acknowledgements cannot erase information delivered while the command was pending', async () => {
  const first = remote(), request = deferred()
  const initial = snapshotWith(first)
  const host = harness({ invoke: command => command === 'device_snapshot' ? Promise.resolve(initial) : request.promise })
  await host.mount()
  try {
    let refresh
    act(() => { refresh = host.controller.refreshInformation(first.id) })
    const finished = { status: 'ready', batteryLevel: 30, serialNumber: 'serial-one' }
    host.emit(first, finished)
    await act(async () => { request.resolve(initial); await refresh })
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, finished)
    assert.equal(host.controller.error, '')
    assert.equal(host.calls[1][0], 'refresh_device_information')
    assert.equal(host.calls[1][1].binding, first.id)
  } finally { await host.unmount() }
})

test('configuration save responses preserve information events and still update the store', async () => {
  const first = remote(), request = deferred()
  const initial = snapshotWith(first)
  const host = harness({ invoke: command => command === 'device_snapshot' ? Promise.resolve(initial) : request.promise })
  await host.mount()
  try {
    const instance = { id: 'saved', binding: first.id }
    let save
    await act(async () => { save = host.controller.put(instance) })
    const partial = { status: 'pending', batteryLevel: 54 }
    host.emit(first, partial)
    const stored = { ...initial, store: { ...initial.store, revision: 1, instances: [instance] } }
    await act(async () => { request.resolve(stored); await save })
    assert.equal(host.controller.snapshot.store, stored.store)
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo, partial)
    assert.equal(host.controller.busy, false)
  } finally { await host.unmount() }
})

test('events do not write readings to disconnected, ambiguous, or different-address devices', async () => {
  const devices = [
    remote('one', { connected: false }),
    remote('two', { identityQuality: 'ambiguous' }),
    remote('three'),
  ]
  const host = harness({ invoke: async () => snapshotWith(...devices) })
  await host.mount()
  try {
    host.emit(devices[0], { status: 'ready', batteryLevel: 10 })
    host.emit(devices[1], { status: 'ready', batteryLevel: 20 })
    host.emit({ ...devices[2], bluetoothAddress: 'AA:BB:CC:DD:EE:FF' }, { status: 'ready', batteryLevel: 30 })
    for (let index = 0; index < devices.length; index++) {
      assert.equal(host.controller.snapshot.discovered[index], devices[index])
    }
  } finally { await host.unmount() }
})

test('polling remains available when event subscription fails and never overlaps its previous poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = remote(), request = deferred()
  let next = request.promise
  const host = harness({ invoke: () => next, listen: async () => { throw new Error('no event capability') } })
  await host.mount()
  try {
    await act(async () => t.mock.timers.tick(5000))
    assert.equal(host.calls.length, 1)
    await act(async () => request.resolve(snapshotWith(first)))
    next = Promise.resolve(snapshotWith({ ...first, deviceInfo: { status: 'ready', batteryLevel: 65 } }))
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(host.calls.length, 2)
    assert.equal(host.controller.snapshot.discovered[0].deviceInfo.batteryLevel, 65)
  } finally { await host.unmount() }
  await act(async () => t.mock.timers.tick(5000))
  assert.equal(host.calls.length, 2)
})

test('unmount handles an event listener that finishes registering later and stops in-flight polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const request = deferred(), subscription = deferred()
  let stop
  const host = harness({ invoke: () => request.promise, listen: unlisten => {
    stop = unlisten
    return subscription.promise
  } })
  await host.mount()
  await host.unmount()
  await act(async () => {
    subscription.resolve(stop)
    request.resolve(snapshotWith(remote()))
  })
  assert.equal(host.stops, 1)
  await act(async () => t.mock.timers.tick(5000))
  assert.equal(host.calls.length, 1)
})

test('preview mode loads its store without subscribing or starting native polling', async () => {
  const store = { version: 1, revision: 2, instances: [{ id: 'preview' }] }
  const host = harness({ native: false, saved: JSON.stringify(store) })
  await host.mount()
  try {
    assert.equal(host.controller.loaded, true)
    assert.equal(host.controller.snapshot.store.instances[0].id, 'preview')
    assert.equal(host.calls.length, 0)
    assert.equal(host.stops, 0)
  } finally { await host.unmount() }
})
