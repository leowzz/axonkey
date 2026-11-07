import { spawnSync } from 'node:child_process'

const marker = '--sequence-from-env'
const args = process.argv.slice(2)
const markerIndex = args.indexOf(marker)
if (markerIndex >= 0) {
  const sequence = process.env.SEQUENCE || process.env.ACTIONS
  if (!sequence) {
    console.error('SEQUENCE or ACTIONS must contain a JSON array')
    process.exit(2)
  }
  args.splice(markerIndex, 1, '--sequence', sequence)
}

const cliBin = process.env.CLI_BIN
if (!cliBin) {
  console.error('CLI_BIN is not set')
  process.exit(2)
}

const result = spawnSync(cliBin, args, { stdio: 'inherit', windowsHide: true })
if (result.error) {
  console.error(`Failed to start Axonkey CLI: ${result.error.message}`)
  process.exit(3)
}
process.exit(result.status ?? 1)
