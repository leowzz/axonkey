import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  generateDeviceDescriptors,
  parseDescriptorSvg,
  readBundledDescriptors,
} from '../scripts/generate-device-descriptors.mjs'
import { deviceDescriptors } from '../src/devices/generatedDescriptors.ts'

test('the committed device index is generated from all six protocol SVGs', () => {
  generateDeviceDescriptors({ check: true })
  assert.deepEqual(deviceDescriptors, readBundledDescriptors())
  assert.equal(Object.keys(deviceDescriptors).length, 6)
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
