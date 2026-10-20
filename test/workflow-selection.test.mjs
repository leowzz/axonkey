import assert from 'node:assert/strict'
import test from 'node:test'
import { SimpleEvent } from 'sequential-workflow-designer'
import { bindWorkflowSelection } from '../src/components/workflowSelection.ts'

function setup(batchedSelection = false) {
  const step = id => ({ id, name: id, type: 'delay', componentType: 'task', properties: {} })
  const branches = { click: [step('a'), step('b')], doubleClick: [step('c')], longPress: [step('d'), { ...step('disabled'), type: 'disabled' }] }
  const markers = Object.values(branches).flat().map(step => ({
    id: step.id, selected: false,
    getAttribute() { return this.id },
    classList: { toggle(_name, active) { markers.find(marker => marker.id === step.id).selected = active } },
  }))
  const handlers = new Map()
  const canvas = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
    querySelectorAll: () => markers, focus() {},
  }
  let primary = null
  let pendingSelection
  let writes = 0
  const designer = {
    getDefinition: () => ({ properties: {}, sequence: [{ type: 'axonkeyTriggers', branches }] }),
    isReadonly: () => false, isDragging: () => false,
    onSelectedStepIdChanged: new SimpleEvent(), onRootComponentUpdated: new SimpleEvent(),
    selectStepById(id) {
      if (primary === id) return
      primary = id
      if (batchedSelection) pendingSelection = id
      else this.onSelectedStepIdChanged.emit(id)
    },
    clearSelectedStep() {
      if (primary === null) return
      primary = null
      if (batchedSelection) pendingSelection = null
      else this.onSelectedStepIdChanged.emit(null)
    },
  }
  const destroy = bindWorkflowSelection(canvas, designer, () => { writes++ })
  function eventTarget(id, editable = false) {
    return { closest(selector) {
      if (selector === '.sqd-workspace') return {}
      if (selector === '[data-step-id]') return id ? markers.find(marker => marker.id === id) : null
      return editable ? {} : null
    } }
  }
  function mouse(id, modifiers = {}) {
    const event = { button: 0, target: eventTarget(id), preventDefault() { this.prevented = true }, stopPropagation() {}, ...modifiers }
    handlers.get('mousedown')(event)
    if (!event.prevented) id ? designer.selectStepById(id) : designer.clearSelectedStep()
    return event
  }
  function key(options = {}) {
    const event = { key: 'Delete', target: eventTarget(), preventDefault() { this.prevented = true }, stopPropagation() {}, ...options }
    handlers.get('keydown')(event)
    return event
  }
  return { branches, markers, designer, mouse, key, destroy, handlers, eventTarget,
    selected: () => markers.filter(marker => marker.selected).map(marker => marker.id),
    writes: () => writes, primary: () => primary,
    flushSelection() {
      if (pendingSelection === undefined) return
      const id = pendingSelection
      pendingSelection = undefined
      designer.onSelectedStepIdChanged.emit(id)
    }
  }
}

test('delayed designer selection events preserve Ctrl selections, including coalesced rapid clicks', () => {
  const app = setup(true)
  app.mouse('a')
  app.flushSelection()
  app.mouse('b', { ctrlKey: true })
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b'])
  app.mouse('a', { ctrlKey: true })
  app.mouse('c', { ctrlKey: true })
  app.flushSelection()
  assert.deepEqual(app.selected(), ['b', 'c'])
  app.key()
  app.flushSelection()
  assert.deepEqual(app.branches.click.map(step => step.id), ['a'])
  assert.deepEqual(app.branches.doubleClick, [])
  app.destroy()
})

test('Ctrl selection toggles across lanes, preserves the primary selection and deletes as one change', () => {
  const app = setup()
  app.mouse('a')
  app.mouse('c', { ctrlKey: true })
  assert.deepEqual(app.selected(), ['a', 'c'])
  app.mouse('b', { ctrlKey: true })
  app.mouse('c', { ctrlKey: true })
  assert.deepEqual(app.selected(), ['a', 'b'])
  assert.equal(app.primary(), 'b')
  assert.equal(app.key().prevented, true)
  assert.deepEqual(app.branches.click, [])
  assert.equal(app.branches.doubleClick[0].id, 'c')
  assert.equal(app.writes(), 1)
  assert.deepEqual(app.selected(), [])
  assert.equal(app.primary(), null)
  app.destroy()
  assert.equal(app.handlers.size, 0)
  assert.equal(app.designer.onSelectedStepIdChanged.count(), 0)
})

test('plain click replaces multi-selection, blank clears it and removed nodes do not stay selected', () => {
  const app = setup()
  app.mouse('a')
  app.mouse('b', { ctrlKey: true })
  app.mouse('a')
  assert.deepEqual(app.selected(), ['a'])
  app.mouse(null)
  assert.deepEqual(app.selected(), [])
  assert.equal(app.key().prevented, undefined)
  app.mouse('c', { ctrlKey: true })
  app.branches.doubleClick.length = 0
  app.designer.onRootComponentUpdated.emit()
  assert.deepEqual(app.selected(), [])
  app.destroy()
})

test('Delete ignores text editing, shortcuts, composition, readonly/dragging and disabled lanes', () => {
  const app = setup()
  app.mouse('a')
  for (const options of [{ target: app.eventTarget(null, true) }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'Backspace' }]) {
    assert.equal(app.key(options).prevented, undefined)
  }
  app.designer.isReadonly = () => true
  app.key()
  app.designer.isReadonly = () => false
  app.designer.isDragging = () => true
  app.key()
  app.designer.isDragging = () => false
  assert.equal(app.writes(), 0)
  app.mouse('d')
  assert.equal(app.key().prevented, undefined)
  assert.equal(app.branches.longPress.length, 2)
  app.mouse('a', { ctrlKey: true })
  app.key()
  assert.deepEqual(app.branches.click.map(step => step.id), ['b'])
  assert.equal(app.branches.longPress.length, 2)
  assert.equal(app.writes(), 1)
  app.destroy()
})
