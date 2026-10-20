import assert from 'node:assert/strict'
import test from 'node:test'
import { Vector } from 'sequential-workflow-designer'
import { fixedWorkflowViewport } from '../src/components/WorkflowViewport.ts'

test('workflow keeps a fixed scale through zoom commands, pinch limits and viewport resets', () => {
  let canvasSize = new Vector(800, 600)
  let rootSize = new Vector(400, 300)
  const controller = fixedWorkflowViewport.viewportController.create({
    getCanvasSize: () => canvasSize,
    getRootComponentSize: () => rootSize,
    getViewport: () => ({ position: new Vector(30, 40), scale: 1 }),
  })
  assert.deepEqual(controller.getDefault(), { position: new Vector(200, 150), scale: 1 })
  assert.equal(controller.getZoomed(true), null)
  assert.equal(controller.getZoomed(false), null)
  for (const scale of [0.1, 0.8, 1, 1.5, 10]) {
    assert.equal(controller.limitScale(scale), 1)
    for (const direction of [true, false]) assert.deepEqual(controller.getNextScale(scale, direction), { current: 1, next: 1 })
  }
  // A long flow or a smaller window stays at full size with its start reachable.
  rootSize = new Vector(1000, 2000)
  canvasSize = new Vector(500, 400)
  assert.deepEqual(controller.getDefault(), { position: new Vector(0, 0), scale: 1 })
  const focused = controller.getFocusedOnComponent(new Vector(100, 200), new Vector(80, 40))
  assert.deepEqual(focused, { position: new Vector(140, 20), scale: 1 })
})
