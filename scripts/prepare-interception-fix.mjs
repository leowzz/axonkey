import { spawnSync } from 'node:child_process'
import { verifyArtifact } from './verify-interception-fix.mjs'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const script = fileURLToPath(new URL('./build-interception-fix.ps1', import.meta.url))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Interception Fix source build failed. See the CMake/vcpkg output above.')
  verifyArtifact(fileURLToPath(new URL('../vendor/interception-fix', import.meta.url)))
}
