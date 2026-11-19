import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const args = process.argv.slice(2)
const env = { ...process.env }

function detectSelfSignedIdentity() {
  const probe = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  if (probe.status !== 0) return undefined
  const match = probe.stdout.match(/"([^"]*Axonkey[^"]*Code Signing[^"]*)"/)
  return match?.[1]
}

if (process.platform === 'darwin' && args[0] === 'dev') {
  const runner = join(root, 'scripts', 'macos-dev-runner.sh')
  env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER ??= runner
  env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER ??= runner
  if (!env.APPLE_SIGNING_IDENTITY?.trim()) {
    const detected = detectSelfSignedIdentity()
    if (detected) env.APPLE_SIGNING_IDENTITY = detected
  }
}

const child = spawn(process.execPath, [cli, ...args], {
  cwd: root,
  env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on('error', error => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
