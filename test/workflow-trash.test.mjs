import assert from 'node:assert/strict'
import test from 'node:test'
import { SimpleEvent } from 'sequential-workflow-designer'
import { bindWorkflowTrash } from '../src/components/workflowTrash.ts'

test('dragging a workflow step over the trash schedules deletion and cleans listeners', async () => {
  const handlers = new Map()
  const oldWindow = globalThis.window
  globalThis.window = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
  }
  const canvasHandlers = new Map()
  const canvas = { addEventListener: (name, handler) => canvasHandlers.set(name, handler), removeEventListener: name => canvasHandlers.delete(name) }
  const classes = new Set()
  const trash = {
    classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name) } },
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
  }
  const designer = { isDragging: () => dragging, onIsDraggingChanged: new SimpleEvent() }
  let dragging = false
  const deleted = []
  const unbind = bindWorkflowTrash(canvas, trash, designer, id => deleted.push(id))
  const marker = { closest: selector => selector === '[data-step-id]' ? { getAttribute: () => 'step-1' } : null }
  canvasHandlers.get('mousedown')({ button: 0, target: marker })
  dragging = true
  designer.onIsDraggingChanged.emit(true)
  handlers.get('mousemove')({ clientX: 50, clientY: 50 })
  assert.equal(classes.has('is-drag-over'), true)
  handlers.get('mouseup')({ clientX: 50, clientY: 50 })
  assert.deepEqual(deleted, [])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(deleted, ['step-1'])
  unbind()
  assert.equal(handlers.size, 0)
  assert.equal(canvasHandlers.size, 0)
  globalThis.window = oldWindow
})
