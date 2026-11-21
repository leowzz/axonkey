import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import vm from 'node:vm'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import ts from 'typescript'
import {
  commandBehaviorMinAppVersion,
  createBehavior,
  createEmptyBehaviorMap,
  createMappingExport,
  minAppVersionForBehaviors,
  normalizeBehavior,
  parseMappingImport,
  parseSequenceImport,
  quickOverlayMinAppVersion,
  serializeSequence,
} from '../src/behaviorModel.ts'
import { behaviorSummary } from '../src/behaviorSummary.ts'
import { behaviorToCliBehavior, cliBehaviorTypes, normalizeCliBehavior } from '../src/cliContract.ts'
import { RelayClient } from '../src/cloud/relayClient.ts'
import { workflowActionChoiceGroups } from '../src/components/workflowActionChoices.ts'
import { insertedWorkflowSteps, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'
import { workflowBehaviorProperties } from '../src/components/workflowStepEditing.ts'
import { createDataBackup, parseDataBackup } from '../src/dataBackup.ts'
import { sampleData } from './fixtures/data-backup.mjs'
import { libraryHarness } from './helpers/behavior-library-harness.mjs'

const require = createRequire(import.meta.url)
const moduleCache = new Map()
function loadTs(file) {
  file = resolve(file)
  if (moduleCache.has(file)) return moduleCache.get(file).exports
  const module = { exports: {} }
  moduleCache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const localRequire = name => {
    if (name === '@tauri-apps/api/core') return { invoke: async () => null }
    if (!name.startsWith('.')) return require(name)
    const base = resolve(dirname(file), name)
    if (extname(base) && existsSync(base)) return loadTs(base)
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
      if (existsSync(base + ext)) return loadTs(base + ext)
    }
    return require(base)
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, globalThis, console })
  return module.exports
}

const { workflowToolboxPalettes } = loadTs('src/components/workflowToolboxPalettes.ts')

const text = node => (typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join(''))
const flush = () => new Promise(resolve => setImmediate(resolve))

test('copyText, runCommand, and httpRequest round-trip via JSON, sequence text axonkey/2, and require minAppVersion 1.9.19', () => {
  const items = [
    createBehavior({ id: 'cp', type: 'copyText', text: 'line1\nline2', title: '片段' }),
    createBehavior({ id: 'cmd', type: 'runCommand', command: 'echo "ok"', workingDirectory: '/tmp', title: '打招呼' }),
    createBehavior({
      id: 'http',
      enabled: false,
      type: 'httpRequest',
      method: 'POST',
      url: 'http://127.0.0.1:8123/api/hook',
      headers: { 'Content-Type': 'application/json', 'X-Token': 'abc' },
      body: '{"ok":true}',
      title: 'Webhook',
    }),
  ]

  assert.equal(minAppVersionForBehaviors([items[0]]), commandBehaviorMinAppVersion)
  assert.equal(minAppVersionForBehaviors([items[1]]), commandBehaviorMinAppVersion)
  assert.equal(minAppVersionForBehaviors([items[2]]), commandBehaviorMinAppVersion)
  assert.equal(commandBehaviorMinAppVersion, '1.9.19')

  const serialized = serializeSequence(items)
  assert.ok(serialized.startsWith('axonkey/2\n'))
  const parsed = parseSequenceImport(serialized)
  assert.ok(parsed)
  assert.deepEqual(
    parsed.map(({ id: _id, ...rest }) => rest),
    items.map(({ id: _id, ...rest }) => rest),
  )

  const map = createEmptyBehaviorMap()
  map.power.click = items
  const exported = createMappingExport(map, true)
  assert.equal(exported.version, 3)
  assert.equal(exported.minAppVersion, commandBehaviorMinAppVersion)
  const imported = parseMappingImport(JSON.stringify(exported))
  assert.deepEqual(imported?.behaviors.power.click, items)

  assert.equal(behaviorSummary(items[0], 'macos'), '复制：片段')
  assert.equal(behaviorSummary(items[1], 'macos'), '命令：打招呼')
  assert.equal(behaviorSummary(items[2], 'macos'), 'POST Webhook')
})

test('normalizeBehavior and sequence import reject invalid copyText, runCommand, and httpRequest inputs', () => {
  for (const invalid of [
    { type: 'copyText', text: null },
    { type: 'runCommand', command: '   ' },
    { type: 'runCommand', command: 'echo\0hi' },
    { type: 'runCommand', command: 'echo hi', workingDirectory: 'relative/path' },
    { type: 'httpRequest', method: 'TRACE', url: 'https://example.com' },
    { type: 'httpRequest', method: 'GET', url: 'https://user:pass@example.com' },
    { type: 'httpRequest', method: 'GET', url: 'https://example.com', headers: { 'X-A': '1', 'x-a': '2' } },
    { type: 'httpRequest', method: 'POST', url: 'https://example.com', body: 'x'.repeat(16385) },
  ]) {
    assert.equal(normalizeBehavior(invalid), null, JSON.stringify(invalid))
  }

  assert.equal(parseSequenceImport('axonkey/2\ncmd ""\nend'), null)
  assert.equal(parseSequenceImport('axonkey/2\nhttp GET file:///etc/passwd\nend'), null)
})

test('backup export keeps minAppVersion 1.9.19 over quickOverlay 1.9.11 and round-trips through parseDataBackup', () => {
  const data = sampleData()
  data.behaviors.power.click = [
    createBehavior({ id: 'cmd', type: 'runCommand', command: 'ls -la', workingDirectory: '/tmp' }),
    createBehavior({ id: 'http', type: 'httpRequest', method: 'DELETE', url: 'http://127.0.0.1:8080/item/1' }),
    createBehavior({ id: 'cp', type: 'copyText', text: 'copied' }),
  ]
  data.profiles.push({
    id: 'quick-1',
    name: '快捷交互',
    deviceId: 'rc003',
    quick: true,
    behaviors: createEmptyBehaviorMap(),
  })
  assert.equal(quickOverlayMinAppVersion, '1.9.11')
  const doc = createDataBackup(data, '1.9.18')
  assert.equal(doc.version, 3)
  assert.equal(doc.minAppVersion, '1.9.19')
  const restored = parseDataBackup(JSON.stringify(doc))
  const restoredActive = restored.profiles.find(p => p.id === restored.activeProfileIds.rc003)
  assert.deepEqual(restoredActive.behaviors.power.click, data.behaviors.power.click)
})

test('CLI contract normalizes and round-trips copyText, runCommand, and httpRequest', () => {
  for (const kind of ['copyText', 'runCommand', 'httpRequest']) {
    assert.ok(cliBehaviorTypes.includes(kind))
  }
  const copy = normalizeCliBehavior({ type: 'copyText', text: 'abc', title: '标签' }, 'macos')
  assert.deepEqual(copy, { type: 'copyText', text: 'abc', title: '标签', enabled: true })

  const cmd = normalizeCliBehavior(
    { type: 'runCommand', command: 'echo ok', workingDirectory: '/tmp', enabled: false },
    'macos',
  )
  assert.deepEqual(cmd, { type: 'runCommand', command: 'echo ok', workingDirectory: '/tmp', enabled: false })
  assert.equal(behaviorToCliBehavior(createBehavior({ id: '1', ...cmd }), 'macos').enabled, false)

  const req = normalizeCliBehavior(
    {
      type: 'httpRequest',
      method: 'patch',
      url: '127.0.0.1:8123/state',
      headers: { Authorization: 'Bearer token' },
      body: '{"on":true}',
    },
    'windows',
  )
  assert.deepEqual(req, {
    type: 'httpRequest',
    method: 'PATCH',
    url: 'https://127.0.0.1:8123/state',
    headers: { Authorization: 'Bearer token' },
    body: '{"on":true}',
    enabled: true,
  })
  assert.equal(normalizeCliBehavior({ type: 'runCommand', command: '   ' }, 'macos'), null)
  assert.equal(normalizeCliBehavior({ type: 'httpRequest', method: 'HEAD', url: 'https://example.com' }, 'macos'), null)
})

test('Behavior Library exposes 6 normalized categories, mouse side buttons, everyday shortcuts, and draft gating', () => {
  const macGroups = workflowToolboxPalettes('macos')[0].groups
  assert.deepEqual(
    Array.from(macGroups, group => group.name),
    ['键盘', '鼠标', '媒体', '文本', '系统与命令', '流程控制'],
  )
  const mouseChoice = workflowActionChoiceGroups.find(group => group.preset === 'mouseButton')
  assert.deepEqual(
    mouseChoice.options.map(option => option.behavior.button),
    ['left', 'right', 'back', 'forward'],
  )

  const copySteps = insertedWorkflowSteps(
    { id: 's-copy', componentType: 'task', type: 'copy', name: '复制', properties: {} },
    'macos',
    b => b.type,
  )
  assert.deepEqual(copySteps[0].properties.keys, ['Win', 'C'])
  assert.equal(copySteps[0].properties.draftGroup, undefined)

  const winCopySteps = insertedWorkflowSteps(
    { id: 'w-copy', componentType: 'task', type: 'copy', name: '复制', properties: {} },
    'windows',
    b => b.type,
  )
  assert.deepEqual(winCopySteps[0].properties.keys, ['Ctrl', 'C'])

  for (const preset of ['copyText', 'runCommand', 'httpRequest']) {
    const nodes = insertedWorkflowSteps(
      { id: `id-${preset}`, componentType: 'task', type: preset, name: preset, properties: {} },
      'macos',
      b => b.type,
    )
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].properties.draftGroup, `id-${preset}`)
  }

  const httpStep = {
    id: 'http-step',
    componentType: 'task',
    type: 'httpRequest',
    name: 'HTTP',
    properties: { behaviorType: 'httpRequest', enabled: true, method: 'GET', url: 'https://example.com' },
  }
  const props = workflowBehaviorProperties(httpStep, {
    id: 'http-step',
    enabled: true,
    type: 'httpRequest',
    method: 'POST',
    url: 'http://127.0.0.1:8123/api',
    headers: { 'X-Test': '1' },
    body: '{}',
    title: '通知',
  })
  assert.equal(props.method, 'POST')
  assert.equal(props.url, 'http://127.0.0.1:8123/api')
  assert.deepEqual(props.headers, { 'X-Test': '1' })
  assert.equal(workflowBehaviorProperties(httpStep, { id: 'http-step', enabled: true, type: 'httpRequest', method: 'GET', url: '' }), null)

  const def = {
    properties: {},
    sequence: [
      {
        id: 'axonkey-triggers',
        componentType: 'switch',
        type: 'axonkeyTriggers',
        name: '触发方式',
        properties: {},
        branches: { click: [{ ...httpStep, properties: props }], doubleClick: [], longPress: [] },
      },
    ],
  }
  assert.equal(workflowToBehaviors(def).click[0].type, 'httpRequest')
})

test('BehaviorShareDialog blocks runCommand and httpRequest sequences while allowing copyText', async () => {
  const harness = libraryHarness()
  const { BehaviorLibraryContext } = harness.load('cloud/BehaviorLibraryContext.tsx')
  const { BehaviorShareDialog } = harness.load('components/BehaviorShareDialog.tsx')
  const session = { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600, user: { id: 'u' } }
  let posts = 0
  const client = new RelayClient(async method => {
    if (method === 'GET') return { status: 200, body: { items: [], total: 0 } }
    posts++
    return { status: 200, body: { id: 'x', revision: 1, source_sequence_key: 'k', status: 'active', published_version_id: null, latest_version: { id: 'v', status: 'pending' } } }
  }, session, () => {})

  const blocked = {
    id: 'cmd-seq',
    name: '危险脚本',
    sequence: serializeSequence([{ id: '1', type: 'runCommand', command: 'echo hi', enabled: true }]),
  }
  let view
  await act(async () => {
    view = Renderer.create(
      React.createElement(
        BehaviorLibraryContext.Provider,
        { value: { client, userId: 'u', accountReady: true, onLogin() {} } },
        React.createElement(BehaviorShareDialog, { sequence: blocked, platform: 'macos', preview: ['cmd'], onClose() {} }),
      ),
    )
    await flush()
  })
  try {
    const alert = view.root.findByProps({ role: 'alert' })
    assert.match(text(alert), /不可公开分享到社区/)
    const submit = view.root.findAllByType('button').find(b => b.props.type === 'submit')
    assert.equal(submit.props.disabled, true)
    await act(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} })
      await flush()
    })
    assert.equal(posts, 0)
  } finally {
    act(() => view.unmount())
  }
})
