import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultWorkflowSplitRatio, workflowSplitLayout, workflowSplitterHeight } from '../src/components/workflowSplitLayout.ts'

test('resizing shares available space while protecting the canvas, full footer and editor', () => {
  for (const height of [0, 400, 680, 1000]) {
    for (const footer of [78, 110, 175]) {
      for (const ratio of [0, 0.25, defaultWorkflowSplitRatio, 0.9, 1]) {
        const layout = workflowSplitLayout(height, footer, ratio)
        assert.ok(layout.upper - footer >= 260, 'canvas keeps its first action below a two-row toolbar visible')
        assert.ok(layout.available - layout.upper >= 190, 'editor remains reachable')
        assert.equal(layout.available + workflowSplitterHeight, Math.max(height, layout.minHeight))
      }
    }
  }
})

test('the same ratio follows a resized window without changing the layout preference', () => {
  const normal = workflowSplitLayout(700, 78, 0.6)
  const taller = workflowSplitLayout(900, 78, 0.6)
  assert.equal(taller.upper - normal.upper, 120)
  const compact = workflowSplitLayout(400, 175, 0)
  assert.equal(compact.upper, compact.minUpper)
  const lowerLimit = workflowSplitLayout(700, 110, 1)
  assert.equal(lowerLimit.available - lowerLimit.upper, 190)
})
