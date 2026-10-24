import assert from 'node:assert/strict'
import test from 'node:test'
import { devices, deviceForInput, mouseInputIds, mouseInputId, mouseScopesForControl, remoteButtonIds } from '../src/deviceModel.ts'
import { createBehavior, createDefaultBehaviorMap, createMappingExport, parseMappingImport, parseStoredBehaviors, updateBehaviorList } from '../src/behaviorModel.ts'
import { behaviorHistoryReducer, createBehaviorHistory } from '../src/behaviorHistory.ts'
import { extractDeviceBehaviors } from '../src/deviceProfiles.ts'

test('legacy remote settings gain empty mouse mappings without losing remote behavior', () => {
  const parsed = parseStoredBehaviors({ mappings: { voice: 'Ctrl+Space', power: 'original' } })
  assert.deepEqual(parsed.voice.click[0].keys, ['Ctrl', 'Space'])
  assert.deepEqual(parsed.power.click, [])
  for (const id of mouseInputIds) assert.deepEqual(parsed[id], { click: [], doubleClick: [], longPress: [] })
})

test('each device transfer round trips its owned inputs without exporting another device', () => {
  let map = createDefaultBehaviorMap()
  mouseInputIds.forEach((id, index) => {
    map = updateBehaviorList(map, id, 'click', () => [createBehavior({ type: 'key', key: ['Up', 'Down', 'Left', 'Right'][index % 4] })])
  })
  const transfer = createMappingExport(map, true, undefined, undefined, 'mouse')
  const imported = parseMappingImport(JSON.stringify(transfer), 'mouse')
  assert.equal(transfer.version, 2)
  assert.equal(transfer.deviceId, 'mouse')
  assert.deepEqual(Object.keys(transfer.behaviors), mouseInputIds)
  assert.deepEqual(imported.behaviors, extractDeviceBehaviors(map, 'mouse'))
  assert.equal(imported.enabled, true)
  const remote = createMappingExport(map, true)
  assert.deepEqual(Object.keys(remote.behaviors), remoteButtonIds)
  assert.equal(parseMappingImport(remote).behaviors.power.click[0].key, 'Esc')
  assert.deepEqual(imported.behaviors.voice.click, [])
  assert.equal(parseMappingImport(transfer, 'rc003'), null)
  assert.equal(parseMappingImport(remote, 'mouse'), null)
  const malformed = createMappingExport(map, true, undefined, undefined, 'mouse')
  malformed.behaviors['mouse.top.up'].click = [{ type: 'wheel', direction: 'invalid' }]
  assert.equal(parseMappingImport(malformed, 'mouse'), null)
})

test('mapping transfers retain an optional profile name', () => {
  const map = createDefaultBehaviorMap()
  const transfer = createMappingExport(map, true, '2026-01-01T00:00:00.000Z', '  客厅遥控  ')
  assert.equal(transfer.profileName, '客厅遥控')
  assert.equal(parseMappingImport(JSON.stringify(transfer)).profileName, '客厅遥控')
  assert.equal(parseMappingImport(createMappingExport(map, true)).profileName, undefined)
})

test('device ownership is unique and mouse edits support undo without changing remote input', () => {
  const all = devices.flatMap(device => device.inputIds)
  assert.equal(new Set(all).size, all.length)
  for (const id of remoteButtonIds) assert.equal(deviceForInput(id).id, 'rc003')
  for (const id of mouseInputIds) assert.equal(deviceForInput(id).id, 'mouse')
  const initial = createDefaultBehaviorMap()
  let history = createBehaviorHistory(initial)
  history = behaviorHistoryReducer(history, { type: 'change', update: map => updateBehaviorList(map, 'mouse.top.down', 'click', () => [createBehavior({ type: 'key', key: 'VolumeDown' })]) })
  assert.deepEqual(history.present.voice, initial.voice)
  assert.equal(history.present['mouse.top.down'].click[0].key, 'VolumeDown')
  history = behaviorHistoryReducer(history, { type: 'undo' })
  assert.deepEqual(history.present, initial)
  history = behaviorHistoryReducer(history, { type: 'redo' })
  assert.equal(history.present['mouse.top.down'].click[0].key, 'VolumeDown')
})


test('legacy edge rules stay in their original scopes while new inputs start empty', () => {
  const legacy = ['mouse.top.up', 'mouse.top.down', 'mouse.top.left', 'mouse.top.right', 'mouse.left.up', 'mouse.left.down', 'mouse.right.up', 'mouse.right.down']
  const behaviors = Object.fromEntries(legacy.map(id => [id, {click: [createBehavior({type:'key',key:'A'})],doubleClick:[],longPress:[]}]))
  const parsed = parseStoredBehaviors({behaviors})
  for (const id of legacy) assert.deepEqual(parsed[id], behaviors[id])
  assert.equal(parsed['mouse.global.up'], undefined)
  assert.equal(parsed['mouse.global.buttonLeft'], undefined)
  assert.deepEqual(parsed['mouse.global.buttonForward'], { click: [], doubleClick: [], longPress: [] })
  assert.deepEqual(parsed['mouse.global.buttonBack'], { click: [], doubleClick: [], longPress: [] })
  let map = updateBehaviorList(parsed, 'mouse.top.buttonLeft', 'doubleClick', () => [createBehavior({type:'key',key:'B'})])
  map = updateBehaviorList(map, 'mouse.right.buttonLeft', 'longPress', () => [createBehavior({type:'key',key:'C'})])
  assert.deepEqual(parseMappingImport(createMappingExport(map, true, undefined, undefined, 'mouse'), 'mouse').behaviors, extractDeviceBehaviors(map, 'mouse'))
})


test('global mouse button rules cannot be created, restored, imported or exported', () => {
  const map = createDefaultBehaviorMap()
  const forbidden = ['mouse.global.buttonLeft', 'mouse.global.buttonRight', 'mouse.global.up', 'mouse.global.down', 'mouse.global.left', 'mouse.global.right']
  for (const id of forbidden) {
    assert.ok(!mouseInputIds.includes(id))
    assert.throws(() => updateBehaviorList(map, id, 'click', () => [createBehavior({type:'disabled'})]), /Unsupported mapping input/)
  }
  const legacy = { ...map, ...Object.fromEntries(forbidden.map(id => [id, {
    click:[createBehavior({type:'key',key:'A'})],
    doubleClick:[createBehavior({type:'key',key:'B'})],
    longPress:[createBehavior({type:'key',key:'C'})],
  }])) }
  legacy['mouse.global.buttonForward'].click = [createBehavior({type:'key',key:'F'})]
  legacy['mouse.left.buttonRight'].click = [createBehavior({type:'key',key:'R'})]
  for (const result of [parseStoredBehaviors({behaviors:legacy}), parseMappingImport({behaviors:legacy}, 'mouse').behaviors, createMappingExport(legacy,true,undefined,undefined,'mouse').behaviors]) {
    for (const id of forbidden) assert.equal(result[id], undefined)
    assert.equal(result['mouse.global.buttonForward'].click[0].key, 'F')
    assert.equal(result['mouse.left.buttonRight'].click[0].key, 'R')
  }
  const oldStrings = {mappings:{voice:'Ctrl+Space', 'mouse.global.buttonLeft':'Ctrl+A', 'mouse.global.buttonRight':'Ctrl+B'}}
  for (const id of forbidden) assert.equal(parseStoredBehaviors(oldStrings)[id], undefined)
  for (const control of ['buttonLeft','buttonRight','up','down','left','right']) {
    assert.deepEqual(mouseScopesForControl(control).map(scope => scope.id), ['top','left','right'])
    assert.equal(mouseInputId('global', control), `mouse.top.${control}`)
  }
  for (const control of ['buttonForward','buttonBack']) {
    assert.deepEqual(mouseScopesForControl(control).map(scope => scope.id), ['global','top','left','right'])
    assert.equal(mouseInputId('global', control), `mouse.global.${control}`)
  }
})

test('legacy imports preserve target-device mappings but never apply the global switch to mouse settings', () => {
  const map = createDefaultBehaviorMap()
  map['mouse.top.up'].click = [createBehavior({ type: 'key', key: 'A' })]
  for (const document of [
    { format: 'axonkey-mapping', version: 1, enabled: false, profileName: '旧配置', behaviors: map },
    { enabled: false, behaviors: map },
  ]) {
    const remote = parseMappingImport(document, 'rc003')
    const mouse = parseMappingImport(document, 'mouse')
    assert.deepEqual(remote.behaviors, extractDeviceBehaviors(map, 'rc003'))
    assert.deepEqual(mouse.behaviors, extractDeviceBehaviors(map, 'mouse'))
    assert.equal(remote.enabled, false)
    assert.equal(mouse.enabled, undefined)
  }
})

test('device transfer validation rejects mixed ownership and missing inputs, and exports do not share mutable maps', () => {
  const map = createDefaultBehaviorMap()
  const transfer = createMappingExport(map, true)
  transfer.behaviors.power.click[0].key = 'A'
  assert.equal(map.power.click[0].key, 'Esc')
  transfer.behaviors['mouse.top.up'] = { click: [], doubleClick: [], longPress: [] }
  assert.equal(parseMappingImport(transfer), null)
  const incomplete = createMappingExport(map, true)
  delete incomplete.behaviors.power
  assert.equal(parseMappingImport(incomplete), null)
  const missingTrigger = createMappingExport(map, true)
  delete missingTrigger.behaviors.voice.click
  assert.equal(parseMappingImport(missingTrigger), null)
})
