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
    './model': captureModel,
    './CaptureSvgStage': captureStage,
    './CaptureDeviceList': captureDeviceList,
    './CaptureSafetyConfirmDialog': captureSafetyDialog,
  })

  return {
    captureModel,
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
      if (cmd === 'capture_stop_session' || cmd === 'capture_set_live_preview_svg' || cmd === 'capture_arm_key') {
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
    // 1. Orphaned bound unregistered device banner is visible with 1-click restore
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

    // Now in 15-second keep-alive dialog!
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

test('4-step guided capture flow: SVG hotzones, streaming noise notice, auto-advance, collision warning, liveHit highlight, and export', async () => {
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
      if (cmd === 'capture_set_live_preview_svg') return true
      if (cmd === 'capture_save_export') return true
      if (cmd === 'capture_stop_session') return true
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
    // Step 1: Connect capture session
    const connectBtn = view.root.findAllByType('button').find(btn => text(btn).includes('连接采集'))
    await act(async () => {
      connectBtn.props.onClick()
    })
    assert.match(text(view.root.findByProps({ className: 'capture-header-status' })), /会话已连接/)

    // Step 2: Load pending draft SVG via file input
    const step2Tab = view.root.findAllByType('button').find(btn => text(btn).includes('加载图稿'))
    await act(async () => {
      step2Tab.props.onClick()
    })

    const fileInput = view.root.findByProps({ 'aria-label': '在步骤二选择 SVG 图稿文件' })
    await act(async () => {
      await fileInput.props.onChange({
        target: {
          value: 'demo-rc1.svg',
          files: [{ name: 'demo-rc1.svg', text: async () => pendingDraftSvg }],
        },
      })
    })
    assert.match(text(view.toJSON()), /已适配 0 \/ 3/)

    // Verify all 3 SVG hotzones start in pending state
    const hotzone = id => view.root.findByProps({ 'data-capture-key': id })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'pending')
    assert.equal(hotzone('demo-rc1.home').props['data-state'], 'pending')
    assert.equal(hotzone('demo-rc1.back').props['data-state'], 'pending')

    // Step 3: Enter guided key capture -> auto-arms first pending key (mute)
    const goStep3 = view.root.findAllByType('button').find(btn => text(btn).includes('进入逐键采集'))
    await act(async () => {
      goStep3.props.onClick()
    })
    assert.match(text(view.toJSON()), /请按下并松开【静音键】/)
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'armed')
    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_arm_key' && c.args.inputId === 'demo-rc1.mute'))

    // Streaming noise report (0x6F) surfaces ignore notice
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 10,
      reportId: 0x6f,
      hex: '6F 12 34 56',
      isStreamingNoise: true,
    })
    assert.match(text(view.toJSON()), /已自动忽略持续数据流报告 0x6F/)

    // Capture mute key -> auto-advances to home key!
    await h.emitCaptureEvent({
      kind: 'keyCaptured',
      sample: {
        inputId: 'demo-rc1.mute',
        reportId: 0x01,
        pressHex: '01 00 00 EF 00 00',
        releaseHex: '01 00 00 00 00 00',
        pressLength: 6,
        releaseLength: 6,
        holdCount: 2,
        durationMs: 95,
      },
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'captured')
    assert.equal(hotzone('demo-rc1.home').props['data-state'], 'armed')
    assert.match(text(view.toJSON()), /请按下并松开【主页键】/)
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

    // Click SVG hotzone for home directly to re-arm & re-capture cleanly!
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

    // Step 4: Live Test & Export
    const goStep4 = view.root.findAllByType('button').find(btn => text(btn).includes('进入试按与导出'))
    await act(async () => {
      goStep4.props.onClick()
    })

    assert.ok(h.invokeCalls.some(c => c.cmd === 'capture_compile_svg'))
    assert.ok(
      h.invokeCalls.some(c => c.cmd === 'capture_set_live_preview_svg' && typeof c.args.svgContent === 'string'),
    )

    // Physical press emits liveHit -> hotzone lights up green ('live') then returns to 'captured'!
    await h.emitCaptureEvent({
      kind: 'liveHit',
      inputId: 'demo-rc1.mute',
      pressed: true,
      reportId: 0x01,
      hex: '01 00 00 EF 00 00',
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'live')
    assert.match(text(view.root.findByProps({ 'aria-label': '实机试按命中记录' })), /静音键.*按下/)

    await h.emitCaptureEvent({
      kind: 'liveHit',
      inputId: 'demo-rc1.mute',
      pressed: false,
      reportId: 0x01,
      hex: '01 00 00 00 00 00',
    })
    assert.equal(hotzone('demo-rc1.mute').props['data-state'], 'captured')

    // Save export & copy CLI command
    const saveBtn = view.root.findAllByType('button').find(btn => text(btn).includes('保存 SVG 与采集记录'))
    await act(async () => {
      await saveBtn.props.onClick()
    })

    const saveCall = h.invokeCalls.find(c => c.cmd === 'capture_save_export')
    assert.ok(saveCall)
    assert.equal(saveCall.args.svgPath, 'D:/devices/demo-rc1.svg')
    assert.equal(saveCall.args.markdownPath, 'D:/devices/demo-rc1.md')
    assert.match(saveCall.args.svgContent, /press="01 00 00 EF 00 00"/)

    const copyBtn = view.root.findByProps({ 'aria-label': '复制设备索引生成命令' })
    await act(async () => {
      await copyBtn.props.onClick()
    })
    assert.deepEqual(h.clipboardWrites, ['npm run generate:devices'])
  } finally {
    await act(async () => view.unmount())
  }
})

test('raw probe mode discovers buttons before SVG exists and binds them once SVG is loaded', async () => {
  const h = createCaptureHarness({
    native: true,
    invokeImpl: async cmd => {
      if (cmd === 'capture_list_candidates') return []
      if (cmd === 'capture_parse_draft_svg') return h.captureModel.parseCaptureDraftSvgLocal(pendingDraftSvg)
      return true
    },
  })

  let view
  await act(async () => {
    view = Renderer.create(React.createElement(h.DeviceCaptureWorkbench, { native: true, onBack() {} }))
  })

  try {
    const probeTab = view.root
      .findAllByType('button')
      .find(btn => btn.props.role === 'tab' && text(btn).includes('无图探针'))
    await act(async () => {
      probeTab.props.onClick()
    })

    // Emit neutral baseline then button press
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 1,
      reportId: 0x01,
      hex: '01 00 00 00 00 00',
      isStreamingNoise: false,
    })
    await h.emitCaptureEvent({
      kind: 'rawFrame',
      sequence: 2,
      reportId: 0x01,
      hex: '01 00 00 AA 00 00',
      isStreamingNoise: false,
    })
    assert.match(text(view.toJSON()), /探针按键 1/)

    // Export raw probe JSON
    const exportJsonBtn = view.root.findAllByType('button').find(btn => text(btn).includes('导出 JSON'))
    await act(async () => {
      exportJsonBtn.props.onClick()
    })
    assert.equal(h.downloads.length, 1)
    assert.match(h.downloads[0].download, /\.capture\.json$/)

    // Load SVG and bind discovered probe button to armed key
    const stageFileInput = view.root.findByProps({ 'aria-label': '选择设备 SVG 图稿文件' })
    await act(async () => {
      await stageFileInput.props.onChange({
        target: {
          value: 'demo-rc1.svg',
          files: [{ name: 'demo-rc1.svg', text: async () => pendingDraftSvg }],
        },
      })
    })
    await act(async () => {
      probeTab.props.onClick()
    })
    const bindBtn = view.root.findAllByType('button').find(btn => text(btn).includes('绑定到 静音键'))
    assert.ok(bindBtn)
    await act(async () => {
      bindBtn.props.onClick()
    })
    assert.match(text(view.toJSON()), /1\/3/)
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
    '../xbox-controller/index.ts': xboxDefinition,
  })
  const controls = h.evalModule('src/devices/integration/IntegrationControls.tsx')
  const battery = h.evalModule('src/components/BatteryIndicator.tsx')
  const { DeviceHub } = h.evalModule('src/devices/integration/DeviceHub.tsx', {
    './InstanceWorkspace': { InstanceWorkspace: () => null },
    './IntegrationControls': controls,
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

    // 2. IntegrationDialog footer link also opens capture workbench
    const addDeviceBtn = view.root.findAllByType('button').find(btn => text(btn).includes('手动添加设备'))
    await act(async () => {
      addDeviceBtn.props.onClick()
    })
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
