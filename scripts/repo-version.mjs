#!/usr/bin/env node

import {
  checkVersions,
  nextPatchTag,
  numericVersion,
  readEnvVersion,
  updateVersions,
} from './version.mjs'

function optionValue(args, option) {
  const index = args.indexOf(option)
  if (index === -1) return undefined
  if (!args[index + 1]) throw new Error(`${option} requires a value`)
  return args[index + 1]
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'get') {
    const envFile = optionValue(args, '--env-file') ?? '.env'
    let tag = readEnvVersion(undefined, envFile)
    if (args.includes('--bump-patch')) tag = nextPatchTag(tag)
    console.log(args.includes('--numeric') ? numericVersion(tag) : tag)
    return
  }
  if (command === 'set') {
    if (args.length !== 1) throw new Error('Usage: repo-version.mjs set vX.Y.Z')
    updateVersions(args[0])
    return
  }
  if (command === 'check') {
    const envFile = optionValue(args, '--env-file')
    const expectedTag = args.find((arg, index) => arg !== '--env-file' && args[index - 1] !== '--env-file')
    if (args.filter((arg) => arg !== '--env-file' && arg !== envFile).length > 1) {
      throw new Error('Usage: repo-version.mjs check [vX.Y.Z] [--env-file PATH]')
    }
    checkVersions(expectedTag, undefined, envFile ?? '.env')
    return
  }
  throw new Error('Usage: repo-version.mjs <get|set|check>')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
