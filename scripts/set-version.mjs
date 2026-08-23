import { assertVersionsMatch, updateVersions } from './version.mjs'

const version = (process.argv[2] ?? '').trim()

try {
  updateVersions(version)
  const synchronizedVersion = assertVersionsMatch()
  if (synchronizedVersion !== version) throw new Error('Version synchronization failed')
  console.log(`Axonkey version synchronized to ${version}`)
} catch (error) {
  console.error(`Version synchronization failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
