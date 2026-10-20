import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { publishUpdaterManifest } from '../scripts/publish-updater-manifest.mjs'

const publisher = fileURLToPath(new URL('../scripts/publish-updater-manifest.mjs', import.meta.url))
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const manifest = (version, signature = 'test-signature') => ({
  version,
  platforms: { 'darwin-aarch64': { url: `https://github.com/test/app/releases/download/v${version}/app.tar.gz`, signature } },
})

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'axonkey-publish-updater-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = join(directory, 'work')
  const remote = join(directory, 'remote.git')
  mkdirSync(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Update Test')
  git(root, 'config', 'user.email', 'update-test@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'user.txt'), 'original\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  git(root, 'init', '--bare', '-q', remote)
  git(root, 'remote', 'add', 'origin', remote)
  const file = (value, name = 'latest.json') => {
    const path = join(directory, name)
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  const publish = (value) => publishUpdaterManifest({ root, manifestPath: file(value) })
  const show = (major) => JSON.parse(git(root, '--git-dir', remote, 'show', `updates:v${major}/latest.json`))
  return { directory, root, remote, file, publish, show }
}

test('creates an independent updates branch and preserves the checkout, working files and index', (t) => {
  const fixture = repository(t)
  const { root, remote, publish, show } = fixture
  writeFileSync(join(root, 'user.txt'), 'staged user change\n')
  git(root, 'add', 'user.txt')
  writeFileSync(join(root, 'user.txt'), 'unstaged user change\n')
  const before = {
    head: git(root, 'rev-parse', 'HEAD'), index: readFileSync(join(root, '.git', 'index')),
    status: git(root, 'status', '--porcelain'), file: readFileSync(join(root, 'user.txt')),
  }
  assert.equal(publish(manifest('1.0.0')).updated, true)
  assert.deepEqual(show(1), manifest('1.0.0'))
  assert.equal(git(root, '--git-dir', remote, 'ls-tree', '--name-only', '-r', 'updates'), 'v1/latest.json')
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head)
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), before.index)
  assert.equal(git(root, 'status', '--porcelain'), before.status)
  assert.deepEqual(readFileSync(join(root, 'user.txt')), before.file)
})

test('keeps majors separate, refuses rollback and refreshes signatures on a same-version rebuild', (t) => {
  const { root, remote, publish, show } = repository(t)
  publish(manifest('0.3.32'))
  publish(manifest('1.10.0'))
  assert.equal(publish(manifest('1.2.0')).updated, false)
  assert.equal(show(1).version, '1.10.0')
  assert.equal(show(0).version, '0.3.32')
  const head = git(root, '--git-dir', remote, 'rev-parse', 'updates')
  assert.equal(publish(manifest('1.10.0')).updated, false)
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'updates'), head)
  assert.equal(publish(manifest('1.10.0', 'rebuilt-signature')).updated, true)
  assert.equal(show(1).platforms['darwin-aarch64'].signature, 'rebuilt-signature')
  assert.equal(show(0).version, '0.3.32')
})

test('previews and invalid manifests never create an update channel', (t) => {
  const { root, publish } = repository(t)
  for (const value of [{}, null, manifest('1.0.0-beta.1'), manifest('invalid'), manifest('01.0.0')]) {
    assert.throws(() => publish(value))
  }
  assert.equal(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/updates'), '')
})

test('concurrent publishers preserve both majors and the highest version', async (t) => {
  const { root, file, show } = repository(t)
  const execute = promisify(execFile)
  const publish = (version) => execute(process.execPath, [publisher, file(manifest(version), `${version}.json`)], { cwd: root })
  await Promise.all([publish('0.3.32'), publish('1.0.0')])
  assert.equal(show(0).version, '0.3.32')
  assert.equal(show(1).version, '1.0.0')
  await Promise.all([publish('1.2.0'), publish('1.3.0')])
  assert.equal(show(1).version, '1.3.0')
  assert.equal(show(0).version, '0.3.32')
})

test('a rejected push fails without changing the checkout or creating the channel', { skip: process.platform === 'win32' }, (t) => {
  const { root, publish } = repository(t)
  const hook = join(root, '.git', 'hooks', 'pre-push')
  mkdirSync(dirname(hook), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  const before = git(root, 'rev-parse', 'HEAD')
  assert.throws(() => publish(manifest('1.0.0')))
  assert.equal(git(root, 'rev-parse', 'HEAD'), before)
  assert.equal(git(root, 'status', '--porcelain'), '')
  assert.equal(git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/updates'), '')
})
