import test from 'node:test'
import assert from 'node:assert/strict'
import { activeApplicationProfile, selectInstanceProfile, setApplicationProfile } from '../src/devices/integration/applicationProfiles.ts'
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
  assert.equal(deleted.applicationProfiles.length, 0)
  assert.equal(deleted.activeProfileId, 'global')
  const deletedGlobal = deleteInstanceProfile(first, 'global')
  assert.equal(deletedGlobal.activeProfileId, 'browser')
  assert.equal(deletedGlobal.applicationProfiles[0].profileId, 'editor')
  const last = { ...first, profiles: [first.profiles[0]] }
  assert.equal(deleteInstanceProfile(last, 'global'), last)
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

test('toolbar selects recent apps directly, toggles automatic switching and adds manual apps in one step', async () => {
  const { ProfileManager } = compile('src/components/ProfileManager.tsx')
  const { ApplicationProfileToolbar } = compile('src/components/ApplicationProfileToolbar.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/core': { invoke: async (command, { path }) => { assert.equal(command, 'resolve_application_path'); if (path === code.path) return code; throw new Error('请选择有效的应用') } },
    '@tauri-apps/plugin-dialog': { open: async () => code.path },
    '../devices/integration/instanceProfiles': { addApplicationForEditing },
    './ProfileManager': { ProfileManager }, './SettingsHelp': { SettingsHelp: () => null },
  })
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
  await act(async () => { view = Renderer.create(React.createElement(Harness), { createNodeMock: () => ({ showModal() {}, close() {} }) }) })
  try {
    await act(async () => view.root.findByProps({ 'aria-label': '编辑应用' }).props.onChange({ target: { value: chrome.id } }))
    assert.equal(selected, chrome.id)
    assert.equal(current.activeProfileId, 'global')
    assert.equal(current.applicationProfiles[0].profileId, current.profiles.at(-1).id)
    await act(async () => view.root.findByProps({ 'aria-label': '配置' }).props.onChange({ target: { value: 'editor' } }))
    assert.deepEqual(switched, ['editor'])
    await act(async () => view.root.findByProps({ role: 'switch' }).props.onClick())
    assert.equal(current.appProfileSwitching, false)
    assert.equal(selected, chrome.id)
    await act(async () => view.root.findByProps({ 'aria-label': '编辑应用' }).props.onChange({ target: { value: '__add_application__' } }))
    await act(async () => view.root.findByProps({ id: 'application-add-path' }).props.onChange({ target: { value: 'invalid' } }))
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /请选择有效的应用/)
    await act(async () => view.root.findByProps({ 'aria-label': '选择应用文件' }).props.onClick())
    assert.equal(selected, code.id)
    assert.equal(current.applicationProfiles.length, 2)
    assert.equal(current.appProfileSwitching, false)
    assert.equal(view.root.findAllByType('dialog').length, 0, 'file selection immediately adds and opens the app')
    await act(async () => view.root.findByProps({ 'aria-label': '编辑应用' }).props.onChange({ target: { value: '' } }))
    assert.equal(selected, '')
    assert.equal(current.activeProfileId, 'global')
  } finally { await act(async () => view.unmount()) }
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
    './IntegrationControls': { DeviceBindingPicker: nullComponent }, '../xbox-controller/ControllerDiagram': { ControllerDiagram: nullComponent },
    './model': { packageFor: () => ({ inputs: [{ id: 'voice', label: '语音键', icon: 'mic' }] }), emptyTriggers: () => ({ click: [], doubleClick: [], longPress: [] }), instanceStatusLabel: () => 'preview' },
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
    await act(async () => toolbar().props.onSelectApplication(''))
    assert.equal(toolbar().props.profileId, 'global')
    assert.equal(workflow().props.sequences.click[0].ms, 100)
  } finally { await act(async () => view.unmount()) }
})
