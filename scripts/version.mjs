import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const versionFiles = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
]

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

export function readVersions() {
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
    'src-tauri/Cargo.lock': extractVersion(
      cargoLock,
      /\[\[package\]\]\r?\nname = "axonkey"\r?\nversion = "([^"]+)"/,
      'src-tauri/Cargo.lock',
    ),
  }
}

export function assertVersionsMatch() {
  const versions = readVersions()
  const unique = new Set(Object.values(versions))
  if (unique.size !== 1 || unique.has(undefined)) {
    const detail = Object.entries(versions).map(([path, version]) => `  ${path}: ${version ?? 'missing'}`).join('\n')
    throw new Error(`Version files are out of sync:\n${detail}`)
  }
  return Object.values(versions)[0]
}

export function parseVersion(value) {
  const match = value.match(versionPattern)
  if (!match) throw new Error(`Invalid version "${value}". Expected MAJOR.MINOR.PATCH, for example 0.2.6.`)
  return match.slice(1).map(Number)
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function nextPatchVersion(current) {
  const [major, minor, patch] = parseVersion(current)
  return `${major}.${minor}.${patch + 1}`
}

function replaceVersion(path, pattern, replacement) {
  const absolutePath = join(repositoryRoot, path)
  const source = readFileSync(absolutePath, 'utf8')
  if (!pattern.test(source)) throw new Error(`Cannot update the Axonkey version in ${path}`)
  writeFileSync(absolutePath, source.replace(pattern, replacement), 'utf8')
}

export function updateVersions(version) {
  parseVersion(version)

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
