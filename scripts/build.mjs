import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertVersionsMatch } from './version.mjs'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const envFile = process.env.ENV_FILE || '.env'

function run(name, args) {
  const windowsNpm = process.platform === 'win32' && name === 'npm'
  const command = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : name
  const commandArgs = windowsNpm ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function build(version) {
  run('npm', ['run', 'tauri', 'build', '--', '--bundles', 'nsis'])
  const artifact = join(
    repositoryRoot,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'nsis',
    `Axonkey_${version}_x64-setup.exe`,
  )
  if (!existsSync(artifact)) throw new Error(`Build completed but the expected installer was not found: ${artifact}`)
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex').toUpperCase()
  console.log(`\nAxonkey v${version} built successfully.`)
  console.log(`Installer: ${artifact}`)
  console.log(`SHA256: ${sha256}`)
}

try {
  build(assertVersionsMatch(envFile))
} catch (error) {
  console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
