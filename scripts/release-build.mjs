import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requestedVersion = (process.argv[2] ?? '').trim()
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const versionFiles = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
]

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

function readJson(path) {
  return JSON.parse(readFileSync(join(repositoryRoot, path), 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(join(repositoryRoot, path), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function extractVersion(source, pattern, path) {
  const match = source.match(pattern)
  if (!match) throw new Error(`Cannot find the Axonkey version in ${path}`)
  return match[1]
}

function readVersions() {
  const packageJson = readJson('package.json')
  const packageLock = readJson('package-lock.json')
  const tauriConfig = readJson('src-tauri/tauri.conf.json')
  const cargoToml = readFileSync(join(repositoryRoot, 'src-tauri/Cargo.toml'), 'utf8')
  const cargoLock = readFileSync(join(repositoryRoot, 'src-tauri/Cargo.lock'), 'utf8')
  return {
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json root package': packageLock.packages?.['']?.version,
    'src-tauri/tauri.conf.json': tauriConfig.version,
    'src-tauri/Cargo.toml': extractVersion(cargoToml, /^version\s*=\s*"([^"]+)"/m, 'src-tauri/Cargo.toml'),
    'src-tauri/Cargo.lock': extractVersion(cargoLock, /\[\[package\]\]\r?\nname = "axonkey"\r?\nversion = "([^"]+)"/, 'src-tauri/Cargo.lock'),
  }
}

function assertVersionsMatch() {
  const versions = readVersions()
  const unique = new Set(Object.values(versions))
  if (unique.size !== 1 || unique.has(undefined)) {
    const detail = Object.entries(versions).map(([path, version]) => `  ${path}: ${version ?? 'missing'}`).join('\n')
    throw new Error(`Version files are out of sync:\n${detail}`)
  }
  return Object.values(versions)[0]
}

function parseVersion(value) {
  const match = value.match(versionPattern)
  if (!match) throw new Error(`Invalid version "${value}". Expected MAJOR.MINOR.PATCH, for example 0.2.6.`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function nextPatchVersion(current) {
  const [major, minor, patch] = parseVersion(current)
  return `${major}.${minor}.${patch + 1}`
}

function replaceVersion(path, pattern, replacement) {
  const absolutePath = join(repositoryRoot, path)
  const source = readFileSync(absolutePath, 'utf8')
  const next = source.replace(pattern, replacement)
  if (next === source) throw new Error(`Cannot update the Axonkey version in ${path}`)
  writeFileSync(absolutePath, next, 'utf8')
}

function updateVersions(version) {
  const packageJson = readJson('package.json')
  packageJson.version = version
  writeJson('package.json', packageJson)

  const packageLock = readJson('package-lock.json')
  packageLock.version = version
  if (!packageLock.packages?.['']) throw new Error('package-lock.json does not contain the root package')
  packageLock.packages[''].version = version
  writeJson('package-lock.json', packageLock)

  const tauriConfig = readJson('src-tauri/tauri.conf.json')
  tauriConfig.version = version
  writeJson('src-tauri/tauri.conf.json', tauriConfig)

  replaceVersion('src-tauri/Cargo.toml', /^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
  replaceVersion(
    'src-tauri/Cargo.lock',
    /(\[\[package\]\]\r?\nname = "axonkey"\r?\nversion = ")[^"]+("\r?\n)/,
    `$1${version}$2`,
  )
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
