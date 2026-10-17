import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(join(process.cwd(), 'tools', 'uninstall-old-driver', 'src', 'main.rs'), 'utf8')
const config = readFileSync(join(process.cwd(), 'src-tauri', 'tauri.windows.conf.json'), 'utf8')

test('legacy cleanup is provided by the Rust executable', () => {
  assert.equal(existsSync(join(process.cwd(), 'scripts', 'uninstall-old-driver.ps1')), false)
  assert.equal(existsSync(join(process.cwd(), 'scripts', 'uninstall-old-driver.exe')), true)
  assert.match(config, /\.\.\/scripts\/uninstall-old-driver\.exe/)
  assert.match(source, /NamedPipeServer/)
  assert.match(source, /taskkill\.exe/)
  assert.doesNotMatch(source, /install-interception\.exe/)
  assert.match(source, /UpperFilters/)
  assert.match(source, /keyboard\.sys/)
  assert.match(source, /mouse\.sys/)
  assert.match(source, /ShellExecuteExW/)
  assert.match(source, /uninstall_interception/)
  assert.match(source, /AxonkeyInterceptionFix/)
  assert.ok(source.includes(String.raw`C:\Program Files\Axonkey Interception Fix`))
  assert.match(source, /uninstall_axonkey_interception_fix/)
})

test('status returns both legacy driver flags without creating logs or prompting', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-status-test-'))
  const logPath = join(directory, 'logs', 'should-not-exist.log')
  try {
    const result = spawnSync(join(process.cwd(), 'scripts', 'uninstall-old-driver.exe'), ['--status', '--log-path', logPath], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const status = JSON.parse(result.stdout)
    assert.equal(status.action, 'status')
    assert.equal(typeof status.components.interception, 'boolean')
    assert.equal(typeof status.components.interceptionFix, 'boolean')
    assert.equal(existsSync(join(directory, 'logs')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
