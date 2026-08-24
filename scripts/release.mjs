import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertVersionsMatch,
  compareVersions,
  nextPatchVersion,
  numericVersion,
  readEnvVersion,
  updateVersions,
  versionFiles,
} from './version.mjs'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requestedTag = (process.argv[2] ?? '').trim()
const envFile = process.env.ENV_FILE || '.env'

function run(name, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(name, args, {
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
    throw new Error(`Releases require a clean Git worktree. Commit or stash these changes first:\n${status}`)
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
  const stagedDiff = run('git', ['diff', '--cached', '--quiet', '--'], { allowFailure: true })
  if (stagedDiff.status === 1) run('git', ['commit', '-m', `chore: release v${version}`])
  if (stagedDiff.status !== 0 && stagedDiff.status !== 1) {
    throw new Error(`git diff --cached --quiet failed with exit code ${stagedDiff.status}`)
  }
}

function main() {
  const currentTag = readEnvVersion(envFile)
  const currentVersion = numericVersion(currentTag)
  ensureCleanWorktree()
  const tag = requestedTag || `v${nextPatchVersion(currentVersion)}`
  const version = numericVersion(tag)
  if (compareVersions(version, currentVersion) < 0) {
    throw new Error(`Requested version ${version} is older than current version ${currentVersion}`)
  }

  ensureTagIsAvailable(tag)
  console.log(`Preparing Axonkey ${currentTag} -> ${tag}`)

  updateVersions(version, envFile)
  const synchronizedVersion = assertVersionsMatch(envFile)
  if (synchronizedVersion !== version) throw new Error('Version synchronization failed')
  createReleaseCommit(version)

  run('git', ['tag', '--annotate', tag, '--message', `Axonkey ${version}`])
  console.log(`Released ${tag}: version metadata committed and tagged`)
}

try {
  main()
} catch (error) {
  console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
