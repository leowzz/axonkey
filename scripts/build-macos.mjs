import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputArgs = process.argv.slice(2)
const buildArgs = inputArgs.length > 0 ? inputArgs : ['--bundles', 'app,dmg']
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim()
const tauriArgs = ['run', 'tauri', '--', 'build', ...buildArgs]

if (signingIdentity) {
  tauriArgs.push('--config', JSON.stringify({
    bundle: { macOS: { signingIdentity } },
  }))
}

const build = spawnSync('npm', tauriArgs, { cwd: root, env: process.env, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const optionValue = (longName, shortName) => {
  const longIndex = buildArgs.indexOf(longName)
  if (longIndex >= 0) return buildArgs[longIndex + 1]
  const shortIndex = buildArgs.indexOf(shortName)
  if (shortIndex >= 0) return buildArgs[shortIndex + 1]
  const inline = buildArgs.find((argument) => argument.startsWith(`${longName}=`))
  return inline?.slice(longName.length + 1)
}

const bundles = optionValue('--bundles', '-b')
if (bundles && !bundles.split(',').includes('dmg')) process.exit(0)

const target = optionValue('--target', '-t')
const profile = buildArgs.includes('--debug') || buildArgs.includes('-d') ? 'debug' : 'release'
const targetRoot = target
  ? join(root, 'src-tauri', 'target', target, profile)
  : join(root, 'src-tauri', 'target', profile)
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
