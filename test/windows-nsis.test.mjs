import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
