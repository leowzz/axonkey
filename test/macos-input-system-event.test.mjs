import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('macOS input parses media keys safely and routes modifier chords correctly', {
  skip: process.platform !== 'darwin',
}, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'axonkey-system-event-'))
  const executable = join(temporaryDirectory, 'system-event-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang',
      '-fobjc-arc',
      '-fmodules',
      '-mmacosx-version-min=13.0',
      '-framework', 'AppKit',
      '-framework', 'ApplicationServices',
      '-framework', 'CoreFoundation',
      '-framework', 'IOKit',
      new URL('./macos-input-system-event.m', import.meta.url).pathname,
      '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)

    const run = spawnSync(executable, [], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
