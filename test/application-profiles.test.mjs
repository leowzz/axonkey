import test from 'node:test'
import assert from 'node:assert/strict'
import { activeApplicationProfile, selectInstanceProfile, setApplicationProfile } from '../src/devices/integration/applicationProfiles.ts'
import { bindMouseApplication, deleteMouseProfile } from '../src/mouseProfiles.ts'
import { addApplicationForEditing, addInstanceProfile, deleteInstanceProfile } from '../src/devices/integration/instanceProfiles.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const chrome = { id: 'macos:com.google.Chrome', name: 'Chrome', path: '/Applications/Google Chrome.app' }
const code = { id: 'macos:com.microsoft.VSCode', name: 'VS Code', path: '/Applications/Visual Studio Code.app' }
const instance = () => ({ id: 'one', activeProfileId: 'global', profiles: ['global','browser','editor'].map(id => ({ id, name: id, behaviors: {} })) })

test('application associations stay per-device, retain the global selection and can be paused', () => {
  const first = setApplicationProfile(instance(), chrome, 'browser')
  const second = { ...instance(), id: 'two' }
  assert.equal(activeApplicationProfile(first, chrome.id).profileId, 'browser')
  assert.equal(activeApplicationProfile(second, chrome.id), undefined)
  assert.equal(activeApplicationProfile(first, code.id), undefined)
  assert.equal(first.activeProfileId, 'global')
  assert.equal(activeApplicationProfile({ ...first, appProfileSwitching: false }, chrome.id), undefined)
})

test('manual switching updates the associated app persistently, while unassociated apps change only global selection', () => {
  const first = setApplicationProfile(setApplicationProfile(instance(), chrome, 'browser'), code, 'editor')
  const switched = selectInstanceProfile(first, 'editor', chrome.id)
  const restored = JSON.parse(JSON.stringify(switched))
  assert.equal(activeApplicationProfile(restored, chrome.id).profileId, 'editor')
  assert.equal(activeApplicationProfile(restored, code.id).profileId, 'editor')
  assert.equal(restored.activeProfileId, 'global')
  assert.equal(first.applicationProfiles[0].profileId, 'browser')
  const fallback = selectInstanceProfile(restored, 'browser', 'unknown')
  assert.equal(fallback.activeProfileId, 'browser')
  assert.deepEqual(fallback.applicationProfiles, restored.applicationProfiles)
  const paused = selectInstanceProfile({ ...restored, appProfileSwitching: false }, 'browser', chrome.id)
  assert.equal(paused.activeProfileId, 'browser')
  assert.equal(paused.applicationProfiles[0].profileId, 'editor')
  const created = addInstanceProfile(first, true, chrome.id)
  assert.equal(created.activeProfileId, 'global')
  assert.equal(created.applicationProfiles[0].profileId, created.profiles.at(-1).id)
  assert.equal(created.applicationProfiles[1].profileId, 'editor')
})

test('changing and deleting profiles cannot leave duplicate or dangling app associations', () => {
  const first = setApplicationProfile(setApplicationProfile(instance(), chrome, 'browser'), chrome, 'editor')
  assert.equal(first.applicationProfiles.length, 1)
  const deleted = deleteInstanceProfile(first, 'editor')
  assert.equal(deleted.applicationProfiles.length, 1)
  assert.equal(deleted.applicationProfiles[0].profileId, 'global')
  assert.equal(deleted.activeProfileId, 'global')
  const deletedGlobal = deleteInstanceProfile(first, 'global')
  assert.equal(deletedGlobal.activeProfileId, 'browser')
  assert.equal(deletedGlobal.applicationProfiles[0].profileId, 'editor')
  const last = { ...first, profiles: [first.profiles[0]] }
  assert.equal(deleteInstanceProfile(last, 'global'), last)
})

test('deleting a mouse app profile keeps the app selected and falls back to the global profile', () => {
  const profiles = [
    { id: 'global', name: '默认', deviceId: 'mouse', behaviors: {}, applicationIds: [] },
    { id: 'browser', name: '浏览器', deviceId: 'mouse', behaviors: {}, applicationIds: [chrome.id] },
  ]
  const deleted = deleteMouseProfile(profiles, 'browser', 'global')
  assert.equal(deleted.globalProfileId, 'global')
  assert.equal(deleted.profiles.length, 1)
  assert.deepEqual(deleted.profiles[0].applicationIds, [chrome.id])
  assert.equal(deleted.profiles[0].id, 'global')
  assert.equal(deleted.profiles.find(profile => profile.applicationIds?.includes(chrome.id)).id, 'global')
})

test('deleting the mouse global profile moves its app bindings to the new global profile', () => {
  const profiles = bindMouseApplication(
    [
      { id: 'global', name: '默认', deviceId: 'mouse', behaviors: {} },
      { id: 'other', name: '其他', deviceId: 'mouse', behaviors: {} },
    ],
    chrome.id,
    'global',
  )
  const deleted = deleteMouseProfile(profiles, 'global', 'global')
  assert.equal(deleted.globalProfileId, 'other')
  assert.deepEqual(deleted.profiles[0].applicationIds, [chrome.id])
})

function compile(path, imports = {}, globals = {}) {
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports, document: { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {} },
    HTMLElement: class {}, ...globals,
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}

test('adding an app creates an independent editable copy and preserves the global selection', () => {
  const original = instance()
  original.profiles[0].behaviors = { voice: { click: [{ id: 'key', enabled: true, type: 'key', key: 'RAlt' }], doubleClick: [], longPress: [] } }
  const added = addApplicationForEditing(original, chrome)
  assert.equal(added.activeProfileId, 'global')
  assert.equal(added.profiles.at(-1).name, 'Chrome 配置')
  assert.equal(added.applicationProfiles[0].profileId, added.profiles.at(-1).id)
  added.profiles.at(-1).behaviors.voice.click[0].key = 'Enter'
  assert.equal(original.profiles[0].behaviors.voice.click[0].key, 'RAlt')
  assert.equal(addApplicationForEditing(added, chrome), added)
  const paused = { ...added, appProfileSwitching: false }
  const copied = addInstanceProfile(paused, true, chrome.id)
  assert.equal(copied.activeProfileId, 'global')
  assert.equal(copied.applicationProfiles[0].profileId, copied.profiles.at(-1).id)
  assert.equal(copied.appProfileSwitching, false)
})

test('toolbar loads application icons automatically, selects recent apps directly, toggles automatic switching and adds manual apps in one step', async () => {
  const iconRequests = []
  const iconsById = {
    [chrome.id]: 'data:image/png;base64,iVBORw0KGgoChrome',
    [code.id]: 'data:image/png;base64,iVBORw0KGgoCode',
  }
  const { SelectControl } = compile('src/components/SelectControl.tsx')
  const { ProfileManager } = compile('src/components/ProfileManager.tsx', { './SelectControl': { SelectControl } })
  const toolbarModule = compile('src/components/ApplicationProfileToolbar.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/core': {
      invoke: async (command, args) => {
        if (command === 'application_icons') {
          iconRequests.push(args.applications)
          return Object.fromEntries(args.applications.flatMap(({ id }) => (iconsById[id] ? [[id, iconsById[id]]] : [])))
        }
        assert.equal(command, 'resolve_application_path')
        if (args.path === code.path) return code
        throw new Error('请选择有效的应用')
      },
    },
    '@tauri-apps/plugin-dialog': { open: async () => code.path },
    '../devices/integration/instanceProfiles': { addApplicationForEditing },
    './ProfileManager': { ProfileManager }, './SettingsHelp': { SettingsHelp: () => null },
  })
  const { ApplicationProfileToolbar } = toolbarModule
  const { MouseApplicationProfileToolbar } = compile('src/components/MouseApplicationProfileToolbar.tsx', {
    './ApplicationProfileToolbar': toolbarModule,
    './ProfileManager': { ProfileManager },
    './SettingsHelp': { SettingsHelp: () => null },
  })
  const nodeText = node => typeof node === 'string' ? node : (node?.children ?? []).map(nodeText).join('')
  let current, selected, view
  const switched = []
  function Harness() {
    const [value, update] = React.useState(instance())
    const [appId, selectApp] = React.useState('')
    current = value; selected = appId
    return React.createElement(ApplicationProfileToolbar, {
      instance: value, editingApplicationId: appId, profileId: value.applicationProfiles?.find(binding => binding.application.id === appId)?.profileId ?? value.activeProfileId,
      applications: { supported: true, current: chrome, recent: [{ application: chrome, lastUsedAt: 1 }], error: null },
      native: true, platform: 'macos', onUpdate: async change => update(change), onSelectApplication: selectApp,
      onSwitchProfile: id => switched.push(id), onCreateProfile() {}, onDuplicateProfile() {}, onRenameProfile() {}, onDeleteProfile() {},
    })
  }
  await act(async () => { view = Renderer.create(React.createElement(Harness), { createNodeMock: () => ({ showModal() {}, close() {}, contains: () => false, focus() {} }) }) })
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(iconRequests)), [[{ id: chrome.id, path: chrome.path }]])
    const trigger = () => view.root.findByProps({ 'aria-label': '编辑应用' })
    await act(async () => trigger().props.onClick())
    const chromeOption = view.root.findAllByProps({ role: 'option' }).find(node => nodeText(node).includes('Chrome'))
    assert.equal(chromeOption.findByType('img').props.src, iconsById[chrome.id])
    await act(async () => chromeOption.props.onClick())
    assert.equal(selected, chrome.id)
    assert.equal(trigger().findByType('img').props.src, iconsById[chrome.id])
    assert.equal(current.activeProfileId, 'global')
    assert.equal(current.applicationProfiles[0].profileId, current.profiles.at(-1).id)
    assert.equal(iconRequests.length, 1, 'polling or moving an app to bindings must not re-fetch cached icons')

    await act(async () => view.root.findByProps({ 'aria-label': '配置' }).props.onChange({ target: { value: 'editor' } }))
    assert.deepEqual(switched, ['editor'])
    await act(async () => view.root.findByProps({ role: 'switch' }).props.onClick())
    assert.equal(current.appProfileSwitching, false)
    assert.equal(selected, chrome.id)

    await act(async () => trigger().props.onClick())
    await act(async () => view.root.findByProps({ className: 'application-select-action' }).props.onClick())
    await act(async () => view.root.findByProps({ id: 'application-add-path' }).props.onChange({ target: { value: 'invalid' } }))
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /请选择有效的应用/)
    await act(async () => view.root.findByProps({ 'aria-label': '选择应用文件' }).props.onClick())
    assert.equal(selected, code.id)
    assert.equal(trigger().findByType('img').props.src, iconsById[code.id])
    assert.deepEqual(JSON.parse(JSON.stringify(iconRequests)), [
      [{ id: chrome.id, path: chrome.path }],
      [{ id: code.id, path: code.path }],
    ])
    assert.equal(current.applicationProfiles.length, 2)
    assert.equal(current.appProfileSwitching, false)
    assert.equal(view.root.findAllByType('dialog').length, 0, 'file selection immediately adds and opens the app')

    await act(async () => trigger().props.onClick())
    const globalOption = view.root.findAllByProps({ role: 'option' }).find(node => nodeText(node) === '全局')
    await act(async () => globalOption.props.onClick())
    assert.equal(selected, '')
    assert.equal(trigger().findAllByType('img').length, 0)
    assert.equal(current.activeProfileId, 'global')
  } finally { await act(async () => view.unmount()) }

  let mouseView
  await act(async () => {
    mouseView = Renderer.create(React.createElement(MouseApplicationProfileToolbar, {
      profiles: [
        { id: 'default', name: '默认配置', deviceId: 'mouse', behaviors: {}, applicationIds: [] },
        { id: 'browser', name: '浏览器', deviceId: 'mouse', behaviors: {}, applicationIds: [chrome.id] },
      ],
      activeProfileId: 'browser',
      applications: { supported: true, current: null, recent: [{ application: chrome, lastUsedAt: 1 }], error: null },
      editingApplicationId: chrome.id,
      autoSwitching: true,
      native: true,
      platform: 'macos',
      onSelectApplication() {},
      onAddApplication() {},
      onSwitchProfile() {},
      onToggle() {},
      onCreate() {},
      onDuplicate() {},
      onRename() {},
      onDelete() {},
    }))
  })
  try {
    const mouseTrigger = mouseView.root.findByProps({ 'aria-label': '编辑应用' })
    assert.equal(mouseTrigger.findByType('img').props.src, iconsById[chrome.id])
    await act(async () => mouseTrigger.props.onClick())
    const boundOption = mouseView.root.findAllByProps({ role: 'option' }).find(node => nodeText(node).includes('Chrome'))
    assert.ok(nodeText(boundOption).includes('浏览器'))
    assert.equal(boundOption.findByType('img').props.src, iconsById[chrome.id])
  } finally { await act(async () => mouseView.unmount()) }
})

test('workspace edits the explicitly selected app while paused and does not follow foreground changes', async () => {
  const require = createRequire(import.meta.url)
  let foreground = { supported: true, current: chrome, recent: [], error: null }
  const nullComponent = () => null
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node }, '@tauri-apps/api/event': { listen: async () => () => {} },
    '../../behaviorModel': require('../src/behaviorModel.ts'), '../../appConfig': { triggerLabels: {} },
    '../../deviceInputSelection': { getStoredDeviceInput: () => 'voice', storeDeviceInput() {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar: props => React.createElement('app-toolbar', props) },
    '../../useForegroundApplications': { useForegroundApplications: () => foreground },
    './applicationProfiles': { setApplicationProfile },
    './instanceProfiles': { addInstanceProfile, deleteInstanceProfile, ...require('../src/devices/integration/instanceProfiles.ts') },
    '../shared/RemoteControl': { RemoteControl: nullComponent },
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: nullComponent },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: nullComponent },
    '../../components/SettingsHelp': { SettingsHelp: nullComponent }, '../../components/BatteryIndicator': { BatteryIndicator: nullComponent },
    '../../components/DeviceRail': { DeviceRecordingStatus: nullComponent },
    '../../telemetry': { reportTencentEvent() {} }, '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
    '../../components/workflowSplitLayout': { defaultWorkflowSplitRatio: .54 },
    '../../components/WorkflowAxonkey': { WorkflowAxonkey: props => React.createElement('workflow', props) },
    '../shared/DeviceSettingsDrawer': { DeviceSettingsDrawer: nullComponent },
    '../shared/DeviceWorkspaceHeader': { DeviceWorkspaceHeader: props => React.createElement('header', null, props.profileControls) },
    './IntegrationControls': { DeviceBindingPicker: nullComponent },
    './model': require('../src/devices/integration/model.ts'),
  })
  let current, view
  function Harness() {
    const initial = setApplicationProfile(instance(), chrome, 'browser')
    initial.kind = 'rc003'; initial.enabled = true; initial.appProfileSwitching = false
    initial.profiles.forEach((profile, index) => { profile.behaviors = { voice: { click: [{ id: 'delay', enabled: true, type: 'delay', ms: (index + 1) * 100 }], doubleClick: [], longPress: [] } } })
    const [value, setValue] = React.useState(initial)
    current = value
    return React.createElement(InstanceWorkspace, {
      instance: value, native: false, platform: 'macos', permissions: {},
      controller: { snapshot: { runtime: {}, discovered: [], store: { instances: [value] } }, update: async (_id, change) => setValue(change) },
    })
  }
  const toolbar = () => view.root.findByType('app-toolbar')
  const workflow = () => view.root.findByType('workflow')
  await act(async () => { view = Renderer.create(React.createElement(Harness)) })
  try {
    assert.equal(toolbar().props.profileId, 'global', 'foreground Chrome must not control the editor')
    await act(async () => toolbar().props.onSelectApplication(chrome.id))
    assert.equal(toolbar().props.profileId, 'browser')
    assert.equal(workflow().props.sequences.click[0].ms, 200)
    foreground = { ...foreground, current: code }
    await act(async () => view.update(React.createElement(Harness)))
    assert.equal(toolbar().props.profileId, 'browser')
    await act(async () => workflow().props.onChange('voice', { click: [{ id: 'changed', enabled: true, type: 'delay', ms: 751 }], doubleClick: [], longPress: [] }))
    assert.equal(current.profiles[0].behaviors.voice.click[0].ms, 100)
    assert.equal(current.profiles[1].behaviors.voice.click[0].ms, 751)
    await act(async () => toolbar().props.onSwitchProfile('editor'))
    assert.equal(current.applicationProfiles[0].profileId, 'editor')
    assert.equal(current.appProfileSwitching, false)
    assert.equal(current.activeProfileId, 'global')
    await act(async () => toolbar().props.onDeleteProfile())
    assert.equal(current.applicationProfiles[0].application.id, chrome.id)
    assert.equal(current.applicationProfiles[0].profileId, 'global')
    assert.equal(toolbar().props.editingApplicationId, chrome.id)
    assert.equal(toolbar().props.profileId, 'global')
    await act(async () => toolbar().props.onSelectApplication(''))
    assert.equal(toolbar().props.profileId, 'global')
    assert.equal(workflow().props.sequences.click[0].ms, 100)
  } finally { await act(async () => view.unmount()) }
})
