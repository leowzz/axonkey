import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const source = readFileSync(join(root, 'tools', 'uninstall-old-driver', 'src', 'main.cpp'), 'utf8')
const project = readFileSync(join(root, 'tools', 'uninstall-old-driver', 'uninstall-old-driver.vcxproj'), 'utf8')
const solution = readFileSync(join(root, 'tools', 'uninstall-old-driver', 'uninstall-old-driver.sln'), 'utf8')
const buildScript = readFileSync(join(root, 'scripts', 'build-uninstall-old-driver.mjs'), 'utf8')
const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
const config = readFileSync(join(root, 'src-tauri', 'tauri.windows.conf.json'), 'utf8')
const tauriSource = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8')

test('legacy cleanup is provided by the standalone C++ Windows executable', () => {
  assert.equal(existsSync(join(root, 'scripts', 'uninstall-old-driver.ps1')), false)
  assert.equal(existsSync(join(root, 'scripts', 'uninstall-old-driver.exe')), true)
  assert.ok(existsSync(join(root, 'tools', 'uninstall-old-driver', 'uninstall-old-driver.sln')))
  assert.ok(existsSync(join(root, 'tools', 'uninstall-old-driver', 'uninstall-old-driver.vcxproj')))
  assert.match(config, /\.\.\/scripts\/uninstall-old-driver\.exe/)
  assert.match(buildScript, /msbuild/i)
  assert.doesNotMatch(buildScript, /cmake|mingw|ninja/i)
  assert.match(buildScript, /copyFileSync/)
  assert.match(packageJson, /"build:tauri": "node scripts\/verify-macos-audio-resources\.mjs && npm run build"/)
  assert.match(project, /PlatformToolset>v145/)
  assert.match(solution, /VisualStudioVersion = 18\.0\./)
  assert.match(project, /SubSystem>Windows/)
  assert.match(source, /EnumServicesStatusExW/)
  assert.match(source, /UpperFilters/)
  assert.match(source, /keyboard\.sys/)
  assert.match(source, /mouse\.sys/)
  assert.match(source, /ShellExecuteExW/)
  assert.match(source, /CreateWindow(?:Ex)?W/)
  assert.match(source, /kCommandTimeoutMs = 10'000/)
  assert.match(source, /WM_CTLCOLORSTATIC/)
  assert.match(source, /SetBkMode\([^\n]+TRANSPARENT/)
  assert.doesNotMatch(source, /CreateFont|WM_SETFONT/)
  assert.match(source, /--headless/)
  const legacyLaunch = tauriSource.slice(tauriSource.indexOf('let mut command = if driver == "legacy"'), tauriSource.indexOf('command.creation_flags(CREATE_NO_WINDOW)', tauriSource.indexOf('let mut command = if driver == "legacy"')))
  assert.match(legacyLaunch, /\.arg\("--confirmed"\)/)
  assert.match(legacyLaunch, /\.arg\("--auto-close"\)/)
  assert.doesNotMatch(legacyLaunch, /--headless/)
  assert.match(source, /开始卸载/)
  assert.doesNotMatch(source, /重启保护标志/)
  assert.doesNotMatch(source, /currentBootId|rebootPending|old-driver-uninstall-reboot-required/)
  assert.doesNotMatch(source, /restart Windows before retrying/)
  assert.match(source, /AxonkeyInterceptionFix/)
  assert.ok(source.includes(String.raw`C:\\Program Files\\Axonkey Interception Fix`))
})

test('status returns both legacy driver flags without creating logs or prompting', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-status-test-'))
  const logPath = join(directory, 'logs', 'should-not-exist.log')
  try {
    const result = spawnSync(join(root, 'scripts', 'uninstall-old-driver.exe'), ['--status', '--auto-close', '--log-path', logPath], {
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
    assert.equal(Object.hasOwn(status, 'rebootRequired'), false)
    assert.equal(existsSync(join(directory, 'logs')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
