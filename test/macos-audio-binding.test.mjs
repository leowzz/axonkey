import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('macOS RC003 connects and reconnects only to the bound Bluetooth address', {
  skip: process.platform !== 'darwin',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-audio-binding-'))
  const executable = join(directory, 'binding-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang', '-fobjc-arc', '-fmodules', '-mmacosx-version-min=13.0',
      '-framework', 'Foundation', '-framework', 'AVFoundation',
      '-framework', 'AudioToolbox', '-framework', 'CoreAudio', '-framework', 'CoreBluetooth',
      fileURLToPath(new URL('./macos-audio-binding.m', import.meta.url)), '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 0, `${run.stderr}\n${run.error ?? ''}`)
    assert.match(run.stdout, /connected=1 scan=1 reconnect=1 missing=1 unsupported=1 legacy=1/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
