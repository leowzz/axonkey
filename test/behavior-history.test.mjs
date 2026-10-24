import assert from 'node:assert/strict'
import test from 'node:test'
import { behaviorHistoryReducer, createBehaviorHistory } from '../src/behaviorHistory.ts'
import { createBehavior, createDefaultBehaviorMap, createEmptyBehaviorMap, updateBehaviorList } from '../src/behaviorModel.ts'

const changeVoiceClick = (map, key) => updateBehaviorList(map, 'voice', 'click', () => [
  createBehavior({ type: 'key', key, id: `voice-click-${key.toLowerCase()}` }),
])

test('behavior history supports undo and redo', () => {
  const original = createDefaultBehaviorMap()
  const changed = changeVoiceClick(original, 'Space')
  let history = createBehaviorHistory(original)

  history = behaviorHistoryReducer(history, { type: 'change', update: () => changed })
  assert.deepEqual(history.present, changed)
  assert.equal(history.past.length, 1)
  assert.equal(history.future.length, 0)

  history = behaviorHistoryReducer(history, { type: 'undo' })
  assert.deepEqual(history.present, original)
  assert.equal(history.past.length, 0)
  assert.equal(history.future.length, 1)

  history = behaviorHistoryReducer(history, { type: 'redo' })
  assert.deepEqual(history.present, changed)
  assert.equal(history.past.length, 1)
  assert.equal(history.future.length, 0)
})

test('a new behavior change after undo clears redo history', () => {
  const original = createDefaultBehaviorMap()
  let history = createBehaviorHistory(original)
  history = behaviorHistoryReducer(history, { type: 'change', update: (current) => changeVoiceClick(current, 'Space') })
  history = behaviorHistoryReducer(history, { type: 'undo' })
  history = behaviorHistoryReducer(history, { type: 'change', update: (current) => changeVoiceClick(current, 'Tab') })

  assert.equal(history.future.length, 0)
  assert.equal(history.present.voice.click[0].type, 'key')
  assert.equal(history.present.voice.click[0].key, 'Tab')
  assert.strictEqual(behaviorHistoryReducer(history, { type: 'redo' }), history)
})

test('a no-op behavior change does not create history', () => {
  const history = createBehaviorHistory(createDefaultBehaviorMap())
  assert.strictEqual(behaviorHistoryReducer(history, { type: 'change', update: (current) => current }), history)
})

for (const [editingDevice, editingInput, switchedDevice, switchedInput] of [
  ['rc003', 'voice', 'mouse', 'mouse.top.up'],
  ['mouse', 'mouse.top.up', 'rc003', 'voice'],
]) {
  test(`${switchedDevice} profile changes rebase every history snapshot while ${editingDevice} undo and redo remain intact`, () => {
    const edit = (map, input, key) => updateBehaviorList(map, input, 'click', () => [createBehavior({ type: 'key', key })])
    const initial = edit(edit(createEmptyBehaviorMap(), editingInput, 'A'), switchedInput, 'OLD')
    let history = createBehaviorHistory(initial)
    history = behaviorHistoryReducer(history, { type: 'change', update: current => edit(current, editingInput, 'B') })
    history = behaviorHistoryReducer(history, { type: 'change', update: current => edit(current, editingInput, 'C') })
    history = behaviorHistoryReducer(history, { type: 'undo' })
    const original = history
    const before = structuredClone(original)
    const switchedMap = edit(edit(createEmptyBehaviorMap(), switchedInput, 'NEW'), editingInput, 'UNRELATED')
    history = behaviorHistoryReducer(history, { type: 'rebaseDevice', deviceId: switchedDevice, behaviors: switchedMap })

    assert.equal(history.past.length, 1)
    assert.equal(history.future.length, 1)
    assert.equal(history.present[editingInput].click[0].key, 'B')
    for (const snapshot of [...history.past, history.present, ...history.future]) {
      assert.equal(snapshot[switchedInput].click[0].key, 'NEW')
    }
    assert.deepEqual(original, before, 'rebase does not mutate existing history')
    switchedMap[switchedInput].click[0].key = 'LATER SOURCE EDIT'
    for (const [action, expected] of [['undo', 'A'], ['redo', 'B'], ['redo', 'C'], ['undo', 'B']]) {
      history = behaviorHistoryReducer(history, { type: action })
      assert.equal(history.present[editingInput].click[0].key, expected)
      assert.equal(history.present[switchedInput].click[0].key, 'NEW', 'undo never restores the former device profile')
    }
  })
}
