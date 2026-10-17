import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
