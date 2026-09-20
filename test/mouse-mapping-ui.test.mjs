import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, extname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { createBehavior, createDefaultBehaviorMap } from '../src/behaviorModel.ts'

const require = createRequire(import.meta.url)
const cache = new Map()
function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (name === '../appConfig') return {
      triggerLabels: {click:'单击',doubleClick:'双击',longPress:'长按'},
      behaviorSummary: behavior => behavior.key ?? behavior.type,
    }
    if (name.startsWith('.')) {
      const path = resolve(dirname(file), name)
      return load(extname(path) ? path : existsSync(path+'.ts') ? path+'.ts' : path+'.tsx')
    }
    return require(name)
  }
  vm.runInNewContext(source, { module, exports:module.exports, require:localRequire, console }, { filename:file })
  return module.exports
}
const { DeviceSelector, DeviceStatusCard } = load('src/components/DeviceRail.tsx')
const { MouseInputModel, MouseControlPicker, MouseTriggerSelector } = load('src/components/MouseMapping.tsx')
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')

test('device selection exposes two rows and selected device owns its status card', () => {
  let view
  function Harness() {
    const [device, select] = React.useState('rc003')
    return React.createElement('main', null,
      React.createElement(DeviceSelector, {selectedId:device,onSelect:select}),
      React.createElement(DeviceStatusCard, {status:{title:device === 'rc003' ? '遥控器状态' : '鼠标状态',rows:device === 'rc003' ? [{label:'电量',value:'95%'}] : [{label:'输入来源',value:'系统鼠标'}]}}))
  }
  act(() => { view = Renderer.create(React.createElement(Harness)) })
  assert.equal(view.root.findAllByType('select').length, 0)
  assert.equal(view.root.findAllByType('button').length, 2)
  assert.equal(view.root.findAllByType('button')[0].props['aria-pressed'], true)
  act(() => view.root.findAllByType('button')[1].props.onClick())
  assert.equal(view.root.findByType('h3').children.join(''), '鼠标状态')
  assert.ok(!JSON.stringify(view.toJSON()).includes('95%'))
  act(() => view.unmount())
})

test('mouse model, input picker and scope preserve selection and expose supported triggers', () => {
  const behaviors = createDefaultBehaviorMap()
  behaviors['mouse.global.buttonForward'] = {click:[],doubleClick:[createBehavior({type:'key',key:'Enter'})],longPress:[]}
  let view, selected
  function Harness() {
    const [id,setId] = React.useState('mouse.top.up')
    const [trigger,setTrigger] = React.useState('click')
    selected = {id,trigger}
    const onSelect = (id, trigger) => {setId(id);setTrigger(trigger)}
    return React.createElement('main', null,
      React.createElement(MouseInputModel, {activeId:id,onSelect:id=>onSelect(id,'click')}),
      React.createElement(MouseControlPicker, {activeId:id,onSelect}),
      React.createElement(MouseTriggerSelector, {activeId:id,trigger,onSelect,behaviors,platform:'windows',rowRefs:{current:{}}}))
  }
  act(() => { view = Renderer.create(React.createElement(Harness)) })
  const buttons = () => view.root.findAllByType('button')
  const tabs = () => buttons().filter(b=>b.props.role === 'tab')
  assert.equal(tabs().length, 1)
  assert.ok(!buttons().some(b=>text(b) === '任意位置'))
  assert.ok(text(tabs()[0]).includes('保留原始滚动'))
  act(() => buttons().find(b=>b.props['aria-label'] === '选择鼠标左键').props.onClick())
  assert.deepEqual(selected, {id:'mouse.top.buttonLeft',trigger:'click'})
  assert.equal(tabs().length, 3)
  assert.ok(!text(tabs()[1]).includes('Enter'))
  assert.ok(!buttons().some(b=>text(b) === '任意位置'))
  assert.ok(text(tabs()[0]).includes('保留原始点击'))
  act(() => tabs()[1].props.onClick())
  act(() => buttons().find(b=>text(b) === '右边缘').props.onClick())
  assert.deepEqual(selected, {id:'mouse.right.buttonLeft',trigger:'doubleClick'})
  act(() => buttons().find(b=>b.props['aria-label'] === '选择向右滚动').props.onClick())
  assert.deepEqual(selected, {id:'mouse.right.right',trigger:'click'})
  assert.equal(tabs().length, 1)
  assert.ok(!buttons().some(b=>text(b) === '任意位置'))
  act(() => buttons().find(b=>b.props['aria-label'] === '选择鼠标前进键').props.onClick())
  assert.deepEqual(selected, {id:'mouse.right.buttonForward',trigger:'click'})
  assert.ok(buttons().some(b=>text(b) === '任意位置'))
  assert.ok(text(tabs()[1]).includes('沿用'))
  assert.ok(text(tabs()[1]).includes('Enter'))
  act(() => buttons().find(b=>text(b) === '任意位置').props.onClick())
  assert.deepEqual(selected, {id:'mouse.global.buttonForward',trigger:'click'})
  // Exercise the right-side picker as well as the model on the left.
  act(() => buttons().find(b=>text(b) === '鼠标右键').props.onClick())
  assert.deepEqual(selected, {id:'mouse.top.buttonRight',trigger:'click'})
  assert.ok(!buttons().some(b=>text(b) === '任意位置'))
  assert.equal(tabs().length, 3)
  act(() => view.unmount())
})

test('mouse status presents permission, switch, and settings action in order', () => {
  let view, toggles = 0, opens = 0
  act(() => { view = Renderer.create(React.createElement(DeviceStatusCard, { status: {
    title: '鼠标状态', rows: [{label:'输入权限',value:'已授权',tone:'ready'}],
    toggle: {checked:true,onChange:()=>toggles++}, onOpenSettings:()=>opens++,
  } })) })
  assert.equal(view.root.findAllByType('dd').length, 1)
  assert.equal(view.root.findByType('dd').children.join(''), '已授权')
  const buttons = view.root.findAllByType('button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props.role, 'switch')
  assert.equal(buttons[0].props['aria-checked'], true)
  assert.equal(buttons[1].props['aria-label'], '鼠标映射设置')
  act(() => { buttons[0].props.onClick(); buttons[1].props.onClick() })
  assert.equal(toggles, 1)
  assert.equal(opens, 1)
  act(() => view.unmount())
})
