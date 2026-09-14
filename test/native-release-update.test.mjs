import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeReleaseChecker } from '../src/nativeReleaseUpdate.ts'
import { generateUpdaterManifest } from '../scripts/generate-updater-manifest.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('native checks deduplicate, throttle, preserve an update on failure and release handles', async () => {
  let state, calls = 0, closed = 0, time = 1, fail = false
  const update = { version: '0.3.0', close: async () => { closed++ } }
  const checker = createNativeReleaseChecker(next => { state = next }, {
    now: () => time, relaunch: async () => {},
    checkUpdate: async () => { calls++; if (fail) throw Error('offline'); return update },
  })
  await Promise.all([checker.check(), checker.check(true)])
  await checker.check()
  assert.equal(calls, 1)
  fail = true
  await checker.check(true)
  assert.equal(state.latestVersion, '0.3.0')
  assert.ok(state.error)
  time += 60000
  fail = false
  await checker.check()
  assert.equal(calls, 3)
  assert.equal(closed, 1)
  checker.dispose()
  assert.equal(closed, 2)
})

test('download progress, double clicks and restart retry do not reinstall', async () => {
  let state, installs = 0, restarts = 0, checks = 0
  const gate = deferred()
  const checker = createNativeReleaseChecker(next => { state = next }, {
    checkUpdate: async () => {
      checks++
      return { version: '0.3.0', close: async () => {}, downloadAndInstall: async progress => {
        installs++
        progress({ event: 'Started', data: { contentLength: 100 } })
        progress({ event: 'Progress', data: { chunkLength: 40 } })
        await gate.promise
        progress({ event: 'Finished' })
      } }
    },
    relaunch: async () => { restarts++; if (restarts === 1) throw Error('restart failed') },
  })
  await checker.check()
  const installing = checker.install()
  assert.equal(state.phase, 'downloading')
  assert.equal(state.downloaded, 40)
  assert.equal(state.total, 100)
  await checker.install()
  await checker.check(true)
  assert.equal(checks, 1)
  assert.equal(installs, 1)
  gate.resolve()
  await installing
  assert.equal(state.phase, 'ready')
  assert.ok(state.error)
  await checker.install()
  assert.equal(installs, 1)
  assert.equal(restarts, 2)
  checker.dispose()
})

test('failed or invalid-signature installation stays retryable and never restarts', async () => {
  let state, installs = 0, restarts = 0
  const checker = createNativeReleaseChecker(next => { state = next }, {
    checkUpdate: async () => ({ version: '0.3.0', close: async () => {}, downloadAndInstall: async () => {
      installs++; throw Error('signature verification failed')
    } }),
    relaunch: async () => { restarts++ },
  })
  await checker.check()
  await checker.install()
  assert.equal(state.phase, 'idle')
  assert.ok(state.error)
  await checker.install()
  assert.equal(installs, 2)
  assert.equal(restarts, 0)
  checker.dispose()
})

test('unmount closes late update handles and suppresses stale state writes', async () => {
  const gate = deferred()
  let writes = 0, closed = 0
  const checker = createNativeReleaseChecker(() => { writes++ }, {
    checkUpdate: () => gate.promise, relaunch: async () => {},
  })
  const checking = checker.check()
  checker.dispose()
  gate.resolve({ version: '0.3.0', close: async () => { closed++ } })
  await checking
  assert.equal(writes, 1)
  assert.equal(closed, 1)
})

test('no-update response marks successful check without offering installation', async () => {
  let state, restarts = 0
  const checker = createNativeReleaseChecker(next => { state = next }, {
    checkUpdate: async () => null, relaunch: async () => { restarts++ },
  })
  await checker.check()
  await checker.install()
  assert.ok(state.checkedAt)
  assert.equal(state.latestVersion, null)
  assert.equal(state.error, null)
  assert.equal(restarts, 0)
  checker.dispose()
})

test('manifest maps both Mac architectures to universal bundle and requires signatures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-updater-'))
  try {
    for (const name of ['Axonkey_0.3.0_x64-setup.exe', 'Axonkey.app.tar.gz']) {
      writeFileSync(join(directory, name), 'test artifact')
      writeFileSync(join(directory, `${name}.sig`), Buffer.from('test signature').toString('base64'))
    }
    const options = { directory, version: '0.3.0', repository: 'leowzz/axonkey' }
    const manifest = generateUpdaterManifest(options)
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64', 'darwin-x86_64', 'darwin-aarch64'])
    assert.deepEqual(manifest.platforms['darwin-x86_64'], manifest.platforms['darwin-aarch64'])
    assert.match(manifest.platforms['windows-x86_64'].url, /\/v0\.3\.0\/Axonkey_0\.3\.0_x64-setup.exe$/)
    writeFileSync(join(directory, 'Axonkey.app.tar.gz.sig'), '')
    assert.throws(() => generateUpdaterManifest(options), /Invalid signature/)
    assert.throws(() => generateUpdaterManifest({ ...options, version: '0.3.0-beta' }), /stable/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
