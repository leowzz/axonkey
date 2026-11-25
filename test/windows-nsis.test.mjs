import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { verifyAsset } from '../scripts/prepare-windows-nsis.mjs'

test('NSIS preparation rejects changed download bytes before extraction', t => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-nsis-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const asset = join(directory, 'asset.zip')
  const expectedHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  writeFileSync(asset, 'abc')
  assert.doesNotThrow(() => verifyAsset(asset, expectedHash))
  writeFileSync(asset, 'corrupt download')
  assert.throws(() => verifyAsset(asset, expectedHash), /SHA-256 mismatch/)
})

test('NSIS preparation requires an explicit cache directory', () => {
  const result = spawnSync(process.execPath, ['scripts/prepare-windows-nsis.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage:/)
})

test('Windows NSIS installer never reads or modifies user or system Environment/Path', () => {
  const template = readFileSync('src-tauri/windows/installer.nsi', 'utf8')
  const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const windowsConfig = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'))

  assert.equal(windowsConfig.bundle?.windows?.nsis?.template, 'windows/installer.nsi')
  assert.equal(windowsConfig.bundle?.windows?.nsis?.installerHooks, undefined)
  assert.equal(tauriConfig.bundle?.windows?.nsis?.installerHooks, undefined)

  assert.doesNotMatch(template, /\b(ReadReg\w*|WriteReg\w*|DeleteReg\w*)\b[^\r\n]*"Environment"/i)
  assert.doesNotMatch(template, /Session Manager\\Environment/i)
  assert.doesNotMatch(template, /\bEnVar::/i)
  assert.doesNotMatch(template, /STR:Environment/i)
  assert.doesNotMatch(template, /\bsetx\b/i)

  const mobileVhidCleanupIdx = template.indexOf(
    'ExecWait \'"$INSTDIR\\${MAINBINARYNAME}.exe" --uninstall-mobile-vhid-if-present\' $0',
  )
  const quarborUninstallAllIdx = template.indexOf(
    'ExecWait \'"$INSTDIR\\vendor\\QuarborUniversalKeyboardDriverInstaller\\QuarborUniversalKeyboardDriverInstaller.exe" --uninstall-all\' $0',
  )
  const deleteMainBinaryIdx = template.indexOf('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"')
  assert.ok(mobileVhidCleanupIdx > 0, 'NSIS Uninstall section must clean up standalone mobile virtual HID node if present')
  assert.ok(
    mobileVhidCleanupIdx < quarborUninstallAllIdx,
    'Standalone mobile virtual HID node must be removed before QuarborUniversalKeyboardDriverInstaller --uninstall-all purges Driver Store packages',
  )
  assert.ok(
    quarborUninstallAllIdx < deleteMainBinaryIdx,
    'Driver uninstallers must run before deleting bundled executables',
  )
})
