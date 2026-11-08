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
  const lanes = ['click', 'doubleClick', 'longPress'].map((trigger, index) => ({
    getAttribute: () => trigger,
    querySelector: () => ({ getBoundingClientRect: () => ({ left: index * 200, top: 0, right: (index + 1) * 200, bottom: 300 }) }),
  }))
  const canvas = {
    addEventListener: (name, handler) => canvasHandlers.set(name, handler), removeEventListener: name => canvasHandlers.delete(name),
    querySelectorAll: () => lanes,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 300 }),
  }
  const classes = new Set()
  const attributes = new Map()
  const trash = {
    classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name) } },
    style: {}, parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    setAttribute: (name, value) => attributes.set(name, value),
    getBoundingClientRect: () => ({ left: parseFloat(trash.style.left), top: parseFloat(trash.style.top), right: parseFloat(trash.style.left) + 76, bottom: parseFloat(trash.style.top) + 54 }),
  }
  const designer = { isDragging: () => dragging, onIsDraggingChanged: new SimpleEvent() }
  let dragging = false
  const deleted = []
  const unbind = bindWorkflowTrash(canvas, trash, designer, id => deleted.push(id))
  const marker = { closest: selector => ({ getAttribute: () => selector === '[data-step-id]' ? 'step-1' : 'click' }) }
  canvasHandlers.get('mousedown')({ button: 0, target: marker })
  dragging = true
  designer.onIsDraggingChanged.emit(true)
  assert.equal(classes.has('is-visible'), true)
  assert.deepEqual(trash.style, { left: '116px', top: '238px' })
  handlers.get('mousemove')({ clientX: 450, clientY: 50 })
  assert.deepEqual(trash.style, { left: '516px', top: '238px' }, 'target follows the active lane')
  handlers.get('mousemove')({ clientX: 650, clientY: 50 })
  assert.equal(classes.has('is-visible'), false, 'outside lanes has no delete target')
  handlers.get('mousemove')({ clientX: 550, clientY: 260 })
  assert.equal(classes.has('is-drag-over'), true)
  handlers.get('mouseup')({ clientX: 550, clientY: 260 })
  assert.equal(classes.has('is-visible'), false)
  assert.equal(attributes.get('aria-hidden'), 'true')
  assert.deepEqual(deleted, [])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(deleted, ['step-1'])
  dragging = false
  designer.onIsDraggingChanged.emit(false)
  canvasHandlers.get('mousedown')({ button: 0, target: { closest: () => null } })
  dragging = true
  designer.onIsDraggingChanged.emit(true)
  handlers.get('mousemove')({ clientX: 550, clientY: 260 })
  handlers.get('mouseup')({ clientX: 550, clientY: 260 })
  assert.equal(classes.has('is-visible'), false, 'library drags never offer deletion')
  assert.deepEqual(deleted, ['step-1'])
  unbind()
  assert.equal(handlers.size, 0)
  assert.equal(canvasHandlers.size, 0)
  globalThis.window = oldWindow
})
