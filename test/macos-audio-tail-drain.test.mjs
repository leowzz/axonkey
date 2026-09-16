import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('PCM stream buffers jitter, smooths underruns, drains tails, and bounds its queue', {
  skip: process.platform !== 'darwin',
}, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'axonkey-pcm-queue-'))
  const executable = join(temporaryDirectory, 'pcm-queue-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang', '-std=c11', '-fsanitize=address,undefined',
      new URL('./macos-pcm-queue.c', import.meta.url).pathname, '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('macOS audio drains short tails, reuses the output, and pauses when idle', {
  skip: process.platform !== 'darwin',
}, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'axonkey-audio-drain-'))
  const executable = join(temporaryDirectory, 'tail-drain-test')
  try {
    const compile = spawnSync('xcrun', [
      'clang',
      '-fobjc-arc',
      '-fmodules',
      '-mmacosx-version-min=13.0',
      '-framework', 'Foundation',
      '-framework', 'AVFoundation',
      '-framework', 'AudioToolbox',
      '-framework', 'CoreAudio',
      '-framework', 'CoreBluetooth',
      new URL('./macos-audio-tail-drain.m', import.meta.url).pathname,
      '-o', executable,
    ], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)

    const run = spawnSync(executable, [], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
