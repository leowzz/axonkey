import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import {
  createBehavior,
  createEmptyBehaviorMap,
  inspectBehaviorMapWarnings,
  sanitizeProfileBehaviors,
} from '../src/behaviorModel.ts'
import { mergeEditedProfileBehaviors } from '../src/devices/integration/instanceProfiles.ts'
import { buildRailOverviewItems } from '../src/devices/integration/railOverview.ts'

const require = createRequire(import.meta.url)

function compile(file, stubs = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  }).outputText
  const module = { exports: {} }
  const localRequire = id => {
    if (id in stubs) return stubs[id]
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (id === 'lucide-react') return require('lucide-react')
    throw new Error(`Unexpected import ${id} in ${file}`)
  }
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: localRequire,
      console,
      crypto: globalThis.crypto,
      structuredClone: globalThis.structuredClone,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      ...globals,
    },
    { filename: file },
  )
  return module.exports
}

const textOf = node =>
  typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.children ?? []).map(textOf).join('')

test('sanitizeProfileBehaviors isolates invalid steps per button while preserving valid steps and healthy buttons', () => {
  const validProfileIds = new Set(['default', 'quick-ai'])
  const raw = {
    'kivo.k18Lite.k01': {
      click: [
        { type: 'unknownFutureVariant', payload: 42 },
        { id: 'step-a', enabled: true, type: 'key', key: 'A' },
      ],
    },
    'kivo.k18Lite.k02': {
      click: [{ id: 'step-q', enabled: true, type: 'quickOverlay', profileId: 'deleted-profile' }],
    },
    'kivo.k18Lite.k03': {
      click: [{ id: 'step-b', enabled: true, type: 'key', key: 'B' }],
    },
  }

  const sanitized = sanitizeProfileBehaviors(raw, validProfileIds)
  assert.equal(sanitized.behaviors['kivo.k18Lite.k01'].click.length, 1)
  assert.equal(sanitized.behaviors['kivo.k18Lite.k01'].click[0].type, 'key')
  assert.equal(sanitized.behaviors['kivo.k18Lite.k03'].click[0].key, 'B')
  assert.equal(sanitized.droppedInputIds.has('kivo.k18Lite.k01'), true)
  assert.equal(sanitized.droppedInputIds.has('kivo.k18Lite.k02'), false)
  assert.match(sanitized.warnings['kivo.k18Lite.k01'], /unknownFutureVariant/)
  assert.equal(sanitized.warnings['kivo.k18Lite.k02'], '关联的快捷交互配置不存在')
  assert.equal(sanitized.warnings['kivo.k18Lite.k03'], undefined)

  // Editing k03 preserves untouched raw k01 until k01 is edited or explicitly cleaned.
  const afterEditingK03 = {
    ...sanitized.behaviors,
    'kivo.k18Lite.k03': {
      click: [createBehavior({ type: 'key', key: 'C', id: 'step-c' })],
      doubleClick: [],
      longPress: [],
    },
  }
  const mergedPreserved = mergeEditedProfileBehaviors(
    raw,
    sanitized.behaviors,
    afterEditingK03,
    sanitized.droppedInputIds,
  )
  assert.deepEqual(mergedPreserved['kivo.k18Lite.k01'], raw['kivo.k18Lite.k01'])

  const mergedCleaned = mergeEditedProfileBehaviors(
    raw,
    sanitized.behaviors,
    afterEditingK03,
    sanitized.droppedInputIds,
    new Set(['kivo.k18Lite.k01']),
  )
  assert.equal(mergedCleaned['kivo.k18Lite.k01'].click.length, 1)

  // Mouse / legacy BehaviorMap warning inspection catches deleted quickOverlay targets per input.
  const mouseMap = createEmptyBehaviorMap()
  mouseMap['mouse.global.buttonForward'].click = [createBehavior({ type: 'quickOverlay', profileId: 'missing-id' })]
  const mouseWarnings = inspectBehaviorMapWarnings(
    mouseMap,
    ['mouse.global.buttonForward', 'mouse.global.buttonBack'],
    new Set(['mouse:default']),
  )
  assert.equal(mouseWarnings['mouse.global.buttonForward'], '关联的快捷交互配置不存在')
  assert.equal(mouseWarnings['mouse.global.buttonBack'], undefined)
})

test('RemoteControl highlights only warned keys and exposes warning details in aria-label and title', () => {
  const { RemoteControl } = compile(
    'src/devices/shared/RemoteControl.tsx',
    {
      '../../appStorage.ts': { appStorage: { getItem: () => '1', setItem() {} } },
      '../xiaomi-remote/view.ts': require('../src/devices/xiaomi-remote/view.ts'),
    },
    {
      window: { addEventListener() {}, removeEventListener() {} },
      document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    },
  )

  let view
  act(() => {
    view = Renderer.create(
      React.createElement(RemoteControl, {
        activeId: 'up',
        mappedIds: ['confirm'],
        warnings: { confirm: '不支持的按键：Foo' },
        onSelect() {},
      }),
    )
  })

  const confirmNode = view.root.find(node => node.type === 'g' && node.props['data-remote-key'] === 'confirm')
  const upNode = view.root.find(node => node.type === 'g' && node.props['data-remote-key'] === 'up')
  assert.match(confirmNode.props.className, /\bwarning\b/)
  assert.doesNotMatch(upNode.props.className, /\bwarning\b/)
  assert.match(confirmNode.props['aria-label'], /不支持的按键：Foo/)
  assert.match(textOf(confirmNode.findByType('title')), /不支持的按键：Foo/)
})

test('InstanceWorkspace isolates per-key warnings, renders valid steps safely, and cleans dropped items on demand', async () => {
  const RemoteControl = () => null
  const WorkflowAxonkey = props => React.createElement('div', { 'data-workflow': true }, props.header)
  const { InstanceWorkspace } = compile(
    'src/devices/integration/InstanceWorkspace.tsx',
    {
      '../../components/QuickOverlayConfigurator': { QuickOverlayConfigurator: () => null },
      'react-dom': { createPortal: node => node },
      '@tauri-apps/api/core': { invoke: async () => null },
      '@tauri-apps/api/event': { listen: async () => () => {} },
      '../../behaviorModel': require('../src/behaviorModel.ts'),
      '../../appConfig': { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' } },
      '../../audioGain': require('../src/audioGain.ts'),
      '../../components/InputIcon': compile('src/components/InputIcon.tsx'),
      './railOverview': { buildRailOverviewItems, railKeyGlyphText: () => null, shouldOpenRailSummaryPopover: () => false },
      '../../deviceInputSelection': { getStoredDeviceInput: () => 'kivo.k18Lite.k01', storeDeviceInput() {} },
      '../../telemetry': { reportTencentEvent() {} },
      '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
      '../../profileNavigation': require('../src/profileNavigation.ts'),
      '../shared/RemoteControl': { RemoteControl },
      '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar: () => null },
      '../../useForegroundApplications': {
        useForegroundApplications: () => ({ current: null, recent: [], supported: true, error: null }),
      },
      './applicationProfiles': require('../src/devices/integration/applicationProfiles.ts'),
      './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
      '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
      '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
      '../../components/PresetProfileDialog': { PresetProfileDialog: () => null },
      '../../components/SettingsHelp': { SettingsHelp: () => null },
      '../../components/BatteryIndicator': { BatteryIndicator: () => null },
      '../../components/BehaviorHistoryActions': { BehaviorHistoryActions: () => null },
      '../../components/BehaviorSummaryPopover': { BehaviorSummaryPopover: ({ children }) => children },
      '../../components/DeviceRail': { DeviceRecordingStatus: () => null },
      '../../components/MappingColumnSplitter': { MappingColumnSplitter: props => React.createElement('column-splitter', props) },
      '../../components/mappingPanelLayout': require('../src/components/mappingPanelLayout.ts'),
      '../../components/LegacyMappingEditor': { LegacyMappingEditor: () => null },
      '../../components/WorkflowAxonkey': { WorkflowAxonkey },
      '../../components/workflowSplitLayout': { defaultWorkflowSplitRatio: 0.54 },
      '../shared/DeviceWorkspaceHeader': { DeviceWorkspaceHeader: () => null },
      '../shared/DeviceSettingsDrawer': { DeviceSettingsDrawer: () => null },
      '../kivo-k18-lite/KivoScreenEditor': { KivoScreenEditor: () => null },
      './IntegrationControls': { DeviceBindingPicker: () => null },
      './model': require('../src/devices/integration/model.ts'),
      '../bundledPresets.ts': require('../src/devices/bundledPresets.ts'),
    },
    {
      window: { addEventListener() {}, removeEventListener() {} },
      document: { querySelector: () => null },
    },
  )

  let instance = {
    id: 'k18-test',
    kind: 'kivoK18Lite',
    name: '桌面小键盘',
    binding: null,
    enabled: true,
    activeProfileId: 'default',
    profiles: [
      {
        id: 'default',
        name: '默认',
        behaviors: {
          'kivo.k18Lite.k01': {
            click: [{ type: 'unknownFutureVariant' }],
          },
          'kivo.k18Lite.k02': {
            click: [{ id: 'bad-key', enabled: true, type: 'key', key: 'NoSuchKey' }],
          },
          'kivo.k18Lite.k03': {
            click: [{ id: 'ok-key', enabled: true, type: 'key', key: 'A' }],
          },
        },
      },
    ],
  }

  let runtime = {
    'k18-test': {
      state: 'idle',
      error: null,
      reports: 0,
      mappingErrors: {
        default: {
          'kivo.k18Lite.k01': '包含无法识别或无效的动作（unknownFutureVariant）',
          'kivo.k18Lite.k02': '不支持的按键：NoSuchKey',
        },
      },
    },
  }

  const controller = {
    get snapshot() {
      return {
        store: { version: 1, revision: 1, instances: [instance] },
        discovered: [],
        runtime,
        error: null,
        scanError: null,
        scanning: false,
      }
    },
    async update(_id, change) {
      instance = change(instance)
      if (!instance.profiles[0].behaviors['kivo.k18Lite.k01']) {
        delete runtime['k18-test'].mappingErrors.default['kivo.k18Lite.k01']
      }
      return this.snapshot
    },
    async refreshInformation() {},
    async toggleRecording() {},
  }

  const renderWorkspace = () =>
    React.createElement(InstanceWorkspace, {
      instance,
      controller,
      native: true,
      platform: 'macos',
      permissions: { accessibility: true, inputMonitoring: true },
      onPermissions() {},
      onBack() {},
      onBind() {},
      async onUnbindDevice() {},
      async onRemoveDevice() {},
      onOpenAudioCalibration() {},
      onOpenAudioDriver() {},
      driverAction: null,
      onInstallDriver() {},
      batteryLevel: null,
    })

  let view
  act(() => {
    view = Renderer.create(renderWorkspace())
  })

  // 1. RemoteControl receives per-key warnings for k01 & k02, while k03 has none.
  const remoteWarnings = view.root.findByType(RemoteControl).props.warnings
  assert.match(remoteWarnings['kivo.k18Lite.k01'], /unknownFutureVariant/)
  assert.equal(remoteWarnings['kivo.k18Lite.k02'], '不支持的按键：NoSuchKey')
  assert.equal(remoteWarnings['kivo.k18Lite.k03'], undefined)

  // 2. WorkflowAxonkey receives clean sanitized sequences for selected k01 (empty rather than crashing).
  assert.deepEqual(view.root.findByType(WorkflowAxonkey).props.sequences, {
    click: [],
    doubleClick: [],
    longPress: [],
  })

  // 3. Inline per-key warning banner shows for selected k01 with a clean button, and hides when selecting healthy k03.
  const warningBanner = view.root.find(node => node.props?.className === 'key-picker-mapping-warning')
  assert.match(textOf(warningBanner), /unknownFutureVariant/)
  const cleanButton = warningBanner.findByType('button')
  assert.equal(textOf(cleanButton), '清理无效项')

  act(() => {
    view.root.findByType(RemoteControl).props.onSelect('kivo.k18Lite.k03')
  })
  assert.equal(view.root.findAll(node => node.props?.className === 'key-picker-mapping-warning').length, 0)

  // 4. Rail overview list includes warned keys even when all steps were invalid.
  const listTab = view.root.find(
    node => node.type === 'button' && node.props.role === 'tab' && textOf(node).startsWith('已配速览'),
  )
  act(() => {
    listTab.props.onClick()
  })
  const overviewRows = view.root.findAll(node => node.type === 'button' && node.props.role === 'option')
  assert.equal(overviewRows.length, 3)
  assert.match(overviewRows[0].props.className, /\bhas-warning\b/)
  assert.doesNotMatch(overviewRows[2].props.className, /\bhas-warning\b/)

  // 5. Selecting k01 again and clicking "清理无效项" removes the invalid entry and clears k01's warning.
  act(() => {
    overviewRows[0].props.onClick()
  })
  const k01CleanButton = view.root
    .find(node => node.props?.className === 'key-picker-mapping-warning')
    .findByType('button')
  await act(async () => {
    k01CleanButton.props.onClick()
  })
  act(() => {
    view.update(renderWorkspace())
  })
  assert.equal(view.root.findAll(node => node.props?.className === 'key-picker-mapping-warning').length, 0)
  assert.equal(instance.profiles[0].behaviors['kivo.k18Lite.k01'], undefined)
})
