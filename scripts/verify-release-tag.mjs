#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { numericVersion, isPrerelease } from './version.mjs'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function verifyReleaseTag(tagName, root = process.cwd()) {
  const version = numericVersion(tagName)

  let branches
  try {
    branches = git(root, [
      'for-each-ref',
      '--format=%(refname:short)',
      '--contains',
      'HEAD',
      'refs/remotes/origin',
    ])
      .split('\n')
      .filter((branch) => branch && branch !== 'origin/HEAD')
  } catch {
    throw new Error('Unable to inspect remote branches containing the tagged commit.')
  }

  if (branches.length === 0) {
    throw new Error(`Tag '${tagName}' does not point to a commit on any remote branch.`)
  }

  return { version, prerelease: isPrerelease(version), branches }
}

function appendGithubMetadata(version, prerelease) {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `APP_VERSION=${version}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`)
}

function main() {
  const tagName = process.argv[2]
  if (!tagName) throw new Error('Usage: verify-release-tag.mjs vMAJOR.MINOR.PATCH')
  const result = verifyReleaseTag(tagName)
  console.log(`Release commit is present on: ${result.branches.join(', ')}`)
  appendGithubMetadata(result.version, result.prerelease)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
