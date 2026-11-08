import assert from 'node:assert/strict'
import test from 'node:test'
import { RelayClient, RelayError } from '../src/cloud/relayClient.ts'
import { uploadCloud, readCloud, fingerprint, SyncConflict } from '../src/cloud/cloudSync.ts'
import { registerHooks } from 'node:module'
import { createDataBackup } from '../src/dataBackup.ts'
import { createBehavior, createDefaultBehaviorMap, createEmptyBehaviorMap } from '../src/behaviorModel.ts'
import { createDefaultDeviceProfiles } from '../src/deviceProfiles.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})
const { createCloudSnapshot, prepareCloudRestore } = await import('../src/cloud/cloudData.ts')
assets.deregister()

const source = {
  source_platform: 'macos',
  source_installation_id: '00000000-0000-4000-8000-000000000001',
  source_computer_name: null,
}
const stored = new Map()
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }
const session = () => ({
  access_token: 'access',
  refresh_token: 'refresh',
  expires_at: Date.now() / 1000 + 900,
  user: { id: 'test-user', email: 'user@example.invalid', phone: null },
})

test('a logged-out client makes no startup requests and rejects cloud access locally', async () => {
  const calls = []
  const client = new RelayClient(
    async (...args) => {
      calls.push(args)
    },
    null,
    () => {},
  )
  assert.deepEqual(calls, [])
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /请先登录/)
  assert.deepEqual(calls, [])
})

test('login uses the app domain and persists credentials without touching configurations', async () => {
  const calls = [],
    saved = []
  const client = new RelayClient(
    async (method, path, body) => {
      calls.push({ method, path, body })
      return { status: 200, body: path.endsWith('/code') ? { retry_after: 60 } : session() }
    },
    null,
    value => saved.push(value),
  )
  await client.sendCode('sms', ' 13800000000 ', 'one-time-cap-token')
  await client.login('email', ' user@example.invalid ', '123456')
  assert.deepEqual(
    calls.map(call => call.path),
    ['/auth/v2/code', '/auth/v2/verify'],
  )
  assert.equal(calls[0].body.captcha_token, 'one-time-cap-token')
  assert.equal(calls[0].body.phone, '13800000000')
  assert.equal(calls[1].body.email, 'user@example.invalid')
  assert.equal(calls[1].body.app_id, 'axonkey')
  assert.equal(saved[0].user.id, 'test-user')
})

test('refresh persists its retry ID before sending and reuses it after a timeout and restart', async () => {
  let saved = { ...session(), expires_at: 0 }
  let firstRequest
  const client = new RelayClient(
    async (_method, path, body) => {
      assert.equal(path, '/auth/refresh')
      assert.equal(saved.requestId, body.request_id)
      firstRequest = body
      throw new Error('network timeout')
    },
    saved,
    value => {
      saved = structuredClone(value)
    },
  )
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /timeout/)
  const restarted = new RelayClient(
    async (_method, path, body) => {
      if (path === '/auth/refresh') {
        assert.deepEqual(body, firstRequest)
        return { status: 200, body: { ...session(), refresh_token: 'rotated' } }
      }
      return { status: 200, body: { ok: true } }
    },
    saved,
    value => {
      saved = structuredClone(value)
    },
  )
  assert.deepEqual(await restarted.request('GET', '/app-settings/axonkey'), { ok: true })
  assert.equal(saved.refresh_token, 'rotated')
  assert.equal(saved.requestId, undefined)
})

test('new authentication never falls back to an unprotected legacy endpoint', async () => {
  const calls = []
  const client = new RelayClient(
    async (_method, path) => {
      calls.push(path)
      return { status: 404, body: { code: 'not_found', detail: 'upgrade required' } }
    },
    null,
    () => {},
  )
  await assert.rejects(client.sendCode('email', 'user@example.invalid', 'one-time-cap-token'), RelayError)
  assert.deepEqual(calls, ['/auth/v2/code'])
})

test('captcha discovery uses an unauthenticated request without refreshing existing sessions', async () => {
  const calls = []
  const config = { enabled: true, api_endpoint: 'https://cap.example/site/', assets_url: 'https://cap.example/assets/' }
  const client = new RelayClient(
    async (...args) => {
      calls.push(args)
      return { status: 200, body: config }
    },
    { ...session(), expires_at: 0 },
    () => {},
  )
  assert.deepEqual(await client.captcha(), config)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['GET', '/auth/captcha', undefined, undefined, undefined])
})

test('concurrent requests share one refresh, and service outages keep credentials', async () => {
  let refreshes = 0
  const client = new RelayClient(
    async (_method, path) => {
      if (path === '/auth/refresh') {
        refreshes++
        await new Promise(resolve => setTimeout(resolve, 10))
        return { status: 200, body: session() }
      }
      return { status: 503, body: { code: 'service_unavailable', detail: '服务暂不可用' } }
    },
    { ...session(), expires_at: 0 },
    () => {},
  )
  const results = await Promise.allSettled([client.request('GET', '/one'), client.request('GET', '/two')])
  assert.equal(refreshes, 1)
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(client.session.refresh_token, 'refresh')
})

test('a failed retry-ID save prevents refresh from consuming credentials', async () => {
  let calls = 0
  const initial = { ...session(), expires_at: 0 }
  const client = new RelayClient(
    async () => {
      calls++
      return { status: 200, body: session() }
    },
    initial,
    async () => {
      throw new Error('disk full')
    },
  )
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /disk full/)
  assert.equal(calls, 0)
  assert.equal(client.session, initial)
})

test('malformed successful auth responses never become an active login', async () => {
  const client = new RelayClient(
    async () => ({ status: 200, body: { access_token: 'incomplete' } }),
    null,
    () => {},
  )
  await assert.rejects(client.login('email', 'user@example.invalid', '123456'), /响应无效/)
  assert.equal(client.session, null)
})

test('invalid sessions clear login, while business refusals keep the session', async () => {
  for (const status of [401, 403, 429]) {
    const client = new RelayClient(
      async () => ({ status, body: { code: 'rejected' } }),
      session(),
      () => {},
    )
    await assert.rejects(client.request('GET', '/one'), RelayError)
    assert.equal(client.session === null, status === 401)
  }
  const client = new RelayClient(
    async () => {
      throw new Error('offline')
    },
    session(),
    () => {},
  )
  await assert.rejects(client.logout(), /offline/)
  assert.equal(client.session, null)
})

function cloudServer({
  documents = [],
  settings = null,
  models = [{ id: 'model', code: 'rc003' }],
  failWrite = 0,
} = {}) {
  const writes = []
  const client = new RelayClient(
    async (method, path, body, _token, conditions) => {
      const etag = '"opaque-version"'
      if (method === 'GET') {
        if (path.startsWith('/v2/device-models')) return { status: 200, body: { items: models } }
        if (path.startsWith('/v2/device-configs?'))
          return { status: 200, body: { items: documents, total: documents.length } }
        if (path.startsWith('/v2/device-configs/'))
          return { status: 200, etag, body: documents.find(doc => path.endsWith('/' + doc.id)) }
        return settings ? { status: 200, etag, body: settings } : { status: 404, body: { code: 'not_found' } }
      }
      assert.equal(body.revision, undefined)
      if (method === 'PUT')
        assert.deepEqual(conditions, path.endsWith('/axonkey') && !settings ? { ifNoneMatch: '*' } : { ifMatch: etag })
      writes.push({ method, path, body, conditions })
      if (writes.length === failWrite) throw new Error('offline')
      const previous = path.endsWith('/axonkey') ? settings : documents.find(doc => path.endsWith('/' + doc.id))
      return { status: 200, etag, body: { ...body, id: 'remote', revision: (previous?.revision ?? 0) + 1 } }
    },
    session(),
    () => {},
  )
  return { client, writes }
}
const snapshot = () => ({
  source,
  documents: [{ key: 'local-instance', kind: 'rc003', config: { name: 'Local' } }],
  settings: { enabled: true },
})
const remote = () => ({
  ...source,
  id: 'remote',
  model_id: 'model',
  instance_key: 'local-instance',
  schema_version: 1,
  revision: 2,
  config: { name: 'Cloud' },
})

test('first upload creates documents and settings with conditional creation and remembers successes', async () => {
  const server = cloudServer()
  let memory = {}
  await uploadCloud(server.client, snapshot(), memory, value => {
    memory = value
  })
  assert.equal(server.writes.length, 2)
  assert.ok(server.writes.every(write => write.body.revision === undefined))
  assert.equal(memory['rc003/local-instance'].revision, 1)
  assert.equal(memory.settings.revision, 1)
})

test('first upload fills empty or compatible partial settings without an unnecessary conflict', async () => {
  for (const settings of [{}, { enabled: true }, { enabled: true, sidebarCollapsed: false }]) {
    const server = cloudServer({ settings: { schema_version: 1, revision: 3, settings } })
    const data = snapshot()
    data.settings = { enabled: true, mouseEnabled: true }
    await uploadCloud(server.client, { ...data, source }, {}, () => {})
    const written = server.writes.find(write => write.path === '/v2/app-settings/axonkey')
    assert.equal(written.body.revision, undefined)
    assert.deepEqual(written.body.settings, { ...settings, ...data.settings })
  }
})

test('a different first cloud value requests a choice, while a later revision change remains protected', async () => {
  const server = cloudServer({ settings: { schema_version: 1, revision: 3, settings: { enabled: false } } })
  for (const [memory, initial] of [
    [{}, true],
    [{ settings: { revision: 2 } }, false],
  ]) {
    await assert.rejects(
      uploadCloud(server.client, snapshot(), memory, () => {}),
      error => error instanceof SyncConflict && error.initial === initial,
    )
    assert.equal(server.writes.length, 0)
  }
})

test('unknown or changed cloud data conflicts before any writes, explicit overwrite uses fetched revisions', async () => {
  for (const memory of [{}, { 'rc003/local-instance': { revision: 1, content: '{}' } }]) {
    const server = cloudServer({ documents: [remote()] })
    await assert.rejects(
      uploadCloud(server.client, snapshot(), memory, () => {}),
      SyncConflict,
    )
    assert.equal(server.writes.length, 0)
    await uploadCloud(server.client, snapshot(), memory, () => {}, true)
    assert.equal(server.writes[0].body.revision, undefined)
    assert.equal(server.writes[0].conditions.ifMatch, '"opaque-version"')
  }
})

test('known revisions allow local edits; partial failure retains only successful revisions', async () => {
  const server = cloudServer({ documents: [remote()], failWrite: 2 })
  let memory = { 'rc003/local-instance': { revision: 2, content: '{}' } }
  await assert.rejects(
    uploadCloud(server.client, snapshot(), memory, value => {
      memory = value
    }),
    /offline/,
  )
  assert.equal(memory['rc003/local-instance'].revision, 3)
  assert.equal(memory.settings, undefined)
})

test('equal JSON ignores key order and does not write; remotely deleted known data conflicts', async () => {
  const data = snapshot()
  const server = cloudServer({
    documents: [{ ...remote(), config: data.documents[0].config }],
    settings: { schema_version: 1, revision: 4, settings: data.settings },
  })
  await uploadCloud(server.client, { ...data, source }, {}, () => {})
  assert.equal(server.writes.length, 0)
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }))
  await assert.rejects(
    uploadCloud(cloudServer().client, data, { settings: { revision: 4, content: '{}' } }, () => {}),
    SyncConflict,
  )
})

test('missing model and newer schemas stop upload without partial writes', async () => {
  const server = cloudServer({ models: [] })
  await assert.rejects(
    uploadCloud(server.client, snapshot(), {}, () => {}),
    /型号/,
  )
  assert.equal(server.writes.length, 0)
  await assert.rejects(readCloud(cloudServer({ documents: [{ ...remote(), schema_version: 3 }] }).client), /版本较新/)
})

function initialBackup(behaviors = createDefaultBehaviorMap()) {
  return createDataBackup({ ...sampleData(), ...createDefaultDeviceProfiles(behaviors), behaviors }, '1.8.5')
}

test('new users and empty profiles upload preferences without creating legacy device documents', async () => {
  for (const behaviors of [createDefaultBehaviorMap(), createEmptyBehaviorMap()]) {
    const data = createCloudSnapshot(initialBackup(behaviors), [])
    assert.deepEqual(data.documents, [])
    const server = cloudServer({ models: [] })
    await uploadCloud(server.client, { ...data, source }, {}, () => {})
    assert.deepEqual(
      server.writes.map(write => write.path),
      ['/v2/app-settings/axonkey'],
    )
    assert.equal(server.writes[0].body.settings.savedBehaviors.length, 1)
  }
})

test('only configured legacy devices upload, including disabled and inactive mappings', async () => {
  const backup = initialBackup()
  const mouse = backup.profiles.find(profile => profile.deviceId === 'mouse')
  backup.profiles.push({ ...structuredClone(mouse), id: 'mouse:custom', name: '自定义' })
  backup.profiles.at(-1).keys['top.up'].longPress = [
    createBehavior({ type: 'disabled', id: 'disable', enabled: false }),
  ]
  backup.settings.mouseEnabled = false
  const data = createCloudSnapshot(backup, [])
  assert.deepEqual(
    data.documents.map(doc => doc.key),
    ['system-mouse'],
  )
  assert.equal(data.documents[0].config.enabled, false)
  assert.equal(data.documents[0].config.profiles.length, 2)
  assert.equal(data.documents[0].config.activeProfileId, mouse.id)
  const server = cloudServer({ models: [{ id: 'mouse', code: 'mouse' }] })
  await uploadCloud(server.client, { ...data, source }, {}, () => {})
  assert.equal(server.writes[0].body.instance_key, 'system-mouse')
})

test('application mappings upload even when their profiles have no actions', () => {
  const backup = initialBackup(createEmptyBehaviorMap())
  const mouse = backup.profiles.find(profile => profile.deviceId === 'mouse')
  mouse.applicationIds = ['windows:c:\\apps\\editor.exe']
  backup.applicationProfileSwitching = { mouse: false }
  const legacy = createCloudSnapshot(backup, []).documents.find(item => item.kind === 'mouse')
  assert.equal(legacy.config.appProfileSwitching, false)
  assert.deepEqual(legacy.config.profiles.find(profile => profile.id === mouse.id).applicationIds, ['windows:c:\\apps\\editor.exe'])

  const instance = {
    id: 'remote-with-app',
    kind: 'rc003',
    name: '应用遥控器',
    binding: null,
    enabled: true,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: '默认配置', behaviors: {} }],
    appProfileSwitching: true,
    applicationProfiles: [{ application: { id: 'editor', name: 'Editor', path: 'C:\\Editor.exe' }, profileId: 'default' }],
  }
  const managed = createCloudSnapshot(initialBackup(createEmptyBehaviorMap()), [instance]).documents.find(item => item.key === instance.id)
  assert.deepEqual(managed.config.applicationProfiles, instance.applicationProfiles)
})

test('legacy mouse cloud documents retain application mappings and switch state', () => {
  const backup = createDataBackup(sampleData(), '1.8.20')
  const mouseProfiles = backup.profiles.filter(profile => profile.deviceId === 'mouse')
  mouseProfiles[0].applicationIds = ['windows:c:\\apps\\editor.exe']
  backup.applicationProfileSwitching = { mouse: false }
  const document = createCloudSnapshot(backup, []).documents.find(item => item.kind === 'mouse')
  assert.deepEqual(document.config.profiles.find(profile => profile.id === mouseProfiles[0].id).applicationIds, ['windows:c:\\apps\\editor.exe'])
  assert.equal(document.config.appProfileSwitching, false)
})

test('clearing a previously synced mapping updates its cloud document without creating empty devices', async () => {
  const behaviors = createEmptyBehaviorMap()
  behaviors.power.click = [createBehavior({ type: 'key', key: 'Enter', id: 'custom' })]
  const configured = createCloudSnapshot(initialBackup(behaviors), [])
  const document = { ...remote(), instance_key: 'legacy-rc003', config: configured.documents[0].config }
  const memory = { 'rc003/legacy-rc003': { revision: 2 } }
  const data = createCloudSnapshot(initialBackup(createEmptyBehaviorMap()), [], memory)
  assert.deepEqual(
    data.documents.map(doc => doc.key),
    ['legacy-rc003'],
  )
  assert.deepEqual(
    createCloudSnapshot(initialBackup(), [], memory).documents.map(doc => doc.key),
    ['legacy-rc003'],
  )
  const server = cloudServer({ documents: [document] })
  await uploadCloud(server.client, { ...data, source }, memory, () => {})
  assert.equal(server.writes[0].method, 'PUT')
  assert.equal(server.writes[0].path, '/v2/device-configs/remote')
  assert.ok(
    Object.values(server.writes[0].body.config.profiles[0].behaviors).every(triggers =>
      Object.values(triggers).every(actions => actions.length === 0),
    ),
  )
})

test('selective restore preserves bindings and active profiles, skips repeats and keeps edited copies', () => {
  stored.clear()
  const backup = createDataBackup(sampleData(), '1.7.15')
  const behaviors = {
    power: { click: [createBehavior({ type: 'key', key: 'Enter', id: 'action' })], doubleClick: [], longPress: [] },
  }
  const instance = {
    id: 'instance',
    kind: 'rc003',
    name: 'Living room',
    enabled: true,
    binding: 'physical-id',
    audioGainDb: 6,
    activeProfileId: 'default',
    appProfileSwitching: true,
    applicationProfiles: [{ application: { id: 'editor', name: 'Editor', path: 'C:\\Editor.exe' }, profileId: 'default' }],
    profiles: [{ id: 'default', name: 'Default', behaviors }],
  }
  const data = createCloudSnapshot(backup, [instance])
  for (const key of ['binding', 'bindingQuality', 'quarborTarget'])
    assert.equal(data.documents[0].config[key], undefined)
  const document = {
    ...remote(),
    config: { ...data.documents[0].config, profiles: [{ ...instance.profiles[0], app_version: '1.7.15' }] },
    source_platform: 'windows',
  }
  const cloud = {
    models: [{ id: 'model', code: 'rc003' }],
    documents: [document],
    settings: { schema_version: 1, revision: 1, settings: { ...data.settings, enabled: false } },
  }
  const selection = {
    devices: [{ documentId: document.id, profileIds: ['default'], targetId: instance.id }],
    settings: false,
    savedBehaviors: false,
  }
  const restored = prepareCloudRestore(cloud, backup, [instance], selection)
  assert.equal(restored.instances[0].binding, 'physical-id')
  assert.equal(restored.instances[0].activeProfileId, 'default')
  assert.equal(restored.instances[0].applicationProfiles[0].profileId, 'default')
  assert.equal(restored.instances[0].profiles.length, 2)
  assert.equal(restored.backup.settings.enabled, backup.settings.enabled)
  assert.equal(restored.instances[0].profiles[1].app_version, '1.7.15')
  stored.set('axonkey.cloud-profile-metadata.v1', JSON.stringify(restored.metadata))
  assert.equal(prepareCloudRestore(cloud, backup, restored.instances, selection).instances[0].profiles.length, 2)
  restored.instances[0].profiles[1].behaviors.power.click[0].key = 'Space'
  assert.equal(prepareCloudRestore(cloud, backup, restored.instances, selection).instances[0].profiles.length, 3)
  const created = prepareCloudRestore(cloud, backup, [], {
    ...selection,
    devices: [{ ...selection.devices[0], targetId: 'new:local-copy' }],
  })
  assert.equal(created.instances[0].id, 'local-copy')
  assert.equal(created.instances[0].binding, null)
  assert.equal(created.instances[0].enabled, false)
  assert.equal(created.instances[0].profiles.length, 1)
  assert.equal(created.instances[0].applicationProfiles[0].profileId, created.instances[0].profiles[0].id)
  assert.notEqual(created.instances[0].applicationProfiles[0].profileId, 'default')
  assert.throws(() => prepareCloudRestore(cloud, backup, [{ ...instance, kind: 'cmiotA15' }], selection), /同型号/)
  cloud.documents[0].config.profiles[0].behaviors.unknownInput = { click: [], doubleClick: [], longPress: [] }
  assert.throws(
    () =>
      prepareCloudRestore(cloud, backup, [], {
        ...selection,
        devices: [{ ...selection.devices[0], targetId: 'new:copy' }],
      }),
    /不支持/,
  )
})

test('request diagnostics correlate server IDs and refresh retries without logging payloads or remote detail', async t => {
  const logs = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        assert.equal(command, 'plugin:log|log')
        if (args.message.startsWith('[relay] ')) logs.push(JSON.parse(args.message.slice(8)))
      },
    },
  }
  t.after(() => {
    globalThis.window = previousWindow
  })
  let refreshCalls = 0
  let status = 409
  const client = new RelayClient(
    async (_method, path) => {
      if (path === '/auth/refresh') {
        refreshCalls++
        return refreshCalls === 1
          ? {
              status: 503,
              requestId: 'server-refresh-failed',
              body: { code: 'service_unavailable', detail: 'SECRET_REMOTE_DETAIL' },
            }
          : {
              status: 200,
              requestId: 'server-refresh-success',
              body: { ...session(), access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH' },
            }
      }
      return {
        status,
        requestId: 'server-document',
        body: { code: status === 409 ? 'revision_conflict' : 'session_invalid', detail: 'SECRET_REMOTE_DETAIL' },
      }
    },
    { ...session(), expires_at: 0, refresh_token: 'SECRET_OLD_REFRESH' },
    () => {},
  )
  await assert.rejects(client.request('PUT', '/app-settings/axonkey', { secret: 'SECRET_CONFIGURATION' }))
  await assert.rejects(client.request('PUT', '/app-settings/axonkey', { secret: 'SECRET_CONFIGURATION' }))
  const refresh = logs.filter(log => log.event === 'session.refresh.start')
  assert.deepEqual(
    refresh.map(log => log.retry),
    [false, true],
  )
  assert.equal(refresh[0].refresh_request_id, refresh[1].refresh_request_id)
  assert.ok(
    logs.some(
      log => log.event === 'session.refresh.failed' && log.status === 503 && log.code === 'service_unavailable',
    ),
  )
  assert.ok(
    logs.some(
      log =>
        log.event === 'request.complete' &&
        log.server_request_id === 'server-document' &&
        log.status === 409 &&
        typeof log.duration_ms === 'number',
    ),
  )
  status = 401
  await assert.rejects(client.request('GET', '/app-settings/axonkey'))
  assert.equal(client.session, null)
  assert.ok(logs.some(log => log.event === 'session.invalidated'))
  assert.ok(!JSON.stringify(logs).includes('SECRET_'))
})

test('log write failures do not interrupt account requests', async t => {
  const previousWindow = globalThis.window
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw new Error('log disk unavailable')
      },
    },
  }
  t.after(() => {
    globalThis.window = previousWindow
  })
  const client = new RelayClient(
    async () => ({ status: 200, body: session() }),
    null,
    () => {},
  )
  await client.login('email', 'user@example.invalid', '123456')
  assert.equal(client.session.user.id, 'test-user')
})

test('pagination reads all devices and preserves opaque ETags', async () => {
  const offsets = []
  const client = new RelayClient(
    async (_method, path) => {
      if (path.includes('device-models')) return { status: 200, body: { items: [] } }
      if (path.includes('device-configs?')) {
        const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'))
        offsets.push(offset)
        return {
          status: 200,
          body: {
            total: 101,
            items: Array.from({ length: offset ? 1 : 100 }, (_, n) => ({ ...remote(), id: String(offset + n) })),
          },
        }
      }
      return { status: 404, body: {} }
    },
    session(),
    () => {},
  )
  assert.equal((await readCloud(client)).documents.length, 101)
  assert.deepEqual(offsets, [0, 100])
})

test('upload never updates another installation even with an identical instance key', async () => {
  const server = cloudServer({ documents: [{ ...remote(), source_installation_id: 'other-computer' }] })
  await uploadCloud(server.client, snapshot(), {}, () => {})
  assert.equal(server.writes[0].method, 'POST')
  assert.equal(server.writes[0].body.schema_version, 2)
  assert.equal(server.writes[0].body.source_platform, 'macos')
})

test('profile versions survive unchanged uploads and restored origins survive local editing', async () => {
  stored.clear()
  const { annotateSnapshot, profileContent } = await import('../src/cloud/cloudMetadata.ts')
  const profile = { id: 'profile', name: 'Read', behaviors: {} }
  const raw = { documents: [{ key: 'device', kind: 'rc003', config: { profiles: [profile] } }], settings: {} }
  const first = annotateSnapshot(raw, source, '1.8.5', true)
  assert.equal(first.documents[0].config.profiles[0].app_version, null)
  assert.notEqual(first.documents[0].key, 'device')
  profile.behaviors = { power: {} }
  assert.equal(annotateSnapshot(raw, source, '1.8.5').documents[0].config.profiles[0].app_version, '1.8.5')
  assert.equal(annotateSnapshot(raw, source, '1.9.0').documents[0].config.profiles[0].app_version, '1.8.5')
  const origin = {
    device_config_id: 'cloud',
    profile_id: 'old',
    revision: 1,
    source_platform: 'windows',
    source_computer_name: 'Office',
    app_version: '1.7.0',
  }
  stored.set(
    'axonkey.cloud-profile-metadata.v1',
    JSON.stringify({
      'device/profile': { content: profileContent(profile), app_version: '1.7.0', restored_from: origin },
    }),
  )
  const restored = annotateSnapshot(raw, source, '1.9.0').documents[0].config.profiles[0]
  assert.equal(restored.app_version, '1.7.0')
  profile.name = 'Updated'
  const edited = annotateSnapshot(raw, source, '1.9.0').documents[0].config.profiles[0]
  assert.equal(edited.app_version, '1.9.0')
  assert.deepEqual(edited.restored_from, origin)
})

test('empty managed devices do not upload until configured, but previously synced ones can be cleared', () => {
  const instance = {
    id: 'empty',
    kind: 'rc003',
    name: 'Empty',
    binding: null,
    enabled: false,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Default', behaviors: {} }],
  }
  assert.equal(createCloudSnapshot(initialBackup(), [instance]).documents.length, 0)
  assert.equal(createCloudSnapshot(initialBackup(), [instance], { 'rc003/empty': { revision: 1 } }).documents.length, 1)
})

test('mouse restore appends only the selected profile without switching or replacing settings', () => {
  stored.clear()
  const backup = createDataBackup(sampleData(), '1.8.5')
  const doc = createCloudSnapshot(backup, []).documents.find(item => item.kind === 'mouse')
  const cloud = {
    models: [{ id: 'mouse', code: 'mouse' }],
    documents: [{ ...remote(), model_id: 'mouse', config: doc.config }],
    settings: null,
  }
  const id = doc.config.profiles[0].id
  const result = prepareCloudRestore(cloud, backup, [], {
    devices: [{ documentId: 'remote', profileIds: [id], targetId: 'legacy:mouse' }],
    settings: false,
    savedBehaviors: false,
  })
  assert.equal(result.instances.length, 0)
  assert.equal(result.backup.profiles.length, backup.profiles.length + 1)
  assert.deepEqual(result.backup.activeProfileIds, backup.activeProfileIds)
})

test('mouse application mappings restore with the selected profile and switch state', () => {
  const backup = initialBackup(createEmptyBehaviorMap())
  const mouse = backup.profiles.find(profile => profile.deviceId === 'mouse')
  mouse.applicationIds = ['windows:c:\\apps\\editor.exe']
  backup.applicationProfileSwitching = { mouse: false }
  const doc = createCloudSnapshot(backup, []).documents.find(item => item.kind === 'mouse')
  const cloud = {
    models: [{ id: 'mouse', code: 'mouse' }],
    documents: [{ ...remote(), model_id: 'mouse', config: doc.config }],
    settings: null,
  }
  const result = prepareCloudRestore(cloud, backup, [], {
    devices: [{ documentId: 'remote', profileIds: [mouse.id], targetId: 'legacy:mouse' }],
    settings: false,
    savedBehaviors: false,
  })
  const restored = result.backup.profiles.at(-1)
  assert.deepEqual(restored.applicationIds, mouse.applicationIds)
  assert.deepEqual(result.backup.applicationProfileSwitching, { mouse: false })
})
