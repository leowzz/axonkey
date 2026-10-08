import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyFiles, verifyArtifact } from '../scripts/verify-interception-fix.mjs'

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

test('packaging includes management and licensed service; install remains opt-in', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json'))
  assert.equal(config.bundle.resources['../vendor/interception-fix/'], 'vendor/interception-fix/')
  assert.equal(config.bundle.resources['../scripts/interception-fix.ps1'], 'scripts/interception-fix.ps1')
  const manager = readFileSync('scripts/interception-fix.ps1', 'utf8')
  assert.doesNotMatch(manager, /Start-Service|Invoke-WebRequest|DownloadFile|install-service/)
  assert.match(manager, /lockdown=no/)
  assert.match(manager, /-StartupType Manual/)
  assert.match(manager, /SeCreatePermanentPrivilege/)
  assert.match(readFileSync('scripts/uninstall-driver.ps1', 'utf8'), /Remove the optional reconnect fix/)
})
