import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appStorage,
  bootstrapAppStorage,
  flushAppStorage,
  resetAppStorageForTests,
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

test('native bootstrap migrates legacy localStorage config to app-config.json and purges WebView entries', async t => {
  t.after(() => resetAppStorageForTests())
  const disk = new Map([['axonkey.settings.v1', '{"enabled":true,"mouseEdgeWidth":5}']])
  const legacy = createMapStorage({
    'axonkey.settings.v1': '{"enabled":false}',
    'axonkey.mapping-profiles.v2': '{"version":2,"profiles":[]}',
    'axonkey.saved-sequences.v1': '[{"id":"1","name":"清空"}]',
    'axonkey.device-model-catalog.cache.v2': '{"items":[]}',
  })
  const calls = []

  await bootstrapAppStorage({
    forceNative: true,
    legacyStorage: legacy,
    invokeFn: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'load_app_config') return Object.fromEntries(disk.entries())
      if (cmd === 'update_app_config') {
        for (const [key, value] of Object.entries(args.updates)) {
          if (value === null) disk.delete(key)
          else disk.set(key, value)
        }
        return
      }
      assert.fail(`Unexpected command: ${cmd}`)
    },
  })

  // Existing native disk entry wins over stale WebView entry; missing keys migrate to disk.
  assert.equal(appStorage.getItem('axonkey.settings.v1'), '{"enabled":true,"mouseEdgeWidth":5}')
  assert.equal(appStorage.getItem('axonkey.mapping-profiles.v2'), '{"version":2,"profiles":[]}')
  assert.equal(appStorage.getItem('axonkey.saved-sequences.v1'), '[{"id":"1","name":"清空"}]')
  assert.equal(disk.get('axonkey.mapping-profiles.v2'), '{"version":2,"profiles":[]}')
  assert.equal(disk.get('axonkey.saved-sequences.v1'), '[{"id":"1","name":"清空"}]')

  // Migrated config keys are purged from WebView localStorage; unrelated cache keys stay untouched.
  assert.equal(legacy.map.has('axonkey.settings.v1'), false)
  assert.equal(legacy.map.has('axonkey.mapping-profiles.v2'), false)
  assert.equal(legacy.map.has('axonkey.saved-sequences.v1'), false)
  assert.equal(legacy.map.has('axonkey.device-model-catalog.cache.v2'), true)

  // Subsequent writes coalesce and persist to disk without writing to WebView localStorage.
  appStorage.setItem('axonkey.ui-state.v1', '{"activePage":"mapping"}')
  appStorage.setItem('axonkey.ui-state.v1', '{"activePage":"settings"}')
  appStorage.removeItem('axonkey.saved-sequences.v1')
  await flushAppStorage()

  assert.equal(disk.get('axonkey.ui-state.v1'), '{"activePage":"settings"}')
  assert.equal(disk.has('axonkey.saved-sequences.v1'), false)
  assert.equal(legacy.map.has('axonkey.ui-state.v1'), false)
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
