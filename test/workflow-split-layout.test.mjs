import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultWorkflowSplitRatio, workflowSplitLayout, workflowSplitterHeight } from '../src/components/workflowSplitLayout.ts'

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { appStorage, bootstrapAppStorage, resetAppStorageForTests } from '../src/appStorage.ts'
import { mappingPanelLayoutStorageKey, useMappingPanelWidths } from '../src/components/mappingPanelLayout.ts'


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
const require = createRequire(import.meta.url)
const splitterModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync('src/components/MappingColumnSplitter.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  module: splitterModule, exports: splitterModule.exports, require,
  getComputedStyle: node => node.style,
  ResizeObserver: class { observe() {} disconnect() {} },
})
const { MappingColumnSplitter } = splitterModule.exports

test('column splitters follow pointer direction, include rail margins, clamp widths and support keyboard/reset', () => {
  for (const panel of ['diagram', 'library']) {
    const widths = []
    const target = { style: { marginLeft: panel === 'diagram' ? '14px' : '0px', marginRight: '0px' }, getBoundingClientRect: () => ({ width: panel === 'diagram' ? 386 : 300 }) }
    const handle = {
      parentElement: { clientWidth: 1000, style: { paddingLeft: '14px', paddingRight: '14px' } },
      previousElementSibling: target, nextElementSibling: target,
      focus() {}, setPointerCapture() {},
    }
    let view
    act(() => { view = Renderer.create(React.createElement(MappingColumnSplitter, { panel, onResize: width => widths.push(width) }), { createNodeMock: () => handle }) })
    const props = () => view.root.findByProps({ role: 'separator' }).props
    const event = { button: 0, clientX: 500, pointerId: 1, currentTarget: handle, preventDefault() {}, stopPropagation() {} }
    try {
      assert.equal(props()['aria-valuenow'], panel === 'diagram' ? 400 : 300)
      act(() => props().onPointerDown(event))
      act(() => props().onPointerMove({ ...event, clientX: 530 }))
      assert.equal(widths.at(-1), panel === 'diagram' ? 412 : 270)
      act(() => props().onPointerMove({ ...event, clientX: -5000 }))
      assert.equal(widths.at(-1), panel === 'diagram' ? 190 : 672)
      act(() => props().onPointerUp(event))
      const count = widths.length
      act(() => props().onPointerMove({ ...event, clientX: 600 }))
      assert.equal(widths.length, count, 'a released splitter stops resizing')
      act(() => props().onKeyDown({ ...event, key: 'ArrowRight' }))
      assert.equal(widths.at(-1), panel === 'diagram' ? 412 : 288)
      act(() => props().onDoubleClick())
      assert.equal(widths.at(-1), undefined)
    } finally { act(() => view.unmount()) }
  }
})

test('switching physical devices restores independent panel widths and edits only the selected device', async t => {
  t.after(() => resetAppStorageForTests())
  await bootstrapAppStorage({ forceNative: true, legacyStorage: null, invokeFn: async cmd => cmd === 'load_app_config' ? {} : undefined })
  let layout, view
  function Harness({ deviceId }) { layout = useMappingPanelWidths(deviceId); return null }
  act(() => { view = Renderer.create(React.createElement(Harness, { deviceId: 'one' })) })
  try {
    act(() => layout.resize('diagram', 420))
    act(() => layout.resize('library', 320))
    act(() => view.update(React.createElement(Harness, { deviceId: 'two' })))
    assert.deepEqual(layout.widths, {})
    act(() => layout.resize('library', 280))
    act(() => view.update(React.createElement(Harness, { deviceId: 'one' })))
    assert.deepEqual(layout.widths, { diagram: 420, library: 320 })
    act(() => layout.resize('diagram', undefined))
    act(() => view.update(React.createElement(Harness, { deviceId: 'two' })))
    assert.deepEqual(layout.widths, { library: 280 })
    assert.deepEqual(JSON.parse(appStorage.getItem(mappingPanelLayoutStorageKey)), { one: { library: 320 }, two: { library: 280 } })
  } finally { act(() => view.unmount()) }
})
