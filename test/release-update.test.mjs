import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseChecker, isNewerRelease } from '../src/releaseUpdate.ts'
const release = (tag_name) => ({ ok: true, json: async () => ({ tag_name, draft: false, prerelease: false }) })

test('numeric comparison, stable tags and prerelease upgrades', () => {
  for (const [latest, current, expected] of [
    ['v0.2.20', '0.2.19', true], ['v0.10.0', '0.9.9', true],
    ['v0.2.19', '0.2.19', false], ['v0.2.18', '0.2.19', false],
    ['v0.3.0-beta.1', '0.2.19', false], ['v0.3.0', '0.3.0-beta.1', true],
    ['v0.2.19+build', '0.2.19', false], ['invalid', '0.2.19', false],
  ]) assert.equal(isNewerRelease(latest, current), expected)
})

test('event deduplication, cooldown, manual retry and failure recovery', async () => {
  let calls = 0, time = 1000, fail = false, state
  const checker = createReleaseChecker((next) => { state = next }, {
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

test('HTTP failures and invalid releases cannot report up-to-date', async () => {
  for (const response of [{ ok: false, status: 404 }, { ok: false, status: 403 },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => ({ tag_name: 'v9.0.0', draft: false, prerelease: true }) },
  ]) {
    let state
    const checker = createReleaseChecker((next) => { state = next }, { request: async () => response })
    await checker.check()
    assert.ok(state.error)
    assert.equal(state.checkedAt, null)
    assert.equal(state.latestVersion, null)
    checker.dispose()
  }
})

test('disposal aborts requests and suppresses stale state writes', async () => {
  let writes = 0, signal, finish
  const checker = createReleaseChecker(() => { writes++ }, { request: async (_url, options) => {
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
