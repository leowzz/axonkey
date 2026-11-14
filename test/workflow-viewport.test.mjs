import assert from 'node:assert/strict'
import test from 'node:test'
import { Vector } from 'sequential-workflow-designer'
import { fixedWorkflowViewport, scrollWorkflowViewport } from '../src/components/WorkflowViewport.ts'
import { clampLaneScroll, layoutWorkflowFlow, workflowLaneLayout } from '../src/components/workflowLaneLayout.ts'
import { createTriggerDefinition, createTriggerRootExtension } from '../src/components/WorkflowTriggerRoot.ts'

test('workflow keeps a fixed scale through zoom commands, pinch limits and viewport resets', () => {
  let canvasSize = new Vector(800, 600)
  let rootSize = new Vector(400, 300)
  const controller = fixedWorkflowViewport.viewportController.create({
    getCanvasSize: () => canvasSize,
    getRootComponentSize: () => rootSize,
    getViewport: () => ({ position: new Vector(30, 40), scale: 1 }),
  })
  assert.deepEqual(controller.getDefault(), { position: new Vector(0, 0), scale: 1 })
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
  assert.deepEqual(focused, { position: new Vector(0, 0), scale: 1 })
})

test('wheel and button lanes fit their canvas independently of sequence lengths, including after a resize', () => {
  for (const width of [360, 480, 876, 1400]) {
    for (const count of [1, 3]) {
      const { padding, gap, laneWidth, laneHeight } = workflowLaneLayout(width, 500, count)
      assert.ok(laneWidth > 0)
      assert.ok(Math.abs(padding * 2 + gap * (count - 1) + laneWidth * count - width) < .001)
      assert.equal(padding * 2 + laneHeight, 500, 'the canvas does not reserve footer space twice')
    }
  }
})

test('each lane clamps its own scroll and a shorter edited sequence cannot retain an offscreen position', () => {
  assert.equal(clampLaneScroll(300, 1000, 400), 300)
  assert.equal(clampLaneScroll(900, 1000, 400), 600)
  assert.equal(clampLaneScroll(-100, 1000, 400), 0)
  assert.equal(clampLaneScroll(600, 300, 400), 0)
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

test('compact behavior lanes lay out sub-actions side-by-side with zero spurious overflow for short sequences and scroll cleanly for 18+ items', () => {
  const threeSubActions = [
    { width: 78, height: 25 },
    { width: 88, height: 25 },
    { width: 54, height: 25 },
  ]
  for (const [canvasWidth, canvasHeight, lanes, expectedMaxRows] of [
    [512, 260, 3, 2], // 980x680 3-lane
    [680, 310, 3, 2], // 1180x820 3-lane
    [910, 350, 3, 1], // 1440x900 3-lane: all 3 fit on 1 row
    [512, 260, 1, 1], // 980x680 single-lane controller: all 3 fit on 1 row
  ]) {
    const layout = workflowLaneLayout(canvasWidth, canvasHeight, lanes, 2)
    assert.equal(layout.compactHeader, true)
    assert.equal(layout.headerHeight, 36)
    const flow = layoutWorkflowFlow(threeSubActions, layout.laneWidth, layout.bodyHeight)
    assert.equal(flow.overflow, 0, `3 sub-actions must never overflow at ${canvasWidth}x${canvasHeight}`)
    assert.equal(flow.contentHeight, layout.bodyHeight)
    const rowCount = flow.items[flow.items.length - 1].row + 1
    assert.ok(rowCount <= expectedMaxRows, `expected <= ${expectedMaxRows} rows, got ${rowCount}`)
  }

  // 20 mixed sub-actions overflow cleanly and clamp scroll to the exact bottom row.
  const narrow3Lane = workflowLaneLayout(512, 260, 3, 2)
  const manyItems = Array.from({ length: 20 }, (_, index) => ({ width: index % 2 === 0 ? 84 : 72, height: 26 }))
  const longFlow = layoutWorkflowFlow(manyItems, narrow3Lane.laneWidth, narrow3Lane.bodyHeight)
  assert.ok(longFlow.overflow > 0, '20 items in a 980x680 lane must be scrollable')
  assert.equal(clampLaneScroll(99999, longFlow.contentHeight, narrow3Lane.bodyHeight), longFlow.overflow)
})

test('2D wrapped lane drop slots partition every row and trailing area into disjoint insertion indices', () => {
  const empty = layoutWorkflowFlow([], 220, 180)
  assert.equal(empty.slots.length, 1)
  assert.equal(empty.slots[0].empty, true)
  assert.equal(empty.slots[0].index, 0)

  const wrapped = layoutWorkflowFlow(
    [
      { width: 82, height: 26 },
      { width: 94, height: 26 },
      { width: 58, height: 26 },
      { width: 76, height: 26 },
    ],
    218,
    200,
  )
  // Row 0: items 0, 1; Row 1: items 2, 3
  assert.deepEqual(
    wrapped.items.map(item => item.row),
    [0, 0, 1, 1],
  )
  assert.equal(wrapped.connectors.length, 3)
  assert.equal(wrapped.connectors[0].wraps, false)
  assert.equal(wrapped.connectors[1].wraps, true)
  assert.equal(wrapped.connectors[2].wraps, false)

  const hitAt = (px, py) =>
    wrapped.slots.filter(
      slot =>
        px > slot.hit.x &&
        px < slot.hit.x + slot.hit.width &&
        py > slot.hit.y &&
        py < slot.hit.y + slot.hit.height,
    )

  const row0Y = wrapped.items[0].y + 13
  const row1Y = wrapped.items[2].y + 13
  assert.deepEqual(hitAt(4, row0Y).map(s => s.index), [0])
  assert.deepEqual(hitAt(wrapped.items[0].x + wrapped.items[0].width + 4, row0Y).map(s => s.index), [1])
  assert.deepEqual(hitAt(210, row0Y).map(s => s.index), [2])
  assert.deepEqual(hitAt(4, row1Y).map(s => s.index), [2])
  assert.deepEqual(hitAt(wrapped.items[2].x + wrapped.items[2].width + 4, row1Y).map(s => s.index), [3])
  assert.deepEqual(hitAt(210, row1Y).map(s => s.index), [4])
  assert.deepEqual(hitAt(100, 165).map(s => s.index), [4], 'open area below wrapped rows appends to end')
})

test('trigger root omits no-op self-move indices, excludes disabled lanes, and zeroes drop rects over trash', () => {
  const prevDoc = globalThis.document
  const prevRect = globalThis.DOMRect
  class FakeRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x
      this.y = y
      this.left = x
      this.top = y
      this.width = width
      this.height = height
      this.right = x + width
      this.bottom = y + height
    }
  }
  const makeEl = tag => {
    const attrs = new Map()
    const classes = new Set()
    const children = []
    const el = {
      tagName: tag,
      children,
      parentNode: null,
      ownerSVGElement: null,
      textContent: '',
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)),
        contains: n => classes.has(n),
      },
      setAttribute(k, v) {
        attrs.set(k, String(v))
        if (k === 'class') {
          classes.clear()
          String(v)
            .split(/\s+/)
            .filter(Boolean)
            .forEach(c => classes.add(c))
        }
      },
      getAttribute: k => attrs.get(k) ?? null,
      appendChild(child) {
        child.parentNode = el
        children.push(child)
        return child
      },
      insertBefore(child, ref) {
        child.parentNode = el
        const idx = children.indexOf(ref)
        if (idx >= 0) children.splice(idx, 0, child)
        else children.push(child)
        return child
      },
      addEventListener() {},
      closest(sel) {
        if (sel === '.workflow-axonkey-canvas') return canvas
        return null
      },
      querySelector(sel) {
        const match = node =>
          sel.startsWith('.') && node.classList.contains(sel.slice(1))
        const stack = [...children]
        while (stack.length) {
          const cur = stack.shift()
          if (match(cur)) return cur
          stack.push(...cur.children)
        }
        return null
      },
      getBoundingClientRect() {
        return new FakeRect(
          Number(attrs.get('x') ?? 0),
          Number(attrs.get('y') ?? 0),
          Number(attrs.get('width') ?? 200),
          Number(attrs.get('height') ?? 180),
        )
      },
    }
    return el
  }
  let trashHover = false
  const workspaceRoot = {
    querySelector: sel => (sel === '.workflow-trash.is-drag-over' && trashHover ? {} : null),
  }
  const canvas = { clientWidth: 680, clientHeight: 300, parentElement: workspaceRoot }
  globalThis.DOMRect = FakeRect
  globalThis.document = { createElementNS: (_ns, tag) => makeEl(tag) }

  try {
    const def = createTriggerDefinition()
    const branches = def.sequence[0].branches
    const stepA = { id: 'a', componentType: 'task', type: 'paste', name: '粘贴文本', properties: {} }
    const stepB = { id: 'b', componentType: 'task', type: 'delay', name: '等待 30 毫秒', properties: {} }
    const stepC = { id: 'c', componentType: 'task', type: 'enter', name: '回车', properties: {} }
    const stepDisabled = { id: 'off', componentType: 'task', type: 'disabled', name: '已禁用', properties: {} }
    branches.click.push(stepA, stepB, stepC)
    branches.longPress.push(stepDisabled)

    const parent = makeEl('g')
    const createdComponents = new Map()
    const root = createTriggerRootExtension(() => {}).create(parent, def.sequence, null, {
      placeholderController: { canCreate: () => true },
      stepComponentFactory: {
        create(container, stepCtx) {
          const g = makeEl('g')
          container.appendChild(g)
          const comp = {
            step: stepCtx.step,
            parentSequence: stepCtx.parentSequence,
            view: { g, width: 78, height: 25, joinX: 39 },
            findById: id => (id === stepCtx.step.id ? comp : null),
            resolveClick: () => null,
            resolvePlaceholders(skip, res) {
              if (skip !== comp) res.components.push(comp)
            },
            updateBadges() {},
          }
          createdComponents.set(stepCtx.step.id, comp)
          return comp
        },
      },
    })

    // Dragging from toolbox (skip = undefined): click has slots for 0..3, doubleClick (empty) has 0, longPress (disabled) has none.
    const toolboxResult = { placeholders: [], components: [] }
    root.resolvePlaceholders(undefined, toolboxResult)
    const clickIndices = toolboxResult.placeholders
      .filter(p => p.parentSequence === branches.click)
      .map(p => p.index)
    assert.ok(clickIndices.includes(0) && clickIndices.includes(1) && clickIndices.includes(2) && clickIndices.includes(3))
    assert.deepEqual(
      toolboxResult.placeholders.filter(p => p.parentSequence === branches.doubleClick).map(p => p.index),
      [0],
    )
    assert.equal(toolboxResult.placeholders.filter(p => p.parentSequence === branches.longPress).length, 0)

    // Dragging stepB (index 1 in click): omits no-op indices 1 and 2 in click, keeps 0 and 3!
    const selfResult = { placeholders: [], components: [] }
    root.resolvePlaceholders(createdComponents.get('b'), selfResult)
    const selfClickIndices = [
      ...new Set(selfResult.placeholders.filter(p => p.parentSequence === branches.click).map(p => p.index)),
    ].sort((x, y) => x - y)
    assert.deepEqual(selfClickIndices, [0, 3])

    // Hovering trash suppresses placeholder hit rects to 0x0 so drop never inserts/moves before deleting.
    assert.ok(toolboxResult.placeholders[0].getClientRect().width > 0)
    trashHover = true
    assert.equal(toolboxResult.placeholders[0].getClientRect().width, 0)
    assert.equal(toolboxResult.placeholders[0].getClientRect().height, 0)
  } finally {
    if (prevDoc) globalThis.document = prevDoc
    else delete globalThis.document
    if (prevRect) globalThis.DOMRect = prevRect
    else delete globalThis.DOMRect
  }
})
