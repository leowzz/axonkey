import assert from 'node:assert/strict'
import test from 'node:test'
import { Vector } from 'sequential-workflow-designer'
import { fixedWorkflowViewport, scrollWorkflowViewport } from '../src/components/WorkflowViewport.ts'

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

test('wheel scrolls vertically within the overflowing flow, with fixed horizontal position and scale', () => {
  let viewport = { position: new Vector(120, 0), scale: 1 }
  let rootHeight = 1000
  const api = {
    getCanvasSize: () => new Vector(800, 400),
    getRootComponentSize: () => new Vector(500, rootHeight),
    getViewport: () => viewport,
    setViewport: value => { viewport = value },
  }
  const wheel = fixedWorkflowViewport.wheelController.create(null, api)
  const scroll = (deltaY, deltaMode = 0, extra = {}) => wheel.onWheel({ deltaY, deltaMode, ...extra })
  scroll(100)
  assert.deepEqual(viewport, { position: new Vector(120, -100), scale: 1 })
  scroll(2, 1)
  assert.equal(viewport.position.y, -148)
  scroll(1, 2)
  assert.equal(viewport.position.y, -548)
  scroll(1000, 0, { ctrlKey: true })
  assert.deepEqual(viewport, { position: new Vector(120, -600), scale: 1 })
  assert.equal(scrollWorkflowViewport(api, 10), false)
  scroll(-10000)
  assert.equal(viewport.position.y, 0)
  scroll(0, 0, { deltaX: 300 })
  assert.equal(viewport.position.x, 120)
  rootHeight = 200
  scroll(100)
  assert.equal(viewport.position.y, 100, 'short flows remain centered')
  scroll(-10000)
  assert.equal(viewport.position.y, 100)
})
