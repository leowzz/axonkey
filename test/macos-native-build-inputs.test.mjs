import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('every compiled macOS adapter participates in Cargo source change tracking', () => {
  const build = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8')
  const compiled = [...build.matchAll(/\.file\("(native\/[^"\n]+)"\)/g)].map(match => match[1])
  const tracked = new Set([...build.matchAll(/cargo:rerun-if-changed=(native\/[^"\n]+)/g)].map(match => match[1]))
  assert.ok(compiled.length > 0)
  assert.deepEqual(compiled.filter(path => !tracked.has(path)), [], 'changes to compiled adapters must rebuild the native library')
})
