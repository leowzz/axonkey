import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('macOS quick overlay panel floats without activation, moves to active Space, and reuses its view', {
  skip: process.platform !== 'darwin',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-quick-overlay-'))
  const executable = join(directory, 'quick-overlay-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang', '-fobjc-arc', '-fmodules', '-mmacosx-version-min=13.0',
      '-framework', 'AppKit', '-framework', 'QuartzCore',
      new URL('./macos-quick-overlay.m', import.meta.url).pathname,
      '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 0, `${run.stderr}\n${run.error ?? ''}`)
    assert.match(run.stdout, /visible=1 active_space=1 nonactivating=1 fullscreen_aux=1 reuse=1/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
