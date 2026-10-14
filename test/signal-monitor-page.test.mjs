import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../public/bluetooth-signal.html', import.meta.url), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1]
function harness() {
  const elements = new Map(), calls = []
  function element(id = '') {
    if (elements.has(id)) return elements.get(id)
    const el = { style: {}, dataset: {}, handlers: {}, children: [], textContent: '',
      addEventListener(name, fn) { this.handlers[name] = fn },
      setAttribute() {}, getBoundingClientRect() { return { width: 500, left: 0 } },
      replaceChildren(...items) { this.children = items }, append(item) { this.children.push(item) },
      querySelector() { return element('svg') }, click() {}, offsetWidth: 180 }
    elements.set(id, el)
    return el
  }
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(Symbol()) },
    window: { __TAURI__: { core: { invoke: (command, args) => new Promise((resolve, reject) => calls.push({ command, args, resolve, reject })) } }, addEventListener() {} },
    performance, Intl, Date, structuredClone, setTimeout() {}, Blob, URL,
  })
  vm.runInContext(source, context)
  return { context, elements, calls, run: script => vm.runInContext(script, context) }
}
function state(now = 1000, generation = 1) {
  return { now, generation, startedAt: 1000,
    bluetooth: { status: 'live', lastSampleAt: now, samples: [{ t: now, rssi: -48 }] },
    audio: { status: 'live', lastSampleAt: now, samples: [{ t: now, pps: 50, underruns: 1, sessionId: 1 }] },
    queue: { status: 'live', samples: [{ t: now, samples: 0, peakSamples: 4096, capacity: 4096, queuedMs: 0, peakMs: 256, capacityMs: 256, emptied: 1, full: 1, resets: 0, discarded: 0, underruns: 1, state: 'empty' }] } }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
test('incremental series retain history, deduplicate, and reset with the backend generation', async () => {
  const h = harness(); h.calls[0].resolve(state()); await settle()
  h.context.next = state(1200)
  h.run('feed=mergeFeed(feed,next); feed=mergeFeed(feed,next); render()')
  assert.equal(h.run('feed.queue.samples.length'), 2)
  assert.equal(h.elements.get('queued').textContent, '0.0')
  assert.match(h.elements.get('queue-peak').textContent, /256.0/)
  assert.match(h.elements.get('queue-events').children[0].textContent, /容量不足/)
  h.context.next = state(1400, 2)
  h.run('feed=mergeFeed(feed,next)')
  assert.equal(h.run('feed.queue.samples.length'), 1)
})
test('clearing while paused ignores an older in-flight reply and preserves playback commands', async () => {
  const h = harness(); h.calls[0].resolve(state()); await settle()
  h.elements.get('pause').handlers.click()
  h.run('poll()') // request started before the clear
  const old = h.calls[1]
  const clear = h.elements.get('clear').handlers.click()
  assert.equal(h.calls[2].args.clear, true)
  h.calls[2].resolve(state(1200, 2)); await clear
  old.resolve(state(1100)); await settle()
  assert.equal(h.run('frozen'), null)
  assert.equal(h.run('feed.now'), 1200)
  assert.equal(h.run('feed.queue.samples.length'), 0)
  assert.ok(h.calls.every(call => call.command === 'get_signal_monitor_state'))
  h.context.next = state(1400, 2)
  h.run('feed=mergeFeed(feed,next); render()')
  assert.equal(h.run('feed.queue.samples.length'), 1)
})
test('clear failure retains history and the paused view', async () => {
  const h = harness(); h.calls[0].resolve(state()); await settle()
  h.elements.get('pause').handlers.click()
  const clear = h.elements.get('clear').handlers.click()
  h.calls[1].reject(new Error('unavailable')); await clear
  assert.equal(h.run('feed.queue.samples.length'), 1)
  assert.notEqual(h.run('frozen'), null)
  assert.match(h.elements.get('marker-help').textContent, /清空失败/)
})
test('CSV includes millisecond timestamps, capacity and transient queue events', async () => {
  const h = harness(); h.calls[0].resolve(state(1234)); await settle()
  const exporting = h.elements.get('export').handlers.click()
  assert.equal(h.calls[1].command, 'export_signal_monitor')
  assert.match(h.calls[1].args.content, /\.234,队列,,,0,4096,4096,1,1,0,0,1/)
  h.calls[1].resolve(true); await exporting
})
