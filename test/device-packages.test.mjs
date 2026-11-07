import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DevicePackageRegistry, devicePackages, loadDeviceCatalog } from '../src/devices/packages.ts'
import { supportPackages, packageFor, newInstance, mobileRemoteKindForSoftware } from '../src/devices/integration/model.ts'

const source = JSON.parse(readFileSync(new URL('../device-packages/builtin.json', import.meta.url), 'utf8'))
const invalid = JSON.parse(readFileSync(new URL('./fixtures/device-catalog-invalid.json', import.meta.url), 'utf8'))

test('registers local declarations by package identity without a compiled model union', () => {
  const catalog = structuredClone(source)
  catalog.packages[1].id = 'lab.rc003'
  catalog.hardware[1].initialPackageId = 'lab.rc003'
  const registry = new DevicePackageRegistry(catalog)
  assert.equal(registry.get('lab.rc003').adapter, 'rc003')
  assert.equal(registry.forHardware(0x2717, 0x32b8).initialPackageId, 'lab.rc003')
  assert.throws(() => registry.get('rc003'), /未知设备支持包/)
  assert.equal(devicePackages.get('rc003').id, 'rc003')
})

for (const fixture of invalid) {
  test(`catalog rejects ${fixture.name} at its loading boundary`, () => {
    const catalog = structuredClone(source)
    let parent = catalog
    for (const part of fixture.path.slice(0, -1)) parent = parent[part]
    const key = fixture.path.at(-1)
    if (fixture.remove) delete parent[key]
    else parent[key] = fixture.value
    assert.throws(() => loadDeviceCatalog(catalog), /设备支持包/)
  })
}

test('runtime packages expose complete inputs and local artwork at the original scale', () => {
  assert.deepEqual(supportPackages.map(pkg => pkg.kind), ['xboxBluetooth', 'rc003', 'cmiotA15', 'xmBt29', 'rc313', 'obeRcuR5'])
  for (const pkg of supportPackages) {
    const svg = readFileSync(new URL(`../public${pkg.artwork}`, import.meta.url), 'utf8')
    if (!pkg.remoteView) continue
    const view = pkg.remoteView
    assert.ok(svg.includes(`viewBox="0 0 ${view.viewBox.width} ${view.viewBox.height}"`), pkg.kind)
    assert.deepEqual(Object.keys(view.keyRegions).sort(), pkg.inputs.map(input => input.id).sort())
    assert.ok(pkg.inputs.every(input => view.keyRegions[input.id].path.length > 0))
  }
  assert.throws(() => packageFor('missing'), /未知设备支持包/)
})

test('shared hardware resolves software variants while saved input IDs remain unchanged', () => {
  assert.equal(mobileRemoteKindForSoftware('XFRSD0D_M_R01_761_debug'), 'xmBt29')
  assert.equal(mobileRemoteKindForSoftware('unknown'), null)
  assert.equal(mobileRemoteKindForSoftware(null), null)
  assert.deepEqual(packageFor('rc313').inputs.map(input => input.id), packageFor('cmiotA15').inputs.map(input => input.id))
  assert.ok(packageFor('xmBt29').inputs.some(input => input.id === 'cmiotA15.power'))
  assert.ok(packageFor('xmBt29').inputs.some(input => input.id === 'xmBt29.delete'))
  assert.equal(packageFor('xmBt29').inputs.length, 28)
  assert.equal(packageFor('rc003').inputs.length, 13)
  assert.equal(packageFor('xboxBluetooth').inputs.length, 25)
  for (const id of ['xmBt29', 'rc313', 'obeRcuR5']) assert.equal(newInstance(id, null).cmiotA15RecordingMode, 'hold')
  assert.equal(newInstance('cmiotA15', null).cmiotA15RecordingMode, 'click')
})
