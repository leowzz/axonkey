import assert from 'node:assert/strict'
import test from 'node:test'
import { SimpleEvent, Vector } from 'sequential-workflow-designer'
import { bindWorkflowSelection } from '../src/components/workflowSelection.ts'

function setup(batchedSelection = false, scrollable = false) {
  let viewport = { position: new Vector(0, 0), scale: 1 }
  const step = id => ({ id, name: id, type: 'delay', componentType: 'task', properties: {} })
  const branches = { click: [step('a'), step('b')], doubleClick: [step('c')], longPress: [step('d'), { ...step('disabled'), type: 'disabled' }] }
  const markers = Object.values(branches).flat().map(step => ({
    id: step.id, selected: false,
    getAttribute() { return this.id },
    classList: { toggle(_name, active) { markers.find(marker => marker.id === step.id).selected = active } },
    getBoundingClientRect() {
      const index = ['a', 'b', 'c', 'd', 'disabled'].indexOf(this.id)
      const left = index < 2 ? 20 : index === 2 ? 180 : 320
      const top = (index === 1 ? 100 : 30) + viewport.position.y
      return { left, top, right: left + 100, bottom: top + 50 }
    },
  }))
  const handlers = new Map()
  const overlays = []
  const workspace = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }),
    querySelectorAll: () => markers,
    appendChild: element => overlays.push(element),
    getCanvasSize: () => new Vector(500, 300), getRootComponentSize: () => new Vector(500, 800),
    getViewport: () => viewport, setViewport: next => { viewport = next },
  }
  const canvas = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
    querySelectorAll: () => markers, focus() {},
    ownerDocument: { createElement: () => ({ style: {}, setAttribute() {}, remove() { overlays.splice(overlays.indexOf(this), 1) } }) },
  }
  let primary = null
  let pendingSelection
  let writes = 0
  const designer = {
    getDefinition: () => ({ properties: {}, sequence: [{ type: 'axonkeyTriggers', branches }] }),
    isReadonly: () => false, isDragging: () => false,
    onSelectedStepIdChanged: new SimpleEvent(), onIsDraggingChanged: new SimpleEvent(),
    onDefinitionChanged: new SimpleEvent(), onRootComponentUpdated: new SimpleEvent(),
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
  const destroy = bindWorkflowSelection(canvas, designer, () => { writes++ }, scrollable ? () => workspace : undefined)
  function eventTarget(id, editable = false) {
    return { closest(selector) {
      if (selector === '.sqd-workspace') return workspace
      if (selector === '[data-step-id]') return id ? markers.find(marker => marker.id === id) : null
      return editable ? {} : null
    } }
  }
  function mouse(id, modifiers = {}, release = true) {
    const event = { button: 0, clientX: 0, clientY: 0, target: eventTarget(id), preventDefault() { this.prevented = true }, stopPropagation() {}, ...modifiers }
    handlers.get('mousedown')(event)
    if (!event.prevented) id ? designer.selectStepById(id) : designer.clearSelectedStep()
    if (release) handlers.get('mouseup')?.(event)
    return event
  }
  function key(options = {}) {
    const event = { key: 'Delete', target: eventTarget(), preventDefault() { this.prevented = true }, stopPropagation() {}, ...options }
    handlers.get('keydown')(event)
    return event
  }
  return { branches, markers, designer, mouse, key, destroy, handlers, eventTarget, overlays, workspace,
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

test('real drag order clears primary selection and finishes before batched events, moving the complete group', async () => {
  const app = setup(true)
  app.mouse('a')
  app.flushSelection()
  app.mouse('b', { ctrlKey: true })
  app.flushSelection()
  // A plain press on a selected group member starts a group drag instead of
  // collapsing the selection to that one member.
  app.mouse('b', {}, false)
  app.designer.clearSelectedStep()
  app.designer.onIsDraggingChanged.emit(true)
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b'], 'designer reset must not collapse the drag group')
  // The designer ends dragging BEFORE it mutates the definition. Public
  // definition/selection events are batched into a later task.
  app.designer.onIsDraggingChanged.emit(false)
  const moved = app.branches.click.splice(1, 1)[0]
  app.branches.doubleClick.push(moved)
  app.designer.selectStepById('b')
  app.destroy.finishDrag(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  app.flushSelection()
  assert.deepEqual(app.branches.click, [])
  assert.deepEqual(app.branches.doubleClick.map(step => step.id), ['c', 'a', 'b'])
  assert.deepEqual(app.selected(), ['a', 'b'])
  assert.equal(app.writes(), 1)
  app.destroy()
})

test('invalid and interrupted group drops leave the definition and selection intact', () => {
  for (const interrupt of [true, false]) {
    const app = setup(true)
    app.mouse('a')
    app.flushSelection()
    app.mouse('c', { ctrlKey: true })
    app.flushSelection()
    app.mouse('a', {}, false)
    app.designer.clearSelectedStep()
    app.designer.onIsDraggingChanged.emit(true)
    app.flushSelection()
    app.designer.onIsDraggingChanged.emit(false)
    app.destroy.finishDrag(interrupt)
    assert.deepEqual(app.branches.click.map(step => step.id), ['a', 'b'])
    assert.deepEqual(app.branches.doubleClick.map(step => step.id), ['c'])
    assert.deepEqual(app.destroy.getSelectedIds(), ['a', 'c'])
    assert.equal(app.writes(), 0)
    app.destroy()
  }
})

test('same-lane moves remove selected predecessors before computing the group insertion index', () => {
  const app = setup()
  app.mouse('a')
  app.mouse('b', { ctrlKey: true })
  app.branches.click.push(app.branches.doubleClick.pop())
  app.mouse('a', {}, false)
  app.designer.onIsDraggingChanged.emit(true)
  app.designer.onIsDraggingChanged.emit(false)
  app.branches.click.push(app.branches.click.shift()) // library moves a to end
  app.destroy.finishDrag(false)
  assert.deepEqual(app.branches.click.map(step => step.id), ['c', 'a', 'b'])
  assert.equal(app.writes(), 1)
  app.destroy()
})

test('plain click replaces multi-selection, blank clears it and removed nodes do not stay selected', async () => {
  const app = setup()
  app.mouse('a')
  app.mouse('b', { ctrlKey: true })
  app.mouse('a')
  await new Promise(resolve => setTimeout(resolve, 0))
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

test('blank drag selects removable blocks across lanes, including the disabling node, and deletes as one change', () => {
  const app = setup(true)
  const start = app.mouse(null, { clientX: 5, clientY: 10 }, false)
  assert.equal(start.prevented, true, 'blank press must not reach designer panning')
  app.handlers.get('mousemove')({ clientX: 450, clientY: 90, preventDefault() {} })
  app.designer.onSelectedStepIdChanged.emit(null)
  assert.deepEqual(app.selected(), ['a', 'c', 'disabled'], 'delayed native selection cannot overwrite marquee')
  assert.equal(app.overlays.length, 1)
  app.handlers.get('mouseup')({ clientX: 450, clientY: 90, preventDefault() {} })
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'c', 'disabled'])
  assert.equal(app.overlays.length, 0)
  assert.equal(app.writes(), 0, 'selection does not save mapping data')
  app.key()
  assert.deepEqual(app.branches.click.map(s => s.id), ['b'])
  assert.deepEqual(app.branches.doubleClick, [])
  assert.equal(app.writes(), 1)
  app.destroy()
})

test('reverse marquee replaces selection; Ctrl marquee adds; Escape and lost focus restore the original group', () => {
  const app = setup(true)
  const finish = (x, y) => app.handlers.get('mouseup')({ clientX: x, clientY: y, preventDefault() {} })
  app.mouse('c')
  app.flushSelection()
  app.mouse(null, { clientX: 130, clientY: 160 }, false)
  finish(15, 25)
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b'])
  app.mouse(null, { ctrlKey: true, clientX: 170, clientY: 20 }, false)
  finish(290, 90)
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b', 'c'])
  app.mouse(null, { clientX: 0, clientY: 0 }, false)
  app.key({ key: 'Escape' })
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b', 'c'])
  app.mouse(null, {}, false)
  app.handlers.get('blur')()
  app.flushSelection()
  assert.deepEqual(app.selected(), ['a', 'b', 'c'])
  app.mouse(null)
  app.flushSelection()
  assert.deepEqual(app.selected(), [])
  assert.equal(app.overlays.length, 0)
  app.destroy()
})

test('edge scrolling extends the marquee through offscreen blocks without losing earlier selections', () => {
  let nextFrame
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => { nextFrame = callback; return 1 }
  globalThis.cancelAnimationFrame = () => { nextFrame = undefined }
  const app = setup(true, true)
  try {
    app.markers.find(m => m.id === 'c').getBoundingClientRect = () => ({ left: 180, right: 280, top: 350 + app.workspace.getViewport().position.y, bottom: 400 + app.workspace.getViewport().position.y })
    app.mouse(null, { clientX: 5, clientY: 20 }, false)
    app.handlers.get('mousemove')({ clientX: 290, clientY: 290, preventDefault() {} })
    for (let i = 0; i < 20; i++) nextFrame()
    assert.equal(app.workspace.getViewport().position.y, -200)
    assert.deepEqual(app.selected(), ['a', 'b', 'c'], 'scrolled-away blocks remain inside the logical selection rectangle')
    app.handlers.get('mouseup')({ clientX: 290, clientY: 290, preventDefault() {} })
    app.flushSelection()
    assert.deepEqual(app.selected(), ['a', 'b', 'c'])
    assert.equal(nextFrame, undefined, 'mouseup stops auto scrolling')
    assert.equal(app.writes(), 0)
  } finally {
    app.destroy()
    if (originalRequest) globalThis.requestAnimationFrame = originalRequest
    else delete globalThis.requestAnimationFrame
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel
    else delete globalThis.cancelAnimationFrame
  }
})


test('the disabling node can be selected, dragged alone and deleted without moving the viewport', () => {
  const app = setup(true, true)
  try {
    const before = app.workspace.getViewport()
    app.mouse('disabled')
    app.flushSelection()
    assert.deepEqual(app.selected(), ['disabled'])
    assert.equal(app.destroy.canDragSelection(), true)
    assert.deepEqual(app.destroy.getDragSteps('disabled').map(step => step.id), ['disabled'])
    app.mouse('a', { ctrlKey: true })
    app.flushSelection()
    assert.equal(app.destroy.canDragSelection(), false, 'a disabling node must not be moved into another lane by a group drag')
    assert.equal(app.key().prevented, true)
    assert.deepEqual(app.branches.longPress.map(step => step.id), ['d'])
    assert.deepEqual(app.branches.click.map(step => step.id), ['b'])
    assert.deepEqual(app.workspace.getViewport(), before)
    assert.equal(app.writes(), 1)
  } finally { app.destroy() }
})


test('profile-switch nodes cannot bypass overwrite confirmation in a group move', () => {
  const app = setup()
  try {
    app.branches.click[0].type = 'switchProfile'
    app.mouse('a')
    assert.equal(app.destroy.canDragSelection(), true, 'the node can still be dragged to trash')
    app.mouse('c', { ctrlKey: true })
    assert.equal(app.destroy.canDragSelection(), false)
  } finally { app.destroy() }
})
