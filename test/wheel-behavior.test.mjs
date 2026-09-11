import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, normalizeBehavior } from '../src/behaviorModel.ts'

test('wheel behaviors survive creation and persistence in both directions', () => {
  for (const direction of ['up', 'down']) {
    const expected = { id: 'scroll', enabled: true, type: 'wheel', direction }
    assert.deepEqual(createBehavior({ type: 'wheel', direction, id: 'scroll' }), expected)
    assert.deepEqual(normalizeBehavior(JSON.parse(JSON.stringify(expected))), expected)
  }
})

test('invalid wheel directions are rejected on import', () => {
  for (const direction of [undefined, 'left', '', 120]) {
    assert.equal(normalizeBehavior({ type: 'wheel', direction }), null)
  }
})
