import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nextPatchVersion, numericVersion, readEnvVersion } from './version.mjs'

function withEnvFile(contents, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-version-'))
  const path = join(directory, '.env')
  writeFileSync(path, contents)
  try {
    callback(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('reads and increments the version from an env file', () => {
  withEnvFile('version=v1.2.3\n', (path) => {
    const version = numericVersion(readEnvVersion(path))
    assert.equal(version, '1.2.3')
    assert.equal(nextPatchVersion(version), '1.2.4')
  })
})

test('accepts a Windows line ending', () => {
  withEnvFile('version=v1.2.3\r\n', (path) => {
    assert.equal(readEnvVersion(path), 'v1.2.3')
  })
})

for (const contents of ['', 'version=1.2.3\n', 'version=v01.2.3\n', 'version=v1.2.3\nversion=v1.2.4\n']) {
  test(`rejects invalid env version ${JSON.stringify(contents)}`, () => {
    withEnvFile(contents, (path) => {
      assert.throws(() => readEnvVersion(path), /exactly one version=vX\.Y\.Z line/)
    })
  })
}

test('reports how to initialize a missing env file', () => {
  assert.throws(
    () => readEnvVersion(join(tmpdir(), 'missing-axonkey-version', '.env')),
    /Copy-Item \.env\.example \.env/,
  )
})
