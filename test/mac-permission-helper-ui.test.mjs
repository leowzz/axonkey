import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function compile(path, imports = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}

const { MacPermissionHelperWindow } = compile('src/components/MacPermissionHelperWindow.tsx', {
  '../../src-tauri/icons/128x128@2x.png': { default: 'axonkey-icon.png' },
})

test('MacPermissionHelperWindow starts native file drag on pointer drag and switches permission tabs', () => {
  const events = []
  const baseProps = {
    activePermission: 'inputMonitoring',
    permissions: { inputMonitoring: false, accessibility: false, captureActive: false },
    nativeTitlebar: true,
    onSelectPermission: kind => events.push(['select', kind]),
    onOpenSettings: kind => events.push(['settings', kind]),
    onStartAppDrag: () => events.push(['drag']),
    onRevealApp: () => events.push(['reveal']),
    onRefresh: () => events.push(['refresh']),
    onClose: () => events.push(['close']),
  }

  const renderer = Renderer.create(React.createElement(MacPermissionHelperWindow, baseProps))
  try {
    assert.equal(renderer.root.findAllByProps({ className: 'native-titlebar' }).length, 1)

    const draggable = renderer.root.findByProps({ className: 'permission-draggable-app' })
    const icon = draggable.findByType('img')
    assert.equal(icon.props.src, 'axonkey-icon.png')

    // Sub-threshold movement does not trigger native drag.
    act(() => {
      draggable.props.onPointerDown({ button: 0, clientX: 50, clientY: 50 })
      draggable.props.onPointerMove({ buttons: 1, clientX: 51, clientY: 51 })
      draggable.props.onPointerUp()
    })
    assert.deepEqual(events, [])

    // Dragging >= 3px while holding primary button starts native file drag once.
    act(() => {
      draggable.props.onPointerDown({ button: 0, clientX: 50, clientY: 50 })
      draggable.props.onPointerMove({ buttons: 1, clientX: 60, clientY: 54 })
      draggable.props.onPointerMove({ buttons: 1, clientX: 80, clientY: 60 })
    })
    assert.deepEqual(events, [['drag']])

    const tabs = renderer.root.findByProps({ className: 'permission-helper-tabs' }).findAllByType('button')
    assert.equal(tabs.length, 2)
    act(() => {
      tabs[1].props.onClick()
    })
    assert.deepEqual(events, [['drag'], ['select', 'accessibility']])

    const targetPane = renderer.root.findByProps({ className: 'permission-target-pane' })
    act(() => {
      targetPane.props.onClick()
    })
    assert.deepEqual(events, [['drag'], ['select', 'accessibility'], ['settings', 'inputMonitoring']])

    // Ready state replaces the drag stage and marks completion.
    act(() => {
      renderer.update(
        React.createElement(MacPermissionHelperWindow, {
          ...baseProps,
          permissions: { inputMonitoring: true, accessibility: true, captureActive: true },
        }),
      )
    })
    assert.equal(renderer.root.findAllByProps({ className: 'permission-draggable-app' }).length, 0)
    assert.equal(renderer.root.findAllByProps({ className: 'permission-ready-state' }).length, 1)
  } finally {
    renderer.unmount()
  }
})
