import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  generateDeviceDescriptors,
  parseDescriptorSvg,
  readBundledDescriptors,
} from '../scripts/generate-device-descriptors.mjs'
import { deviceDescriptors } from '../src/devices/generatedDescriptors.ts'

test('the committed device index is generated from all thirteen protocol SVGs', () => {
  generateDeviceDescriptors({ check: true })
  assert.deepEqual(deviceDescriptors, readBundledDescriptors())
  assert.equal(Object.keys(deviceDescriptors).length, 13)
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
  assert.deepEqual(deviceDescriptors['tcl-rc802a'].voice, {
    engine: 'tcl-rc802a.ico',
    transport: 'hid-report',
    triggerModes: ['hold'],
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
  assert.equal(deviceDescriptors['hisense-rcf3b65'].voice, null)
  assert.equal(deviceDescriptors['phicomm-db1-r'].voice, null)
  assert.equal(deviceDescriptors['kivo-k18-lite'].voice, null)
  assert.equal(deviceDescriptors['g17-touch'].voice, null)
  assert.equal(deviceDescriptors['hisense-rcf3b65'].inputs.length, 18)
  assert.equal(deviceDescriptors['phicomm-db1-r'].inputs.length, 12)
  assert.equal(deviceDescriptors['kivo-k18-lite'].inputs.length, 18)
  assert.equal(deviceDescriptors['g17-touch'].inputs.length, 23)
  assert.deepEqual(deviceDescriptors['kivo-k18-lite'].identities, [
    {
      vendorIds: [0x2e8a],
      productIds: [0xa018],
      softwareContains: '',
      softwareFallback: false,
      windowsPrefix: '',
      informationRequired: false,
      modelContains: '',
      manufacturerContains: '',
    },
  ])
  assert.deepEqual(
    deviceDescriptors['kivo-k18-lite'].inputs.map(input => ({
      id: input.id,
      stableId: input.stableId,
      label: input.label,
      short: input.short,
    })),
    Array.from({ length: 18 }, (_, index) => {
      const code = String(index + 1).padStart(2, '0')
      return {
        id: `kivo.k18Lite.k${code}`,
        stableId: `kivo.k18Lite.k${code}`,
        label: `K${code}`,
        short: `K${code}`,
      }
    }),
  )
  for (const descriptor of Object.values(deviceDescriptors)) {
    assert.ok(descriptor.identities.length >= 1, `${descriptor.id} must declare runtime identity`)
    if (descriptor.id !== 'kivo.k18Lite' && descriptor.id !== 'g17.touch') {
      assert.ok(descriptor.identities.every(identity => identity.windowsPrefix))
    }
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

test('Kivo K18 Lite SVG has a flat top enclosure edge and exact keycap-to-region alignment', () => {
  const source = readFileSync(new URL('../public/device-descriptors/kivo-k18-lite.svg', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /usbc|kivo-k18-usbc-port/i)
  assert.deepEqual(deviceDescriptors['kivo-k18-lite'].viewBox, { width: 600, height: 496 })
  const regionsTag = source.match(/<g\b[^>]*\bdata-ak-regions=["']true["'][^>]*>/)?.[0] ?? ''
  assert.ok(regionsTag)
  assert.doesNotMatch(regionsTag, /\btransform=/)

  const shellRect = source.match(/<g id="kivo-k18-shell"[\s\S]*?<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/)
  assert.ok(shellRect)
  const [, shellX, shellY, shellW, shellH] = shellRect.map(Number)
  assert.deepEqual([shellX, shellY, shellW, shellH], [8, 8, 584, 480])

  for (const input of deviceDescriptors['kivo-k18-lite'].inputs) {
    const suffix = input.id.split('.').pop()
    const keyGroup = source.match(new RegExp(`<g id="key-${suffix}"[\\s\\S]*?<\\/g>`))?.[0] ?? ''
    const hit = keyGroup.match(/<rect class="hit" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"/)
    assert.ok(hit, `missing hit rect for ${input.id}`)
    const [, x, y, w, h, rx] = hit.map(Number)
    assert.equal(y > shellY, true)
    assert.deepEqual(input.anchor, { x: x + w / 2, y: y + h / 2 })
    const expectedPath = `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${rx} 0 0 1 ${x + w} ${y + rx} V ${y + h - rx} A ${rx} ${rx} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${rx} 0 0 1 ${x} ${y + h - rx} V ${y + rx} A ${rx} ${rx} 0 0 1 ${x + rx} ${y} Z`
    assert.equal(input.path, expectedPath)
  }
})
