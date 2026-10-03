import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

test('Tauri CLI leaves Cargo.toml unchanged under Windows and macOS configuration', t => {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-manifest-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const native = join(directory, 'src-tauri')
  mkdirSync(join(native, 'src'), { recursive: true })
  mkdirSync(join(directory, 'frontend'))
  writeFileSync(join(directory, 'frontend', 'index.html'), '<html></html>')
  for (const name of ['Cargo.toml', 'Cargo.lock']) copyFileSync(join(root, 'src-tauri', name), join(native, name))
  writeFileSync(join(native, 'src', 'lib.rs'), '')
  writeFileSync(join(native, 'src', 'main.rs'), 'fn main() {}')
  // The CLI rewrites the manifest before calling its Cargo runner. Stop there
  // so this checks the real CLI without building or launching a second app.
  writeFileSync(join(native, 'build'), "process.stderr.write('AXONKEY_MANIFEST_RUNNER\\n'); process.exit(73)\n")
  const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  config.build = { frontendDist: '../frontend' }
  config.bundle.active = false
  writeFileSync(join(native, 'tauri.conf.json'), JSON.stringify(config))
  const before = readFileSync(join(native, 'Cargo.toml'), 'utf8')
  for (const platform of ['windows', 'macos', 'windows']) {
    const platformConfig = JSON.parse(readFileSync(join(root, 'src-tauri', `tauri.${platform}.conf.json`), 'utf8'))
    const result = spawnSync(process.execPath, [cli, 'build', '--debug', '--no-bundle', '--runner', process.execPath, '--config', JSON.stringify(platformConfig)], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CARGO_NET_OFFLINE: 'true', TAURI_CONFIG: '' },
    })
    assert.ifError(result.error)
    assert.match(`${result.stdout}\n${result.stderr}`, /AXONKEY_MANIFEST_RUNNER/, `${platform}: CLI did not reach the runner:\n${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(join(native, 'Cargo.toml'), 'utf8'), before, `${platform} rewrote Cargo.toml`)
  }
})
