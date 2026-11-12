import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { parseSequenceImport, serializeSequence } from '../src/behaviorModel.ts'
import { RelayClient } from '../src/cloud/relayClient.ts'
import {
  behaviorLibraryCacheTtlMs,
  parseLibraryPage,
  fetchLibraryPage,
  readCachedLibraryPage,
  submitSequence,
  withdrawSequence,
  writeCachedLibraryPage,
} from '../src/cloud/behaviorLibrary.ts'
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
const recommendationButtons = view => view.root.findAllByType('button').filter(node => /^(设为推荐|取消推荐)：/.test(node.props['aria-label'] ?? ''))
const recommendationItem = (id, catalog_key = null, recommend_enabled = false, revision = 2) => ({ id, catalog_key, recommend_enabled, revision, status: 'active', published_version_id: `version-${id}` })
function recommendationToolbox(harness, client, account = {}, selectedCategory = 'all') {
  const { BehaviorLibraryContext } = harness.load('cloud/BehaviorLibraryContext.tsx')
  const { WorkflowToolbox } = harness.load('components/WorkflowToolbox.tsx')
  return React.createElement(BehaviorLibraryContext.Provider,
    { value: { client, userId: 'user', accountReady: true, debugMode: true, onLogin() {}, ...account } },
    React.createElement(WorkflowToolbox, { platform: 'macos', selectedCategory, onCategoryChange() {}, palettes: [
      { name: '常用行为', groups: [{ name: '常用行为', steps: [builtin] }] },
      { name: '已保存', groups: [{ name: '已保存', steps: [{ componentType: 'task', type: 'savedSequence', name: saved.name, properties: { savedSequenceId: saved.id, sequence: saved.sequence } }] }] },
    ], iconUrls: {}, api: { toolbox: { tryDrag() {} } }, onAddStep() {}, addLabel: '添加到单击', getStepPreview: () => ['Enter', '30ms'] }))
}

test('cloud decoding preserves order, skips unsupported entries whole, and inserts independent snapshots', () => {
  const source = [publicItem('b'), { ...publicItem('a'), source: 'official', content: { kind: 'builtin', preset: 'volumeControl' } },
    { ...publicItem('future'), content_schema_version: 2 }, { ...publicItem('windows'), platforms: ['windows'] },
    { ...publicItem('unknown'), content: { kind: 'builtin', preset: 'not-supported' } },
    { ...publicItem('shared-mix'), content: { kind: 'sequence', behaviors: [{type: 'switchProfile', direction: 'next'}, {type: 'key', key: 'Enter'}] } },
    { ...publicItem('partial'), content: { kind: 'sequence', behaviors: [{ type: 'key', key: 'Enter' }, { type: 'future' }] } }]
  const page = parseLibraryPage({ items: source, next_cursor: 'next' }, 'macos', [builtin])
  assert.deepEqual(page.steps.map(s => s.name), ['b', builtin.name])
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

test('recommended builtins retain platform names instead of cloud titles', () => {
  for (const [platform, names, cloudTitles] of [
    ['windows', ['右 Win', '右 Alt'], ['右 Cmd', '右 Opt']],
    ['macos', ['右 Cmd', '右 Opt'], ['右 Win', '右 Alt']],
  ]) {
    const presets = ['rightCommand', 'rightAlt']
    const builtins = presets.map((preset, index) => ({
      componentType: 'task', type: preset, name: names[index], properties: { preset },
    }))
    const items = presets.map((preset, index) => ({
      ...publicItem(preset, cloudTitles[index]), source: 'official', platforms: [platform],
      content: { kind: 'builtin', preset },
    }))
    const page = parseLibraryPage({ items }, platform, builtins)
    assert.deepEqual(page.steps.map(step => step.name), names)
    assert.deepEqual(page.steps.map(step => step.properties.libraryItemId), presets)
    assert.deepEqual(page.steps.map(step => step.properties.preset), presets)
    assert.equal(builtins[0].properties.libraryItemId, undefined)
  }
})

test('library lists authenticate only with a session; confirmed share and withdrawal require auth', async () => {
  const requests = []
  const client = new RelayClient(async (...args) => {
    requests.push(args)
    const path = args[1]
    if (path.endsWith('/submissions')) return { status: 200, body: shared }
    if (path.includes('/withdraw?')) return { status: 200, body: { ...shared, revision: 3, latest_version: undefined } }
    return { status: 200, body: { items: [publicItem('a')] } }
  }, session, () => {})
  await fetchLibraryPage(client, 'macos', 'community', '音量 & 关闭', 'abc_cursor', [builtin])
  const url = new URL('https://relay.invalid' + requests[0][1])
  assert.equal(url.searchParams.get('q'), '音量 & 关闭')
  assert.equal(url.searchParams.get('cursor'), 'abc_cursor')
  assert.equal(requests[0][3], 'access')
  await submitSequence(client, saved, 'macos', '', false)
  assert.equal(requests[1][3], 'access')
  assert.equal(requests[1][2].confirmed, true)
  assert.equal(requests[1][2].submission_note, '')
  assert.equal(requests[1][2].source_sequence_key, saved.id)
  assert.deepEqual(requests[1][2].snapshot.platforms, ['macos'])
  const withdrawn = await withdrawSequence(client, shared, false)
  assert.equal(withdrawn.latest_version.status, 'withdrawn')
  assert.equal(requests[2][4].ifMatch, '"behavior-library:abc-123:2"')
  const anonymous = new RelayClient(async (method, path, _body, token) => {
    assert.equal(method, 'GET')
    assert.match(path, /view=recommended/)
    assert.equal(token, undefined)
    return { status: 200, body: { items: [publicItem('a')] } }
  }, null, () => {})
  const page = await fetchLibraryPage(anonymous, 'macos', 'recommended', '', '', [builtin])
  assert.equal(page.steps.length, 1)
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

test('public library pages use a ten-minute local cache and retry bypasses it', async () => {
  const values = new Map()
  const storage = {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) },
  }
  const harness = libraryHarness({ localStorage: storage })
  const { useBehaviorLibrary } = harness.load('cloud/useBehaviorLibrary.ts')
  let requests = 0, value
  const client = new RelayClient(async () => {
    requests++
    return { status: 200, body: { items: [publicItem(`item-${requests}`)] } }
  }, null, () => {})
  function App() { value = useBehaviorLibrary(client, 'macos', 'community', '', []); return null }
  let view
  await act(async () => { view = Renderer.create(React.createElement(App)) })
  try {
    await act(async () => { harness.tick(); await flush() })
    assert.equal(requests, 1)
    assert.equal(value.steps[0].name, 'item-1')
    act(() => view.unmount())
    await act(async () => {
      view = Renderer.create(React.createElement(App))
      assert.equal(value.loading, false)
      assert.equal(value.steps[0].name, 'item-1')
    })
    await act(async () => { harness.tick(); await flush() })
    assert.equal(requests, 1)
    assert.equal(value.steps[0].name, 'item-1')
    await act(async () => value.retry())
    await act(async () => { harness.tick(); await flush() })
    assert.equal(requests, 2)
    const page = readCachedLibraryPage('macos', 'community', '', '', storage, Date.now())
    assert.ok(page)
    writeCachedLibraryPage('macos', 'community', '', '', page, storage, 1000)
    const key = [...values.keys()][0]
    assert.equal(JSON.parse(values.get(key)).expiresAt, 1000 + behaviorLibraryCacheTtlMs)
    assert.ok(readCachedLibraryPage('macos', 'community', '', '', storage, 1000 + behaviorLibraryCacheTtlMs - 1))
    assert.equal(readCachedLibraryPage('macos', 'community', '', '', storage, 1000 + behaviorLibraryCacheTtlMs), null)
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
    assert.equal(text(view.root.findByType('dialog').findByType('h2')), '登录后分享')
    assert.equal(view.root.findAllByType('textarea').length, 0)
    assert.equal(view.root.findAllByType('ol').length, 0)
    await act(async () => button(view, '取消').props.onClick())
    assert.equal(login, 0)
    assert.equal(view.root.findAllByType('dialog').length, 0)
    await act(async () => view.root.findByProps({ 'aria-label': '分享发送' }).props.onClick())
    assert.equal(button(view, '确定').props.type, 'submit')
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    assert.equal(login, 1)
    assert.equal(view.root.findAllByType('dialog').length, 0)
    assert.ok(requests.every(([method, path]) => method === 'GET' && !path.includes('/mine')))
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

test('recommendation controls require debug mode, a ready login and confirmed administrator permission', async () => {
  for (const account of [{ debugMode: false }, { userId: null }, { accountReady: false }, {}]) {
    const harness = libraryHarness()
    const requests = []
    const client = new RelayClient(async (method, path) => {
      requests.push({ method, path })
      assert.equal(path, '/v2/me')
      return { status: 200, body: { is_admin: false } }
    }, session, () => {})
    let view
    await act(async () => { view = Renderer.create(recommendationToolbox(harness, client, account)); await flush() })
    try {
      assert.equal(recommendationButtons(view).length, 0)
      assert.deepEqual(requests, Object.keys(account).length ? [] : [{ method: 'GET', path: '/v2/me' }])
    } finally { act(() => view.unmount()) }
  }
})

test('administrator recommendations publish builtins and saved sequences, toggle cloud items and refresh public results', async () => {
  const harness = libraryHarness()
  const requests = []
  const cloudItem = recommendationItem('cloud')
  const client = new RelayClient(async (method, path, body, token, conditions) => {
    requests.push({ method, path, body, token, conditions })
    if (path === '/v2/me') return { status: 200, body: { is_admin: true } }
    if (method === 'GET' && path.startsWith('/v2/behavior-library/admin/items?')) return { status: 200, body: { items: [cloudItem], total: 1 } }
    if (method === 'GET') return { status: 200, body: { items: [publicItem('cloud', '云端序列')] } }
    if (path.endsWith('/admin/recommendations')) return { status: 200, body: recommendationItem(body.catalog_key, body.catalog_key, true, 1) }
    if (path.includes('/admin/items/')) return { status: 200, body: recommendationItem(path.includes('/cloud/') ? 'cloud' : 'builtin:macos:volumeControl', path.includes('/cloud/') ? null : 'builtin:macos:volumeControl', body.recommend_enabled, 3) }
    assert.fail(`unexpected request: ${method} ${path}`)
  }, session, () => {})
  let view
  await act(async () => { view = Renderer.create(recommendationToolbox(harness, client)); await flush() })
  try {
    await act(async () => { await view.root.findByProps({ 'aria-label': '设为推荐：音量控制' }).props.onClick(); await flush() })
    const builtinWrite = requests.find(request => request.method === 'POST')
    assert.equal(builtinWrite.path, '/v2/behavior-library/admin/recommendations')
    assert.equal(builtinWrite.token, 'access')
    assert.deepEqual(builtinWrite.body, { app_id: 'axonkey', catalog_key: 'builtin:macos:volumeControl', snapshot: { title: '音量控制', category_code: 'common', platforms: ['macos'], content_schema_version: 1, content: { kind: 'builtin', preset: 'volumeControl' } } })
    await act(async () => { await view.root.findByProps({ 'aria-label': '取消推荐：音量控制' }).props.onClick(); await flush() })
    const cancel = requests.filter(request => request.method === 'POST').at(-1)
    assert.equal(cancel.path, '/v2/behavior-library/admin/items/builtin%3Amacos%3AvolumeControl/recommendation')
    assert.deepEqual(cancel.body, { app_id: 'axonkey', recommend_enabled: false })
    assert.equal(cancel.conditions.ifMatch, '"behavior-library:builtin:macos:volumeControl:1"')
    assert.equal(view.root.findByProps({ 'aria-label': '设为推荐：音量控制' }).props.disabled, false)
    await act(async () => { view.update(recommendationToolbox(harness, client, {}, '已保存/已保存')); await flush() })
    await act(async () => { await view.root.findByProps({ 'aria-label': '设为推荐：发送' }).props.onClick(); await flush() })
    const savedWrite = requests.filter(request => request.path.endsWith('/admin/recommendations')).at(-1)
    assert.equal(savedWrite.body.catalog_key, `saved:macos:${saved.id}`)
    const { content, ...savedMetadata } = savedWrite.body.snapshot
    assert.deepEqual(savedMetadata, { title: saved.name, category_code: 'composite', platforms: ['macos'], content_schema_version: 1 })
    assert.equal(content.kind, 'sequence')
    assert.deepEqual(content.behaviors.map(({ id, ...behavior }) => behavior), parseSequenceImport(saved.sequence).map(({ id, ...behavior }) => behavior))
    await act(async () => { view.update(recommendationToolbox(harness, client, {}, 'community')); await flush() })
    await act(async () => { harness.tick(); await flush() })
    const publicReads = () => requests.filter(request => request.method === 'GET' && request.path.startsWith('/v2/behavior-library?')).length
    const before = publicReads()
    await act(async () => { await view.root.findByProps({ 'aria-label': '设为推荐：云端序列' }).props.onClick(); await flush() })
    const cloudWrite = requests.filter(request => request.method === 'POST').at(-1)
    assert.equal(cloudWrite.path, '/v2/behavior-library/admin/items/cloud/recommendation')
    assert.deepEqual(cloudWrite.body, { app_id: 'axonkey', recommend_enabled: true })
    assert.equal(cloudWrite.conditions.ifMatch, '"behavior-library:cloud:2"')
    assert.ok(view.root.findByProps({ 'aria-label': '取消推荐：云端序列' }))
    await act(async () => { harness.tick(); await flush() })
    assert.ok(publicReads() > before)
  } finally { act(() => view.unmount()) }
})

test('recommendation failures keep a retryable control, and a 403 removes administrator controls', async () => {
  const harness = libraryHarness()
  const requests = []
  let status = 503
  const client = new RelayClient(async (method, path) => {
    requests.push({ method, path })
    if (path === '/v2/me') return { status: 200, body: { is_admin: true } }
    if (method === 'GET') return { status: 200, body: { items: [], total: 0 } }
    return { status, body: { code: 'rejected' } }
  }, session, () => {})
  let view
  await act(async () => { view = Renderer.create(recommendationToolbox(harness, client)); await flush() })
  try {
    await act(async () => { await view.root.findByProps({ 'aria-label': '设为推荐：音量控制' }).props.onClick(); await flush() })
    assert.match(text(view.toJSON()), /未完成|重试/)
    assert.equal(view.root.findByProps({ 'aria-label': '设为推荐：音量控制' }).props.disabled, false)
    status = 403
    await act(async () => { await view.root.findByProps({ 'aria-label': '设为推荐：音量控制' }).props.onClick(); await flush() })
    assert.equal(recommendationButtons(view).length, 0)
    assert.match(text(view.toJSON()), /权限已失效/)
    assert.equal(requests.filter(request => request.method === 'POST').length, 2)
  } finally { act(() => view.unmount()) }
})

test('turning debug off or changing users immediately hides recommendation controls and ignores old permission results', async () => {
  const harness = libraryHarness()
  let resolveItems
  const requests = []
  let user = 'first'
  const client = new RelayClient(async (method, path) => {
    requests.push({ method, path, user })
    if (path === '/v2/me') return { status: 200, body: { is_admin: user === 'first' } }
    if (method === 'GET') return new Promise(resolve => { resolveItems = resolve })
    assert.fail('must not write')
  }, session, () => {})
  let view
  await act(async () => { view = Renderer.create(recommendationToolbox(harness, client)); await flush() })
  try {
    user = 'second'
    await act(async () => { view.update(recommendationToolbox(harness, client, { userId: 'second' })); await flush() })
    assert.equal(recommendationButtons(view).length, 0)
    await act(async () => { resolveItems({ status: 200, body: { items: [], total: 0 } }); await flush() })
    assert.equal(recommendationButtons(view).length, 0)
    user = 'first'
    await act(async () => { view.update(recommendationToolbox(harness, client)); await flush() })
    await act(async () => { resolveItems({ status: 200, body: { items: [], total: 0 } }); await flush() })
    assert.equal(recommendationButtons(view).length, 1)
    await act(async () => { view.update(recommendationToolbox(harness, client, { debugMode: false })); await flush() })
    assert.equal(recommendationButtons(view).length, 0)
    assert.equal(requests.filter(request => request.method === 'POST').length, 0)
  } finally { act(() => view.unmount()) }
})

test('recommended list hides manual load-more button, auto-loads near scroll bottom, and stops on error', async () => {
  const harness = libraryHarness()
  const cursors = []
  let failMore = false
  const listNode = { clientHeight: 240, scrollHeight: 200, scrollTop: 0 }
  const client = new RelayClient(async (_, path) => {
    const cursor = new URL('https://relay.invalid' + path).searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    if (cursor && failMore) throw new Error('offline')
    if (!cursor) return { status: 200, body: { items: [publicItem('p1', '推荐一')], next_cursor: 'cursor-2' } }
    if (cursor === 'cursor-2') {
      listNode.scrollHeight = 620
      return { status: 200, body: { items: [publicItem('p2', '推荐二')], next_cursor: 'cursor-3' } }
    }
    listNode.scrollHeight = 960
    return { status: 200, body: { items: [publicItem('p3', '推荐三')], next_cursor: 'cursor-4' } }
  }, null, () => {})
  let view
  await act(async () => {
    view = Renderer.create(recommendationToolbox(harness, client, { debugMode: false, userId: null }, 'recommended'), {
      createNodeMock: element => (element.props.className === 'workflow-toolbox-list' ? listNode : null),
    })
  })
  try {
    await act(async () => { harness.tick(); await flush() })
    await act(async () => { await flush() })
    assert.deepEqual(cursors, ['', 'cursor-2'], 'tall container auto-fills next page until scrollable')
    assert.equal(button(view, '加载更多'), undefined)
    assert.ok(button(view, '推荐一'))
    assert.ok(button(view, '推荐二'))

    const list = view.root.findByProps({ className: 'workflow-toolbox-list' })
    listNode.scrollTop = 200
    await act(async () => { list.props.onScroll({ currentTarget: listNode }); await flush() })
    assert.deepEqual(cursors, ['', 'cursor-2'])

    listNode.scrollTop = 320
    await act(async () => { list.props.onScroll({ currentTarget: listNode }); await flush() })
    assert.deepEqual(cursors, ['', 'cursor-2', 'cursor-3'])
    assert.ok(button(view, '推荐三'))

    failMore = true
    listNode.scrollTop = 680
    await act(async () => { list.props.onScroll({ currentTarget: listNode }); await flush() })
    assert.deepEqual(cursors, ['', 'cursor-2', 'cursor-3', 'cursor-4'])
    assert.match(text(view.toJSON()), /加载更多失败/)
    await act(async () => { list.props.onScroll({ currentTarget: listNode }); await flush() })
    assert.deepEqual(cursors, ['', 'cursor-2', 'cursor-3', 'cursor-4'])
  } finally { act(() => view.unmount()) }
})
