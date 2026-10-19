import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The helper is a Windows-only bundled resource. Tauri builds for other
// platforms do not need to compile or copy it.
if (process.platform !== 'win32') process.exit(0)

const project = join(root, 'tools', 'uninstall-old-driver')
const solution = join(project, 'uninstall-old-driver.sln')
const source = join(project, 'CMakeLists.txt')
const resource = join(root, 'scripts', 'uninstall-old-driver.exe')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
  if (result.error) return { available: false, status: 1 }
  return { available: true, status: result.status ?? 1 }
}

function findMsbuild() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
  ]

  for (const vswhere of candidates) {
    if (!existsSync(vswhere)) continue
    const result = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8', windowsHide: true })
    const path = result.stdout?.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (path && existsSync(path)) return path
  }

  const where = spawnSync('where.exe', ['msbuild'], { encoding: 'utf8', windowsHide: true })
  const path = where.stdout?.trim().split(/\r?\n/).filter(Boolean)[0]
  return path && existsSync(path) ? path : null
}

if (!existsSync(solution) || !existsSync(source)) {
  throw new Error(`The uninstall-old-driver C++ project is incomplete: ${project}`)
}

const msbuild = findMsbuild()
let build
if (msbuild) {
  console.log(`Building uninstall-old-driver with ${msbuild}`)
  build = run(msbuild, [solution, '/m', '/p:Configuration=Release', '/p:Platform=x64'])
}

if (!build || !build.available || build.status !== 0) {
  if (msbuild) console.log('MSBuild could not use the requested v145 toolset; using the CMake toolchain fallback.')
  else console.log('Visual Studio MSBuild was not found; using the CMake toolchain fallback.')
  const buildDir = join(project, 'build')
  const configure = run('cmake', ['-S', project, '-B', buildDir, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'])
  if (configure.status !== 0) process.exit(configure.status)
  build = run('cmake', ['--build', buildDir, '--config', 'Release'])
}

if (!build.available || build.status !== 0) process.exit(build.status || 1)

const output = join(project, 'bin', 'Release', 'uninstall-old-driver.exe')
if (!existsSync(output)) {
  console.error(`Helper build completed but the executable was not found: ${output}`)
  process.exit(1)
}

mkdirSync(dirname(resource), { recursive: true })
copyFileSync(output, resource)
console.log(`Built uninstall-old-driver: ${resource}`)
