import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { serializeSequence } from '../src/behaviorModel.ts'
import { RelayClient } from '../src/cloud/relayClient.ts'
import { parseLibraryPage, fetchLibraryPage, submitSequence, withdrawSequence, recordLibraryAddition } from '../src/cloud/behaviorLibrary.ts'
import { insertedWorkflowSteps } from '../src/components/workflowBehaviorBridge.ts'
import { libraryHarness } from './helpers/behavior-library-harness.mjs'

const builtin = { componentType: 'task', type: 'volumeControl', name: '音量控制', properties: { preset: 'volumeControl' } }
const publicItem = (id, title = id) => ({ id, title, source: 'community', version_id: `version-${id}`, content_schema_version: 1, platforms: ['macos'], author_display_name: '作者', content: { kind: 'sequence', behaviors: [{ id: 'remote', type: 'key', key: 'Enter', enabled: true }, { id: 'remote2', type: 'delay', ms: 30, enabled: false }] } })
const saved = { id: 'local-sequence', name: '发送', sequence: serializeSequence([{ id: 'local1', type: 'key', key: 'Enter', enabled: true }, { id: 'local2', type: 'delay', ms: 30, enabled: true }]) }
const session = { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now()/1000 + 3600, user: { id: 'user' } }
const shared = { id: 'abc-123', revision: 2, source_sequence_key: saved.id, status: 'active', published_version_id: null, latest_version: { id: 'version-1', status: 'pending' } }
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
const button = (view, name) => view.root.findAllByType('button').find(node => text(node) === name)
const flush = () => new Promise(resolve => setImmediate(resolve))

test('cloud decoding preserves order, skips unsupported entries whole, and inserts independent snapshots', () => {
  const source = [publicItem('b'), { ...publicItem('a'), source: 'official', content: { kind: 'builtin', preset: 'volumeControl' } },
    { ...publicItem('future'), content_schema_version: 2 }, { ...publicItem('windows'), platforms: ['windows'] },
    { ...publicItem('unknown'), content: { kind: 'builtin', preset: 'not-supported' } },
    { ...publicItem('shared-mix'), content: { kind: 'sequence', behaviors: [{type: 'switchProfile', direction: 'next'}, {type: 'key', key: 'Enter'}] } },
    { ...publicItem('partial'), content: { kind: 'sequence', behaviors: [{ type: 'key', key: 'Enter' }, { type: 'future' }] } }]
  const page = parseLibraryPage({ items: source, next_cursor: 'next' }, 'macos', [builtin])
  assert.deepEqual(page.steps.map(s => s.name), ['b', 'a'])
  assert.equal(page.skipped, 5)
  assert.equal(page.nextCursor, 'next')
  const add = id => insertedWorkflowSteps({ ...page.steps[0], id }, 'macos', b => b.type)
  const first = add('first'), second = add('second')
  assert.ok(first.every(s => !second.some(other => s.id === other.id)))
  assert.equal(first[1].properties.enabled, false)
  source[0].content.behaviors[0].key = 'Esc'
  assert.equal(first[0].properties.key, 'Enter')
  assert.throws(() => parseLibraryPage({ items: null }, 'macos', []), /响应/)
})

test('public requests remain anonymous; confirmed share reuses auth and empty note; withdrawal keeps version status', async () => {
  const requests = []
  const client = new RelayClient(async (...args) => {
    requests.push(args)
    const path = args[1]
    if (path.endsWith('/submissions')) return { status: 200, body: shared }
    if (path.includes('/withdraw?')) return { status: 200, body: { ...shared, revision: 3, latest_version: undefined } }
    if (path.endsWith('/additions')) throw new Error('offline')
    return { status: 200, body: { items: [publicItem('a')] } }
  }, session, () => {})
  await fetchLibraryPage(client, 'macos', 'community', '音量 & 关闭', 'abc_cursor', [builtin])
  const url = new URL('https://relay.invalid' + requests[0][1])
  assert.equal(url.searchParams.get('q'), '音量 & 关闭')
  assert.equal(url.searchParams.get('cursor'), 'abc_cursor')
  assert.equal(requests[0][3], undefined)
  await submitSequence(client, saved, 'macos', '', false)
  assert.equal(requests[1][3], 'access')
  assert.equal(requests[1][2].confirmed, true)
  assert.equal(requests[1][2].submission_note, '')
  assert.equal(requests[1][2].source_sequence_key, saved.id)
  assert.deepEqual(requests[1][2].snapshot.platforms, ['macos'])
  const withdrawn = await withdrawSequence(client, shared, false)
  assert.equal(withdrawn.latest_version.status, 'withdrawn')
  assert.equal(requests[2][4].ifMatch, '"behavior-library:abc-123:2"')
  await recordLibraryAddition(client, 'abc-123', 'macos')
  assert.equal(requests[3][3], undefined)
  const anonymous = new RelayClient(async () => { throw new Error('must not send') }, null, () => {})
  await assert.rejects(submitSequence(anonymous, saved, 'macos', '', false), /请先登录/)
})

test('public hook handles pagination deduplication, stale searches, and failure without clearing downloaded content', async () => {
  const harness = libraryHarness()
  const { useBehaviorLibrary } = harness.load('cloud/useBehaviorLibrary.ts')
  let value, fail = false, pendingResolve
  const client = new RelayClient(async (_, path) => {
    const params = new URL('https://relay.invalid' + path).searchParams
    if (params.get('q') === 'old') return new Promise(resolve => { pendingResolve = resolve })
    if (fail) throw new Error('offline')
    return { status: 200, body: params.has('cursor') ? { items: [publicItem('b'), publicItem('c')] }
      : { items: [publicItem(params.get('q') || 'a'), publicItem('b')], next_cursor: 'next' } }
  }, null, () => {})
  function App({ query = '' }) { value = useBehaviorLibrary(client, 'macos', 'recommended', query, []); return null }
  let view
  await act(async () => { view = Renderer.create(React.createElement(App)) })
  try {
    await act(async () => { harness.tick(); await flush() })
    assert.deepEqual(Array.from(value.steps, s => s.name), ['a', 'b'])
    await act(async () => value.more())
    assert.deepEqual(Array.from(value.steps, s => s.name), ['a', 'b', 'c'])
    fail = true
    await act(async () => value.retry())
    await act(async () => { harness.tick(); await flush() })
    assert.match(value.error, /不可用/)
    assert.equal(value.steps.length, 3)
    fail = false
    await act(async () => view.update(React.createElement(App, { query: 'old' })))
    await act(async () => { harness.tick(); await flush() })
    await act(async () => view.update(React.createElement(App, { query: 'new' })))
    await act(async () => { harness.tick(); await flush() })
    await act(async () => { pendingResolve({ status: 200, body: { items: [publicItem('old')] } }); await flush() })
    assert.equal(value.steps[0].name, 'new')
  } finally { act(() => view.unmount()) }
})

test('toolbox defaults can show local fallback, distinguish empty community, and open share without submitting', async () => {
  const harness = libraryHarness()
  const { BehaviorLibraryContext } = harness.load('cloud/BehaviorLibraryContext.tsx')
  const { WorkflowToolbox } = harness.load('components/WorkflowToolbox.tsx')
  const requests = []
  let offline = true, login = 0
  const client = new RelayClient(async (method, path) => { requests.push([method, path]); if (offline) throw new Error('offline'); return { status: 200, body: { items: [] } } }, null, () => {})
  function App() {
    const [selectedCategory, onCategoryChange] = React.useState('recommended')
    return React.createElement(BehaviorLibraryContext.Provider, { value: { client, userId: null, accountReady: true, onLogin: () => login++ } },
      React.createElement(WorkflowToolbox, { platform: 'macos', selectedCategory, onCategoryChange, palettes: [
        { name: '常用行为', groups: [{ name: '常用行为', steps: [builtin] }] },
        { name: '已保存', groups: [{ name: '已保存', steps: [{ componentType: 'task', type: 'savedSequence', name: saved.name, properties: { savedSequenceId: saved.id, sequence: saved.sequence } }] }] },
      ], iconUrls: {}, api: { toolbox: { tryDrag() {} } }, onAddStep() {}, addLabel: '添加到单击', getStepPreview: () => ['Enter', '30ms'] }))
  }
  let view
  await act(async () => { view = Renderer.create(React.createElement(App)) })
  try {
    await act(async () => { harness.tick(); await flush() })
    assert.match(text(view.toJSON()), /云端暂时不可用/)
    assert.match(text(view.toJSON()), /本地常用/)
    assert.ok(button(view, '音量控制'))
    offline = false
    await act(async () => button(view, '社区').props.onClick())
    await act(async () => { harness.tick(); await flush() })
    assert.match(text(view.toJSON()), /暂无社区行为/)
    assert.ok(!button(view, '音量控制'))
    await act(async () => button(view, '我的').props.onClick())
    await act(async () => view.root.findByProps({ 'aria-label': '分享发送' }).props.onClick())
    assert.equal(requests.filter(([method]) => method === 'POST').length, 0)
    await act(async () => button(view, '登录后分享').props.onClick())
    assert.equal(login, 1)
  } finally { act(() => view.unmount()) }
})

test('share dialog confirms without a note, reports pending, and withdraws using the returned revision', async () => {
  const harness = libraryHarness()
  const { BehaviorLibraryContext } = harness.load('cloud/BehaviorLibraryContext.tsx')
  const { BehaviorShareDialog } = harness.load('components/BehaviorShareDialog.tsx')
  const requests = []
  const client = new RelayClient(async (method, path, body, token, conditions) => {
    requests.push({ method, path, body, token, conditions })
    if (method === 'GET') return { status: 200, body: { items: [], total: 0 } }
    if (path.endsWith('/submissions')) return { status: 200, body: shared }
    return { status: 200, body: { ...shared, revision: 3, latest_version: undefined } }
  }, session, () => {})
  let view
  await act(async () => { view = Renderer.create(React.createElement(BehaviorLibraryContext.Provider,
    { value: { client, userId: 'user', accountReady: true, onLogin() {} } },
    React.createElement(BehaviorShareDialog, { sequence: saved, platform: 'macos', preview: ['Enter'], onClose() {} }))); await flush() })
  try {
    assert.equal(requests.length, 1)
    await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }); await flush() })
    assert.equal(requests[1].body.submission_note, '')
    assert.equal(text(view.root.findByProps({ role: 'status' })), '待审核')
    await act(async () => { button(view, '撤回申请').props.onClick(); await flush() })
    assert.equal(requests[2].conditions.ifMatch, '"behavior-library:abc-123:2"')
    assert.equal(text(view.root.findByProps({ role: 'status' })), '已撤回')
  } finally { act(() => view.unmount()) }
})
