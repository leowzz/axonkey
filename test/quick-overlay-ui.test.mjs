import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reicon from 'reicon-react'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})

const { buildQuickOverlayView, summarizeQuickTrigger } = await import('../src/components/quickOverlayModel.ts')
const { applyLocalCustomDevices } = await import('../src/cloud/deviceModelCatalog.ts')

function configuratorHarness() {
  const require = createRequire(import.meta.url)
  const modules = new Map()
  const document = { elementFromPoint: () => null }
  function load(file) {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        console,
        document,
        crypto: globalThis.crypto,
        setTimeout,
        clearTimeout,
        window: { localStorage: { getItem: () => null } },
        require(name) {
          if (name.endsWith('.css')) return {}
          if (name.endsWith('.svg')) return 'asset.svg'
          if (name === 'react-dom') return { createPortal: node => node }
          if (name === './QuickOverlay') return { QuickOverlayPresentation: () => null }
          if (name === './WorkflowStepDialog') return { WorkflowStepDialog: () => null }
          if (name === 'reicon-react') return reicon
          if (!name.startsWith('.')) return require(name)
          const path = resolve(dirname(file), name)
          return load(
            extname(path)
              ? path
              : existsSync(`${path}.tsx`)
                ? `${path}.tsx`
                : existsSync(`${path}.ts`)
                  ? `${path}.ts`
                  : `${path}/index.ts`,
          )
        },
      },
      { filename: file },
    )
    return module.exports
  }
  const { QuickOverlayConfigurator } = load('src/components/QuickOverlayConfigurator.tsx')
  const { WorkflowToolbox } = load('src/components/WorkflowToolbox.tsx')
  const { SelectControl } = load('src/components/SelectControl.tsx')
  const { packageFor } = load('src/devices/integration/model.ts')
  const { devices } = load('src/devices/index.ts')
  const { mouseInputs } = load('src/components/MouseMapping.tsx')
  const changes = []
  const props = {
    deviceKind: 'rc003',
    deviceName: '遥控器',
    profileId: 'quick',
    profileName: '快捷配置',
    inputs: packageFor('rc003').inputs,
    behaviors: {},
    platform: 'windows',
    onChange: (...args) => changes.push(args),
    onRename() {},
    onDuplicate() {},
    onDelete() {},
    onClose() {},
    history: { canUndo: false, canRedo: false, onUndo() {}, onRedo() {} },
  }
  let view
  const render = updates => {
    Object.assign(props, updates)
    act(() => {
      const element = React.createElement(QuickOverlayConfigurator, props)
      if (view) view.update(element)
      else view = Renderer.create(element)
    })
  }
  return {
    render,
    changes,
    document,
    WorkflowToolbox,
    SelectControl,
    devices,
    mouseInputs,
    packageFor,
    get view() {
      return view
    },
    close() {
      act(() => view.unmount())
    },
  }
}

const text = node => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))
const editorKeys = view =>
  view.root.findAll(node => node.type === 'button' && node.props.className?.includes('quick-overlay-editor-key'))
const enterStep = { componentType: 'task', type: 'enter', name: '回车', properties: {} }

test('quick configurator marks and disables its trigger, selects an editable key, and rejects drops on the trigger', () => {
  const harness = configuratorHarness()
  const trigger = harness.devices.find(device => device.id === 'rc003').inputIds[0]
  const legacy = { click: [{ id: 'legacy', type: 'key', key: 'Esc', enabled: true }], doubleClick: [], longPress: [] }
  harness.render({ triggerInput: `xiaomi.rc003.${trigger}`, behaviors: { [trigger]: legacy } })
  try {
    const keys = editorKeys(harness.view)
    const triggerKey = keys.find(key => key.props.className.includes('is-trigger'))
    assert.ok(triggerKey)
    assert.equal(triggerKey.props.disabled, true)
    assert.equal(triggerKey.props['aria-pressed'], false)
    assert.equal(triggerKey.props['data-quick-overlay-input'], undefined)
    assert.match(triggerKey.props['aria-label'], /触发键.*再按退出.*不可配置/)
    assert.match(text(triggerKey), /触发键再按退出/)
    assert.ok(!text(triggerKey).includes('Esc'), 'old actions do not obscure the reserved trigger')
    const selected = keys.find(key => key.props['aria-pressed'])
    assert.ok(selected)
    assert.notEqual(selected.props['data-quick-overlay-input'], trigger)
    act(() => triggerKey.props.onClick())
    assert.equal(
      editorKeys(harness.view).find(key => key.props['aria-pressed']),
      selected,
    )
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    assert.equal(harness.changes.length, 1)
    assert.equal(harness.changes[0][0], selected.props['data-quick-overlay-input'])
    assert.equal(harness.changes[0][1].click[0].type, 'key')

    harness.document.elementFromPoint = () => ({
      closest: selector =>
        selector === '[data-quick-overlay-input]' && triggerKey.props['data-quick-overlay-input']
          ? { dataset: { quickOverlayInput: triggerKey.props['data-quick-overlay-input'] } }
          : null,
    })
    const event = {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      currentTarget: { setPointerCapture() {} },
    }
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onStepPointerDown(event, enterStep))
    const section = harness.view.root.findByProps({ 'aria-label': '快捷交互窗配置' })
    act(() => section.props.onPointerMove({ ...event, clientX: 20 }))
    act(() => section.props.onPointerUp({ ...event, clientX: 20, type: 'pointerup' }))
    assert.equal(harness.changes.length, 1, 'dragging onto the trigger must not write a sequence')

    const nextTrigger = selected.props['data-quick-overlay-input']
    harness.render({ triggerInput: nextTrigger })
    assert.equal(editorKeys(harness.view).find(key => key.props.className.includes('is-trigger')).props.disabled, true)
    assert.notEqual(
      editorKeys(harness.view).find(key => key.props['aria-pressed']).props['data-quick-overlay-input'],
      nextTrigger,
    )
    harness.render({ triggerInput: undefined })
    assert.equal(
      editorKeys(harness.view).some(key => key.props.className.includes('is-trigger')),
      false,
    )
    assert.equal(
      editorKeys(harness.view).find(key => key.props['data-quick-overlay-input'] === trigger).props.disabled,
      false,
    )
  } finally {
    harness.close()
  }
})

test('quick configurator reserves only the triggering mouse scope and handles a profile with no editable keys', () => {
  const harness = configuratorHarness()
  harness.render({
    deviceKind: 'mouse',
    inputs: harness.mouseInputs,
    triggerInput: 'mouse.top.buttonMiddle',
  })
  try {
    assert.equal(editorKeys(harness.view).filter(key => key.props.className.includes('is-trigger')).length, 1)
    const scope = harness.view.root.findByType(harness.SelectControl)
    act(() => scope.props.onChange({ target: { value: 'left' } }))
    const middle = editorKeys(harness.view).find(
      key => key.props['data-quick-overlay-input'] === 'mouse.left.buttonMiddle',
    )
    assert.ok(middle)
    assert.equal(middle.props.disabled, false)
    assert.equal(
      editorKeys(harness.view).some(key => key.props.className.includes('is-trigger')),
      false,
    )
    act(() => middle.props.onClick())
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    assert.equal(harness.changes[0][0], 'mouse.left.buttonMiddle')

    const input = { id: 'power', label: '电源键', icon: 'power' }
    harness.render({ deviceKind: 'rc003', inputs: [input], triggerInput: input.id })
    assert.equal(
      editorKeys(harness.view).some(key => key.props['aria-pressed']),
      false,
    )
    assert.equal(harness.view.root.findAllByProps({ className: 'quick-overlay-track' }).length, 0)
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    assert.equal(harness.changes.length, 1, 'a reserved sole key cannot receive toolbox actions')
  } finally {
    harness.close()
  }
})

test('quick configurator keeps default actions after click or drag insertion and switching keys', () => {
  const defaults = [
    ['volumeControl', { type: 'key', key: 'VolumeUp' }],
    ['mediaTrack', { type: 'key', key: 'MediaPrevious' }],
    ['mouseButton', { type: 'mouse', button: 'left' }],
    ['wheel', { type: 'wheel', direction: 'up' }],
    ['cursorMove', { type: 'cursorMove', direction: 'up', distance: 50 }],
  ]
  const harness = configuratorHarness()
  const inputs = [
    { id: 'power', label: '电源键', icon: 'power' },
    { id: 'menu', label: '菜单键', icon: 'menu' },
  ]
  harness.render({ inputs })
  try {
    for (const mode of ['click', 'drag'])
      for (const [type, value] of defaults) {
        harness.render({ behaviors: {} })
        act(() =>
          editorKeys(harness.view)
            .find(key => key.props['data-quick-overlay-input'] === 'power')
            .props.onClick(),
        )
        const toolbox = harness.view.root.findByType(harness.WorkflowToolbox)
        const action = toolbox.props.palettes
          .flatMap(palette => palette.groups)
          .flatMap(group => group.steps)
          .find(step => step.type === type)
        const count = harness.changes.length
        if (mode === 'click') act(() => toolbox.props.onAddStep(action))
        else {
          harness.document.elementFromPoint = () => ({
            closest: selector =>
              selector === '[data-quick-overlay-input]' ? { dataset: { quickOverlayInput: 'power' } } : null,
          })
          const event = {
            button: 0,
            isPrimary: true,
            pointerId: 1,
            clientX: 0,
            clientY: 0,
            currentTarget: { setPointerCapture() {} },
          }
          act(() => toolbox.props.onStepPointerDown(event, action))
          const section = harness.view.root.findByProps({ 'aria-label': '快捷交互窗配置' })
          act(() => section.props.onPointerMove({ ...event, clientX: 20 }))
          act(() => section.props.onPointerUp({ ...event, clientX: 20, type: 'pointerup' }))
        }
        assert.equal(harness.changes.length, count + 1, `${mode}: ${type} saves without editing`)
        const [id, saved] = harness.changes.at(-1)
        assert.equal(id, 'power')
        assert.deepEqual(JSON.parse(JSON.stringify(saved.click)), [{ id: saved.click[0]?.id, enabled: true, ...value }])
        harness.render({ behaviors: { [id]: saved } })
        act(() =>
          editorKeys(harness.view)
            .find(key => key.props['data-quick-overlay-input'] === 'menu')
            .props.onClick(),
        )
        assert.equal(harness.view.root.findAllByProps({ className: 'quick-overlay-step' }).length, 0)
        act(() =>
          editorKeys(harness.view)
            .find(key => key.props['data-quick-overlay-input'] === 'power')
            .props.onClick(),
        )
        assert.equal(harness.view.root.findAllByProps({ className: 'quick-overlay-step' }).length, 1)
        assert.equal(harness.changes.length, count + 1)
      }
  } finally {
    harness.close()
  }
})

test('Escape dismisses live and simulated quick overlays and removes its listener after closing', () => {
  const require = createRequire(import.meta.url)
  const listeners = new Map()
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/components/QuickOverlay.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      },
    },
    require(name) {
      if (name === './quickOverlayModel') return { buildQuickOverlayView }
      if (name === './QuickOverlaySurface') return { QuickOverlaySurface: () => null }
      if (name.startsWith('../') || name.startsWith('@tauri-apps/')) return {}
      return require(name)
    },
  })
  const { QuickOverlayPresentation } = module.exports
  const view = buildQuickOverlayView(
    {
      revision: 1,
      sourceId: 'dev',
      deviceKind: 'rc003',
      deviceName: '遥控器',
      profileId: 'quick',
      profileName: '快捷配置',
      triggerInput: 'menu',
      behaviors: {},
      pressed: [],
      preview: false,
    },
    'windows',
  )
  let dismissals = 0
  let prevented = 0
  for (const preview of [false, true]) {
    let renderer
    act(() => {
      renderer = Renderer.create(
        React.createElement(QuickOverlayPresentation, {
          view,
          preview,
          onDismiss: () => {
            dismissals++
          },
        }),
      )
    })
    try {
      const before = dismissals
      act(() =>
        listeners.get('keydown')({
          key: 'Enter',
          preventDefault() {
            prevented++
          },
        }),
      )
      assert.equal(dismissals, before)
      act(() =>
        listeners.get('keydown')({
          key: 'Escape',
          preventDefault() {
            prevented++
          },
        }),
      )
      assert.equal(dismissals, before + 1)
      assert.equal(renderer.root.findByProps({ className: 'quick-overlay-close' }).props['aria-keyshortcuts'], 'Escape')
    } finally {
      act(() => renderer.unmount())
    }
    assert.equal(listeners.size, 0)
  }
  assert.equal(prevented, 2)
})

test('quick overlay view resolves trigger exit key, preserves full prompt text, and excludes trigger key from executable cards', () => {
  const longPrompt =
    '请作为资深架构师审查当前选中的代码，重点指出潜在的数据竞争、未处理的错误分支以及可简化的抽象，不要重写无关逻辑。'

  const view = buildQuickOverlayView(
    {
      revision: 3,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '书房遥控器',
      profileId: 'quick-ai',
      profileName: 'AI 编程提示词',
      triggerInput: 'xiaomi.rc003.menu',
      pressed: ['xiaomi.rc003.up'],
      preview: false,
      behaviors: {
        menu: {
          click: [{ id: '1', type: 'paste', text: '不会被执行，因为再次按触发键直接退出', enabled: true }],
        },
        'xiaomi.rc003.up': {
          click: [
            { id: '2', type: 'paste', text: longPrompt, enabled: true },
            { id: '3', type: 'delay', ms: 30, enabled: true },
            { id: '4', type: 'key', key: 'Enter', enabled: true },
          ],
        },
        down: {
          click: [{ id: '5', type: 'shortcut', keys: ['Win', 'K'], enabled: true }],
          longPress: [{ id: '6', type: 'paste', text: '生成精简的单元测试用例', enabled: true }],
        },
      },
    },
    'macos',
  )

  assert.equal(view.isMouse, false)
  assert.equal(view.profileName, 'AI 编程提示词')
  assert.equal(view.deviceName, '书房遥控器')
  assert.equal(view.triggerInputId, 'menu')
  assert.ok(view.triggerLabel && view.triggerLabel.length > 0)
  assert.deepEqual(view.pressedIds, ['up'])
  assert.deepEqual(view.mappedIds, ['up', 'down'])

  const upCard = view.items.find(item => item.inputId === 'up')
  assert.ok(upCard)
  assert.equal(upCard.triggers.length, 1)
  assert.equal(upCard.triggers[0].kind, 'prompt')
  assert.equal(upCard.triggers[0].badge, '粘贴并发送')
  assert.equal(upCard.triggers[0].text, longPrompt)

  const downCard = view.items.find(item => item.inputId === 'down')
  assert.ok(downCard)
  assert.equal(downCard.triggers.length, 2)
  assert.equal(downCard.triggers[0].triggerLabel, '单击')
  assert.match(downCard.triggers[0].text, /Cmd \+ K/)
  assert.equal(downCard.triggers[1].triggerLabel, '长按')
  assert.equal(downCard.triggers[1].text, '生成精简的单元测试用例')
})

test('quick overlay view supports system mouse, multi-scope slots, and custom SVG devices', () => {
  const mouseView = buildQuickOverlayView(
    {
      revision: 7,
      sourceId: 'mouse',
      deviceKind: 'mouse',
      deviceName: '系统鼠标',
      profileId: 'mouse-q1',
      profileName: '鼠标快捷面板',
      triggerInput: 'mouse.global.buttonMiddle',
      pressed: [],
      preview: false,
      behaviors: {
        'mouse.global.buttonBack': {
          click: [{ id: '1', type: 'paste', text: '总结当前网页核心结论', enabled: true }],
        },
        'mouse.top.buttonBack': {
          click: [{ id: '1b', type: 'shortcut', keys: ['Win', 'ArrowUp'], enabled: true }],
        },
        'mouse.top.up': {
          click: [{ id: '2', type: 'key', key: 'F12', enabled: true }],
        },
      },
    },
    'windows',
  )

  assert.equal(mouseView.isMouse, true)
  assert.equal(mouseView.triggerInputId, 'mouse.global.buttonMiddle')
  assert.equal(mouseView.items.length, 3)
  assert.equal(mouseView.surface.variant, 'mouse')
  assert.equal(mouseView.surface.wheelWell.center?.status, 'trigger')

  const backSlot = mouseView.surface.thumbStack.find(s => s.slotId === 'buttonBack')
  assert.ok(backSlot)
  assert.equal(backSlot.scopedEntries?.length, 2)
  assert.equal(backSlot.scopedEntries[0].inputId, 'mouse.global.buttonBack')
  assert.equal(backSlot.scopedEntries[1].inputId, 'mouse.top.buttonBack')
  assert.equal(backSlot.scopedEntries[1].contextLabel, '上边缘')

  const topWheel = mouseView.items.find(item => item.inputId === 'mouse.top.up')
  assert.ok(topWheel)
  assert.ok(topWheel.contextLabel)
  assert.equal(topWheel.triggers[0].triggerLabel, '滚动')

  const customSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="200" height="120" viewBox="0 0 200 120"
     data-ak-schema="axonkey.device/1"
     data-ak-device="studio.pad2"
     data-ak-revision="1"
     data-ak-status="active">
  <metadata>
    <ak:device schema="axonkey.device/1" id="studio.pad2" vendor="Studio" model="Pad2" revision="1" display-name="双键宏板" status="active">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xB099" usage-page="0xFF60" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="btns" direction="input" report-id="0x01" length="2" encoding="bit-field" prefix="0x01" state-group="btns" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="studio.pad2.k1" label="宏键一" short="M1" icon="center" kind="button" target="#k1" order="0" original="false" binding="captured"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x01" /></ak:input>
        <ak:input id="studio.pad2.k2" label="宏键二" short="M2" icon="center" kind="button" target="#k2" order="1" original="false" binding="captured"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x02" /></ak:input>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="k1"><rect x="10" y="10" width="80" height="80" /></g>
  <g id="k2"><rect x="110" y="10" width="80" height="80" /></g>
  <path data-ak-region="studio.pad2.k1" data-ak-anchor="50 50" d="M10 10h80v80h-80z" />
  <path data-ak-region="studio.pad2.k2" data-ak-anchor="150 50" d="M110 10h80v80h-80z" />
</svg>`

  applyLocalCustomDevices([
    {
      kind: 'studioPad2',
      deviceId: 'studio.pad2',
      name: '双键宏板',
      model: 'Pad2',
      vendor: 'Studio',
      svg: customSvg,
      filePath: 'custom-devices/studio-pad2.svg',
    },
  ])

  const customView = buildQuickOverlayView(
    {
      revision: 8,
      sourceId: 'pad-1',
      deviceKind: 'studioPad2',
      deviceName: '桌面双键板',
      profileId: 'pad-q1',
      profileName: '剪辑提示',
      triggerInput: 'studio.pad2.k1',
      pressed: [],
      preview: true,
      behaviors: {
        'studio.pad2.k2': {
          click: [{ id: '1', type: 'typeText', text: 'git status -sb', enabled: true }],
        },
      },
    },
    'macos',
  )

  assert.equal(customView.triggerLabel, '宏键一')
  assert.equal(customView.items.length, 1)
  assert.equal(customView.items[0].label, '宏键二')
  assert.equal(customView.items[0].short, 'M2')
  assert.equal(customView.items[0].triggers[0].badge, '输入')
  assert.equal(customView.items[0].triggers[0].text, 'git status -sb')
  assert.equal(customView.surface.variant, 'matrix')
  assert.equal(customView.surface.rows, 1)
  assert.equal(customView.surface.cols, 2)

  applyLocalCustomDevices([])
})

test('summarizeQuickTrigger highlights embedded prompt inside multi-step sequences', () => {
  const detail = summarizeQuickTrigger(
    'click',
    [
      { id: '1', type: 'shortcut', keys: ['Win', 'L'], enabled: true },
      { id: '2', type: 'delay', ms: 80, enabled: true },
      { id: '3', type: 'paste', text: '解释当前报错原因并给出最小修复方案', enabled: true },
      { id: '4', type: 'key', key: 'Enter', enabled: true },
    ],
    'macos',
  )
  assert.ok(detail)
  assert.equal(detail.kind, 'sequence')
  assert.equal(detail.badge, '4 步序列')
  assert.equal(detail.text, '解释当前报错原因并给出最小修复方案')
  assert.match(detail.stepsSummary ?? '', /粘贴文本/)

  assert.equal(summarizeQuickTrigger('click', [{ id: '1', type: 'key', key: 'A', enabled: false }], 'macos'), null)
})

test('geometry compiler transforms bundled remotes, bridge remotes, dual-view side rails, matrix keypads, and gamepads into ceramic surfaces without hardcoding', () => {
  // 1. RC003 standard vertical remote -> panel with crown row, cross ring, and 3 stem rows
  const rcView = buildQuickOverlayView(
    {
      revision: 9,
      sourceId: 'rc-mouse',
      deviceKind: 'rc003',
      deviceName: '小米遥控器',
      profileId: 'p-mouse',
      profileName: '鼠标操作',
      triggerInput: 'menu',
      pressed: ['confirm'],
      preview: false,
      behaviors: {
        power: { click: [{ id: '1', enabled: true, type: 'openPath', path: '/Users/leo/work/reveland' }] },
        up: { click: [{ id: '3', enabled: true, type: 'cursorMove', direction: 'up', distance: 50 }] },
        confirm: { click: [{ id: '5', enabled: true, type: 'mouse', button: 'left' }] },
      },
    },
    'macos',
  )
  assert.equal(rcView.surface.variant, 'panel')
  assert.ok(
    rcView.surface.blocks.some(b => b.kind === 'cross' && b.up?.inputId === 'up' && b.center?.inputId === 'confirm'),
  )
  assert.equal(rcView.surface.sideRail, undefined)

  // 2. CMIOT A15 -> detects symmetric left/right rocker stacks flanking central voice button (bridge block)
  const a15View = buildQuickOverlayView(
    {
      revision: 10,
      sourceId: 'a15-1',
      deviceKind: 'cmiotA15',
      deviceName: 'CMIOT A15',
      profileId: 'a15-q',
      profileName: '会议控制',
      triggerInput: 'cmiotA15.voice',
      pressed: [],
      preview: false,
      behaviors: {
        'cmiotA15.volumeUp': { click: [{ id: '1', enabled: true, type: 'key', key: 'VolumeUp' }] },
        'cmiotA15.channelUp': { click: [{ id: '2', enabled: true, type: 'key', key: 'PageUp' }] },
      },
    },
    'macos',
  )
  assert.equal(a15View.surface.variant, 'panel')
  const a15Bridge = a15View.surface.blocks.find(b => b.kind === 'bridge')
  assert.ok(a15Bridge, 'expected bridge block for A15 rockers + center voice')
  assert.equal(a15Bridge.center.inputId, 'cmiotA15.voice')
  assert.equal(a15Bridge.center.status, 'trigger')

  // 3. TCL RC802A dual-view SVG -> automatically splits side buttons into right sideRail
  const tclView = buildQuickOverlayView(
    {
      revision: 11,
      sourceId: 'tcl-1',
      deviceKind: 'tclRc802a',
      deviceName: 'TCL RC802A',
      profileId: 'tcl-q',
      profileName: '演示控制',
      triggerInput: 'tcl-rc802a.voice',
      pressed: [],
      preview: false,
      behaviors: {
        'tcl-rc802a.sideUpper': { click: [{ id: '1', enabled: true, type: 'key', key: 'PageUp' }] },
      },
    },
    'macos',
  )
  assert.equal(tclView.surface.variant, 'panel')
  assert.equal(tclView.surface.sideRail?.side, 'right')
  assert.equal(tclView.surface.sideRail?.slots.length, 3)
  assert.ok(tclView.surface.blocks.some(b => b.kind === 'cross'))

  // 4. Kivo K18 Lite -> pure geometry detects 4x5 matrix and 1x2 top-left OLED span
  const k18View = buildQuickOverlayView(
    {
      revision: 12,
      sourceId: 'k18-1',
      deviceKind: 'kivoK18Lite',
      deviceName: 'Kivo K18 Lite',
      profileId: 'k18-ai',
      profileName: 'AI 编程助手',
      triggerInput: 'kivo.k18Lite.k01',
      pressed: [],
      preview: false,
      behaviors: {
        'kivo.k18Lite.k02': { click: [{ id: '1', enabled: true, type: 'shortcut', keys: ['Win', '['] }] },
        'kivo.k18Lite.k18': {
          click: [{ id: '2', enabled: true, type: 'key', key: 'Esc' }],
          longPress: [{ id: '3', enabled: true, type: 'shortcut', keys: ['Win', 'Q'] }],
        },
      },
    },
    'macos',
  )
  assert.equal(k18View.surface.variant, 'matrix')
  assert.equal(k18View.surface.rows, 4)
  assert.equal(k18View.surface.cols, 5)
  assert.deepEqual(k18View.surface.oledSpan, { row: 1, colStart: 1, colSpan: 2 })
  const k01 = k18View.surface.cells.find(c => c.inputId === 'kivo.k18Lite.k01')
  assert.deepEqual({ row: k01?.row, col: k01?.col, status: k01?.status }, { row: 1, col: 3, status: 'trigger' })

  // 5. Xbox controller -> geometry compiler detects controller variant with shoulders, center, D-pad & ABXY diamond
  const xboxSession = {
    revision: 13,
    sourceId: 'xb-1',
    deviceKind: 'xboxBluetooth',
    deviceName: 'Xbox 手柄',
    profileId: 'xb-q',
    profileName: '审片控制',
    triggerInput: 'xbox.menu',
    pressed: [],
    preview: false,
    behaviors: {
      'xbox.a': { click: [{ id: '1', enabled: true, type: 'key', key: 'Space' }] },
      'xbox.lt': { click: [{ id: '2', enabled: true, type: 'key', key: 'Left' }] },
    },
  }
  const xboxView = buildQuickOverlayView(xboxSession, 'macos')
  assert.equal(xboxView.surface.variant, 'controller')
  assert.equal(xboxView.surface.leftShoulders.length, 2)
  assert.equal(xboxView.surface.rightShoulders.length, 2)
  assert.ok(xboxView.surface.leftPod.some(b => b.kind === 'cross'))
  assert.ok(xboxView.surface.rightPod.some(b => b.kind === 'cross'))
  const xboxEditorView = buildQuickOverlayView(xboxSession, 'macos', { includeUnconfiguredAxes: true })
  assert.equal(xboxEditorView.surface.variant, 'controller')
  for (const axis of ['xbox.ls.up', 'xbox.ls.left', 'xbox.rs.right', 'xbox.rs.down']) {
    assert.ok(JSON.stringify(xboxEditorView.surface).includes(`"inputId":"${axis}"`))
    assert.ok(!JSON.stringify(xboxView.surface).includes(`"inputId":"${axis}"`))
  }
})

test('G17 geometry retains the numpad spans and keeps all six touch controls in a separate ordered rail', () => {
  const session = {
    revision: 1,
    sourceId: 'g17',
    deviceKind: 'g17Touch',
    deviceName: 'G17 Touch',
    profileId: 'quick-g17',
    profileName: '数字快捷键',
    triggerInput: 'g17.touch.num',
    pressed: ['g17.touch.t2'],
    preview: false,
    behaviors: { 'g17.touch.t2': { click: [{ id: 't2', type: 'key', key: 'Enter', enabled: true }] } },
  }
  const assertLayout = (surface, prefix, withRail = true) => {
    assert.equal(surface.variant, 'matrix')
    assert.equal(surface.rows, 5)
    assert.equal(surface.cols, 4)
    assert.equal(surface.cells.length, 17)
    assert.equal(surface.oledSpan, undefined)
    const expected = [
      ['num', 1, 1, 1, 1],
      ['div', 1, 2, 1, 1],
      ['mul', 1, 3, 1, 1],
      ['sub', 1, 4, 1, 1],
      ['k7', 2, 1, 1, 1],
      ['k8', 2, 2, 1, 1],
      ['k9', 2, 3, 1, 1],
      ['add', 2, 4, 2, 1],
      ['k4', 3, 1, 1, 1],
      ['k5', 3, 2, 1, 1],
      ['k6', 3, 3, 1, 1],
      ['k1', 4, 1, 1, 1],
      ['k2', 4, 2, 1, 1],
      ['k3', 4, 3, 1, 1],
      ['enter', 4, 4, 2, 1],
      ['k0', 5, 1, 1, 2],
      ['dot', 5, 3, 1, 1],
    ]
    assert.deepEqual(
      surface.cells.map(cell => [
        cell.inputId.slice(prefix.length),
        cell.row,
        cell.col,
        cell.rowSpan ?? 1,
        cell.colSpan ?? 1,
      ]),
      expected,
    )
    assert.equal(new Set(surface.cells.map(cell => cell.inputId)).size, 17)
    if (withRail) {
      assert.equal(surface.sideRail.side, 'right')
      assert.deepEqual(
        surface.sideRail.slots.map(slot => slot.inputId),
        ['swipeUp', 't1', 't2', 't3', 't4', 'swipeDown'].map(id => prefix + id),
      )
    } else assert.equal(surface.sideRail, undefined)
  }
  const view = buildQuickOverlayView(session, 'windows')
  assertLayout(view.surface, 'g17.touch.')
  assert.equal(view.surface.cells[0].status, 'trigger')
  assert.equal(view.surface.sideRail.slots[2].status, 'configured')
  assert.deepEqual(view.mappedIds, ['g17.touch.t2'])
  assert.deepEqual(view.pressedIds, ['g17.touch.t2'])
  assert.deepEqual(buildQuickOverlayView(session, 'windows', { includeUnconfiguredAxes: true }), view)

  const svg = readFileSync('public/device-descriptors/g17-touch.svg', 'utf8').replaceAll('g17.touch', 'acme.pad')
  const custom = { ...session, deviceKind: 'unregisteredPad', descriptorSvg: svg, triggerInput: '', behaviors: {} }
  assertLayout(buildQuickOverlayView(custom, 'windows').surface, 'acme.pad.')
  const numpadOnly = svg
    .replace(/<ak:input\b[^>]*id="acme\.pad\.(?:swipeUp|swipeDown|t[1-4])"[^>]*\/>/g, '')
    .replace(/<path\b[^>]*data-ak-region="acme\.pad\.(?:swipeUp|swipeDown|t[1-4])"[^>]*\/>/g, '')
  assertLayout(buildQuickOverlayView({ ...custom, descriptorSvg: numpadOnly }, 'windows').surface, 'acme.pad.', false)
})

test('G17 configurator renders spanning keys and independently selectable touch controls', () => {
  const harness = configuratorHarness()
  harness.render({
    deviceKind: 'g17Touch',
    inputs: harness.packageFor('g17Touch').inputs,
    triggerInput: 'g17.touch.num',
  })
  try {
    const key = id =>
      editorKeys(harness.view).find(node => node.props['data-quick-overlay-input'] === `g17.touch.${id}`)
    assert.equal(editorKeys(harness.view).length, 23)
    assert.equal(key('add').props.style.gridRow, '2 / span 2')
    assert.equal(key('enter').props.style.gridRow, '4 / span 2')
    assert.equal(key('k0').props.style.gridColumn, '1 / span 2')
    const rail = harness.view.root.findByProps({ 'aria-label': '侧面按键区' })
    assert.equal(rail.findAllByType('button').length, 6)
    act(() => key('t4').props.onClick())
    assert.equal(key('t4').props['aria-pressed'], true)
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    assert.equal(harness.changes[0][0], 'g17.touch.t4')
  } finally {
    harness.close()
  }
})

test('cloud-delivered descriptorSvg on session dynamically compiles brand-new unregistered SVG models into ceramic surfaces', () => {
  // Brand-new presenter remote SVG pushed from cloud console (never pre-bundled anywhere)
  const cloudPresenterSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="360" height="820" viewBox="0 0 360 820"
     data-ak-schema="axonkey.device/1"
     data-ak-device="acme.presenterR1"
     data-ak-revision="1">
  <metadata>
    <ak:device schema="axonkey.device/1" id="acme.presenterR1" vendor="Acme" model="Presenter R1" revision="1" display-name="Acme 演示笔 R1">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xC100" usage-page="0xFF00" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="btns" direction="input" report-id="0x01" length="2" encoding="bit-field" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="acme.r1.laser" label="激光" short="激光" icon="locate" kind="button" target="#k1" order="0"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x01" /></ak:input>
        <ak:input id="acme.r1.up" label="上翻" short="上" icon="up" kind="button" target="#k2" order="1"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x02" /></ak:input>
        <ak:input id="acme.r1.left" label="左切" short="左" icon="left" kind="button" target="#k3" order="2"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x03" /></ak:input>
        <ak:input id="acme.r1.ok" label="确认" short="确认" icon="center" kind="button" target="#k4" order="3"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x04" /></ak:input>
        <ak:input id="acme.r1.right" label="右切" short="右" icon="right" kind="button" target="#k5" order="4"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x05" /></ak:input>
        <ak:input id="acme.r1.down" label="下翻" short="下" icon="down" kind="button" target="#k6" order="5"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x06" /></ak:input>
        <ak:input id="acme.r1.ai" label="AI助手" short="AI" icon="mic" kind="button" target="#k7" order="6"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x07" /></ak:input>
        <ak:input id="acme.r1.black" label="黑屏" short="黑屏" icon="tv" kind="button" target="#k8" order="7"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x08" /></ak:input>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="k1"/><g id="k2"/><g id="k3"/><g id="k4"/><g id="k5"/><g id="k6"/><g id="k7"/><g id="k8"/>
  <path data-ak-region="acme.r1.laser" data-ak-anchor="180 90" d="M150 60h60v60h-60z" />
  <path data-ak-region="acme.r1.up" data-ak-anchor="180 220" d="M150 190h60v60h-60z" />
  <path data-ak-region="acme.r1.left" data-ak-anchor="76 324" d="M46 294h60v60h-60z" />
  <path data-ak-region="acme.r1.ok" data-ak-anchor="180 324" d="M150 294h60v60h-60z" />
  <path data-ak-region="acme.r1.right" data-ak-anchor="284 324" d="M254 294h60v60h-60z" />
  <path data-ak-region="acme.r1.down" data-ak-anchor="180 428" d="M150 398h60v60h-60z" />
  <path data-ak-region="acme.r1.ai" data-ak-anchor="104 620" d="M74 590h60v60h-60z" />
  <path data-ak-region="acme.r1.black" data-ak-anchor="256 620" d="M226 590h60v60h-60z" />
</svg>`

  const cloudView = buildQuickOverlayView(
    {
      revision: 21,
      sourceId: 'cloud-r1',
      deviceKind: 'acmePresenterR1',
      deviceName: 'Acme 演示笔 R1',
      profileId: 'cloud-q',
      profileName: '演讲模式',
      triggerInput: 'acme.r1.ai',
      pressed: [],
      preview: false,
      descriptorSvg: cloudPresenterSvg,
      behaviors: {
        'acme.r1.ok': {
          click: [{ id: 'c1', enabled: true, type: 'paste', text: '请为本页幻灯片补充一句精炼收尾金句' }],
        },
      },
    },
    'macos',
  )

  assert.equal(cloudView.triggerLabel, 'AI助手')
  assert.equal(cloudView.surface.variant, 'panel')
  assert.equal(cloudView.surface.blocks.length, 3)
  assert.equal(cloudView.surface.blocks[0].kind, 'row')
  assert.equal(cloudView.surface.blocks[1].kind, 'cross')
  assert.equal(cloudView.surface.blocks[1].center?.inputId, 'acme.r1.ok')
  assert.equal(cloudView.surface.blocks[1].center?.primaryKind, 'prompt')
  assert.equal(cloudView.surface.blocks[2].kind, 'row')
  assert.equal(cloudView.surface.blocks[2].slots[0].status, 'trigger')

  // Brand-new 2x3 macro keypad pushed from cloud console -> auto compiles into 2x3 matrix
  const cloudGridSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="420" height="300" viewBox="0 0 420 300"
     data-ak-schema="axonkey.device/1"
     data-ak-device="acme.grid6"
     data-ak-revision="1">
  <metadata>
    <ak:device schema="axonkey.device/1" id="acme.grid6" vendor="Acme" model="Grid6" revision="1" display-name="Acme 6键小盘">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xC106" usage-page="0xFF00" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="btns" direction="input" report-id="0x01" length="2" encoding="bit-field" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="acme.g6.b1" label="B1" short="B1" icon="center" kind="button" target="#b1" order="0"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x01" /></ak:input>
        <ak:input id="acme.g6.b2" label="B2" short="B2" icon="center" kind="button" target="#b2" order="1"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x02" /></ak:input>
        <ak:input id="acme.g6.b3" label="B3" short="B3" icon="center" kind="button" target="#b3" order="2"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x03" /></ak:input>
        <ak:input id="acme.g6.b4" label="B4" short="B4" icon="center" kind="button" target="#b4" order="3"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x04" /></ak:input>
        <ak:input id="acme.g6.b5" label="B5" short="B5" icon="center" kind="button" target="#b5" order="4"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x05" /></ak:input>
        <ak:input id="acme.g6.b6" label="B6" short="B6" icon="center" kind="button" target="#b6" order="5"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x06" /></ak:input>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="b1"/><g id="b2"/><g id="b3"/><g id="b4"/><g id="b5"/><g id="b6"/>
  <path data-ak-region="acme.g6.b1" data-ak-anchor="80 85" d="M40 45h80v80h-80z" />
  <path data-ak-region="acme.g6.b2" data-ak-anchor="210 85" d="M170 45h80v80h-80z" />
  <path data-ak-region="acme.g6.b3" data-ak-anchor="340 85" d="M300 45h80v80h-80z" />
  <path data-ak-region="acme.g6.b4" data-ak-anchor="80 215" d="M40 175h80v80h-80z" />
  <path data-ak-region="acme.g6.b5" data-ak-anchor="210 215" d="M170 175h80v80h-80z" />
  <path data-ak-region="acme.g6.b6" data-ak-anchor="340 215" d="M300 175h80v80h-80z" />
</svg>`

  const gridView = buildQuickOverlayView(
    {
      revision: 22,
      sourceId: 'cloud-g6',
      deviceKind: 'acmeGrid6',
      deviceName: 'Acme 6键小盘',
      profileId: 'grid-q',
      profileName: '剪辑宏',
      triggerInput: 'acme.g6.b1',
      pressed: [],
      preview: false,
      descriptorSvg: cloudGridSvg,
      behaviors: {
        'acme.g6.b4': { click: [{ id: 'g1', enabled: true, type: 'key', key: 'Space' }] },
      },
    },
    'macos',
  )

  assert.equal(gridView.surface.variant, 'matrix')
  assert.equal(gridView.surface.rows, 2)
  assert.equal(gridView.surface.cols, 3)
  assert.equal(gridView.surface.oledSpan, undefined)

  assets.deregister()
})

test('quick configurator supports Pure Prompt Mode editing, non-destructive notices, and standard step quick actions', () => {
  const harness = configuratorHarness()
  const inputs = [
    { id: 'up', label: '上方向', icon: 'up' },
    { id: 'down', label: '下方向', icon: 'down' },
    { id: 'menu', label: '菜单', icon: 'menu' },
  ]
  const shortcutSeq = {
    click: [{ id: 's1', enabled: true, type: 'shortcut', keys: ['Ctrl', 'C'] }],
    doubleClick: [],
    longPress: [],
  }
  const toggledModes = []
  harness.render({
    inputs,
    triggerInput: 'menu',
    promptMode: false,
    behaviors: { down: shortcutSeq },
    onTogglePromptMode: next => {
      toggledModes.push(next)
      harness.render({ promptMode: next })
    },
  })

  try {
    // Standard Mode: single-click edit step, quick-delete step, and track clear button
    const upKey = () => editorKeys(harness.view).find(k => k.props['data-quick-overlay-input'] === 'up')
    act(() => upKey().props.onClick())
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    const savedClick = harness.changes.at(-1)[1].click
    assert.equal(savedClick.length, 1)
    harness.render({ behaviors: { up: { click: savedClick, doubleClick: [], longPress: [] }, down: shortcutSeq } })

    const stepBtn = harness.view.root.findByProps({ className: 'quick-overlay-step' })
    act(() => stepBtn.props.onClick())
    // Opening WorkflowStepDialog (stubbed as null) runs without throwing; quick-remove deletes the step cleanly.
    const removeBtn = harness.view.root.findByProps({ className: 'quick-overlay-step-remove' })
    act(() => removeBtn.props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(harness.changes.at(-1)[1].click)), [])

    act(() =>
      editorKeys(harness.view)
        .find(k => k.props['data-quick-overlay-input'] === 'down')
        .props.onClick(),
    )
    const clearBtn = harness.view.root.findByProps({ className: 'quick-overlay-track-clear' })
    act(() => clearBtn.props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(harness.changes.at(-1))), [
      'down',
      { click: [], doubleClick: [], longPress: [] },
    ])

    // Standard Mode edits on currently selected key immediately sync into Pure Prompt Mode when toggled on
    act(() => upKey().props.onClick())
    const initialPasteUp = {
      click: [{ id: 'p0', enabled: true, type: 'paste', title: '快速回复', text: '收到，马上处理' }],
      doubleClick: [],
      longPress: [],
    }
    harness.render({ behaviors: { up: initialPasteUp, down: shortcutSeq } })
    act(() => harness.view.root.findByType(harness.WorkflowToolbox).props.onAddStep(enterStep))
    const standardUpSeq = {
      click: JSON.parse(JSON.stringify(harness.changes.at(-1)[1].click)),
      doubleClick: [],
      longPress: [],
    }
    assert.equal(standardUpSeq.click.length, 2)
    harness.render({ behaviors: { up: standardUpSeq, down: shortcutSeq } })

    const modeSwitch = harness.view.root.findByProps({ role: 'switch' })
    assert.equal(modeSwitch.props['aria-checked'], false)
    act(() => modeSwitch.props.onClick())
    assert.deepEqual(toggledModes, [true])
    assert.equal(harness.view.root.findByProps({ role: 'switch' }).props['aria-checked'], true)
    assert.equal(harness.view.root.findAllByProps({ className: 'quick-overlay-track' }).length, 0)
    const promptEditor = harness.view.root.findByProps({ 'aria-label': 'Prompt 编辑器' })
    assert.ok(promptEditor)
    assert.equal(promptEditor.find(node => node.type === 'input' && node.props.type === 'text').props.value, '快速回复')
    assert.equal(promptEditor.find(node => node.type === 'textarea').props.value, '收到，马上处理')
    assert.equal(promptEditor.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, true)

    // Non-prompt sequence key displays warning notice and does not overwrite when toggling autoEnter alone
    act(() =>
      editorKeys(harness.view)
        .find(k => k.props['data-quick-overlay-input'] === 'down')
        .props.onClick(),
    )
    harness.render({ behaviors: { down: shortcutSeq } })
    const notice = promptEditor.findByProps({ className: 'quick-overlay-prompt-notice' })
    assert.match(text(notice), /已配置其他行为/)
    const beforeToggleCount = harness.changes.length
    const autoEnterCheckbox = promptEditor.find(node => node.type === 'input' && node.props.type === 'checkbox')
    act(() => autoEnterCheckbox.props.onChange({ target: { checked: true } }))
    assert.equal(harness.changes.length, beforeToggleCount, 'toggling option without content preserves other behaviors')

    // Switching to 'up' key and authoring titled prompt updates keycap live and commits on blur
    act(() => upKey().props.onClick())
    const titleInput = promptEditor.find(node => node.type === 'input' && node.props.type === 'text')
    const contentArea = promptEditor.find(node => node.type === 'textarea')
    const typeMethodBtn = promptEditor.findAll(node => node.type === 'button' && text(node) === '模拟输入')[0]

    act(() => titleInput.props.onChange({ target: { value: '总结提交' } }))
    act(() => contentArea.props.onChange({ target: { value: '请总结本次提交的重点改动' } }))
    // Keycap previews live draft immediately before debounce/blur
    assert.match(text(upKey()), /总结提交/)
    act(() => contentArea.props.onBlur())
    const committedUp = harness.changes.at(-1)
    assert.equal(committedUp[0], 'up')
    assert.equal(committedUp[1].click[0].type, 'paste')
    assert.equal(committedUp[1].click[0].title, '总结提交')
    assert.equal(committedUp[1].click[0].text, '请总结本次提交的重点改动')

    harness.render({ behaviors: { up: committedUp[1], down: shortcutSeq } })
    act(() => typeMethodBtn.props.onClick())
    act(() =>
      promptEditor
        .find(node => node.type === 'input' && node.props.type === 'checkbox')
        .props.onChange({ target: { checked: true } }),
    )
    const finalUp = harness.changes.at(-1)[1].click
    assert.deepEqual(JSON.parse(JSON.stringify(finalUp.map(step => step.type))), ['typeText', 'delay', 'key'])
    assert.equal(finalUp[0].title, '总结提交')

    // Clearing prompt slot resets sequence to empty while preserving chosen method
    harness.render({ behaviors: { up: { click: finalUp, doubleClick: [], longPress: [] }, down: shortcutSeq } })
    act(() => promptEditor.findByProps({ className: 'quick-overlay-track-clear' }).props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(harness.changes.at(-1))), [
      'up',
      { click: [], doubleClick: [], longPress: [] },
    ])
    harness.render({ behaviors: { down: shortcutSeq } })
    assert.equal(
      promptEditor.findAll(node => node.type === 'button' && text(node) === '模拟输入')[0].props['aria-pressed'],
      true,
    )
  } finally {
    harness.close()
  }
})

test('QuickOverlayPresentation renders Pure Prompt Mode pill, titled keycaps, compact tags, and detail preview', () => {
  const require = createRequire(import.meta.url)
  const modules = new Map()
  const listeners = new Map()
  function load(file) {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        console,
        window: {
          addEventListener: (type, fn) => listeners.set(type, fn),
          removeEventListener: (type, fn) => {
            if (listeners.get(type) === fn) listeners.delete(type)
          },
        },
        require(name) {
          if (name.endsWith('.css')) return {}
          if (name.startsWith('../devices/') && name.endsWith('/railOverview')) return { railKeyGlyphText: () => null }
          if (name === './InputIcon') return { iconFor: () => null }
          if (name === './quickOverlayModel') return { buildQuickOverlayView, summarizeQuickTrigger }
          if (name.startsWith('../') || name.startsWith('@tauri-apps/')) return {}
          if (!name.startsWith('.')) return require(name)
          const path = resolve(dirname(file), name)
          return load(extname(path) ? path : existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts`)
        },
      },
      { filename: file },
    )
    return module.exports
  }
  const { QuickOverlayPresentation } = load('src/components/QuickOverlay.tsx')

  const view = buildQuickOverlayView(
    {
      revision: 1,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '书房遥控器',
      profileId: 'q-prompt',
      profileName: '代码评审提示词',
      triggerInput: 'menu',
      pressed: [],
      preview: false,
      promptMode: true,
      behaviors: {
        up: { click: [{ id: 'p1', enabled: true, type: 'paste', title: '找 Bug', text: '找出潜在竞态与空指针' }] },
        down: {
          click: [
            { id: 'p2', enabled: true, type: 'paste', title: '直接发送', text: '生成回归测试' },
            { id: 'd2', enabled: true, type: 'delay', ms: 30 },
            { id: 'e2', enabled: true, type: 'key', key: 'Enter' },
          ],
        },
      },
    },
    'macos',
  )

  let renderer
  act(() => {
    renderer = Renderer.create(
      React.createElement(QuickOverlayPresentation, { view, preview: false, onDismiss() {}, onTrigger() {} }),
    )
  })
  try {
    const shell = renderer.root.findByProps({ role: 'dialog' })
    assert.match(shell.props.className, /is-prompt-mode/)
    const pill = renderer.root.findByProps({ className: 'quick-overlay-mode-pill is-prompt' })
    assert.equal(text(pill), '纯 Prompt')

    const upButton = renderer.root.findAll(
      node => node.type === 'button' && node.props.className?.includes('kind-prompt') && text(node).includes('找 Bug'),
    )[0]
    assert.ok(upButton)
    assert.ok(!text(upButton).includes('粘贴'), 'Pure Prompt Mode suppresses repetitive 粘贴 tag')
    assert.match(text(upButton), /找出潜在竞态与空指针/)

    const downButton = renderer.root.findAll(
      node =>
        node.type === 'button' && node.props.className?.includes('kind-prompt') && text(node).includes('直接发送'),
    )[0]
    assert.ok(downButton)
    assert.match(text(downButton), /↵ 发送/)

    const detailBar = renderer.root.findByProps({ className: 'quick-surface-detail-bar' })
    assert.match(text(detailBar), /找 Bug/)
    assert.match(text(detailBar), /找出潜在竞态与空指针/)
  } finally {
    act(() => renderer.unmount())
  }
})

test('QuickOverlayConfigurator renders inline trigger binding controls and empty-slot quick-add chips', () => {
  const harness = configuratorHarness()
  const boundEvents = []
  harness.render({
    triggerInput: 'menu',
    triggerType: 'longPress',
    onBindTrigger: (inputId, trigger) => boundEvents.push([inputId, trigger]),
  })
  try {
    const keySelect = harness.view.root.findByProps({ 'aria-label': '快捷交互窗唤起按键' })
    const triggerSelect = harness.view.root.findByProps({ 'aria-label': '快捷交互窗唤起方式' })
    assert.equal(keySelect.props.value, 'menu')
    assert.equal(triggerSelect.props.value, 'longPress')

    act(() => {
      keySelect.props.onChange({ target: { value: 'tv' } })
    })
    assert.deepEqual(boundEvents.at(-1), ['tv', 'longPress'])

    const chips = harness.view.root.findAllByProps({ className: 'quick-overlay-quick-chip' })
    assert.deepEqual(chips.map(chip => text(chip).trim()), ['按键', '快捷键', '粘贴文本'])
  } finally {
    harness.close()
  }
})
