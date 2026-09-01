import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('main window can subscribe to native remote-key events', () => {
  const capability = JSON.parse(readFileSync(
    join(projectRoot, 'src-tauri', 'capabilities', 'main.json'),
    'utf8',
  ))

  assert.ok(capability.windows.includes('main'))
  assert.ok(capability.permissions.includes('core:event:allow-listen'))
  assert.ok(capability.permissions.includes('core:event:allow-unlisten'))
  assert.ok(capability.permissions.includes('log:default'))
})
