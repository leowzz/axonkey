import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const project = join(root, 'tools', 'uninstall-old-driver')

const required = [
  'tools/uninstall-old-driver/uninstall-old-driver.sln',
  'tools/uninstall-old-driver/uninstall-old-driver.vcxproj',
  'tools/uninstall-old-driver/CMakeLists.txt',
  'tools/uninstall-old-driver/src/main.cpp',
  'tools/uninstall-old-driver/README.md',
  'scripts/build-uninstall-old-driver.mjs',
  'scripts/uninstall-old-driver.exe',
]

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}: ${(result.stderr || '').trim()}`)
  }
  return result
}

function isTracked(path) {
  return git(['ls-files', '--error-unmatch', '--', path], { allowFailure: true }).status === 0
}

function isPendingAdd(path) {
  const status = git(['status', '--porcelain=v1', '--', path]).stdout.trim()
  return status.split(/\r?\n/).some(line => line && (line.startsWith('?? ') || line.startsWith('A ') || line.startsWith('AM ')))
}

function isPendingDeletion(path) {
  const status = git(['status', '--porcelain=v1', '--', path]).stdout
  return status.split(/\r?\n/).some(line => line && (line.startsWith(' D ') || line.startsWith('D  ')))
}

function assertPresent(path, { tracked = false } = {}) {
  const absolute = join(root, ...path.split('/'))
  if (!existsSync(absolute)) throw new Error(`Required uninstall-old-driver file is missing: ${path}`)
  if (tracked && !isTracked(path)) throw new Error(`The bundled helper must be tracked by Git: ${path}`)
  if (!tracked && !isTracked(path) && !isPendingAdd(path)) {
    throw new Error(`The VC project file is neither tracked nor a pending Git add: ${path}`)
  }
}

for (const path of required) assertPresent(path, { tracked: path.endsWith('.exe') })

for (const generated of [
  'tools/uninstall-old-driver/build/CMakeCache.txt',
  'tools/uninstall-old-driver/bin/Release/uninstall-old-driver.exe',
  'tools/uninstall-old-driver/obj/Release/uninstall-old-driver.obj',
]) {
  const ignored = git(['check-ignore', '--quiet', '--no-index', '--', generated], { allowFailure: true }).status === 0
  if (!ignored) throw new Error(`Generated VC output is not protected by .gitignore: ${generated}`)
}

if ((isTracked('tools/uninstall-old-driver/Cargo.toml') && !isPendingDeletion('tools/uninstall-old-driver/Cargo.toml'))
  || (isTracked('tools/uninstall-old-driver/src/main.rs') && !isPendingDeletion('tools/uninstall-old-driver/src/main.rs'))) {
  throw new Error('The old Rust helper is still tracked at tools/uninstall-old-driver; use tools/uninstall-old-driver-rust instead.')
}

const references = [
  'Makefile',
  'package.json',
  'scripts/build-uninstall-old-driver.mjs',
  'test/legacy-cleanup-script.test.mjs',
  '.github/workflows/build-tag.yml',
]
for (const path of references) {
  const absolute = join(root, ...path.split('/'))
  if (!existsSync(absolute)) continue
  const contents = readFileSync(absolute, 'utf8')
  if (contents.includes('tools/uninstall-old-driver/Cargo.toml') || contents.includes('tools/uninstall-old-driver/src/main.rs')) {
    throw new Error(`Found a stale Rust helper reference in ${path}`)
  }
}

console.log(`Git layout check passed for ${relative(root, project).replaceAll('\\', '/')}`)
