import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reiconReact from 'reicon-react'

const require = createRequire(import.meta.url)

const text = node =>
  typeof node === 'string' ? node : (Array.isArray(node) ? node : (node?.children ?? [])).map(text).join('')

function transpileTsFile(path) {
  const raw = readFileSync(path, 'utf8').replaceAll(
    'import.meta.url',
    JSON.stringify(`file://${process.cwd().replace(/\\/g, '/')}/${path}`),
  )
  return ts.transpileModule(raw, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
}

function createCaptureHarness({ invokeImpl, saveDialogImpl, native = true } = {}) {
  const invokeCalls = []
  const listeners = new Map()
  const downloads = []

  const invoke = async (cmd, args) => {
    invokeCalls.push({ cmd, args })
    if (invokeImpl) return invokeImpl(cmd, args)
    throw new Error(`Unhandled invoke: ${cmd}`)
  }

  const listen = async (eventName, cb) => {
    const set = listeners.get(eventName) ?? new Set()
    set.add(cb)
    listeners.set(eventName, set)
    return () => set.delete(cb)
  }

  const emitCaptureEvent = async payload => {
    const set = listeners.get('axonkey-device-capture') ?? new Set()
    await act(async () => {
      for (const cb of [...set]) {
        cb({ payload })
      }
    })
  }

  const saveDialog = async opts => {
    if (saveDialogImpl) return saveDialogImpl(opts)
    return 'C:/exports/demo-remote.svg'
  }

  class MockElement {
    isConnected = true
    href = ''
    download = ''
    focus() {}
    click() {
      downloads.push({ download: this.download, href: this.href })
    }
    remove() {}
  }

  const mockDocument = {
    activeElement: new MockElement(),
    body: {
      appendChild() {},
    },
    createElement: () => new MockElement(),
    getElementById: () => null,
  }

  const mockWindow = Object.assign(new EventTarget(), native ? { __TAURI_INTERNALS__: {} } : {})
  const clipboardWrites = []

  const baseGlobals = {
    URL: Object.assign(
      function (...args) {
        return new globalThis.URL(...args)
      },
      {
        createObjectURL: () => 'blob:mock-export',
        revokeObjectURL: () => {},
      },
    ),
    Blob: globalThis.Blob,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    document: mockDocument,
    window: mockWindow,
    HTMLElement: MockElement,
    fetch: async url => {
      const cleanPath = String(url).replace(/^\//, '')
      const content = readFileSync(`public/${cleanPath}`, 'utf8')
      return {
        ok: true,
        status: 200,
        text: async () => content,
      }
    },
    navigator: {
      clipboard: {
        writeText: async str => {
          clipboardWrites.push(str)
        },
      },
    },
  }

  function evalModule(path, extraImports = {}) {
    const code = transpileTsFile(path)
    const module = { exports: {} }
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      ...baseGlobals,
      require: name => {
        if (name in extraImports) return extraImports[name]
        if (name === '@tauri-apps/api/core') return { invoke }
        if (name === '@tauri-apps/api/event') return { listen }
        if (name === '@tauri-apps/plugin-dialog') return { save: saveDialog }
        if (name === 'react-dom') return { createPortal: node => node }
        if (name === 'reicon-react') return reiconReact
        if (name.endsWith('.css')) return {}
        return require(name)
      },
    })
    return module.exports
  }

  const captureModel = evalModule('src/devices/capture/model.ts')
  const captureStage = evalModule('src/devices/capture/CaptureSvgStage.tsx', {
    './model': captureModel,
  })
  const captureDeviceList = evalModule('src/devices/capture/CaptureDeviceList.tsx', {
    './model': captureModel,
  })
  const captureSafetyDialog = evalModule('src/devices/capture/CaptureSafetyConfirmDialog.tsx', {
    './model': captureModel,
  })
  const workbenchMod = evalModule('src/devices/capture/DeviceCaptureWorkbench.tsx', {
    '../../cloud/deviceModelCatalog': require('../src/cloud/deviceModelCatalog.ts'),
    '../generatedDescriptors': require('../src/devices/generatedDescriptors.ts'),
    './model': captureModel,
    './CaptureSvgStage': captureStage,
    './CaptureDeviceList': captureDeviceList,
    './CaptureSafetyConfirmDialog': captureSafetyDialog,
  })

  return {
    captureModel,
    CaptureDeviceList: captureDeviceList.CaptureDeviceList,
    DeviceCaptureWorkbench: workbenchMod.DeviceCaptureWorkbench,
    evalModule,
    invokeCalls,
    emitCaptureEvent,
    downloads,
    clipboardWrites,
  }
}

const pendingDraftSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:ak="urn:axonkey:device:1" width="320" height="640" viewBox="0 0 320 640" data-ak-schema="axonkey.device/1" data-ak-device="demo-rc1" data-ak-status="draft">
  <metadata>
    <ak:device schema="axonkey.device/1" id="demo-rc1" vendor="Demo" model="RC1" display-name="Demo RC1" status="draft">
      <ak:inputs>
        <ak:input id="demo-rc1.mute" label="静音键" short="静音" icon="mute" kind="button" target="#key-mute" order="1" binding="pending"/>
        <ak:input id="demo-rc1.home" label="主页键" short="主页" icon="home" kind="button" target="#key-home" order="2" binding="pending"/>
        <ak:input id="demo-rc1.back" label="返回键" short="返回" icon="back" kind="button" target="#key-back" order="3" binding="pending"/>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="front-view" data-ak-view="front">
    <g id="key-mute" data-ak-key="demo-rc1.mute"><circle cx="80" cy="100" r="24" fill="#222"/></g>
    <g id="key-home" data-ak-key="demo-rc1.home"><circle cx="160" cy="100" r="24" fill="#222"/></g>
    <g id="key-back" data-ak-key="demo-rc1.back"><circle cx="240" cy="100" r="24" fill="#222"/></g>
  </g>
  <g data-ak-regions="true" fill="transparent" pointer-events="none">
    <path data-ak-region="demo-rc1.mute" data-ak-anchor="80 100" d="M 56 100 A 24 24 0 1 0 104 100 A 24 24 0 1 0 56 100 Z"/>
    <path data-ak-region="demo-rc1.home" data-ak-anchor="160 100" d="M 136 100 A 24 24 0 1 0 184 100 A 24 24 0 1 0 136 100 Z"/>
    <path data-ak-region="demo-rc1.back" data-ak-anchor="240 100" d="M 216 100 A 24 24 0 1 0 264 100 A 24 24 0 1 0 216 100 Z"/>
  </g>
</svg>`

test('SVG sanitizer rejects unsafe scripts/handlers/external refs and parses real tcl-rc802a draft', () => {
  const { captureModel } = createCaptureHarness({ native: false })
  const { sanitizeAndExtractSvgStage, parseCaptureDraftSvgLocal, seedSamplesFromDraft } = captureModel

  assert.throws(
    () => sanitizeAndExtractSvgStage('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>'),
    /不允许的标签/,
  )
  assert.throws(
    () => sanitizeAndExtractSvgStage('<svg viewBox="0 0 10 10"><rect width="5" height="5" onclick="evil()"/></svg>'),
    /事件处理属性/,
  )
  assert.throws(
    () => sanitizeAndExtractSvgStage('<svg viewBox="0 0 10 10"><use href="https://evil.example/a.svg#x"/></svg>'),
    /外部资源/,
  )
  assert.throws(
    () => sanitizeAndExtractSvgStage('<!DOCTYPE svg [<!ENTITY xxe "bad">]><svg viewBox="0 0 10 10"></svg>'),
    /DOCTYPE/,
  )

  const tclSvg = readFileSync('docs/device-drafts/tcl-rc802a.svg', 'utf8')
  const stage = sanitizeAndExtractSvgStage(tclSvg)
  assert.equal(stage.viewBox.width, 440)
  assert.equal(stage.viewBox.height, 912)
  assert.equal(stage.hotzones.length, 22)

  const parsed = parseCaptureDraftSvgLocal(tclSvg)
  assert.equal(parsed.deviceId, 'tcl-rc802a')
  assert.equal(parsed.displayName, 'TCL RC802A')
  assert.equal(parsed.inputs.length, 22)

  const seeded = seedSamplesFromDraft(parsed)
  assert.equal(seeded.size, 22)
  assert.equal(seeded.get('tcl-rc802a.mute')?.pressHex, '01 00 00 EF 00 00 00 00 00')
})

test('safety guardrails enforce blocked devices, orphaned-driver banner, caution pre-attach + 15s keep-alive, and exit cleanup', async () => {
  let candidatesState = [
    {
      targetId: 'ble-remote',
      displayName: 'Demo BLE Remote',
      transport: 'bluetooth-le',
      instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&0416_PID&0301\\8&1111',
      vid: 0x0416,
      pid: 0x0301,
      usagePage: 0x0c,
      usage: 0x01,
      boundToQuarbor: false,
      recoveryActive: false,
      registeredKind: null,
      safetyTier: 'safe',
      safetyReason: null,
      gattInfo: { manufacturer: 'Demo', modelNumber: 'BT_RC1', softwareRevision: '1.0', bluetoothAddress: null },
    },
    {
      targetId: 'usb-keypad',
      displayName: 'Secondary Macro Keypad',
      transport: 'usb-hid',
      instanceId: 'HID\\VID_1234&PID_5678\\7&2222',
      vid: 0x1234,
      pid: 0x5678,
      usagePage: 0x01,
      usage: 0x06,
      boundToQuarbor: false,
      recoveryActive: false,
      registeredKind: null,
      safetyTier: 'caution',
      safetyReason: '检测到副键盘，挂载后将独占拦截该键盘输入',
      gattInfo: null,
    },
    {
      targetId: 'primary-mouse',
      displayName: 'System Primary Mouse',
      transport: 'usb-hid',
      instanceId: 'HID\\VID_046D&PID_C547\\7&3333',
      vid: 0x046d,
      pid: 0xc547,
      usagePage: 0x01,
      usage: 0x02,
      boundToQuarbor: false,
      recoveryActive: false,
      registeredKind: null,
      safetyTier: 'blocked',
      safetyReason: '系统鼠标输入源，禁止挂载拦截驱动以防锁死点击',
      gattInfo: null,
    },
    {
      targetId: 'orphan-pad',
      displayName: 'Orphan Unregistered Pad',
      transport: 'usb-hid',
      instanceId: 'HID\\VID_9999&PID_0001\\7&4444',
      vid: 0x9999,
      pid: 0x0001,
      usagePage: 0x0c,
      usage: 0x01,
      boundToQuarbor: true,
      recoveryActive: false,
      registeredKind: null,
      safetyTier: 'safe',
      safetyReason: null,
      gattInfo: null,
    },
  ]

  const h = createCaptureHarness({
    native: true,
    invokeImpl: async (cmd, args) => {
      if (cmd === 'capture_list_candidates') return candidatesState
      if (cmd === 'capture_detach_driver') {
        candidatesState = candidatesState.map(item =>
          item.instanceId === args.instanceId ? { ...item, boundToQuarbor: false } : item,
        )
        return {
          ok: true,
          instanceId: args.instanceId,
          boundToQuarbor: false,
          rebootRequired: false,
          cancelledByUser: false,
          installationState: 'uninstalled',
          message: null,
        }
      }
      if (cmd === 'capture_attach_driver') {
        candidatesState = candidatesState.map(item =>
          item.instanceId === args.instanceId ? { ...item, boundToQuarbor: true } : item,
        )
        return {
          ok: true,
          instanceId: args.instanceId,
          boundToQuarbor: true,
          rebootRequired: false,
          cancelledByUser: false,
          installationState: 'installed',
          message: null,
        }
      }
      if (cmd === 'capture_start_session') {
        return {
          active: true,
          targetId: args.targetId,
          instanceId: args.instanceId,
          transportMode: 'quarbor-pipe',
          driverVersion: '0.9.2.0',
          supportsKeysend: true,
          supportsResetInput: true,
          frameCount: 0,
          streamingReportIds: [],
        }
      }
      if (
        cmd === 'capture_set_workbench_active' ||
        cmd === 'capture_stop_session' ||
        cmd === 'capture_set_live_preview_svg' ||
        cmd === 'capture_arm_key'
      ) {
        return true
      }
      throw new Error(`Unexpected command: ${cmd}`)
    },
  })

  let backCount = 0
  const modal = { showModal() {}, close() {} }
  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(h.DeviceCaptureWorkbench, {
        native: true,
        onBack: () => {
          backCount += 1
        },
      }),
      { createNodeMock: node => (node.type === 'dialog' ? modal : null) },
    )
  })

  try {
    // 1. Orphaned bound unregistered device banner is visible immediately on mount with 1-click restore
    const orphanBanner = view.root.findByProps({ 'aria-label': '未注册拦截驱动提醒' })
    assert.match(text(orphanBanner), /Orphan Unregistered Pad/)
    await act(async () => {
      orphanBanner.findByType('button').props.onClick()
    })
    assert.ok(
      h.invokeCalls.some(
        c => c.cmd === 'capture_detach_driver' && c.args.instanceId === 'HID\\VID_9999&PID_0001\\7&4444',
      ),
    )
    assert.equal(view.root.findAllByProps({ 'aria-label': '未注册拦截驱动提醒' }).length, 0)

    // Enter Step 2 (定位与挂载) to inspect device tree & safety guardrails
    const step2Btn = view.root.findAllByType('button').find(btn => text(btn).includes('下一步：定位与挂载'))
    await act(async () => {
      step2Btn.props.onClick()
    })

    // 2. Blocked primary mouse has disabled attach & listen buttons + visible safetyReason
    const blockedCard = view.root.findByProps({ 'data-target-id': 'primary-mouse' })
    assert.match(text(blockedCard), /禁止挂载拦截驱动以防锁死点击/)
    const blockedButtons = blockedCard.findAllByType('button')
    assert.ok(blockedButtons.every(btn => btn.props.disabled === true))

    // 3. Caution secondary keyboard requires explicit pre-attach confirmation + 15s post-attach keep-alive
    const cautionCard = view.root.findByProps({ 'data-target-id': 'usb-keypad' })
    const attachCautionBtn = cautionCard.findAllByType('button').find(btn => text(btn).includes('挂载拦截驱动'))
    await act(async () => {
      attachCautionBtn.props.onClick()
    })

    const dialog = view.root.findByType('dialog')
    assert.match(text(dialog), /确认挂载副键盘拦截驱动/)
    const proceedBtn = () => dialog.findAllByType('button').find(btn => text(btn).includes('继续挂载拦截驱动'))
    assert.equal(proceedBtn().props.disabled, true)

    const confirmCheckbox = dialog.findAllByProps({ type: 'checkbox' })[0]
    await act(async () => {
      confirmCheckbox.props.onChange({ target: { checked: true } })
    })
    assert.equal(proceedBtn().props.disabled, false)

    await act(async () => {
      proceedBtn().props.onClick()
    })

    assert.ok(
      h.invokeCalls.some(
        c =>
          c.cmd === 'capture_attach_driver' &&
          c.args.instanceId === 'HID\\VID_1234&PID_5678\\7&2222' &&
          c.args.allowCaution === true,
      ),
    )
    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_start_session' && c.args.passthroughStandardKeys === true))

    // Now in 15-second keep-alive dialog! Confirming advances into Step 3 3-column workspace
    const keepAliveDialog = view.root.findByType('dialog')
    assert.match(text(keepAliveDialog), /请确认主键盘与鼠标输入正常/)
    assert.match(text(keepAliveDialog), /15s/)
    const confirmKeepAliveBtn = keepAliveDialog
      .findAllByType('button')
      .find(btn => text(btn).includes('确认主输入正常'))
    await act(async () => {
      confirmKeepAliveBtn.props.onClick()
    })
    assert.equal(view.root.findAllByType('dialog').length, 0)
    assert.ok(view.root.findByProps({ 'aria-label': 'HID 事件流面板' }))
    assert.ok(view.root.findByProps({ 'aria-label': '设备树抽屉' }))

    // 4. Closing workbench when session installed Quarbor on an unregistered device prompts exit cleanup
    const backBtn = view.root.findByProps({ 'aria-label': '返回我的设备' })
    await act(async () => {
      backBtn.props.onClick()
    })
    assert.equal(backCount, 0)
    const exitDialog = view.root.findByType('dialog')
    assert.match(text(exitDialog), /退出并恢复原驱动（推荐）/)
    assert.match(text(exitDialog), /保留驱动/)

    const restoreAndExitBtn = exitDialog
      .findAllByType('button')
      .find(btn => text(btn).includes('退出并恢复原驱动（推荐）'))
    await act(async () => {
      restoreAndExitBtn.props.onClick()
    })
    assert.equal(backCount, 1)
    assert.ok(
      h.invokeCalls.some(
        c => c.cmd === 'capture_detach_driver' && c.args.instanceId === 'HID\\VID_1234&PID_5678\\7&2222',
      ),
    )
  } finally {
    await act(async () => view.unmount())
  }
})

test('4-step integration workflow: SVG skill & preset prep -> diff & attach -> 3-column drag-drop + sequential capture + collapsible drawer -> press/release test & export', async () => {
  const candidate = {
    targetId: 'ble-rc1',
    displayName: 'Demo RC1 Remote',
    transport: 'bluetooth-le',
    instanceId: 'BTHLEDEVICE\\{00001812}_DEV_VID&0416_PID&0301\\8&9999',
    vid: 0x0416,
    pid: 0x0301,
    usagePage: 0x0c,
    usage: 0x01,
    boundToQuarbor: true,
    recoveryActive: false,
    registeredKind: null,
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
  }

  let livePreviewBackendEnabled = true
  const h = createCaptureHarness({
    native: true,
    saveDialogImpl: async () => 'D:/devices/demo-rc1.svg',
    invokeImpl: async (cmd, args) => {
      if (cmd === 'capture_list_candidates') return [candidate]
      if (cmd === 'capture_start_session') {
        return {
          active: true,
          targetId: args.targetId,
          instanceId: args.instanceId,
          transportMode: 'quarbor-pipe',
          driverVersion: '0.9.2.0',
          supportsKeysend: false,
          supportsResetInput: true,
          frameCount: 1,
          streamingReportIds: [],
        }
      }
      if (cmd === 'capture_parse_draft_svg') {
        return h.captureModel.parseCaptureDraftSvgLocal(args.svgContent)
      }
      if (cmd === 'capture_arm_key') return true
      if (cmd === 'capture_compile_svg') {
        return h.captureModel.compileCaptureSvgLocal(
          args.draftSvg,
          args.candidate,
          args.samples,
          args.targetStatus ?? undefined,
        )
      }
      if (cmd === 'capture_set_live_preview_svg') return livePreviewBackendEnabled
      if (cmd === 'capture_save_export') return true
      if (cmd === 'capture_stop_session' || cmd === 'capture_set_workbench_active') return true
      throw new Error(`Unexpected command: ${cmd}`)
    },
  })

  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(h.DeviceCaptureWorkbench, {
        native: true,
        onBack() {},
      }),
    )
  })

  try {
    // Step 1 (准备 SVG): Copy axonkey-device-svg skill prompt, load existing repo SVG preset, then load local draft SVG
    const copySkillBtn = view.root.findByProps({ 'aria-label': '复制生成 SVG 技能指令' })
    await act(async () => {
      await copySkillBtn.props.onClick()
    })
    assert.match(h.clipboardWrites[0], /axonkey-device-svg/)

    const presetBtn = view.root.findByProps({ 'data-preset-slug': 'tcl-rc802a' })
    await act(async () => {
      await presetBtn.props.onClick()
    })
    assert.match(text(view.toJSON()), /TCL RC802A/)

    const fileInput = view.root.findByProps({ 'aria-label': '选择本地 SVG 图稿文件' })
    await act(async () => {
      await fileInput.props.onChange({
        target: {
          value: 'demo-rc1.svg',
          files: [{ name: 'demo-rc1.svg', text: async () => pendingDraftSvg }],
        },
      })
    })
    assert.match(text(view.toJSON()), /已适配 0 \/ 3/)

    const hotzone = id => view.root.findByProps({ 'data-capture-key': id })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'pending')
    assert.equal(hotzone('demo-rc1.home').props['data-state'], 'pending')
    assert.equal(hotzone('demo-rc1.back').props['data-state'], 'pending')

    // Step 2 (定位与挂载): SVG remains visible alongside PnP tree; connecting session auto-enters Step 3 3-column layout!
    const nextToStep2Btn = view.root.findAllByType('button').find(btn => text(btn).includes('下一步：定位与挂载'))
    await act(async () => {
      nextToStep2Btn.props.onClick()
    })
    assert.ok(view.root.findByProps({ 'aria-label': '定位新设备与挂载驱动面板' }))
    assert.ok(view.root.findByProps({ 'aria-label': 'SVG 示意图舞台' }))

    const connectBtn = view.root.findAllByType('button').find(btn => text(btn).includes('连接采集'))
    await act(async () => {
      await connectBtn.props.onClick()
    })
    assert.match(text(view.root.findByProps({ className: 'capture-header-status' })), /会话已连接/)

    // Step 3 (采集绑定): Verify 3 columns 【SVG 示意图 | HID 事件流 | 设备树】 + collapsible right drawer
    const grid = () =>
      view.root.find(
        node => typeof node.props?.className === 'string' && node.props.className.includes('capture-workbench-grid'),
      )
    assert.match(grid().props.className, /is-three-col/)
    assert.doesNotMatch(grid().props.className, /is-drawer-collapsed/)
    assert.ok(view.root.findByProps({ 'aria-label': 'HID 事件流面板' }))
    assert.ok(view.root.findByProps({ 'aria-label': '设备树抽屉' }))

    const collapseDrawerBtn = view.root.findByProps({ 'aria-label': '收起设备树' })
    await act(async () => {
      collapseDrawerBtn.props.onClick()
    })
    assert.match(grid().props.className, /is-drawer-collapsed/)
    const expandDrawerBtn = view.root.findByProps({ 'aria-label': '展开设备树' })
    await act(async () => {
      expandDrawerBtn.props.onClick()
    })
    assert.doesNotMatch(grid().props.className, /is-drawer-collapsed/)

    // Streaming noise report (0x6F) is auto-filtered from HID event cards and surfaces ignore notice
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 10,
      reportId: 0x6f,
      hex: '6F 12 34 56',
      isStreamingNoise: true,
    })
    assert.match(text(view.toJSON()), /已自动忽略持续数据流报告 0x6F/)

    // Mode A (拖拽绑定): Press + hold repeat + release HID frames merge into ONE combined draggable item!
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 11,
      reportId: 0x01,
      hex: '01 00 00 EF 00 00',
      isStreamingNoise: false,
    })
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 12,
      reportId: 0x01,
      hex: '01 00 00 EF 00 00',
      isStreamingNoise: false,
    })
    assert.match(text(view.root.findByProps({ 'aria-label': 'HID 事件流列表' })), /按下中/)

    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 13,
      reportId: 0x01,
      hex: '01 00 00 00 00 00',
      isStreamingNoise: false,
    })

    const hidCards = view.root.findByProps({ 'aria-label': 'HID 事件流列表' }).findAllByProps({ role: 'listitem' })
    assert.equal(hidCards.length, 1)
    assert.match(text(hidCards[0]), /Demo RC1 Remote/)
    assert.match(text(hidCards[0]), /×1/)
    assert.match(text(hidCards[0]), /按下01 00 00 EF 00 00/)
    assert.match(text(hidCards[0]), /抬起01 00 00 00 00 00/)

    // Export paired HID stream JSON
    const exportJsonBtn = view.root.findAllByType('button').find(btn => text(btn).includes('导出 JSON'))
    await act(async () => {
      exportJsonBtn.props.onClick()
    })
    assert.equal(h.downloads.length, 1)
    assert.match(h.downloads[0].download, /demo-rc1\.capture\.json$/)

    // Drag-and-drop combined HID event card onto SVG hotzone 'demo-rc1.mute'
    const transferStore = new Map()
    const mockDataTransfer = {
      types: [h.captureModel.HID_EVENT_DRAG_MIME],
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (mime, val) => transferStore.set(mime, val),
      getData: mime => transferStore.get(mime) || '',
    }
    await act(async () => {
      hidCards[0].props.onDragStart({ dataTransfer: mockDataTransfer })
    })
    await act(async () => {
      hotzone('demo-rc1.mute').props.onDragOver({
        dataTransfer: mockDataTransfer,
        preventDefault() {},
        stopPropagation() {},
      })
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-drop-target'], true)

    await act(async () => {
      hotzone('demo-rc1.mute').props.onDrop({
        dataTransfer: mockDataTransfer,
        preventDefault() {},
        stopPropagation() {},
      })
      hidCards[0].props.onDragEnd()
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'captured')
    assert.match(text(view.toJSON()), /已适配 1 \/ 3/)

    // Mode B (逐步集成): Click '开始逐步采集' -> arms next pending key ('demo-rc1.home') -> press/release auto-advances!
    const startSeqBtn = view.root.findAllByType('button').find(btn => text(btn).includes('开始逐步采集'))
    await act(async () => {
      startSeqBtn.props.onClick()
    })
    assert.match(text(view.toJSON()), /请按下并松开【主页键】/)
    assert.equal(hotzone('demo-rc1.home').props['data-state'], 'armed')
    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_arm_key' && c.args.inputId === 'demo-rc1.home'))

    // Emit a colliding frame on home key -> collision warning surfaces!
    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'demo-rc1.home',
        reportId: 0x01,
        pressHex: '01 00 00 EF 00 00',
        releaseHex: '01 00 00 00 00 00',
        pressLength: 6,
        releaseLength: 6,
        holdCount: 1,
        durationMs: 80,
      },
    })
    assert.match(text(view.toJSON()), /按键冲突：【静音键】与【主页键】按下报文相同/)

    // Click SVG hotzone for home directly to re-arm & re-capture cleanly -> auto-advances to back key!
    await act(async () => {
      hotzone('demo-rc1.home').props.onClick()
    })
    assert.equal(hotzone('demo-rc1.home').props['data-state'], 'armed')

    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'demo-rc1.home',
        reportId: 0x01,
        pressHex: '01 00 00 83 00 00',
        releaseHex: '01 00 00 00 00 00',
        pressLength: 6,
        releaseLength: 6,
        holdCount: 2,
        durationMs: 90,
      },
    })
    assert.doesNotMatch(text(view.toJSON()), /按键冲突/)
    assert.equal(hotzone('demo-rc1.back').props['data-state'], 'armed')
    assert.match(text(view.toJSON()), /请按下并松开【返回键】/)

    // Capture final back key
    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'demo-rc1.back',
        reportId: 0x01,
        pressHex: '01 00 00 F1 00 00',
        releaseHex: '01 00 00 00 00 00',
        pressLength: 6,
        releaseLength: 6,
        holdCount: 1,
        durationMs: 85,
      },
    })
    assert.match(text(view.toJSON()), /已适配 3 \/ 3/)

    // Step 4 (测试与导出): Verify per-key press AND release state transitions via liveHit & rawFrame fallback
    livePreviewBackendEnabled = false
    const goStep4 = view.root.findAllByType('button').find(btn => text(btn).includes('进入测试与导出'))
    await act(async () => {
      goStep4.props.onClick()
    })

    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_compile_svg'))
    const testRow = id => view.root.findByProps({ 'data-test-key': id })
    assert.match(text(testRow('demo-rc1.mute')), /待按下.*待抬起/)

    // 1) Test via rawFrame matcher (when live_preview backend is inactive): press mute -> shows 按下中 + 松开测试…
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 30,
      reportId: 0x01,
      hex: '01 00 00 EF 00 00',
      isStreamingNoise: false,
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'live')
    assert.equal(hotzone('demo-rc1.mute').props['data-live-phase'], 'pressed')
    assert.match(text(testRow('demo-rc1.mute')), /按下中.*松开测试/)

    // Release mute -> hotzone shows data-live-phase="released" and checklist marks BOTH 按下 ✓ and 抬起 ✓!
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 31,
      reportId: 0x01,
      hex: '01 00 00 00 00 00',
      isStreamingNoise: false,
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'captured')
    assert.equal(hotzone('demo-rc1.mute').props['data-live-phase'], 'released')
    assert.match(text(testRow('demo-rc1.mute')), /按下 ✓.*抬起 ✓/)
    assert.match(text(view.toJSON()), /已验证 1 \/ 3/)

    // 2) Test via backend liveHit event on home key as well
    await h.emitCaptureEvent({
      kind: 'liveHit',
      inputId: 'demo-rc1.home',
      pressed: true,
      reportId: 0x01,
      hex: '01 00 00 83 00 00',
    })
    assert.equal(hotzone('demo-rc1.home').props['data-live-phase'], 'pressed')
    await h.emitCaptureEvent({
      kind: 'liveHit',
      inputId: 'demo-rc1.home',
      pressed: false,
      reportId: 0x01,
      hex: '01 00 00 00 00 00',
    })
    assert.equal(hotzone('demo-rc1.home').props['data-live-phase'], 'released')
    assert.match(text(view.toJSON()), /已验证 2 \/ 3/)

    // Save export & verify Markdown includes recorded target device name + copy CLI command
    const saveBtn = view.root.findAllByType('button').find(btn => text(btn).includes('保存 SVG 与采集记录'))
    await act(async () => {
      await saveBtn.props.onClick()
    })

    const saveCall = h.invokeCalls.find(c => c.cmd === 'capture_save_export')
    assert.ok(saveCall)
    assert.equal(saveCall.args.svgPath, 'D:/devices/demo-rc1.svg')
    assert.equal(saveCall.args.markdownPath, 'D:/devices/demo-rc1.md')
    assert.match(saveCall.args.svgContent, /press="01 00 00 EF 00 00"/)
    assert.match(saveCall.args.svgContent, /release="01 00 00 00 00 00"/)
    assert.match(saveCall.args.markdownContent, /Demo RC1 Remote/)

    const copyBtn = view.root.findByProps({ 'aria-label': '复制设备索引生成命令' })
    await act(async () => {
      await copyBtn.props.onClick()
    })
    assert.equal(h.clipboardWrites.at(-1), 'npm run generate:devices')
  } finally {
    await act(async () => view.unmount())
  }
})

test('DeviceHub header button and IntegrationDialog link open DeviceCaptureWorkbench', async () => {
  const h = createCaptureHarness({ native: false })
  const xboxDefinition = h.evalModule('src/devices/xbox-controller/definition.ts', {
    './xbox-controller.svg': { default: 'controller.svg' },
    './inputs.ts': require('../src/devices/xbox-controller/inputs.ts'),
  })
  const model = h.evalModule('src/devices/integration/model.ts', {
    '../xiaomi-remote/definition.ts': require('../src/devices/xiaomi-remote/definition.ts'),
    '../cmiot-a15-remote/definition.ts': require('../src/devices/cmiot-a15-remote/definition.ts'),
    '../xm-bt-29-remote/definition.ts': require('../src/devices/xm-bt-29-remote/definition.ts'),
    '../rc-313-remote/definition.ts': require('../src/devices/rc-313-remote/definition.ts'),
    '../obe-rcu-r5-remote/definition.ts': require('../src/devices/obe-rcu-r5-remote/definition.ts'),
    '../tcl-rc802a-remote/definition.ts': require('../src/devices/tcl-rc802a-remote/definition.ts'),
    '../tcl-rc902n-remote/definition.ts': require('../src/devices/tcl-rc902n-remote/definition.ts'),
    '../tcl-rc902v-remote/definition.ts': require('../src/devices/tcl-rc902v-remote/definition.ts'),
    '../hisense-rcf3b65-remote/definition.ts': require('../src/devices/hisense-rcf3b65-remote/definition.ts'),
    '../phicomm-db1-r-remote/definition.ts': require('../src/devices/phicomm-db1-r-remote/definition.ts'),
    '../kivo-k18-lite/definition.ts': require('../src/devices/kivo-k18-lite/definition.ts'),
    '../g17-touch/definition.ts': require('../src/devices/g17-touch/definition.ts'),
    '../xbox-controller/index.ts': xboxDefinition,
    '../../appStorage.ts': require('../src/appStorage.ts'),
  })
  const controls = h.evalModule('src/devices/integration/IntegrationControls.tsx')
  const battery = h.evalModule('src/components/BatteryIndicator.tsx')
  const behaviorLibraryContext = h.evalModule('src/cloud/BehaviorLibraryContext.tsx')
  const useDeviceModelCatalog = h.evalModule('src/cloud/useDeviceModelCatalog.ts', {
    './deviceModelCatalog.ts': require('../src/cloud/deviceModelCatalog.ts'),
  })
  const modelMarkdown = h.evalModule('src/devices/integration/ModelMarkdown.tsx', {
    '../../openExternalUrl': require('../src/openExternalUrl.ts'),
  })
  const { DeviceHub } = h.evalModule('src/devices/integration/DeviceHub.tsx', {
    '../../appStorage': require('../src/appStorage.ts'),
    '../../cloud/BehaviorLibraryContext': behaviorLibraryContext,
    '../../cloud/useDeviceModelCatalog': useDeviceModelCatalog,
    './InstanceWorkspace': { InstanceWorkspace: () => null },
    './IntegrationControls': controls,
    './ModelMarkdown': modelMarkdown,
    '../../components/BatteryIndicator': battery,
    './model': model,
    '../capture/DeviceCaptureWorkbench': {
      DeviceCaptureWorkbench: h.DeviceCaptureWorkbench,
    },
  })

  const hubProps = {
    selectedInstanceId: null,
    onSelectInstance() {},
    controller: {
      snapshot: model.emptySnapshot(),
      error: '',
      busy: false,
      refresh: async () => model.emptySnapshot(),
      reorder: async () => {},
      put: async () => model.emptySnapshot(),
      refreshInformation: async () => {},
    },
    native: false,
    platform: 'windows',
    permissions: { accessibility: true, inputMonitoring: true },
    onBrandClick() {},
    onPermissions() {},
    onLegacy() {},
    onOpenAudioCalibration() {},
    onOpenAudioDriver() {},
    onOpenBluetoothSettings() {},
    onOpenDeviceManager() {},
    driverAction: null,
    onInstallDriver() {},
    onUnbindDevice: async () => {},
    onRemoveDevice: async () => {},
    mouseProfileName: '默认配置',
  }

  const modal = { showModal() {}, close() {} }
  let view
  await act(async () => {
    view = Renderer.create(React.createElement(DeviceHub, hubProps), {
      createNodeMock: node => (node.type === 'dialog' ? modal : null),
    })
  })

  try {
    // 1. Header button opens capture workbench
    const headerAdaptBtn = view.root.findAllByType('button').find(btn => text(btn).includes('适配新设备'))
    assert.ok(headerAdaptBtn)
    await act(async () => {
      headerAdaptBtn.props.onClick()
    })
    assert.ok(view.root.findByProps({ 'aria-label': '适配新设备工作台' }))
    assert.match(text(view.toJSON()), /浏览器预览模式/)

    // Return to DeviceHub
    const backBtn = view.root.findByProps({ 'aria-label': '返回我的设备' })
    await act(async () => {
      await backBtn.props.onClick()
    })
    assert.equal(view.root.findAllByProps({ 'aria-label': '适配新设备工作台' }).length, 0)

    // 2. IntegrationDialog footer link also opens capture workbench, and manual add header reads 添加设备
    const addDeviceBtn = view.root.findAllByType('button').find(btn => text(btn).includes('手动添加设备'))
    await act(async () => {
      addDeviceBtn.props.onClick()
    })
    assert.equal(text(view.root.findByProps({ id: 'managed-integration-title' })), '添加设备')
    const modalAdaptLink = view.root.findAllByType('button').find(btn => text(btn).includes('没有找到型号？适配新设备'))
    assert.ok(modalAdaptLink)
    await act(async () => {
      modalAdaptLink.props.onClick()
    })
    assert.ok(view.root.findByProps({ 'aria-label': '适配新设备工作台' }))
  } finally {
    await act(async () => view.unmount())
  }
})

test('automatic temporary snapshot diff, scrollable list/tree CSS contracts, and file-directory tree hierarchy', async () => {
  // Verify scroll container CSS contracts across all device, preset, HID event, key, and test lists
  const cssText = readFileSync('src/devices/capture/DeviceCaptureWorkbench.css', 'utf8')
  for (const selector of [
    '\\.capture-tree',
    '\\.capture-candidate-list',
    '\\.capture-preset-svg-list',
    '\\.capture-hid-event-list',
    '\\.capture-key-list',
  ]) {
    const blockMatch = cssText.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
    assert.ok(blockMatch, `${selector} CSS rule must exist`)
    assert.match(blockMatch[1], /flex:\s*1\s+1\s+0/)
    assert.match(blockMatch[1], /min-height:\s*0/)
    assert.match(blockMatch[1], /overflow-y:\s*auto/)
  }
  const testListMatch = cssText.match(/\.capture-test-key-list\s*\{([^}]*)\}/)
  assert.ok(testListMatch)
  assert.match(testListMatch[1], /overflow-y:\s*auto/)
  const gridBlockMatch = cssText.match(/\.capture-workbench-grid\s*\{([^}]*)\}/)
  assert.ok(gridBlockMatch)
  assert.match(gridBlockMatch[1], /grid-template-rows:\s*minmax\(0,\s*1fr\)/)

  const usbHubAncestors = [
    { id: 'USB\\ROOT_HUB30\\5&1', label: 'USB 根集线器(USB 3.0)' },
    { id: 'USB\\VID_05E3&PID_0608\\6&2', label: '通用 USB 集线器 (05E3:0608)' },
  ]
  const oldUsbCandidate = {
    targetId: 'usb-old-dongle',
    displayName: 'Old Test Dongle',
    transport: 'usb-hid',
    instanceId: 'HID\\VID_1111&PID_2222\\7&OLD',
    vid: 0x1111,
    pid: 0x2222,
    usagePage: 0xff00,
    usage: 0x01,
    boundToQuarbor: false,
    recoveryActive: false,
    registeredKind: null,
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
    ancestors: [...usbHubAncestors, { id: 'USB\\VID_1111&PID_2222\\7&OLD', label: 'USB 输入设备 (1111:2222)' }],
  }
  const existingBleCandidate = {
    targetId: 'ble-remote-1',
    displayName: 'MI RC',
    transport: 'bluetooth-le',
    instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV\\8&BLE1',
    vid: 0x2717,
    pid: 0x32b8,
    usagePage: 0xff00,
    usage: 0x01,
    boundToQuarbor: true,
    recoveryActive: false,
    registeredKind: 'rc003',
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
    ancestors: [{ id: 'BTHLE\\DEV_C05D39C2B40E\\A&1', label: 'MI RC' }],
  }
  const newUsbCandidate = {
    targetId: 'usb-new-remote',
    displayName: 'New HID Remote',
    transport: 'usb-hid',
    instanceId: 'HID\\VID_1209&PID_0007&MI_01\\7&NEW',
    vid: 0x1209,
    pid: 0x0007,
    usagePage: 0x0c,
    usage: 0x01,
    boundToQuarbor: false,
    recoveryActive: false,
    registeredKind: null,
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
    ancestors: [
      ...usbHubAncestors,
      { id: 'USB\\VID_1209&PID_0007\\6&3', label: 'USB Composite Device (1209:0007)' },
      { id: 'USB\\VID_1209&PID_0007&MI_01\\7&NEW', label: 'USB 输入设备 · MI_01' },
    ],
  }
  const pairedBleCandidate = {
    targetId: 'ble-remote-2',
    displayName: 'TCL RC802A',
    transport: 'bluetooth-le',
    instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV\\8&BLE2',
    vid: 0x0416,
    pid: 0x0301,
    usagePage: 0x01,
    usage: 0x06,
    boundToQuarbor: false,
    recoveryActive: false,
    registeredKind: null,
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
    ancestors: [{ id: 'BTHLE\\DEV_AABBCCDDEEFF\\A&2', label: 'TCL RC802A' }],
  }

  let liveList = [oldUsbCandidate, existingBleCandidate]
  const harness = createCaptureHarness({
    invokeImpl: async cmd => {
      if (cmd === 'capture_list_candidates') return liveList
      if (cmd === 'capture_session_status') return null
      return null
    },
  })

  // Model-level checks for temporary TTL cache, tree grouping, single-BLE unwrap, and snapshot diff
  const t0 = 1_700_000_000_000
  const savedSnap = harness.captureModel.setTempCaptureSnapshot(liveList, t0)
  assert.equal(harness.captureModel.getTempCaptureSnapshot(t0 + 60_000)?.entries.length, 2)
  assert.equal(
    harness.captureModel.getTempCaptureSnapshot(t0 + harness.captureModel.CAPTURE_TEMP_SNAPSHOT_TTL_MS + 1),
    null,
  )
  assert.equal(harness.captureModel.formatHidUsageRole(0x0c, 0x01), '多媒体 / 功能键')

  const modelDiff = harness.captureModel.diffCandidatesWithSnapshot([existingBleCandidate, newUsbCandidate], savedSnap)
  assert.deepEqual([...modelDiff.addedIds], ['usb-new-remote'])
  assert.deepEqual(
    modelDiff.removedEntries.map(e => e.targetId),
    ['usb-old-dongle'],
  )

  const modelTree = harness.captureModel.buildCaptureDeviceTree([
    {
      kind: 'live',
      key: 'live:ble-remote-1',
      diff: 'unchanged',
      displayName: existingBleCandidate.displayName,
      transport: existingBleCandidate.transport,
      vid: existingBleCandidate.vid,
      pid: existingBleCandidate.pid,
      usagePage: existingBleCandidate.usagePage,
      usage: existingBleCandidate.usage,
      ancestors: existingBleCandidate.ancestors,
      candidate: existingBleCandidate,
    },
    {
      kind: 'live',
      key: 'live:usb-new-remote',
      diff: 'added',
      displayName: newUsbCandidate.displayName,
      transport: newUsbCandidate.transport,
      vid: newUsbCandidate.vid,
      pid: newUsbCandidate.pid,
      usagePage: newUsbCandidate.usagePage,
      usage: newUsbCandidate.usage,
      ancestors: newUsbCandidate.ancestors,
      candidate: newUsbCandidate,
    },
    {
      kind: 'removed',
      key: 'removed:usb-old-dongle',
      diff: 'removed',
      displayName: oldUsbCandidate.displayName,
      transport: oldUsbCandidate.transport,
      vid: oldUsbCandidate.vid,
      pid: oldUsbCandidate.pid,
      usagePage: oldUsbCandidate.usagePage,
      usage: oldUsbCandidate.usage,
      ancestors: oldUsbCandidate.ancestors,
      entry: savedSnap.entries[0],
    },
  ])
  assert.equal(modelTree[0].id, 'bus:usb-hid')
  assert.equal(modelTree[0].addedCount, 1)
  assert.equal(modelTree[0].removedCount, 1)
  assert.equal(modelTree[0].totalCount, 2)
  assert.equal(modelTree[1].id, 'bus:bluetooth-le')
  assert.equal(modelTree[1].children.length, 0)
  assert.equal(modelTree[1].items.length, 1)

  harness.captureModel.clearTempCaptureSnapshot()

  // Visit 1: initial scan seeds baseline automatically (no manual snapshot controls), then Step 2 refresh shows diff
  const view1 = Renderer.create(React.createElement(harness.DeviceCaptureWorkbench, { onBack: () => {} }))
  try {
    await act(async () => {})
    const goStep2 = view1.root.findAllByType('button').find(btn => text(btn).includes('下一步：定位与挂载'))
    await act(async () => {
      goStep2.props.onClick()
    })
    assert.equal(
      view1.root.findAllByType('button').filter(btn => /保存快照|更新快照|清除快照/.test(text(btn))).length,
      0,
    )
    assert.equal(view1.root.findAllByProps({ 'data-diff': 'added' }).length, 0)

    // Unplug oldUsbCandidate, plug newUsbCandidate, click refresh inside page
    liveList = [existingBleCandidate, newUsbCandidate]
    const refreshBtn = view1.root.findByProps({ 'aria-label': '刷新候选设备' })
    await act(async () => {
      refreshBtn.props.onClick()
    })

    assert.ok(view1.root.findByProps({ role: 'tree', 'aria-label': '物理设备目录树' }))
    const addedCard = view1.root.findByProps({ 'data-target-id': 'usb-new-remote', 'data-diff': 'added' })
    assert.match(text(addedCard), /\+ 新增/)
    assert.match(text(addedCard), /多媒体 \/ 功能键/)

    const removedCard = view1.root.findByProps({ 'data-removed-target-id': 'usb-old-dongle', 'data-diff': 'removed' })
    assert.match(text(removedCard), /- 已消失/)

    const usbFolderBtn = view1.root.findByProps({ 'data-folder-id': 'bus:usb-hid' })
    assert.match(text(usbFolderBtn), /\+1/)
    assert.match(text(usbFolderBtn), /-1/)

    // Diff filter pill hides unchanged BLE device
    const diffPill = view1.root.findAllByType('button').find(btn => text(btn).includes('变化 (2)'))
    assert.ok(diffPill)
    await act(async () => {
      diffPill.props.onClick()
    })
    assert.equal(view1.root.findAllByProps({ 'data-target-id': 'ble-remote-1' }).length, 0)
    assert.equal(view1.root.findAllByProps({ 'data-target-id': 'usb-new-remote' }).length, 1)
    assert.equal(view1.root.findAllByProps({ 'data-removed-target-id': 'usb-old-dongle' }).length, 1)

    // Switch to flat list view and check ancestor breadcrumb path, then collapse/expand USB tree folder
    const listBtn = view1.root.findAllByType('button').find(btn => text(btn).trim() === '列表')
    await act(async () => {
      listBtn.props.onClick()
    })
    const listContainer = view1.root.findByProps({ role: 'list', 'aria-label': '物理设备候选列表' })
    assert.match(text(listContainer), /USB 根集线器\(USB 3\.0\)/)

    const treeBtn = view1.root.findAllByType('button').find(btn => text(btn).trim() === '树形')
    await act(async () => {
      treeBtn.props.onClick()
    })
    const usbFolderBtnAgain = view1.root.findByProps({ 'data-folder-id': 'bus:usb-hid' })
    await act(async () => {
      usbFolderBtnAgain.props.onClick()
    })
    assert.equal(view1.root.findAllByProps({ 'data-target-id': 'usb-new-remote' }).length, 0)
    await act(async () => {
      usbFolderBtnAgain.props.onClick()
    })
    assert.equal(view1.root.findAllByProps({ 'data-target-id': 'usb-new-remote' }).length, 1)
  } finally {
    // Unmounting Visit 1 automatically caches latest liveList ([existingBleCandidate, newUsbCandidate])
    await act(async () => view1.unmount())
  }

  // Visit 2: user paired pairedBleCandidate while away and re-enters workbench Step 2 shortly after
  liveList = [existingBleCandidate, newUsbCandidate, pairedBleCandidate]
  const view2 = Renderer.create(React.createElement(harness.DeviceCaptureWorkbench, { onBack: () => {} }))
  try {
    await act(async () => {})
    const goStep2 = view2.root.findAllByType('button').find(btn => text(btn).includes('下一步：定位与挂载'))
    await act(async () => {
      goStep2.props.onClick()
    })
    assert.equal(view2.root.findAllByProps({ 'data-removed-target-id': 'usb-old-dongle' }).length, 0)
    assert.equal(view2.root.findByProps({ 'data-target-id': 'usb-new-remote' }).props['data-diff'], undefined)
    const newlyPairedCard = view2.root.findByProps({ 'data-target-id': 'ble-remote-2', 'data-diff': 'added' })
    assert.match(text(newlyPairedCard), /\+ 新增/)
    assert.ok(view2.root.findAllByType('button').find(btn => text(btn).includes('变化 (1)')))
  } finally {
    await act(async () => view2.unmount())
  }
})

test('clearing single/all key definitions and preventing display interception during re-capture', async () => {
  const candidate = {
    targetId: 'ble-tcl-902n',
    displayName: 'TCL_RC902N_M1',
    transport: 'bluetooth-le',
    instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010417_PID&0304\\8&ABCD',
    vid: 0x0417,
    pid: 0x0304,
    usagePage: 0x0c,
    usage: 0x01,
    boundToQuarbor: true,
    recoveryActive: false,
    registeredKind: null,
    safetyTier: 'safe',
    safetyReason: null,
    gattInfo: null,
  }

  const h = createCaptureHarness({
    native: true,
    invokeImpl: async (cmd, args) => {
      if (cmd === 'capture_set_workbench_active') return args.active
      if (cmd === 'capture_list_candidates') return [candidate]
      if (cmd === 'capture_parse_draft_svg') {
        return h.captureModel.parseCaptureDraftSvgLocal(args.svgContent)
      }
      if (cmd === 'capture_start_session') {
        return {
          active: true,
          targetId: args.targetId,
          instanceId: args.instanceId,
          transportMode: 'quarbor-pipe',
          driverVersion: '0.9.2.0',
          supportsKeysend: false,
          supportsResetInput: true,
          frameCount: 1,
          streamingReportIds: [],
        }
      }
      if (cmd === 'capture_arm_key' || cmd === 'capture_stop_session') return true
      if (cmd === 'capture_set_live_preview_svg') return Boolean(args.svgContent)
      if (cmd === 'capture_compile_svg') {
        return h.captureModel.compileCaptureSvgLocal(
          args.draftSvg,
          args.candidate,
          args.samples,
          args.targetStatus ?? undefined,
        )
      }
      throw new Error(`Unexpected command: ${cmd}`)
    },
  })

  // 1. Model-level verification on both <ak:hid-capture> (tcl-rc902n.svg) and inline+<ak:source> (rc003.svg)
  const rc902nSvg = readFileSync('public/device-descriptors/tcl-rc902n.svg', 'utf8')
  const clearedOneSvg = h.captureModel.clearSvgKeyDefinitions(rc902nSvg, new Set(['tcl-rc902n.bookmark']))
  const parsedAfterOne = h.captureModel.parseCaptureDraftSvgLocal(clearedOneSvg)
  const bookmarkItem = parsedAfterOne.inputs.find(i => i.id === 'tcl-rc902n.bookmark')
  assert.equal(bookmarkItem.binding, 'pending')
  assert.equal(bookmarkItem.pressHex, null)
  assert.equal(h.captureModel.seedSamplesFromDraft(parsedAfterOne).size, 21)

  const rc003Svg = readFileSync('public/device-descriptors/rc003.svg', 'utf8')
  const clearedRc003All = h.captureModel.clearSvgKeyDefinitions(rc003Svg)
  const parsedRc003Cleared = h.captureModel.parseCaptureDraftSvgLocal(clearedRc003All)
  assert.ok(parsedRc003Cleared.inputs.every(i => i.binding === 'pending'))
  assert.match(clearedRc003All, /id="voice-audio"/)
  assert.doesNotMatch(clearedRc003All, /id="keyboard-header"/)

  // 2. Workbench lifecycle & UI re-capture flow
  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(h.DeviceCaptureWorkbench, {
        native: true,
        onBack() {},
      }),
    )
  })

  try {
    // Workbench immediately pauses Axonkey managed pipes on mount
    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_set_workbench_active' && c.args.active === true))

    // Load tcl-rc902n preset (22 pre-captured keys)
    const presetBtn = view.root.findByProps({ 'data-preset-slug': 'tcl-rc902n' })
    await act(async () => {
      await presetBtn.props.onClick()
    })
    assert.match(text(view.toJSON()), /已适配 22 \/ 22/)
    assert.ok(view.root.findAllByType('button').some(btn => text(btn).includes('清空按键定义')))

    // Connect session in Step 2 -> enters Step 3
    const goStep2 = view.root.findAllByType('button').find(btn => text(btn).includes('下一步：定位与挂载'))
    await act(async () => {
      goStep2.props.onClick()
    })
    const connectBtn = view.root.findAllByType('button').find(btn => text(btn).includes('连接采集'))
    await act(async () => {
      await connectBtn.props.onClick()
    })

    // Simulate mis-binding bookmark to 03 41 00 (same as confirm), enter Step 4 (populating compiled.collisions), then return to Step 3
    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'tcl-rc902n.bookmark',
        reportId: 0x03,
        pressHex: '03 41 00',
        releaseHex: '03 00 00',
        pressLength: 3,
        releaseLength: 3,
        holdCount: 1,
        durationMs: 70,
      },
    })
    const goStep4 = view.root.findAllByType('button').find(btn => text(btn).includes('进入测试与导出'))
    await act(async () => {
      goStep4.props.onClick()
    })
    assert.match(text(view.toJSON()), /按键冲突：【书签图标键】与【确认】/)

    // In Step 4, each test row has 重采 and 清空 buttons; click 重采 on 书签图标键 -> jumps to Step 3, clears old definition & arms!
    const reCaptureBookmarkFromStep4 = view.root.findByProps({ 'aria-label': '重新采集 书签图标键' })
    await act(async () => {
      reCaptureBookmarkFromStep4.props.onClick()
    })
    const hotzone = id => view.root.findByProps({ 'data-capture-key': id })
    assert.equal(hotzone('tcl-rc902n.bookmark').props['data-state'], 'armed')
    assert.doesNotMatch(text(view.toJSON()), /按键冲突/)
    assert.match(text(view.toJSON()), /已适配 21 \/ 22/)

    // Emit a stray liveHit while on Step 3 -> MUST be ignored so 'armed' hotzone is NOT hijacked for display!
    await h.emitCaptureEvent({
      kind: 'liveHit',
      inputId: 'tcl-rc902n.confirm',
      pressed: true,
      reportId: 0x03,
      hex: '03 41 00',
    })
    assert.equal(hotzone('tcl-rc902n.confirm').props['data-state'], 'captured')
    assert.equal(hotzone('tcl-rc902n.bookmark').props['data-state'], 'armed')

    // Switch to 按键清单 tab -> clear single key (菜单) -> 20/22, then 清空全部 -> 0/22!
    const keysTab = view.root.findAllByProps({ role: 'tab' }).find(tab => text(tab).includes('按键清单'))
    await act(async () => {
      keysTab.props.onClick()
    })
    const clearMenuBtn = view.root.findByProps({ 'aria-label': '清空 菜单 按键定义' })
    await act(async () => {
      clearMenuBtn.props.onClick()
    })
    assert.equal(hotzone('tcl-rc902n.menu').props['data-state'], 'pending')
    assert.match(text(view.toJSON()), /已适配 20 \/ 22/)

    const clearAllBtn = view.root.findByProps({ 'aria-label': '清空全部按键定义' })
    await act(async () => {
      clearAllBtn.props.onClick()
    })
    assert.match(text(view.toJSON()), /已适配 0 \/ 22/)
    assert.equal(hotzone('tcl-rc902n.confirm').props['data-state'], 'pending')
  } finally {
    await act(async () => view.unmount())
  }
  assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_set_workbench_active' && c.args.active === false))
})

test('Step 4 放入本机并测试 writes to local custom-devices, registers descriptor, and hands off to IntegrationDialog', async () => {
  const activeCompiledSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="320" height="640" viewBox="0 0 320 640"
     data-ak-schema="axonkey.device/1"
     data-ak-device="demo-rc1"
     data-ak-revision="1"
     data-ak-status="active">
  <metadata>
    <ak:device schema="axonkey.device/1" id="demo-rc1" vendor="Demo" model="RC1" revision="1" display-name="Demo RC1" status="active">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xC001" usage-page="0xFF60" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="captured-buttons" direction="input" report-id="0x01" length="6" encoding="bit-field" prefix="0x01" state-group="captured-buttons" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="demo-rc1.mute" label="静音键" short="静音" icon="mute" kind="button" target="#key-mute" order="1" original="false" binding="captured"><ak:source report="captured-buttons" offset="3" bit="0" width="8" equals="0xef" /></ak:input>
        <ak:input id="demo-rc1.home" label="主页键" short="主页" icon="home" kind="button" target="#key-home" order="2" original="false" binding="pending" />
        <ak:input id="demo-rc1.back" label="返回键" short="返回" icon="back" kind="button" target="#key-back" order="3" original="false" binding="pending" />
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="front-view" data-ak-view="front">
    <g id="key-mute" data-ak-key="demo-rc1.mute"><circle cx="80" cy="100" r="24" fill="#222"/></g>
    <g id="key-home" data-ak-key="demo-rc1.home"><circle cx="160" cy="100" r="24" fill="#222"/></g>
    <g id="key-back" data-ak-key="demo-rc1.back"><circle cx="240" cy="100" r="24" fill="#222"/></g>
  </g>
  <g data-ak-regions="true" fill="transparent" pointer-events="none">
    <path data-ak-region="demo-rc1.mute" data-ak-anchor="80 100" d="M 56 100 A 24 24 0 1 0 104 100 A 24 24 0 1 0 56 100 Z"/>
    <path data-ak-region="demo-rc1.home" data-ak-anchor="160 100" d="M 136 100 A 24 24 0 1 0 184 100 A 24 24 0 1 0 136 100 Z"/>
    <path data-ak-region="demo-rc1.back" data-ak-anchor="240 100" d="M 216 100 A 24 24 0 1 0 264 100 A 24 24 0 1 0 216 100 Z"/>
  </g>
</svg>`

  const h = createCaptureHarness({
    native: true,
    invokeImpl: async (cmd, args) => {
      if (cmd === 'capture_set_workbench_active') return Boolean(args.active)
      if (cmd === 'capture_list_candidates') {
        return [
          {
            targetId: 'usb-demo-rc1',
            displayName: 'Demo RC1',
            transport: 'usb-hid',
            instanceId: 'USB\\VID_2E8A&PID_C001\\1',
            vid: 0x2e8a,
            pid: 0xc001,
            usagePage: 0xff60,
            usage: 0x01,
            boundToQuarbor: false,
            recoveryActive: false,
            registeredKind: null,
            safetyTier: 'safe',
            safetyReason: null,
            gattInfo: null,
          },
        ]
      }
      if (cmd === 'capture_parse_draft_svg') {
        return h.captureModel.parseCaptureDraftSvgLocal(args.svgContent)
      }
      if (cmd === 'capture_arm_key') return true
      if (cmd === 'capture_compile_svg') {
        return {
          svgContent: activeCompiledSvg,
          markdownSummary: '# Demo RC1\n',
          adaptedCount: 1,
          pendingCount: 2,
          collisions: [],
          validated: args.targetStatus === 'active',
        }
      }
      if (cmd === 'capture_set_live_preview_svg') return true
      if (cmd === 'capture_stop_session') return true
      if (cmd === 'install_local_custom_device') {
        return {
          kind: 'demoRc1',
          deviceId: 'demo-rc1',
          name: 'Demo RC1',
          model: 'RC1',
          vendor: 'Demo',
          svg: args.svgContent,
          filePath: '/Users/test/Library/Application Support/com.axonkey.app/custom-devices/demo-rc1.svg',
        }
      }
      if (cmd === 'open_local_custom_devices_dir') {
        return '/Users/test/Library/Application Support/com.axonkey.app/custom-devices'
      }
      return undefined
    },
  })

  const catalogMod = require('../src/cloud/deviceModelCatalog.ts')
  const realModel = require('../src/devices/integration/model.ts')
  catalogMod.resetLocalCustomDevicesForTest()
  realModel.resetRuntimeSupportPackages()

  let handedOffKind = null
  let view
  try {
    await act(async () => {
      view = Renderer.create(
        React.createElement(h.DeviceCaptureWorkbench, {
          native: true,
          onBack() {},
          onInstalledLocalDevice: kind => {
            handedOffKind = kind
          },
        }),
      )
    })

    // Load draft SVG in Step 1
    const fileInput = view.root.findAllByProps({ type: 'file' })[0]
    await act(async () => {
      await fileInput.props.onChange({
        target: {
          files: [{ name: 'demo-rc1.svg', text: async () => pendingDraftSvg }],
          value: 'demo-rc1.svg',
        },
      })
    })

    // Go to Step 3 and capture 1 key (leaving 2 keys pending so default Step 4 status starts as draft)
    const step3Tab = view.root.findAllByType('button').find(b => text(b).includes('采集绑定'))
    await act(async () => {
      await step3Tab.props.onClick()
    })
    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'demo-rc1.mute',
        reportId: 0x01,
        pressHex: '01 00 00 EF 00 00',
        releaseHex: '01 00 00 00 00 00',
        pressLength: 6,
        releaseLength: 6,
        holdCount: 1,
        durationMs: 90,
      },
    })

    // Enter Step 4 -> starts in draft mode because only 1/3 keys captured
    const toStep4Btn = view.root.findAllByType('button').find(b => text(b).includes('进入测试与导出'))
    await act(async () => {
      await toStep4Btn.props.onClick()
    })

    // Verify 打开本机目录 button invokes open_local_custom_devices_dir
    const openDirBtn = view.root.findByProps({ 'aria-label': '打开本机设备目录' })
    await act(async () => {
      await openDirBtn.props.onClick()
    })
    assert.ok(h.invokeCalls.some(c => c.cmd === 'open_local_custom_devices_dir'))

    // Click 放入本机并测试 -> automatically compiles as 'active', installs to custom-devices, registers package, and hands off!
    const installBtn = view.root.findAllByType('button').find(b => text(b).includes('放入本机并测试'))
    assert.ok(installBtn)
    assert.equal(installBtn.props.disabled, false)
    await act(async () => {
      await installBtn.props.onClick()
    })

    assert.equal(handedOffKind, 'demoRc1')
    assert.ok(h.invokeCalls.some(c => c.cmd === 'install_local_custom_device'))
    assert.equal(realModel.packageFor('demoRc1').name, 'Demo RC1')
    assert.equal(realModel.packageFor('demoRc1').inputs.length, 3)

    // Subsequent cloud catalog refresh does NOT overwrite or erase local custom device!
    catalogMod.activateCatalogDeviceDescriptors(catalogMod.getBundledDeviceModelCatalog())
    assert.equal(realModel.packageFor('demoRc1').name, 'Demo RC1')
  } finally {
    if (view) await act(async () => view.unmount())
    catalogMod.resetLocalCustomDevicesForTest()
    realModel.resetRuntimeSupportPackages()
  }
})
