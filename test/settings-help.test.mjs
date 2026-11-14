import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function createHarness() {
  const listeners = new Map()
  const windowMock = {
    innerWidth: 980,
    innerHeight: 680,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) {
        handler({ type, preventDefault() {}, ...event })
      }
    },
  }
  const module = { exports: {} }
  const source = ts.transpileModule(
    readFileSync(new URL('../src/components/SettingsHelp.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    document: { body: { nodeType: 1 } },
    window: windowMock,
    setTimeout,
    clearTimeout,
    require: dependency =>
      dependency === 'react-dom'
        ? { createPortal: children => children }
        : require(dependency),
  })
  return { SettingsHelp: module.exports.SettingsHelp, windowMock }
}

test('settings help stays open while selecting or scrolling inside its popover and closes on Escape or outside click', async () => {
  const { SettingsHelp, windowMock } = createHarness()
  const insideNode = { id: 'copyable-text' }
  const outsideNode = { id: 'outside' }
  const buttonMock = {
    closest: () => null,
    contains: target => target === buttonMock,
    getBoundingClientRect: () => ({ left: 920, right: 944, top: 640, bottom: 664, width: 24, height: 24 }),
  }
  const panelMock = {
    contains: target => target === panelMock || target === insideNode,
    getBoundingClientRect: () => ({ left: 0, right: 280, top: 0, bottom: 120, width: 280, height: 120 }),
  }

  let view
  act(() => {
    view = Renderer.create(
      React.createElement(SettingsHelp, { id: 'help-mic', label: '虚拟麦克风' }, 'MiRemoteV 2ch'),
      {
        createNodeMock: element => {
          if (element.type === 'button') return buttonMock
          if (element.type === 'div') return panelMock
          return null
        },
      },
    )
  })

  try {
    const trigger = view.root.findByType('button')
    act(() => trigger.props.onClick())
    const popover = view.root.findByProps({ className: 'settings-help-popover' })

    // Clamps horizontally and flips above the trigger at 980x680 bottom-right edge.
    assert.equal(popover.props.style.left, 980 - 280 - 8)
    assert.equal(popover.props.style.top, 640 - 120 - 6)

    // Real browser W3C event order when clicking/selecting inside popover while trigger is focused:
    // pointerdown (panel + window) -> mousedown -> trigger blur (relatedTarget: null).
    act(() => {
      popover.props.onMouseEnter()
      popover.props.onPointerDown()
      windowMock.dispatch('pointerdown', { target: insideNode })
      trigger.props.onBlur({ relatedTarget: null })
    })
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 1)

    // Scrolling inside the popover does not self-dismiss.
    act(() => windowMock.dispatch('scroll', { target: insideNode }))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 1)

    // Leaving the popover after trigger already blurred schedules delayed close.
    act(() => popover.props.onMouseLeave())
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 0)

    // Keyboard blur when pointer is not inside popover closes after delay.
    act(() => trigger.props.onFocus())
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 1)
    act(() => trigger.props.onBlur({ relatedTarget: null }))
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 0)

    // Escape and outside pointerdown close immediately.
    act(() => trigger.props.onClick())
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 1)
    act(() => windowMock.dispatch('keydown', { key: 'Escape' }))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 0)

    act(() => trigger.props.onClick())
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 1)
    act(() => windowMock.dispatch('pointerdown', { target: outsideNode }))
    assert.equal(view.root.findAllByProps({ className: 'settings-help-popover' }).length, 0)
  } finally {
    act(() => view.unmount())
  }
})
