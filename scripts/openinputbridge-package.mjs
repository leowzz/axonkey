import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const requiredOpenInputBridgeFiles = [
  'OpenInputBridgeSetup.exe',
  'oib_kbd/oib_kbd.inf',
  'oib_kbd/oib_kbd.cat',
  'oib_kbd/oib_kbd.sys',
  'oib_mou/oib_mou.inf',
  'oib_mou/oib_mou.cat',
  'oib_mou/oib_mou.sys',
]

export function assertOpenInputBridgePackage(repositoryRoot) {
  const packageRoot = join(repositoryRoot, 'vendor', 'openinputbridge')
  const missing = requiredOpenInputBridgeFiles.filter((path) => !existsSync(join(packageRoot, path)))
  if (missing.length > 0) {
    throw new Error(
      `OpenInputBridge WHQL package is incomplete. Missing: ${missing.join(', ')}. `
      + 'See vendor/openinputbridge/SOURCE.md.',
    )
  }
  return packageRoot
}
