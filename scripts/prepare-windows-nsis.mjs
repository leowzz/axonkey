import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Match the toolchain pinned by @tauri-apps/cli 2.12.4.
const assets = [
  {
    repo: 'tauri-apps/binary-releases', tag: 'nsis-3.13', name: 'nsis-3.13.zip',
    sha256: 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8',
  },
  {
    repo: 'tauri-apps/nsis-tauri-utils', tag: 'nsis_tauri_utils-v0.5.3', name: 'nsis_tauri_utils.dll',
    sha256: '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
  },
]

export function prepareWindowsNsis(cacheDirectory) {
  mkdirSync(cacheDirectory, { recursive: true })
  const staging = mkdtempSync(join(cacheDirectory, 'nsis-download-'))
  try {
    for (const asset of assets) {
      downloadAsset(asset, staging)
      verifyAsset(join(staging, asset.name), asset.sha256)
    }
    extractNsisArchive(join(staging, assets[0].name), staging)
    const nsis = join(staging, 'nsis-3.13')
    const plugins = join(nsis, 'Plugins', 'x86-unicode', 'additional')
    mkdirSync(plugins, { recursive: true })
    renameSync(join(staging, assets[1].name), join(plugins, assets[1].name))
    const target = join(cacheDirectory, 'NSIS')
    rmSync(target, { recursive: true, force: true })
    renameSync(nsis, target)
    console.log(`Verified NSIS toolchain ready: ${target}`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function downloadAsset(asset, directory) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Downloading ${asset.name} through GitHub API (attempt ${attempt}/3)`)
    const result = spawnSync('gh', ['release', 'download', asset.tag, '--repo', asset.repo,
      '--pattern', asset.name, '--dir', directory, '--clobber'], { stdio: 'inherit', timeout: 120_000 })
    if (result.error) throw result.error
    if (result.status === 0) return
  }
  throw new Error(`Could not download ${asset.name} through GitHub API`)
}

export function verifyAsset(path, expectedHash) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== expectedHash) throw new Error(`SHA-256 mismatch: ${path}`)
}

function extractNsisArchive(archive, directory) {
  const result = spawnSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`NSIS extraction failed with exit code ${result.status}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-windows-nsis.mjs <tauri-cache-directory>')
    prepareWindowsNsis(resolve(process.argv[2]))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
