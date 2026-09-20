import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, normalizeBehavior } from '../src/behaviorModel.ts'

test('cursor move behaviors default to 20 pixels and keep all four directions', () => {
  for (const direction of ['up', 'down', 'left', 'right']) {
    const expected = { id: 'nudge', enabled: true, type: 'cursorMove', direction, distance: 20 }
    assert.deepEqual(createBehavior({ type: 'cursorMove', direction, id: 'nudge' }), expected)
    assert.deepEqual(normalizeBehavior(JSON.parse(JSON.stringify(expected))), expected)
  }
})

test('cursor move distance is clamped and missing values fall back to 20', () => {
  assert.equal(createBehavior({ type: 'cursorMove', direction: 'up', distance: 0 }).distance, 20)
  assert.equal(createBehavior({ type: 'cursorMove', direction: 'up', distance: 501 }).distance, 500)
  assert.equal(normalizeBehavior({ type: 'cursorMove', direction: 'left' }).distance, 20)
  assert.equal(normalizeBehavior({ type: 'cursorMove', direction: 'right', distance: 36.6 }).distance, 37)
})

test('invalid cursor move directions are rejected on import', () => {
  for (const direction of [undefined, 'diagonal', '', 20]) {
    assert.equal(normalizeBehavior({ type: 'cursorMove', direction }), null)
  }
})
