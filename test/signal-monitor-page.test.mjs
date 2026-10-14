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

test('waveform replaces unfinished bins, renders silence without bridging gaps, and clears with history', async () => {
  const h = harness(), first = state(1200)
  first.waveform = { samples: [{ t: 1000, min: -32768, max: 32767, count: 240 }, { t: 1100, min: 0, max: 0, count: 240 }] }
  h.calls[0].resolve(first); await settle()
  const next = state(1400)
  next.waveform = { samples: [{ t: 1100, min: -10, max: 20, count: 480 }] }
  h.context.next = next
  h.run('feed=mergeFeed(feed,next); render()')
  assert.equal(h.run('feed.waveform.samples.length'), 2)
  assert.equal(h.run('feed.waveform.samples[1].count'), 480)
  assert.equal(h.elements.get('waveform-empty').hidden, true)
  assert.match(h.elements.get('waveform-summary').textContent, /0.0 dBFS/)
  const path = h.elements.get('waveform-chart').innerHTML.split('<path').at(-1)
  assert.match(path, /M.*V/)
  assert.doesNotMatch(path, /L[0-9]/) // Each bin is separate, including across gaps.
  h.elements.get('pause').handlers.click()
  const clear = h.elements.get('clear').handlers.click()
  h.calls.at(-1).resolve(state(1600, 2)); await clear
  assert.equal(h.run('feed.waveform.samples.length'), 0)
  assert.equal(h.elements.get('waveform-empty').hidden, false)
})
test('CSV exports waveform envelopes without PCM audio', async () => {
  const h = harness(), s = state(1200)
  s.waveform = { samples: [{ t: 1100, min: -20, max: 40, count: 240 }] }
  h.calls[0].resolve(s); await settle()
  const exporting = h.elements.get('export').handlers.click()
  const call = h.calls.at(-1)
  assert.equal(call.command, 'export_signal_monitor')
  assert.match(call.args.content, /波形最小值/)
  assert.match(call.args.content, /音频波形,.*-20,40,240/)
  call.resolve(true); await exporting
})

test('waveform scales quiet speech to readable height while keeping silence and full-scale bounded', async () => {
 const h=harness(); h.calls[0].resolve(state()); await settle()
 assert.equal(h.run('waveformScale([])'), .01)
 assert.equal(h.run('waveformScale([{min:0,max:0}])'), .01)
 assert.equal(h.run('waveformScale([{min:-32768,max:32767}])'), 1)
 const scale=h.run('waveformScale([{min:-500,max:800}])')
 assert.equal(scale, 800/32768*1.05)
 assert.equal(h.run('waveformScale([{min:-1,max:1}])'), 1/32768*1.05)
 assert.ok(h.run('waveformScale([{min:-50,max:80}])')<scale)
 h.run('plotWaveform([{t:1000,min:-500,max:800}])')
 const svg=h.elements.get('waveform-chart').innerHTML
 assert.match(svg, />0.0256<\/text>/)
 assert.doesNotMatch(svg, /NaN|Infinity/)
})
