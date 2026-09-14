import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function generateUpdaterManifest({ directory, version, repository, notes = '', date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected stable release version')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository')
  const asset = name => {
    if (!statSync(join(directory, name)).isFile()) throw new Error(`Missing update artifact: ${name}`)
    const signature = readFileSync(join(directory, `${name}.sig`), 'utf8').trim()
    if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`Invalid signature: ${name}`)
    return { url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`, signature }
  }
  const windows = asset(`Axonkey_${version}_x64-setup.exe`)
  const macos = asset('Axonkey.app.tar.gz')
  return {
    version, notes, pub_date: date,
    platforms: { 'windows-x86_64': windows, 'darwin-x86_64': macos, 'darwin-aarch64': macos },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] || 'release-assets')
  const manifest = generateUpdaterManifest({
    directory,
    version: (process.env.TAG_NAME || '').replace(/^v/, ''),
    repository: process.env.GITHUB_REPOSITORY,
    notes: `Axonkey ${process.env.TAG_NAME}`,
  })
  writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
