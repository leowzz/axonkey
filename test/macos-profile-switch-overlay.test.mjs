import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('macOS profile notifications use a passive native panel in the active Space and retain the latest switch until expiry', {
  skip: process.platform !== 'darwin',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-profile-overlay-'))
  const executable = join(directory, 'overlay-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang', '-fobjc-arc', '-fmodules', '-mmacosx-version-min=13.0',
      '-framework', 'AppKit', '-framework', 'QuartzCore',
      new URL('./macos-profile-switch-overlay.m', import.meta.url).pathname,
      '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 0, `${run.stderr}\n${run.error ?? ''}`)
    assert.match(run.stdout, /active_space=1 nonactivating=1/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
