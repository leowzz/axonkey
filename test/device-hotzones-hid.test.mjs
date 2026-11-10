import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../docs/device-drafts/device-hotzones.html', import.meta.url), 'utf8')
const script = html.match(/<script id="hid-codec">([\s\S]*?)<\/script>/)[1]
const codec = vm.runInNewContext(script + '\nHidCapture')
const plain = value => JSON.parse(JSON.stringify(value))
const reportsFor = filename => {
  const svg = readFileSync(new URL(`../public/device-descriptors/${filename}`, import.meta.url), 'utf8')
  return [...svg.matchAll(/<ak:report\b([^>]+)>/g)].map(match => codec.readReport(Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]),
  )))
}

test('raw HID hex accepts spaced, prefixed and compact bytes without truncating malformed input', () => {
  for (const text of ['03 3a 00', '0x03, 0x3a, 0x00', '033a00', '03\n3A\t00']) {
    assert.deepEqual(plain(codec.parseHex(text)), { bytes: [3, 58, 0], hex: '03 3A 00' })
  }
  assert.equal(codec.parseHex('  '), null)
  for (const text of ['3 3A 00', '03 3G 00', '033A0', '-1', '03,', '0x100']) {
    assert.throws(() => codec.parseHex(text), /两位 hex/)
  }
})

test('unknown drafts retain exact samples without inventing a Usage Page or Report ID', () => {
  const result = codec.analyze('03 3A 00', '03 00 00', [])
  assert.equal(result.valid, true)
  assert.equal(result.press.sample.hex, '03 3A 00')
  assert.equal(result.release.sample.hex, '03 00 00')
  assert.equal(result.press.decoded.report, undefined)
  assert.equal(result.binding, null)
})

test('RC003 press and release resolve the real report layout and isolate a newly pressed usage', () => {
  const reports = reportsFor('rc003.svg')
  const result = codec.analyze('01 66 00 00 00 00 00', '01 00 00 00 00 00 00', reports)
  assert.deepEqual(plain(result.binding), { report: 'keyboard', page: 7, usage: 0x66 })
  const held = codec.analyze('01 52 00 28 00 00 00', '01 52 00 00 00 00 00', reports)
  assert.deepEqual(plain(held.binding), { report: 'keyboard', page: 7, usage: 0x28 })
  const noId = codec.analyze('52 00 00 00 00 00', '00 00 00 00 00 00', reports)
  assert.deepEqual(plain(noId.binding), { report: 'keyboard-no-id', page: 7, usage: 0x52 })
})

test('the 3-byte consumer report uses its declared page rather than a keyboard page assumption', () => {
  const result = codec.analyze('03 3A 00', '03 00 00', reportsFor('cmiot-a15.svg'))
  assert.deepEqual(plain(result.binding), { report: 'consumer', page: 0x0c, usage: 0x3a })
})

test('Boot Keyboard defaults skip modifier and reserved bytes with and without a Report ID', () => {
  for (const withId of [false, true]) {
    const report = codec.readReport({
      id: 'boot', direction: 'input', encoding: 'boot-keyboard', 'usage-page': '0x07',
      ...(withId ? { 'report-id': '0x01' } : {}),
    })
    const prefix = withId ? '01 ' : ''
    const result = codec.analyze(prefix + '04 00 66 00 00 00 00 00', prefix + '04 00 00 00 00 00 00 00', [report])
    assert.deepEqual(plain(result.binding), { report: 'boot', page: 7, usage: 0x66 })
  }
})

test('RC003 equal-length report variants use prefix and prefix-not to choose the decoder', () => {
  const reports = reportsFor('rc003.svg')
  const header = codec.analyze('01 00 00 66 00 00 00 00 00', '01 00 00 00 00 00 00 00 00', reports)
  assert.deepEqual(plain(header.binding), { report: 'keyboard-header', page: 7, usage: 0x66 })
  const fourSlots = codec.analyze('01 66 00 00 00 00 00 00 00', '01 52 00 00 00 00 00 00 00', reports)
  assert.equal(fourSlots.press.decoded.report.id, 'keyboard-four-slots')
  assert.equal(fourSlots.binding, null)
  const sharedRelease = codec.analyze('01 66 00 00 00 00 00 00 00', '01 00 00 00 00 00 00 00 00', reports)
  assert.deepEqual(plain(sharedRelease.binding), { report: 'keyboard-four-slots', page: 7, usage: 0x66 })
})

test('ambiguous keys, malformed samples and unsupported encodings never produce a binding', () => {
  const reports = reportsFor('rc003.svg')
  for (const [press, release] of [
    ['01 52 00 28 00 00 00', '01 00 00 00 00 00 00'],
    ['01 52 00 00 00 00 00', '01 28 00 00 00 00 00'],
    ['01 52 00 00 00 00 00', ''],
    ['01 52 00 00 00 00 00', '01 52 00 00 00 00 00'],
    ['00 00 01 00 00 00 00 00', '00 00 00 00 00 00 00 00'],
  ]) assert.equal(codec.analyze(press, release, reports).binding, null)
  assert.equal(codec.analyze('01 66 00 00 00 00 00', '01 GG', reports).valid, false)
  const duplicate = codec.analyze('01 66 00 00 00 00 00', '01 00 00 00 00 00 00', [...reports, reports[0]])
  assert.equal(duplicate.binding, null)
  const xbox = codec.analyze('02 01', '02 00', reportsFor('xbox.svg'))
  assert.equal(xbox.binding, null)
})
