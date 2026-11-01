import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const helper = resolve('scripts/uninstall-old-driver.exe')

function invoke(args) {
  const result = spawnSync(helper, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.ifError(result.error)
  return result
}

test('VB-CABLE status is read-only and returns the same JSON through a result file', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-vbcable-status-'))
  try {
    const output = join(directory, 'result with spaces.json')
    const log = join(directory, 'unused.log')
    const result = invoke(['--vbcable-status', '--result-path', output, '--log-path', log])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const reply = JSON.parse(result.stdout)
    assert.equal(reply.action, 'status')
    assert.equal(reply.success, true)
    assert.equal(typeof reply.installed, 'boolean')
    assert.equal(reply.rebootRequired, false)
    assert.equal(reply.error, null)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), reply)
    assert.equal(existsSync(log), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('VB-CABLE dry run reports devices, historical packages and files without removal', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-vbcable-plan-'))
  try {
    const before = JSON.parse(invoke(['--vbcable-status']).stdout)
    const log = join(directory, 'unused.log')
    const result = invoke(['--uninstall-vbcable', '--dry-run', '--log-path', log])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.action, 'dry-run')
    assert.equal(plan.success, true)
    assert.deepEqual(plan.devices.toSorted(), before.devices.toSorted())
    assert.equal(plan.devicesRemoved, 0)
    assert.equal(plan.packagesRemoved, 0)
    assert.equal(plan.rebootRequired, false)
    assert.ok(Array.isArray(plan.files))
    assert.ok(Array.isArray(plan.directories))
    for (const inf of plan.packages) assert.match(inf, /\\oem\d+\.inf$/i)
    assert.equal(existsSync(log), false)
    assert.deepEqual(JSON.parse(invoke(['--vbcable-status']).stdout).devices.toSorted(), before.devices.toSorted())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('VB-CABLE removal requires its own explicit command and confirmation', { skip: process.platform !== 'win32' }, () => {
  for (const args of [
    ['--uninstall-vbcable'],
    ['--dry-run'],
    ['--vbcable-status', '--uninstall-vbcable', '--confirmed'],
    ['--status', '--uninstall-vbcable', '--confirmed'],
    ['--status', '--vbcable-status'],
  ]) {
    const result = invoke(args)
    assert.equal(result.status, 2, args.join(' '))
    assert.equal(result.stdout, '')
    assert.notEqual(result.stderr, '')
  }
})

test('Windows backend and bundle use the native helper instead of PowerShell', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'))
  assert.equal(config.bundle.resources['../scripts/uninstall-old-driver.exe'], 'scripts/uninstall-old-driver.exe')
  assert.equal(Object.keys(config.bundle.resources).some(path => path.endsWith('.ps1')), false)
  assert.equal(existsSync('scripts/legacy-audio-cleanup.ps1'), false)
  const backend = readFileSync('src-tauri/src/windows_vmic/legacy.rs', 'utf8')
  assert.match(backend, /scripts\/uninstall-old-driver\.exe/)
  assert.match(backend, /--vbcable-status/)
  assert.match(backend, /--uninstall-vbcable/)
  assert.doesNotMatch(backend, /powershell|\.ps1/)
})
