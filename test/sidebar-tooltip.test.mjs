import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
function setup() {
  let now = 0, nextId = 0, clicks = 0
  const timers = new Map(), listeners = new Map()
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/SidebarButton.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports, document: { body: {} },
    window: {
      innerHeight: 800,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
    },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id),
    require: name => name === 'react-dom' ? { createPortal: child => child } : require(name),
  })
  const props = { collapsed: true, title: '映射 · 双击展开侧栏', onClick: () => clicks++ }
  let view
  act(() => { view = Renderer.create(React.createElement(module.exports.SidebarButton, props), {
    createNodeMock: () => ({ getBoundingClientRect: () => ({ right: 56, top: 140, height: 42 }) }),
  }) })
  return {
    view,
    button: () => view.root.findByType('button'),
    hints: () => view.root.findAll(node => node.props.role === 'tooltip'),
    event(name, value = {}) { act(() => view.root.findByType('button').props[name](value)) },
    advance(ms) { act(() => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() } }) },
    emit(name, value = {}) { act(() => listeners.get(name)?.(value)) },
    update(values) { Object.assign(props, values); act(() => view.update(React.createElement(module.exports.SidebarButton, props))) },
    clicks: () => clicks,
    unmount() { act(() => view.unmount()); assert.equal(timers.size, 0); assert.equal(listeners.size, 0) },
  }
}

test('collapsed sidebar shows a custom hint after 500ms and removes the competing native title', () => {
  const app = setup()
  try {
    assert.equal(app.button().props.title, undefined)
    app.event('onMouseEnter')
    app.advance(499)
    assert.equal(app.hints().length, 0)
    app.advance(1)
    assert.equal(app.hints()[0].children[0], '映射 · 双击展开侧栏')
    app.event('onMouseLeave')
    assert.equal(app.hints().length, 0)
  } finally { app.unmount() }
})

test('leaving, activating, scrolling or dismissing cancels both pending and visible hints', () => {
  const app = setup()
  try {
    const dismissals = [() => app.event('onMouseLeave'), () => app.event('onPointerDown'), () => app.event('onClick'),
      () => app.event('onBlur'), ...['scroll', 'resize', 'blur'].map(name => () => app.emit(name)), () => app.emit('keydown', { key: 'Escape' })]
    for (const dismiss of dismissals) {
      app.event('onMouseEnter'); app.advance(250); dismiss(); app.advance(500)
      assert.equal(app.hints().length, 0)
      app.event('onMouseEnter'); app.advance(500)
      assert.equal(app.hints().length, 1)
      dismiss()
      assert.equal(app.hints().length, 0)
    }
    assert.equal(app.clicks(), 2)
  } finally { app.unmount() }
})

test('keyboard focus shows the hint immediately; expansion restores native titles and clears pending work', () => {
  const app = setup()
  try {
    app.event('onFocus', { currentTarget: { matches: () => true } })
    assert.equal(app.hints().length, 1)
    app.update({ title: '关于 · 发现新版本' })
    assert.equal(app.hints().length, 0)
    app.event('onMouseEnter')
    app.update({ collapsed: false })
    app.advance(500)
    assert.equal(app.hints().length, 0)
    assert.equal(app.button().props.title, '关于 · 发现新版本')
    app.update({ collapsed: true })
    app.event('onMouseEnter')
  } finally { app.unmount() }
})
