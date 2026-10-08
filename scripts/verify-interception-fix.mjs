import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
export function verifyFiles(directory, files) {
  for (const [file, expected] of Object.entries(files)) {
    if (!/^[\w./-]+$/.test(file) || file.split('/').includes('..') || file.startsWith('/')) throw new Error('Unsafe manifest path')
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid SHA-256: ${file}`)
    const actual = createHash('sha256').update(readFileSync(resolve(directory, file))).digest('hex')
    if (actual !== expected) throw new Error(`Interception Fix SHA-256 mismatch: ${file}`)
  }
}
export function verifyArtifact(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
  if (manifest.upstreamCommit !== 'e1a7720863f514d51caf06b020da5c0d2e345c41' || manifest.vcpkgCommit !== '2750401336fb7c95f6619657a46a7e798661341c') throw new Error('Unexpected Interception Fix provenance')
  for (const file of ['axonkey-interception-fix.exe', 'licenses/interception-driver-fix.txt', 'licenses/scope-guard-MIT.txt', 'licenses/cli11.txt', 'licenses/fmt.txt', 'licenses/spdlog.txt', 'licenses/boost-algorithm.txt', 'licenses/phnt.txt']) {
    if (!manifest.files?.[file]) throw new Error(`Missing required artifact: ${file}`)
  }
  verifyFiles(directory, manifest.files)
  const bytes = readFileSync(resolve(directory, 'axonkey-interception-fix.exe'))
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1
  if (offset < 0 || offset + 6 > bytes.length || bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Expected an AMD64 PE service')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(root, 'third_party/interception-driver-fix')
  verifyFiles(directory, JSON.parse(readFileSync(resolve(directory, 'axonkey-source-sha256.json'), 'utf8')))
  if (process.argv.includes('--artifact')) verifyArtifact(resolve(root, 'vendor/interception-fix'))
  console.log('Interception Fix integrity verified (no service executed).')
}
