import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appStorage,
  bootstrapAppStorage,
  flushAppStorage,
  resetAppStorageForTests,
  storageMigrationMarkerKey,
} from '../src/appStorage.ts'

function createMapStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  }
}

test('native bootstrap migrates legacy localStorage non-destructively and skips re-importing after marker is written', async t => {
  t.after(() => resetAppStorageForTests())
  const disk = new Map([['axonkey.settings.v1', '{"enabled":true,"mouseEdgeWidth":5}']])
  const legacy = createMapStorage({
    'axonkey.settings.v1': '{"enabled":false}',
    'axonkey.mapping-profiles.v2': '{"version":2,"profiles":[]}',
    'axonkey.saved-sequences.v1': '[{"id":"1","name":"清空"}]',
    'axonkey.device-model-catalog.cache.v2': '{"items":[]}',
  })

  const invokeMock = async (cmd, args) => {
    if (cmd === 'load_app_config') return Object.fromEntries(disk.entries())
    if (cmd === 'update_app_config') {
      for (const [key, value] of Object.entries(args.updates)) {
        if (value === null) disk.delete(key)
        else disk.set(key, value)
      }
      return
    }
    assert.fail(`Unexpected command: ${cmd}`)
  }

  await bootstrapAppStorage({
    forceNative: true,
    legacyStorage: legacy,
    invokeFn: invokeMock,
  })

  // Existing native disk entry wins over stale WebView entry; missing keys migrate to disk with marker.
  assert.equal(appStorage.getItem('axonkey.settings.v1'), '{"enabled":true,"mouseEdgeWidth":5}')
  assert.equal(appStorage.getItem('axonkey.mapping-profiles.v2'), '{"version":2,"profiles":[]}')
  assert.equal(appStorage.getItem('axonkey.saved-sequences.v1'), '[{"id":"1","name":"清空"}]')
  assert.equal(disk.get('axonkey.mapping-profiles.v2'), '{"version":2,"profiles":[]}')
  assert.equal(disk.get('axonkey.saved-sequences.v1'), '[{"id":"1","name":"清空"}]')
  assert.equal(disk.get(storageMigrationMarkerKey), '1')

  // Legacy WebView localStorage is preserved intact during automatic migration for rollback safety.
  assert.equal(legacy.map.get('axonkey.mapping-profiles.v2'), '{"version":2,"profiles":[]}')
  assert.equal(legacy.map.get('axonkey.saved-sequences.v1'), '[{"id":"1","name":"清空"}]')
  assert.equal(legacy.map.has('axonkey.device-model-catalog.cache.v2'), true)

  // Subsequent writes coalesce and explicit removeItem deletes from disk; next boot never re-imports legacy keys.
  appStorage.setItem('axonkey.ui-state.v1', '{"activePage":"mapping"}')
  appStorage.setItem('axonkey.ui-state.v1', '{"activePage":"settings"}')
  appStorage.removeItem('axonkey.saved-sequences.v1')
  await flushAppStorage()

  assert.equal(disk.get('axonkey.ui-state.v1'), '{"activePage":"settings"}')
  assert.equal(disk.has('axonkey.saved-sequences.v1'), false)

  // Simulate restarting the upgraded app while legacy localStorage still holds another untouched key.
  resetAppStorageForTests()
  legacy.map.set('axonkey.saved-sequences.v1', '[{"id":"stale","name":"旧残留"}]')
  await bootstrapAppStorage({
    forceNative: true,
    legacyStorage: legacy,
    invokeFn: invokeMock,
  })
  assert.equal(appStorage.getItem('axonkey.saved-sequences.v1'), null)
  assert.equal(appStorage.getItem('axonkey.ui-state.v1'), '{"activePage":"settings"}')
})

test('transient disk write failure during upgrade migration preserves all legacy data and retries cleanly', async t => {
  t.after(() => resetAppStorageForTests())
  const disk = new Map()
  const legacy = createMapStorage({
    'axonkey.mapping-profiles.v2': '{"version":2,"profiles":[{"id":"mouse:work","name":"办公"}]}',
    'axonkey.saved-sequences.v1': '[{"id":"seq-1","name":"常用提示词"}]',
  })
  let failWrite = true

  await bootstrapAppStorage({
    forceNative: true,
    legacyStorage: legacy,
    invokeFn: async (cmd, args) => {
      if (cmd === 'load_app_config') return Object.fromEntries(disk.entries())
      if (cmd === 'update_app_config') {
        if (failWrite) throw new Error('disk temporarily full')
        for (const [key, value] of Object.entries(args.updates)) {
          if (value === null) disk.delete(key)
          else disk.set(key, value)
        }
        return
      }
      assert.fail(`Unexpected command: ${cmd}`)
    },
  })

  // Even when the initial disk write failed, neither memory nor legacy localStorage loses any user config!
  assert.equal(
    appStorage.getItem('axonkey.mapping-profiles.v2'),
    '{"version":2,"profiles":[{"id":"mouse:work","name":"办公"}]}',
  )
  assert.equal(
    legacy.map.get('axonkey.mapping-profiles.v2'),
    '{"version":2,"profiles":[{"id":"mouse:work","name":"办公"}]}',
  )
  assert.equal(disk.has(storageMigrationMarkerKey), false)

  // Once disk recovers, flushing persists both the queued migration and any new edits.
  failWrite = false
  await flushAppStorage()
  assert.equal(
    disk.get('axonkey.mapping-profiles.v2'),
    '{"version":2,"profiles":[{"id":"mouse:work","name":"办公"}]}',
  )
  assert.equal(disk.get('axonkey.saved-sequences.v1'), '[{"id":"seq-1","name":"常用提示词"}]')
  assert.equal(disk.get(storageMigrationMarkerKey), '1')

  // Subsequent failed runtime writes reject explicit flushAppStorage() and re-queue without losing newer edits.
  failWrite = true
  appStorage.setItem('axonkey.audio-settings.v2', '{"gain":6}')
  await assert.rejects(() => flushAppStorage(), /disk temporarily full/)
  appStorage.setItem('axonkey.ui-state.v1', '{"activePage":"settings"}')

  failWrite = false
  await flushAppStorage()
  assert.equal(disk.get('axonkey.audio-settings.v2'), '{"gain":6}')
  assert.equal(disk.get('axonkey.ui-state.v1'), '{"activePage":"settings"}')
})

test('non-native mode delegates directly to fallback localStorage', t => {
  const prevWindow = globalThis.window
  t.after(() => {
    globalThis.window = prevWindow
    resetAppStorageForTests()
  })
  resetAppStorageForTests()
  const fallback = createMapStorage()
  globalThis.window = { localStorage: fallback }

  appStorage.setItem('axonkey.settings.v1', '{"mouseEnabled":true}')
  assert.equal(appStorage.getItem('axonkey.settings.v1'), '{"mouseEnabled":true}')
  assert.equal(fallback.map.get('axonkey.settings.v1'), '{"mouseEnabled":true}')
  appStorage.removeItem('axonkey.settings.v1')
  assert.equal(appStorage.getItem('axonkey.settings.v1'), null)
})
