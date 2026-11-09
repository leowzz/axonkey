import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputArgs = process.argv.slice(2)
const buildArgs = inputArgs.length > 0 ? inputArgs : ['--bundles', 'app,dmg']
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim()
const signedRelease = Boolean(signingIdentity && signingIdentity !== '-')
const tauriArgs = ['run', 'tauri', '--', 'build', ...buildArgs]
const optionValue = (longName, shortName) => {
  const longIndex = buildArgs.indexOf(longName)
  if (longIndex >= 0) return buildArgs[longIndex + 1]
  const shortIndex = buildArgs.indexOf(shortName)
  if (shortIndex >= 0) return buildArgs[shortIndex + 1]
  const inline = buildArgs.find((argument) => argument.startsWith(`${longName}=`))
  return inline?.slice(longName.length + 1)
}

const audioPackage = spawnSync(
  join(root, 'scripts', 'build-macos-audio-package.sh'),
  [],
  {
    cwd: root,
    env: {
      ...process.env,
      REQUIRE_SIGNED_INSTALLER: signedRelease ? '1' : (process.env.REQUIRE_SIGNED_INSTALLER ?? '0'),
    },
    stdio: 'inherit',
  },
)
if (audioPackage.status !== 0) process.exit(audioPackage.status ?? 1)

const profile = buildArgs.includes('--debug') || buildArgs.includes('-d') ? 'debug' : 'release'
const cargoProfileArgs = profile === 'debug' ? [] : ['--release']
const cargoManifest = join(root, 'src-tauri', 'Cargo.toml')
const target = optionValue('--target', '-t')
const targetRoot = target
  ? join(root, 'src-tauri', 'target', target, profile)
  : join(root, 'src-tauri', 'target', profile)

function runCargo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', ['build', '--manifest-path', cargoManifest, '--bin', 'axonkey-cli', ...args], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`cargo build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`))
      }
    })
  })
}

async function buildCliBinary() {
  if (target === 'universal-apple-darwin') {
    const architectures = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    const binaries = await Promise.all(architectures.map(async (architecture) => {
      await runCargo([...cargoProfileArgs, '--target', architecture])
      return join(root, 'src-tauri', 'target', architecture, profile, 'axonkey-cli')
    }))
    const universalBinary = join(targetRoot, 'axonkey-cli')
    mkdirSync(targetRoot, { recursive: true })
    const lipo = spawnSync('lipo', ['-create', ...binaries, '-output', universalBinary], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    if (lipo.status !== 0) process.exit(lipo.status ?? 1)
    return
  }

  await runCargo([...cargoProfileArgs, ...(target ? ['--target', target] : [])])
}

try {
  await buildCliBinary()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

if (signingIdentity) {
  tauriArgs.push('--config', JSON.stringify({
    bundle: { macOS: { signingIdentity } },
  }))
}

const build = spawnSync('npm', tauriArgs, { cwd: root, env: process.env, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const bundles = optionValue('--bundles', '-b')
if (bundles && !bundles.split(',').includes('dmg')) process.exit(0)
const dmgDirectory = join(targetRoot, 'bundle', 'dmg')
const dmgFiles = readdirSync(dmgDirectory)
  .filter((file) => file.endsWith('.dmg'))
  .map((file) => join(dmgDirectory, file))

if (dmgFiles.length === 0) {
  console.error(`No DMG files found in ${dmgDirectory}`)
  process.exit(1)
}

const postprocess = spawnSync(
  join(root, 'scripts', 'remove-dmg-volume-icon.sh'),
  dmgFiles,
  {
    cwd: root,
    env: { ...process.env, DMG_SIGNING_IDENTITY: signingIdentity ?? '' },
    stdio: 'inherit',
  },
)
process.exit(postprocess.status ?? 1)
