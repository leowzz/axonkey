import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { verifyArtifact } from './verify-interception-fix.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

function buildFromSource() {
  const script = fileURLToPath(new URL('./build-interception-fix.ps1', import.meta.url))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Interception Fix source build failed. See the CMake/vcpkg output above.')
}

export function prepareInterceptionFix({
  platform = process.platform,
  reuseExisting = false,
  directory = fileURLToPath(new URL('../vendor/interception-fix', import.meta.url)),
  build = buildFromSource,
} = {}) {
  if (platform !== 'win32') return
  if (reuseExisting && existsSync(resolve(directory, 'manifest.json'))) {
    verifyArtifact(directory)
    console.log('Reusing verified Interception Fix resources for development.')
    return
  }
  build()
  verifyArtifact(directory)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareInterceptionFix({ reuseExisting: process.argv.includes('--if-missing') })
}
