import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  for (const file of ['MiRemoteV2ch-Install.pkg', 'MiRemoteV2ch-Uninstall.pkg']) {
    const path = join(root, 'src-tauri', 'resources', 'macos', file)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Missing macOS audio resource: ${path}. Run make build-macos-audio first.`)
    }
  }
}
