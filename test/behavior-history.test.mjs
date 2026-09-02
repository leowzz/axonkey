import assert from 'node:assert/strict'
import test from 'node:test'
import { behaviorHistoryReducer, createBehaviorHistory } from '../src/behaviorHistory.ts'
import { createBehavior, createDefaultBehaviorMap, updateBehaviorList } from '../src/behaviorModel.ts'

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
