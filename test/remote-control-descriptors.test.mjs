import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  generateDeviceDescriptors,
  parseDescriptorSvg,
  readBundledDescriptors,
} from '../scripts/generate-device-descriptors.mjs'
import { deviceDescriptors } from '../src/devices/generatedDescriptors.ts'

test('the committed device index is generated from all nine protocol SVGs', () => {
  generateDeviceDescriptors({ check: true })
  assert.deepEqual(deviceDescriptors, readBundledDescriptors())
  assert.equal(Object.keys(deviceDescriptors).length, 9)
  for (const descriptor of Object.values(deviceDescriptors)) {
    assert.equal(new Set(descriptor.inputs.map(input => input.id)).size, descriptor.inputs.length)
    for (const input of descriptor.inputs) {
      assert.ok(input.path)
      assert.ok(input.anchor.x >= 0 && input.anchor.x <= descriptor.viewBox.width)
      assert.ok(input.anchor.y >= 0 && input.anchor.y <= descriptor.viewBox.height)
    }
  }
})

test('stable RC003 protocol IDs retain existing saved mapping IDs', () => {
  const { inputs } = deviceDescriptors.rc003
  assert.equal(inputs[0].id, 'power')
  assert.equal(inputs[1].id, 'voice')
  assert.equal(inputs.find(input => input.id === 'confirm').stableId, 'xiaomi.rc003.confirm')
})

test('legacy alias lists retain the same primary saved mapping ID as the native registry', () => {
  const source = readFileSync(new URL('../public/device-descriptors/rc003.svg', import.meta.url), 'utf8')
  const descriptor = parseDescriptorSvg(
    source.replace('legacy-key="power"', 'legacy-key=" power  oldPower "'),
    '/test.svg',
  )
  assert.equal(descriptor.inputs[0].id, 'power')
  assert.equal(descriptor.inputs[0].stableId, 'xiaomi.rc003.power')
})

test('identity hardware and software recognition fields come from protocol metadata', () => {
  const source = readFileSync(new URL('../public/device-descriptors/cmiot-a15.svg', import.meta.url), 'utf8')
  const descriptor = parseDescriptorSvg(
    source.replaceAll('CMIOT3_B311', 'future-software').replaceAll('vid="0x0416"', 'vid="0x010416 0x1234"'),
    '/test.svg',
  )
  assert.deepEqual(descriptor.identities[0].vendorIds, [0x0416, 0x1234])
  assert.deepEqual(descriptor.identities[0].productIds, [0x0300])
  assert.equal(descriptor.identities[0].softwareContains, 'future-software')
  assert.equal(descriptor.identities[0].softwareFallback, false)
  assert.ok(deviceDescriptors.rc313.identities.every(identity => identity.softwareFallback))
})

test('voice capabilities and analog trigger settings are generated from the SVG declarations', () => {
  assert.deepEqual(deviceDescriptors['cmiot-a15'].voice, {
    engine: 'cmiot-a15.g7221',
    transport: 'hid-report',
    triggerModes: ['hold', 'click'],
  })
  for (const id of ['tcl-rc902n', 'tcl-rc902v']) {
    assert.deepEqual(deviceDescriptors[id].voice, {
      engine: 'tcl-rc902v-atvv',
      transport: 'gatt',
      triggerModes: ['hold', 'click'],
    })
  }
  assert.equal(deviceDescriptors.rc003.voice.transport, 'gatt')
  assert.equal(deviceDescriptors.xbox.voice, null)
  for (const descriptor of Object.values(deviceDescriptors)) {
    assert.ok(descriptor.identities.every(identity => identity.windowsPrefix))
  }
  assert.deepEqual(
    deviceDescriptors.xbox.inputs
      .filter(input => input.kind === 'trigger')
      .map(input => ({
        id: input.id,
        short: input.short,
        threshold: input.threshold,
        releaseThreshold: input.releaseThreshold,
      })),
    [
      { id: 'xbox.lt', short: 'LT', threshold: 0.55, releaseThreshold: 0.35 },
      { id: 'xbox.rt', short: 'RT', threshold: 0.55, releaseThreshold: 0.35 },
    ],
  )
})

test('analog thresholds also follow a nested source declaration', () => {
  const source = readFileSync(new URL('../public/device-descriptors/xbox.svg', import.meta.url), 'utf8')
  const nested = source.replace(
    /<ak:input id="xbox.lt"[^>]*\/>/,
    input =>
      input.replace(' threshold="0.55" release-threshold="0.35"', '').replace(' />', '>') +
      '<ak:source report="controller" engine="xbox.axis-u16" field="axis" offset="9" min="0" max="1023" threshold="0.7" release-threshold="0.4" /></ak:input>',
  )
  const input = parseDescriptorSvg(nested, '/test.svg').inputs.find(input => input.id === 'xbox.lt')
  assert.equal(input.threshold, 0.7)
  assert.equal(input.releaseThreshold, 0.4)
})

test('descriptor generation rejects inputs without an accurate interactive region', () => {
  const source = readFileSync(new URL('../public/device-descriptors/rc003.svg', import.meta.url), 'utf8')
  assert.throws(
    () =>
      parseDescriptorSvg(
        source.replace('data-ak-region="xiaomi.rc003.power"', 'data-ak-region="unknown"'),
        '/test.svg',
      ),
    /needs a unique ID/,
  )
  assert.throws(
    () => parseDescriptorSvg(source.replace('data-ak-anchor="132 162"', 'data-ak-anchor="invalid"'), '/test.svg'),
    /invalid or duplicate region/,
  )
})

test('hidden protocol inputs are retained in metadata without changing visible mapping regions', () => {
  const source = readFileSync(new URL('../public/device-descriptors/rc003.svg', import.meta.url), 'utf8')
  const hidden =
    '<ak:input id="xiaomi.rc003.hidden" label="Hidden input" kind="button" report="keyboard" page="0x07" usage="0x65" />'
  const descriptor = parseDescriptorSvg(source.replace('</ak:inputs>', `${hidden}</ak:inputs>`), '/test.svg')
  assert.deepEqual(descriptor.inputs, deviceDescriptors.rc003.inputs)
})
