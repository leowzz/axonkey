import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseChecker, updateManifestUrl, isNewerRelease } from '../src/releaseUpdate.ts'
const response = (manifest) => ({ ok: true, json: async () => manifest })
const release = (version) => response({ version })

test('numeric comparison, stable tags and prerelease upgrades', () => {
  for (const [latest, current, expected] of [
    ['v0.2.20', '0.2.19', true], ['v0.10.0', '0.9.9', true],
    ['v0.2.19', '0.2.19', false], ['v0.2.18', '0.2.19', false],
    ['v0.3.0-beta.1', '0.2.19', false], ['v0.3.0', '0.3.0-beta.1', true],
    ['v0.2.29', '0.3.0-beta.1', false], ['v0.3.0', '0.3.0-rc.1', true],
    ['v0.2.19+build', '0.2.19', false], ['invalid', '0.2.19', false],
    ['v1.0.0', '0.3.31', false], ['v0.9.9', '1.0.0', false],
    ['v1.0.1', '1.0.0', true], ['v1.1.0', '1.0.0', true],
    ['v2.0.0', '1.0.0', false], ['v1.0.0', '0.9.0-rc.1', false],
    ['v1.0.0', '1.0.0-rc.1', true],
  ]) assert.equal(isNewerRelease(latest, current), expected)
})

test('event deduplication, cooldown, manual retry and failure recovery', async () => {
  let calls = 0, time = 1000, fail = false, state
  const checker = createReleaseChecker((next) => { state = next }, {
    currentVersion: '0.2.19',
    now: () => time,
    request: async () => { calls++; if (fail) throw Error('offline'); return release('v0.2.20') },
  })
  await Promise.all([checker.check(), checker.check(), checker.check(true)])
  assert.equal(calls, 1)
  await checker.check()
  assert.equal(calls, 1)
  time += 3600000
  await checker.check()
  assert.equal(calls, 2)
  fail = true
  await checker.check(true)
  assert.equal(state.latestVersion, 'v0.2.20')
  assert.ok(state.error)
  assert.equal(state.checking, false)
  await checker.check()
  assert.equal(calls, 3)
  time += 60000
  fail = false
  await checker.check()
  assert.equal(calls, 4)
  assert.equal(state.error, null)
  checker.dispose()
})

test('HTTP failures and invalid responses cannot report up-to-date', async () => {
  for (const response of [{ ok: false, status: 404 }, { ok: false, status: 403 },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => null },
  ]) {
    let state
    const checker = createReleaseChecker((next) => { state = next }, { currentVersion: '0.2.19', request: async () => response })
    await checker.check()
    assert.ok(state.error)
    assert.equal(state.checkedAt, null)
    assert.equal(state.latestVersion, null)
    checker.dispose()
  }
})

test('disposal aborts requests and suppresses stale state writes', async () => {
  let writes = 0, signal, finish
  const checker = createReleaseChecker(() => { writes++ }, { currentVersion: '0.2.19', request: async (_url, options) => {
    signal = options.signal
    return new Promise((resolve) => { finish = resolve })
  } })
  const pending = checker.check()
  checker.dispose()
  assert.equal(signal.aborted, true)
  finish(release('v0.2.20'))
  await pending
  assert.equal(writes, 1)
})

test('automatic and manual checks fetch only the fixed manifest for the installed major', async () => {
  for (const [currentVersion, major] of [['0.3.31', 0], ['1.0.0', 1], ['1.0.0-rc.1', 1], ['2.0.0', 2]]) {
    let state, calls = 0
    const checker = createReleaseChecker(next => { state = next }, {
      currentVersion,
      request: async (url, options) => {
        calls++
        assert.equal(url, `https://raw.githubusercontent.com/leowzz/axonkey/updates/v${major}/latest.json`)
        assert.equal(options.credentials, 'omit')
        assert.equal(options.cache, 'no-cache')
        return release(`${major}.1.0`)
      },
    })
    await checker.check()
    await checker.check(true)
    assert.equal(calls, 2)
    assert.equal(state.latestVersion, `${major}.1.0`)
    assert.equal(state.error, null)
    checker.dispose()
  }
  assert.throws(() => updateManifestUrl('invalid'), /Invalid current version/)
})

test('a cross-major, prerelease or malformed manifest never offers an update or reports success', async () => {
  for (const version of ['0.9.9', '2.0.0', '1.1.0-beta.1', 'invalid', 123, null]) {
    let state
    const checker = createReleaseChecker(next => { state = next }, {
      currentVersion: '1.0.0',
      request: async () => release(version),
    })
    for (const force of [false, true]) {
      await checker.check(force)
      assert.equal(state.latestVersion, null)
      assert.ok(state.error)
      assert.equal(state.checkedAt, null)
    }
    checker.dispose()
  }
})

test('equal and older same-major manifests do not offer a downgrade', async () => {
  for (const version of ['1.0.0', '1.0.1']) {
    let state
    const checker = createReleaseChecker(next => { state = next }, {
      currentVersion: '1.0.1', request: async () => release(version),
    })
    await checker.check()
    assert.equal(state.error, null)
    assert.equal(isNewerRelease(state.latestVersion, '1.0.1'), false)
    checker.dispose()
  }
})
