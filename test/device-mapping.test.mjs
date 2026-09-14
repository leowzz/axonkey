import assert from 'node:assert/strict'
import test from 'node:test'
import { devices, deviceForInput, mouseInputIds, remoteButtonIds } from '../src/deviceModel.ts'
import { createBehavior, createDefaultBehaviorMap, createMappingExport, parseMappingImport, parseStoredBehaviors, updateBehaviorList } from '../src/behaviorModel.ts'
import { behaviorHistoryReducer, createBehaviorHistory } from '../src/behaviorHistory.ts'

test('legacy remote settings gain empty mouse mappings without losing remote behavior', () => {
  const parsed = parseStoredBehaviors({ mappings: { voice: 'Ctrl+Space', power: 'original' } })
  assert.deepEqual(parsed.voice.click[0].keys, ['Ctrl', 'Space'])
  assert.deepEqual(parsed.power.click, [])
  for (const id of mouseInputIds) assert.deepEqual(parsed[id], { click: [], doubleClick: [], longPress: [] })
})

test('each mouse direction round trips independently alongside all remote mappings', () => {
  let map = createDefaultBehaviorMap()
  mouseInputIds.forEach((id, index) => {
    map = updateBehaviorList(map, id, 'click', () => [createBehavior({ type: 'key', key: ['Up', 'Down', 'Left', 'Right'][index % 4] })])
  })
  const imported = parseMappingImport(JSON.stringify(createMappingExport(map, true)))
  assert.deepEqual(imported.behaviors, map)
  assert.equal(imported.enabled, true)
  assert.equal(imported.behaviors.voice.click[0].key, 'RAlt')
  assert.equal(imported.behaviors.power.click[0].key, 'Esc')
  const malformed = createMappingExport(map, true)
  malformed.behaviors['mouse.top.up'].click = [{ type: 'wheel', direction: 'invalid' }]
  assert.equal(parseMappingImport(malformed), null)
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
