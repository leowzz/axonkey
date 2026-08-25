import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertOpenInputBridgePackage } from './openinputbridge-package.mjs'
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

function buildTarget() {
  if (process.platform === 'win32') {
    return {
      bundle: 'nsis',
      directory: 'nsis',
      artifact: (version) => `Axonkey_${version}_x64-setup.exe`,
      label: 'Installer',
    }
  }
  if (process.platform === 'darwin') {
    return {
      bundle: 'dmg',
      directory: 'dmg',
      artifact: (version) => {
        const prefix = `Axonkey_${version}_`
        const candidates = readdirSync(join(repositoryRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg'))
          .filter((name) => name.startsWith(prefix) && name.endsWith('.dmg'))
        if (candidates.length !== 1) {
          throw new Error(`Expected exactly one macOS DMG matching ${prefix}*.dmg, found ${candidates.length}`)
        }
        return candidates[0]
      },
      label: 'DMG',
    }
  }
  throw new Error(`Unsupported build platform: ${process.platform}`)
}

function build(version) {
  const target = buildTarget()
  if (process.platform === 'win32') assertOpenInputBridgePackage(repositoryRoot)
  if (process.platform === 'darwin') {
    const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim()
    if (signingIdentity && signingIdentity !== '-') process.env.REQUIRE_SIGNED_INSTALLER = '1'
    run(join(repositoryRoot, 'scripts', 'build-macos-audio-package.sh'), [])
  }
  run('npm', ['run', 'tauri', 'build', '--', '--bundles', target.bundle])
  const artifactDirectory = join(repositoryRoot, 'src-tauri', 'target', 'release', 'bundle', target.directory)
  const artifact = join(artifactDirectory, target.artifact(version))
  if (!existsSync(artifact)) throw new Error(`Build completed but the expected ${target.label} was not found: ${artifact}`)
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex').toUpperCase()
  console.log(`\nAxonkey v${version} built successfully for ${process.platform}.`)
  console.log(`${target.label}: ${artifact}`)
  console.log(`SHA256: ${sha256}`)
}

try {
  build(assertVersionsMatch(envFile))
} catch (error) {
  console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
