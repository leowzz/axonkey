import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, createEmptyBehaviorMap, createMappingExport, normalizeBehavior, normalizeApplicationPath, normalizeWebsiteUrl, parseMappingImport, parseStoredBehaviors } from '../src/behaviorModel.ts'

test('launch actions survive storage and mapping transfers in sequence', () => {
  const map = createEmptyBehaviorMap()
  for (const id of ['menu', 'mouse.top.up']) {
    map[id].click = [
      createBehavior({ type: 'openApp', path: 'C:\\Program Files\\应用 & 工具\\Tool.exe', id: 'app' }),
      createBehavior({ type: 'delay', ms: 100, id: 'wait' }),
      createBehavior({ type: 'openWebsite', url: 'example.com/search?q=测试&lang=zh', id: 'web' }),
    ]
  }
  assert.deepEqual(parseStoredBehaviors(JSON.stringify({ behaviors: map })), map)
  const transfer = createMappingExport(map, true)
  assert.deepEqual(parseMappingImport(JSON.stringify(transfer)), { behaviors: map, enabled: true })
})

test('application paths accept spaces, unicode, shortcuts and macOS bundles', () => {
  for (const path of ['C:\\Program Files\\Tool.exe', 'C:\\应用\\Tool.COM', 'C:\\Users\\leo\\Desktop\\Tool.lnk', '\\\\server\\share\\Tool.exe', '/Applications/工具.app']) {
    assert.equal(normalizeApplicationPath(path), path)
    assert.equal(normalizeBehavior({ type: 'openApp', path }).path, path)
  }
  assert.equal(normalizeApplicationPath(' "C:\\Apps\\Tool.exe" '), 'C:\\Apps\\Tool.exe')
  for (const path of ['', 'Tool.exe', 'C:Tool.exe', 'https://example.com/Tool.exe', 'C:\\Apps\\Tool.exe\0', 'C:\\Apps\\File.txt', 10]) {
    assert.equal(normalizeBehavior({ type: 'openApp', path }), null)
  }
})

test('website addresses normalize to HTTPS and reject non-web or malformed targets', () => {
  assert.equal(normalizeWebsiteUrl(' example.com '), 'https://example.com/')
  assert.equal(normalizeWebsiteUrl('example.com:8443/path'), 'https://example.com:8443/path')
  assert.equal(normalizeWebsiteUrl('localhost:3000'), 'https://localhost:3000/')
  assert.equal(normalizeWebsiteUrl('http://localhost:3000/?a=1&b=%22%26'), 'http://localhost:3000/?a=1&b=%22%26')
  assert.equal(normalizeWebsiteUrl('https://例子.中国/测试'), 'https://xn--fsqu00a.xn--fiqs8s/%E6%B5%8B%E8%AF%95')
  for (const url of ['', 'https://', 'https://example .com', 'javascript:alert(1)', 'file:///C:/Tool.exe', 'mailto:a@example.com', 'https://user:pass@example.com', 'https://example.com/\nfoo', 10]) {
    assert.equal(normalizeBehavior({ type: 'openWebsite', url }), null)
  }
})

test('invalid imported launch targets are rejected, disabled valid actions retain their state', () => {
  const map = createEmptyBehaviorMap()
  map.menu.click = [{ id: 'bad', enabled: true, type: 'openWebsite', url: 'file:///C:/Tool.exe' }]
  assert.equal(parseMappingImport(createMappingExport(map, true)), null)
  const behavior = createBehavior({ id: 'disabled', type: 'openWebsite', url: 'example.com', enabled: false })
  assert.deepEqual(normalizeBehavior(behavior), behavior)
})
