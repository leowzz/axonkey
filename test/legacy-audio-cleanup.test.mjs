import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

test('legacy audio selector accepts standard VB-CABLE only (Windows PowerShell 5.1)', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'test/legacy-audio-cleanup.test.ps1'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('Windows bundle includes the legacy cleanup script', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'))
  assert.equal(config.bundle.resources['../scripts/legacy-audio-cleanup.ps1'], 'scripts/legacy-audio-cleanup.ps1')
})
