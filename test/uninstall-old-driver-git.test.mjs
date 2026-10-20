import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

test('the standalone VC helper has a complete Git layout', () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'check-uninstall-old-driver-git.mjs')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
