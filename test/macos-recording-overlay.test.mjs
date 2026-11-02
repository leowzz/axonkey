import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('macOS recording panel renders, accepts stop clicks without focus, and hides and reuses its window', {
  skip: process.platform !== 'darwin',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-recording-overlay-'))
  const executable = join(directory, 'recording-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang', '-fobjc-arc', '-fmodules', '-mmacosx-version-min=13.0',
      '-framework', 'AppKit',
      new URL('./macos-recording-overlay.m', import.meta.url).pathname,
      '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 0, `${run.stderr}\n${run.error ?? ''}`)
    assert.match(run.stdout, /nonactivating=1 clickable=1 rendering=1 reuse=1/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
