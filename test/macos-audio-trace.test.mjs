import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('packet trace is bounded, sealed, hashed and exported without overwriting', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'axonkey-packet-trace-'))
  try {
    const exe = join(dir, 'test')
    const compile = spawnSync('xcrun', ['clang', '-fobjc-arc',
      '-fsanitize=address,undefined', '-framework', 'Foundation',
      new URL('./macos-audio-trace.m', import.meta.url).pathname, '-o', exe],
    { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(exe, [], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
