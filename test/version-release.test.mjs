import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkVersions, updateVersions, versionFiles } from '../scripts/version.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: options.env ?? process.env,
  })
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result
}

function git(root, ...args) {
  return run(root, 'git', args)
}

function seedRepository(t) {
  const root = mkdtempSync(join(tmpdir(), 'axonkey-release-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src-tauri'))

  writeFileSync(join(root, '.env'), 'version=v0.1.5\n')
  writeFileSync(join(root, '.env.example'), 'version=v0.1.5\n')
  writeFileSync(join(root, '.gitignore'), '.env\n')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'axonkey-ui', version: '0.1.5' }, null, 2)}\n`)
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'axonkey-ui',
    version: '0.1.5',
    lockfileVersion: 3,
    packages: {
      '': { name: 'axonkey-ui', version: '0.1.5' },
      'node_modules/dependency': { version: '0.1.5' },
    },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "axonkey"\nversion = "0.1.5"\n')
  writeFileSync(
    join(root, 'src-tauri', 'Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "axonkey"\nversion = "0.1.5"\n\n[[package]]\nname = "dependency"\nversion = "0.1.5"\n',
  )
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    `${JSON.stringify({ productName: 'Axonkey', version: '0.1.5' }, null, 2)}\n`,
  )

  for (const script of ['release.sh', 'repo-version.mjs', 'version.mjs']) {
    copyFileSync(join(projectRoot, 'scripts', script), join(root, 'scripts', script))
  }
  chmodSync(join(root, 'scripts', 'release.sh'), 0o755)

  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Release Test')
  git(root, 'config', 'user.email', 'release-test@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'tag.gpgsign', 'false')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  return root
}

function runRelease(root, version, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides }
  if (version) env.V = version
  else delete env.V
  return run(root, 'bash', ['scripts/release.sh'], { check: false, env })
}

function snapshotVersionFiles(root) {
  return Object.fromEntries(
    ['.env', ...versionFiles].map((path) => [path, readFileSync(join(root, path))]),
  )
}

test('version updater changes only repository-owned version fields', (t) => {
  const root = seedRepository(t)
  updateVersions('v1.2.3', root)

  assert.equal(checkVersions('v1.2.3', root), 'v1.2.3')
  assert.match(readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'), /name = "dependency"\nversion = "0\.1\.5"/)
  assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages['node_modules/dependency'].version, '0.1.5')
})

test('invalid repository metadata is rejected before any version file changes', (t) => {
  const root = seedRepository(t)
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{"version": 123}\n')
  const before = snapshotVersionFiles(root)

  assert.throws(() => updateVersions('v1.2.3', root), /root version must be a string/)
  assert.deepEqual(snapshotVersionFiles(root), before)
})

test('default release bumps patch, commits tracked versions, then creates an annotated tag', (t) => {
  const root = seedRepository(t)
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim()
  const result = runRelease(root)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'chore: release v0.1.6')
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim()
  assert.notEqual(head, before)
  assert.equal(git(root, 'rev-parse', 'v0.1.6^{}').stdout.trim(), head)
  assert.equal(git(root, 'cat-file', '-t', 'v0.1.6').stdout.trim(), 'tag')
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'version=v0.1.6\n')
  const committed = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout.trim().split('\n').sort()
  assert.deepEqual(committed, [...versionFiles].sort())
})

test('explicit release uses the requested tag version', (t) => {
  const root = seedRepository(t)
  const result = runRelease(root, 'v2.3.4')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(checkVersions('v2.3.4', root), 'v2.3.4')
})

for (const dirtyKind of ['staged', 'unstaged', 'untracked']) {
  test(`release rejects a ${dirtyKind} worktree without mutation`, (t) => {
    const root = seedRepository(t)
    if (dirtyKind === 'unstaged') {
      writeFileSync(join(root, '.env.example'), 'version=v9.9.9\n')
    } else {
      writeFileSync(join(root, 'dirty.txt'), 'dirty\n')
      if (dirtyKind === 'staged') git(root, 'add', 'dirty.txt')
    }
    const head = git(root, 'rev-parse', 'HEAD').stdout.trim()
    const envVersion = readFileSync(join(root, '.env'), 'utf8')

    const result = runRelease(root)

    assert.notEqual(result.status, 0)
    assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), head)
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), envVersion)
    assert.equal(git(root, 'tag', '--list', 'v0.1.6').stdout.trim(), '')
  })
}

test('release rejects an existing tag before changing files', (t) => {
  const root = seedRepository(t)
  git(root, 'tag', 'v0.1.6')
  const before = snapshotVersionFiles(root)

  const result = runRelease(root)

  assert.notEqual(result.status, 0)
  assert.deepEqual(snapshotVersionFiles(root), before)
})

test('release rejects invalid local version state before changing files', (t) => {
  const root = seedRepository(t)
  writeFileSync(join(root, '.env'), 'version=0.1.5\n')
  const before = snapshotVersionFiles(root)
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim()

  const result = runRelease(root)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Expected vMAJOR\.MINOR\.PATCH/)
  assert.deepEqual(snapshotVersionFiles(root), before)
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), head)
  assert.equal(git(root, 'tag', '--list').stdout.trim(), '')
})

test('a failing commit hook prevents tag creation and leaves changes visible', (t) => {
  const root = seedRepository(t)
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho commit hook failed >&2\nexit 1\n')
  chmodSync(hook, 0o755)

  const result = runRelease(root)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /commit hook failed/)
  assert.equal(git(root, 'tag', '--list', 'v0.1.6').stdout.trim(), '')
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'version=v0.1.6\n')
})

test('a tag failure leaves the release commit visible for diagnosis', (t) => {
  const root = seedRepository(t)
  const wrapperDirectory = mkdtempSync(join(tmpdir(), 'axonkey-git-wrapper-'))
  t.after(() => rmSync(wrapperDirectory, { recursive: true, force: true }))
  const wrapper = join(wrapperDirectory, 'git')
  writeFileSync(
    wrapper,
    '#!/usr/bin/env bash\nif [[ "$1" == "tag" ]]; then\n  echo tag creation failed >&2\n  exit 1\nfi\nPATH="$ORIGINAL_PATH" exec git "$@"\n',
  )
  chmodSync(wrapper, 0o755)

  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim()
  const originalPath = process.env.PATH ?? ''
  const result = runRelease(root, undefined, {
    ORIGINAL_PATH: originalPath,
    PATH: `${wrapperDirectory}:${originalPath}`,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /tag creation failed/)
  assert.notEqual(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead)
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'chore: release v0.1.6')
  assert.equal(git(root, 'tag', '--list', 'v0.1.6').stdout.trim(), '')
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'version=v0.1.6\n')
})
