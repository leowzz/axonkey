import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyFiles, verifyArtifact } from '../scripts/verify-interception-fix.mjs'
import { prepareInterceptionFix } from '../scripts/prepare-interception-fix.mjs'
import { mkdirSync } from 'node:fs'

function writeValidArtifact(directory) {
  mkdirSync(resolve(directory, 'licenses'), { recursive: true })
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(0x8664, 68)
  const files = {}
  for (const name of ['axonkey-interception-fix.exe', ...['interception-driver-fix', 'scope-guard-MIT', 'cli11', 'fmt', 'spdlog', 'boost-algorithm', 'phnt'].map(name => `licenses/${name}.txt`)]) {
    const content = name.endsWith('.exe') ? bytes : Buffer.from('test license')
    writeFileSync(resolve(directory, name), content)
    files[name] = createHash('sha256').update(content).digest('hex')
  }
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({
    upstreamCommit: 'e1a7720863f514d51caf06b020da5c0d2e345c41',
    vcpkgCommit: '2750401336fb7c95f6619657a46a7e798661341c',
    files,
  }))
}

test('development prepares missing Windows resources, reuses valid resources and rejects tampering', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'axonkey-fix-dev-'))
  let builds = 0
  const options = { platform: 'win32', reuseExisting: true, directory, build: () => { builds++; writeValidArtifact(directory) } }
  try {
    prepareInterceptionFix(options)
    assert.equal(builds, 1)
    prepareInterceptionFix(options)
    assert.equal(builds, 1)
    // Production still rebuilds from the pinned source even when a cache exists.
    prepareInterceptionFix({ ...options, reuseExisting: false })
    assert.equal(builds, 2)
    writeFileSync(resolve(directory, 'axonkey-interception-fix.exe'), 'tampered')
    assert.throws(() => prepareInterceptionFix(options), /mismatch/)
    assert.equal(builds, 2)
    prepareInterceptionFix({ ...options, platform: 'darwin' })
    prepareInterceptionFix({ ...options, platform: 'linux' })
    assert.equal(builds, 2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('fixed source snapshot validates; production code cannot write device ACLs', () => {
  const dir = resolve('third_party/interception-driver-fix')
  verifyFiles(dir, JSON.parse(readFileSync(resolve(dir, 'axonkey-source-sha256.json'))))
  const core = readFileSync(resolve(dir, 'src/core.hpp'), 'utf8')
  assert.doesNotMatch(core, /NtSetSecurityObject|WRITE_DAC|ConvertStringSecurityDescriptorToSecurityDescriptor/)
  assert.match(core, /if \(cfg.lockdown\)[\s\S]*throw/)
  const main = readFileSync(resolve(dir, 'src/main.cpp'), 'utf8')
  assert.doesNotMatch(main, /#include "install_uninstall_service.hpp"/)
  assert.match(main, /Run only through the AxonkeyInterceptionFix/)
})

test('hash verification fails closed on tampering, missing files and traversal', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'axonkey-fix-'))
  try {
    writeFileSync(resolve(dir, 'payload'), 'original')
    const hash = createHash('sha256').update('original').digest('hex')
    verifyFiles(dir, { payload: hash })
    writeFileSync(resolve(dir, 'payload'), 'tampered')
    assert.throws(() => verifyFiles(dir, { payload: hash }), /mismatch/)
    assert.throws(() => verifyFiles(dir, { missing: hash }), /ENOENT/)
    for (const path of ['../payload', '/payload', 'C:/payload', '..\\payload']) {
      assert.throws(() => verifyFiles(dir, { [path]: hash }), /Unsafe/)
    }
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ upstreamCommit: 'master' }))
    assert.throws(() => verifyArtifact(dir), /provenance/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('packaging includes management and licensed service; driver lifecycle installs the fix', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json'))
  assert.equal(config.bundle.resources['../vendor/interception-fix/'], 'vendor/interception-fix/')
  assert.equal(config.bundle.resources['../scripts/interception-fix.ps1'], 'scripts/interception-fix.ps1')
  const manager = readFileSync('scripts/interception-fix.ps1', 'utf8')
  assert.match(manager, /function Convert-ToProviderPath/)
  assert.match(manager, /Convert-ToProviderPath \$PSScriptRoot/)
  assert.match(manager, /\$root = Split-Path -Parent \$scriptRoot/)
  assert.doesNotMatch(manager, /Start-Service|Invoke-WebRequest|DownloadFile|install-service/)
  assert.match(manager, /lockdown=no/)
  assert.match(manager, /-StartupType Manual/)
  assert.match(manager, /SeCreatePermanentPrivilege/)
  const installDriver = readFileSync('scripts/install-driver.ps1', 'utf8')
  const uninstallDriver = readFileSync('scripts/uninstall-driver.ps1', 'utf8')
  assert.match(installDriver, /-Action install -Confirmed/)
  assert.match(uninstallDriver, /-Action uninstall -Confirmed/)
  assert.match(uninstallDriver, /Removing the bundled Interception reconnect fix/)
})
