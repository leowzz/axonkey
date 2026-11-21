import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { createFileRequire } from './helpers/resolve-compiled-require.mjs'

const require = createRequire(import.meta.url)
const text = node => (typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join(''))

function compile(path, imports = {}, globals = {}) {
  const resolveFileRequire = createFileRequire(path, require)
  const source = ts.transpileModule(
    readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(`file://${process.cwd()}/${path}`)),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    URL,
    setTimeout,
    clearTimeout,
    document: { getElementById: () => null, activeElement: null, body: {} },
    HTMLElement: class {},
    ...globals,
    require: name => (name in imports ? imports[name] : resolveFileRequire(name)),
  })
  return module.exports
}

test('agentPrompt builds starter and scenario prompts with optional resolved CLI path', () => {
  const mod = compile('src/agentPrompt.ts')
  assert.equal(mod.buildAgentCliPrompt(), '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。')
  assert.equal(
    mod.buildAgentCliPrompt(' /Applications/Axonkey.app/Contents/MacOS/axonkey-cli '),
    '请先了解 axonkey-cli（/Applications/Axonkey.app/Contents/MacOS/axonkey-cli），再按我的需求查看和调整设备按键设置。',
  )
  assert.ok(mod.agentPromptScenarios.length >= 4)
  const scenarioText = mod.buildAgentScenarioPrompt(
    mod.agentPromptScenarios[0].task,
    'E:\\Axonkey\\axonkey-cli.exe',
  )
  assert.match(scenarioText, /E:\\Axonkey\\axonkey-cli\.exe/)
  assert.match(scenarioText, /具体需求：/)
})

test('AgentConfigDialog shows resolved CLI path, copies starter and scenario prompts, and closes cleanly', async () => {
  const copied = []
  const toasts = []
  let showCalls = 0
  let closeCalls = 0
  let closedCallbackCalls = 0
  const { AgentConfigDialog } = compile(
    'src/components/AgentConfigDialog.tsx',
    {
      '@tauri-apps/api/core': {
        invoke: async cmd => {
          assert.equal(cmd, 'cli_executable_path')
          return '/Applications/Axonkey.app/Contents/MacOS/axonkey-cli'
        },
      },
      '../clipboard': {
        writeClipboardText: async value => copied.push(value),
      },
    },
    { window: { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout } },
  )

  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(AgentConfigDialog, {
        native: true,
        onClose: () => {
          closedCallbackCalls += 1
        },
        onToast: msg => toasts.push(msg),
      }),
      {
        createNodeMock: node =>
          node.type === 'dialog'
            ? {
                showModal() {
                  showCalls += 1
                },
                close() {
                  closeCalls += 1
                },
              }
            : null,
      },
    )
  })

  try {
    assert.equal(showCalls, 1)
    const codeText = text(view.root.findByType('code'))
    assert.match(codeText, /\/Applications\/Axonkey\.app\/Contents\/MacOS\/axonkey-cli/)
    assert.match(text(view.root.findByProps({ className: 'agent-path-badge ready' })), /已附带本机 CLI 路径/)

    await act(async () => {
      view.root.findByProps({ 'aria-label': '复制通用提示词' }).props.onClick()
    })
    assert.equal(copied.length, 1)
    assert.match(copied[0], /\/Applications\/Axonkey\.app\/Contents\/MacOS\/axonkey-cli/)
    assert.equal(toasts[0], '已复制 Agent 通用提示词')

    const scenarioBtn = view.root.findByProps({ 'aria-label': '复制模板：纯 Prompt 快捷交互窗' })
    await act(async () => {
      scenarioBtn.props.onClick()
    })
    assert.equal(copied.length, 2)
    assert.match(copied[1], /纯 Prompt/)

    act(() => {
      view.root.findByProps({ className: 'managed-primary' }).props.onClick()
    })
    assert.equal(closedCallbackCalls, 1)
  } finally {
    act(() => view.unmount())
    assert.equal(closeCalls, 1)
  }
})

test('Home DeviceHub renders AI configuration bar and copies prompt in 1 click', async () => {
  const copied = []
  const toasts = []
  const model = compile('src/devices/integration/model.ts')
  const controls = compile('src/devices/integration/IntegrationControls.tsx')
  const battery = compile('src/components/BatteryIndicator.tsx')
  const behaviorLibraryContext = compile('src/cloud/BehaviorLibraryContext.tsx')
  const useDeviceModelCatalog = compile('src/cloud/useDeviceModelCatalog.ts', {
    './deviceModelCatalog.ts': require('../src/cloud/deviceModelCatalog.ts'),
  })
  const modelMarkdown = compile('src/devices/integration/ModelMarkdown.tsx', {
    '../../openExternalUrl': require('../src/openExternalUrl.ts'),
  })
  const { DeviceHub } = compile(
    'src/devices/integration/DeviceHub.tsx',
    {
      'react-dom': { createPortal: node => node },
      '@tauri-apps/api/core': {
        invoke: async cmd => {
          if (cmd === 'cli_executable_path') return '/usr/local/bin/axonkey-cli'
          return null
        },
      },
      '@tauri-apps/api/event': { listen: async () => () => {} },
      '../../appStorage': require('../src/appStorage.ts'),
      '../../cloud/BehaviorLibraryContext': behaviorLibraryContext,
      '../../cloud/useDeviceModelCatalog': useDeviceModelCatalog,
      './InstanceWorkspace': { InstanceWorkspace: () => null },
      './IntegrationControls': controls,
      './ModelMarkdown': modelMarkdown,
      '../../components/BatteryIndicator': battery,
      './model': model,
      '../../clipboard': {
        writeClipboardText: async value => copied.push(value),
      },
    },
    { window: { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} } },
  )

  const snapshot = model.emptySnapshot()
  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(DeviceHub, {
        selectedInstanceId: null,
        onSelectInstance() {},
        controller: { snapshot, error: '', busy: false, refresh: async () => snapshot, reorder: async () => {} },
        native: true,
        platform: 'macos',
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
        onToast: msg => toasts.push(msg),
      }),
    )
  })

  try {
    const entry = view.root.findByProps({ className: 'home-ai-entry' })
    assert.match(text(entry), /AI 配置/)
    assert.match(text(entry), /快捷交互窗/)

    const copyBtn = view.root.findByProps({ 'aria-label': '复制 Agent 提示词' })
    await act(async () => {
      copyBtn.props.onClick()
    })
    assert.equal(copied.length, 1)
    assert.equal(copied[0], '请先了解 axonkey-cli（/usr/local/bin/axonkey-cli），再按我的需求查看和调整设备按键设置。')
    assert.equal(toasts[0], '已复制 Agent 提示词')
    assert.match(text(view.root.findByProps({ 'aria-label': '复制 Agent 提示词' })), /已复制提示词/)
  } finally {
    act(() => view.unmount())
  }
})
