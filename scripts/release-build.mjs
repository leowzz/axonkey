import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertVersionsMatch,
  compareVersions,
  nextPatchVersion,
  parseVersion,
  updateVersions,
  versionFiles,
} from './version.mjs'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requestedVersion = (process.argv[2] ?? '').trim()

function run(name, args, { capture = false, allowFailure = false } = {}) {
  const windowsNpm = process.platform === 'win32' && name === 'npm'
  const command = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : name
  const commandArgs = windowsNpm ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : ''
    throw new Error(`${name} ${args.join(' ')} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function ensureCleanWorktree() {
  const status = run('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true }).stdout.trim()
  if (status) {
    throw new Error(`Release builds require a clean Git worktree. Commit or stash these changes first:\n${status}`)
  }
}

function ensureTagIsAvailable(tag) {
  const result = run('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], {
    capture: true,
    allowFailure: true,
  })
  if (result.status === 0) throw new Error(`Git tag ${tag} already exists`)
}

function createReleaseCommit(version) {
  run('git', ['add', '--', ...versionFiles])
  run('git', ['commit', '-m', `chore: release v${version}`])
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
  console.log(`\nRelease v${version} built successfully.`)
  console.log(`Installer: ${artifact}`)
  console.log(`SHA256: ${sha256}`)
}

function main() {
  ensureCleanWorktree()
  const currentVersion = assertVersionsMatch()
  const version = requestedVersion || nextPatchVersion(currentVersion)
  parseVersion(version)
  if (compareVersions(version, currentVersion) < 0) {
    throw new Error(`Requested version ${version} is older than current version ${currentVersion}`)
  }

  const tag = `v${version}`
  ensureTagIsAvailable(tag)
  console.log(`Preparing Axonkey ${currentVersion} -> ${version}`)

  if (version !== currentVersion) {
    updateVersions(version)
    const synchronizedVersion = assertVersionsMatch()
    if (synchronizedVersion !== version) throw new Error('Version synchronization failed')
    createReleaseCommit(version)
  }

  run('git', ['tag', '--annotate', tag, '--message', `Axonkey ${version}`])
  console.log(`Created Git tag ${tag}`)
  build(version)
}

try {
  main()
} catch (error) {
  console.error(`\nRelease build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
