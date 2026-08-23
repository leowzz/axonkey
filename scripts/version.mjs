import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const versionFiles = [
  '.env.example',
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
]

const tagVersionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function absolutePath(root, path) {
  return isAbsolute(path) ? path : join(root, path)
}

function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(absolutePath(root, path), 'utf8'))
  } catch (error) {
    throw new Error(`${path}: invalid or missing JSON`, { cause: error })
  }
}

function jsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function linesWithEndings(source) {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function lineValue(line) {
  return line.replace(/\r?\n$/, '')
}

function findTomlSectionVersion(source, header, path) {
  const lines = linesWithEndings(source)
  const sections = lines
    .map((line, index) => [lineValue(line).trim(), index])
    .filter(([line]) => line === header)
  if (sections.length !== 1) throw new Error(`${path}: expected exactly one ${header} section`)

  const start = sections[0][1] + 1
  const end = lines.findIndex((line, index) => index >= start && /^\s*\[/.test(lineValue(line)))
  const sectionEnd = end === -1 ? lines.length : end
  const versions = []
  for (let index = start; index < sectionEnd; index += 1) {
    if (/^\s*version\s*=\s*"[^"]+"\s*$/.test(lineValue(lines[index]))) versions.push(index)
  }
  if (versions.length !== 1) throw new Error(`${path}: expected exactly one version field in ${header}`)
  return { lines, index: versions[0] }
}

function findCargoLockPackageVersion(source, packageName, path) {
  const lines = linesWithEndings(source)
  const starts = lines
    .map((line, index) => [lineValue(line).trim(), index])
    .filter(([line]) => line === '[[package]]')
    .map(([, index]) => index)
  const candidates = []

  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position] + 1
    const end = starts[position + 1] ?? lines.length
    const names = []
    const versions = []
    for (let index = start; index < end; index += 1) {
      const line = lineValue(lines[index])
      if (/^name\s*=\s*"[^"]+"\s*$/.test(line)) names.push(line.match(/"([^"]+)"/)?.[1])
      if (/^version\s*=\s*"[^"]+"\s*$/.test(line)) versions.push(index)
    }
    if (names.length === 1 && names[0] === packageName) candidates.push({ versions })
  }

  if (candidates.length !== 1) throw new Error(`${path}: expected exactly one ${packageName} package`)
  if (candidates[0].versions.length !== 1) {
    throw new Error(`${path}: expected exactly one version field for ${packageName}`)
  }
  return { lines, index: candidates[0].versions[0] }
}

function quotedVersion(line) {
  const value = lineValue(line).match(/"([^"]+)"/)?.[1]
  if (!value) throw new Error('Version field is missing a quoted value')
  return value
}

function updatedTomlSection(source, header, version, path) {
  const { lines, index } = findTomlSectionVersion(source, header, path)
  const indent = lineValue(lines[index]).match(/^\s*/)?.[0] ?? ''
  lines[index] = `${indent}version = "${version}"\n`
  return lines.join('')
}

function updatedCargoLockPackage(source, packageName, version, path) {
  const { lines, index } = findCargoLockPackageVersion(source, packageName, path)
  lines[index] = `version = "${version}"\n`
  return lines.join('')
}

export function validateTagVersion(value) {
  const match = tagVersionPattern.exec(value)
  if (!match) throw new Error(`Invalid version "${value}". Expected vMAJOR.MINOR.PATCH, for example v0.2.6.`)
  return value
}

export function numericVersion(tag) {
  return validateTagVersion(tag).slice(1)
}

export function nextPatchTag(tag) {
  const match = tagVersionPattern.exec(validateTagVersion(tag))
  const [major, minor, patch] = match.slice(1).map(Number)
  return `v${major}.${minor}.${patch + 1}`
}

export function readEnvVersion(root = repositoryRoot, envFile = '.env') {
  let source
  try {
    source = readFileSync(absolutePath(root, envFile), 'utf8')
  } catch (error) {
    throw new Error(`Missing ${envFile}; run: cp .env.example .env (PowerShell: Copy-Item .env.example .env)`, {
      cause: error,
    })
  }
  const normalized = source.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const lines = normalized.split('\n')
  if (lines.length !== 1 || !lines[0].startsWith('version=')) {
    throw new Error(`${envFile} must contain exactly one version=vX.Y.Z line`)
  }
  return validateTagVersion(lines[0].slice('version='.length))
}

export function readVersions(root = repositoryRoot) {
  const packageJson = readJson(root, 'package.json')
  const packageLock = readJson(root, 'package-lock.json')
  const tauriConfig = readJson(root, 'src-tauri/tauri.conf.json')
  if (typeof packageJson?.version !== 'string') throw new Error('package.json: root version must be a string')
  if (typeof packageLock?.version !== 'string') throw new Error('package-lock.json: root version must be a string')
  if (typeof packageLock?.packages?.['']?.version !== 'string') {
    throw new Error('package-lock.json: packages root version must be a string')
  }
  if (typeof tauriConfig?.version !== 'string') {
    throw new Error('src-tauri/tauri.conf.json: root version must be a string')
  }
  const cargoTomlPath = 'src-tauri/Cargo.toml'
  const cargoLockPath = 'src-tauri/Cargo.lock'
  const cargoToml = readFileSync(absolutePath(root, cargoTomlPath), 'utf8')
  const cargoLock = readFileSync(absolutePath(root, cargoLockPath), 'utf8')
  const cargoManifestVersion = findTomlSectionVersion(cargoToml, '[package]', cargoTomlPath)
  const cargoPackageVersion = findCargoLockPackageVersion(cargoLock, 'axonkey', cargoLockPath)

  return {
    '.env.example': numericVersion(readEnvVersion(root, '.env.example')),
    'package.json': packageJson?.version,
    'package-lock.json': packageLock?.version,
    'package-lock.json root package': packageLock?.packages?.['']?.version,
    'src-tauri/Cargo.toml': quotedVersion(cargoManifestVersion.lines[cargoManifestVersion.index]),
    'src-tauri/Cargo.lock': quotedVersion(cargoPackageVersion.lines[cargoPackageVersion.index]),
    'src-tauri/tauri.conf.json': tauriConfig?.version,
  }
}

export function checkVersions(expectedTag, root = repositoryRoot) {
  const envTag = readEnvVersion(root)
  const targetTag = expectedTag ? validateTagVersion(expectedTag) : envTag
  const targetVersion = numericVersion(targetTag)
  const versions = readVersions(root)
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== targetVersion)
    .map(([path, version]) => `${path}=${version ?? 'missing'}`)
  if (envTag !== targetTag) mismatches.unshift(`.env=${envTag}`)
  if (mismatches.length > 0) {
    throw new Error(`Repository version ${targetTag} mismatch: ${mismatches.join(', ')}`)
  }
  return targetTag
}

export function updateVersions(tag, root = repositoryRoot) {
  const version = numericVersion(tag)

  readEnvVersion(root)
  readVersions(root)

  const packageJson = readJson(root, 'package.json')
  packageJson.version = version

  const packageLock = readJson(root, 'package-lock.json')
  if (!packageLock?.packages?.['']) throw new Error('package-lock.json: packages root entry is required')
  packageLock.version = version
  packageLock.packages[''].version = version

  const tauriConfig = readJson(root, 'src-tauri/tauri.conf.json')
  tauriConfig.version = version

  const cargoTomlPath = 'src-tauri/Cargo.toml'
  const cargoLockPath = 'src-tauri/Cargo.lock'
  const cargoToml = readFileSync(absolutePath(root, cargoTomlPath), 'utf8')
  const cargoLock = readFileSync(absolutePath(root, cargoLockPath), 'utf8')
  const contents = new Map([
    ['.env', `version=${tag}\n`],
    ['.env.example', `version=${tag}\n`],
    ['package.json', jsonContent(packageJson)],
    ['package-lock.json', jsonContent(packageLock)],
    [cargoTomlPath, updatedTomlSection(cargoToml, '[package]', version, cargoTomlPath)],
    [cargoLockPath, updatedCargoLockPackage(cargoLock, 'axonkey', version, cargoLockPath)],
    ['src-tauri/tauri.conf.json', jsonContent(tauriConfig)],
  ])

  for (const [path, content] of contents) writeFileSync(absolutePath(root, path), content, 'utf8')
}
