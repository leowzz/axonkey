import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assertOpenInputBridgePackage,
  requiredOpenInputBridgeFiles,
} from '../scripts/openinputbridge-package.mjs'

function withRepository(callback) {
  const repository = mkdtempSync(join(tmpdir(), 'axonkey-oib-package-'))
  try {
    callback(repository)
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
}

test('rejects a Windows release without the signed OpenInputBridge package', () => {
  withRepository((repository) => {
    assert.throws(
      () => assertOpenInputBridgePackage(repository),
      /OpenInputBridge WHQL package is incomplete.*OpenInputBridgeSetup\.exe/,
    )
  })
})

test('accepts the complete OpenInputBridge package layout', () => {
  withRepository((repository) => {
    const packageRoot = join(repository, 'vendor', 'openinputbridge')
    for (const path of requiredOpenInputBridgeFiles) {
      const file = join(packageRoot, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '')
    }
    assert.equal(assertOpenInputBridgePackage(repository), packageRoot)
  })
})

test('Windows packaging excludes the legacy Interception runtime and installer', () => {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)))
  const windowsConfig = readFileSync(join(repository, 'src-tauri', 'tauri.windows.conf.json'), 'utf8')
  const driverScript = readFileSync(join(repository, 'scripts', 'openinputbridge-driver.ps1'), 'utf8')

  assert.doesNotMatch(windowsConfig, /vendor\/interception|interception\.dll|install-interception/i)
  assert.match(windowsConfig, /vendor\/openinputbridge/)
  assert.match(driverScript, /OpenInputBridgeKeyboard|OpenInputBridge WHQL installer/)
})
