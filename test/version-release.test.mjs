import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkVersions, updateVersions, versionFiles, compareVersions, numericVersion, nextPatchTag } from '../scripts/version.mjs'
import { verifyReleaseTag } from '../scripts/verify-release-tag.mjs'

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
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
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

  for (const script of ['release.sh', 'release.mjs', 'repo-version.mjs', 'version.mjs']) {
    // Fixtures must behave identically under Windows Git and bash/WSL Git.
    writeFileSync(join(root, 'scripts', script), readFileSync(join(projectRoot, 'scripts', script), 'utf8').replace(/\r\n/g, '\n'))
  }
  writeFileSync(join(root, 'Makefile'), readFileSync(join(projectRoot, 'Makefile')))
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
  // Windows' system32/bash.exe is WSL: it drops Windows environment overrides
  // and resolves a different git, making release fixtures behave incorrectly.
  let bash = 'bash'
  if (process.platform === 'win32') {
    const gitPath = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0]
    const candidates = gitPath ? [join(dirname(gitPath), '..', 'bin', 'bash.exe'), join(dirname(gitPath), '..', '..', 'bin', 'bash.exe'), join(dirname(gitPath), 'bash.exe')] : []
    bash = candidates.find(existsSync) ?? bash
  }
  const args = ['scripts/release.sh']
  if (process.platform === 'win32' && envOverrides.PATH) {
    env.AXONKEY_TEST_PATH = envOverrides.PATH
    // The Git Bash launcher prepends its own git directory; restore the test
    // shim after shell startup so the intentional tag failure is exercised.
    args.splice(0, 1, '-c', 'export PATH="$(cygpath -p -u "$AXONKEY_TEST_PATH")"; exec "$BASH" scripts/release.sh')
  }
  return run(root, bash, args, { check: false, env })
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

test('release tag may point to a commit on a non-main remote branch', (t) => {
  const root = seedRepository(t)
  git(root, 'branch', '-M', 'main')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'switch', '-qc', 'feat/mac')
  writeFileSync(join(root, 'feature.txt'), 'feature release\n')
  git(root, 'add', 'feature.txt')
  git(root, 'commit', '-qm', 'feature release')
  git(root, 'update-ref', 'refs/remotes/origin/feat/mac', 'HEAD')

  assert.deepEqual(verifyReleaseTag('v0.1.10', root), {
    version: '0.1.10',
    prerelease: false,
    branches: ['origin/feat/mac'],
  })
})

test('release tag is rejected when no remote branch contains its commit', (t) => {
  const root = seedRepository(t)
  assert.throws(
    () => verifyReleaseTag('v0.1.10', root),
    /does not point to a commit on any remote branch/,
  )
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
    '#!/bin/bash\nif [[ "$1" == "tag" ]]; then\n  echo tag creation failed >&2\n  exit 1\nfi\nif command -v cygpath >/dev/null; then ORIGINAL_PATH="$(cygpath -p -u "$ORIGINAL_PATH")"; fi\nPATH="$ORIGINAL_PATH" exec git "$@"\n',
  )
  chmodSync(wrapper, 0o755)

  const originalHead = git(root, 'rev-parse', 'HEAD').stdout.trim()
  const originalPath = process.env.PATH ?? ''
  const result = runRelease(root, undefined, {
    ORIGINAL_PATH: originalPath,
    PATH: `${wrapperDirectory}${delimiter}${originalPath}`,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /tag creation failed/)
  assert.notEqual(git(root, 'rev-parse', 'HEAD').stdout.trim(), originalHead)
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'chore: release v0.1.6')
  assert.equal(git(root, 'tag', '--list', 'v0.1.6').stdout.trim(), '')
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'version=v0.1.6\n')
})


test('prerelease versions sort by core, channel and numeric sequence', () => {
  const versions = ['1.2.2', '1.2.3-alpha.1', '1.2.3-alpha.2', '1.2.3-alpha.10',
    '1.2.3-beta.1', '1.2.3-rc.1', '1.2.3', '1.2.4-alpha.1']
  for (let i = 0; i < versions.length; i++) {
    assert.equal(compareVersions(versions[i], versions[i]), 0)
    for (let j = i + 1; j < versions.length; j++) {
      assert.ok(compareVersions(versions[i], versions[j]) < 0)
      assert.ok(compareVersions(versions[j], versions[i]) > 0)
    }
  }
  assert.equal(nextPatchTag('v1.2.3'), 'v1.2.4')
  assert.throws(() => nextPatchTag('v1.2.3-beta.1'), /explicit V/)
  for (const tag of ['v1.2.3-beta', 'v1.2.3-beta.0', 'v1.2.3-beta.01',
    'v1.2.3-preview.1', 'v1.2.3+build', 'v01.2.3', '1.2.3', 'v1.2.3-rc.1.extra']) {
    assert.throws(() => numericVersion(tag), /Invalid version/)
  }
})

for (const channel of ['alpha', 'beta', 'rc']) {
  test(`${channel} release synchronizes manifests and emits CI metadata`, (t) => {
    const root = seedRepository(t)
    const tag = `v1.2.3-${channel}.1`
    const result = runRelease(root, tag)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(checkVersions(tag, root), tag)
    assert.equal(git(root, 'cat-file', '-t', tag).stdout.trim(), 'tag')
    git(root, 'update-ref', 'refs/remotes/origin/preview', 'HEAD')
    assert.deepEqual(verifyReleaseTag(tag, root), {
      version: tag.slice(1), prerelease: true, branches: ['origin/preview'],
    })
    const output = join(root, '.git', 'github-output')
    const environment = join(root, '.git', 'github-env')
    run(root, process.execPath, [join(projectRoot, 'scripts/verify-release-tag.mjs'), tag], {
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_ENV: environment },
    })
    assert.equal(readFileSync(output, 'utf8'), `version=${tag.slice(1)}\nprerelease=true\n`)
    assert.equal(readFileSync(environment, 'utf8'), `APP_VERSION=${tag.slice(1)}\n`)
    const before = snapshotVersionFiles(root)
    const implicit = runRelease(root)
    assert.notEqual(implicit.status, 0)
    assert.match(implicit.stderr, /explicit V/)
    assert.deepEqual(snapshotVersionFiles(root), before)

    const older = runRelease(root, 'v1.2.2')
    assert.notEqual(older.status, 0)
    assert.match(older.stderr, /older than current/)
    assert.deepEqual(snapshotVersionFiles(root), before)

    const stable = runRelease(root, 'v1.2.3')
    assert.equal(stable.status, 0, stable.stderr)
    assert.equal(checkVersions('v1.2.3', root), 'v1.2.3')
  })
}


for (const prerelease of [false, true]) {
  for (const state of ['absent', 'draft', 'published']) {
    const exists = state !== 'absent'
    test(`publish workflow: prerelease=${prerelease}, release=${state}`, { skip: process.platform === 'win32' }, (t) => {
      const root = seedRepository(t)
      const bin = join(root, 'bin')
      mkdirSync(bin)
      mkdirSync(join(root, 'release-assets'))
      writeFileSync(join(root, 'release-assets', 'installer.exe'), 'fixture')
      const log = join(root, 'gh-calls.jsonl')
      const notesFile = join(root, 'release-notes.md')
      if (state !== 'published') writeFileSync(notesFile, 'Changes since the previous published commit')
      const gh = join(bin, 'gh')
      writeFileSync(gh, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\n');
if (args[1] === 'view') process.exit(process.env.RELEASE_EXISTS === 'true' ? 0 : 1);
`)
      chmodSync(gh, 0o755)
      const workflow = readFileSync(join(projectRoot, '.github/workflows/build-tag.yml'), 'utf8')
      const step = workflow.split('      - name: Create or update GitHub Release')[1]
      const script = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')
      const result = run(root, 'bash', ['-e', '-o', 'pipefail', '-c', script], {
        check: false,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
          CALL_LOG: log, RELEASE_EXISTS: String(exists), PRERELEASE: String(prerelease),
          TAG_NAME: prerelease ? 'v1.2.3-beta.1' : 'v1.2.3', GITHUB_REPOSITORY: 'test/axonkey',
          RELEASE_NOTES_FILE: notesFile },
      })
      assert.equal(result.status, 0, result.stderr)
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const create = calls.find(args => args[1] === 'create')
      assert.equal(Boolean(create), !exists)
      if (create) {
        assert.ok(create.includes('--draft'))
        assert.ok(create.includes('--notes-file'))
        assert.ok(create.includes(notesFile))
      }
      const edit = calls.find(args => args[1] === 'edit')
      for (const args of [create, edit].filter(Boolean)) {
        assert.ok(args.includes(`--prerelease=${prerelease}`))
        assert.equal(args.includes('--latest=false'), prerelease)
      }
      assert.ok(edit.includes('--draft=false'))
      assert.equal(edit.includes('--notes-file'), state !== 'published')
      const uploadIndex = calls.findIndex(args => args[1] === 'upload')
      assert.ok(uploadIndex < calls.indexOf(edit))
      assert.ok(calls[uploadIndex].includes('--clobber'))
    })
  }
}


for (const current of ['v0.2.29', 'v0.2.29-alpha.1']) {
  for (const [args, expected] of [
    [['RC=1'], 'v0.2.30-rc.1'],
    [['V=0.2.30', 'RC=3'], 'v0.2.30-rc.3'],
    [['V=v0.2.30', 'RC=3'], 'v0.2.30-rc.3'],
  ]) {
    test(`make release ${args.join(' ')} from ${current}`, { skip: process.platform === 'win32' }, (t) => {
      const root = seedRepository(t)
      updateVersions(current, root)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'set current version')
      const result = run(root, 'make', ['release', ...args], {
        check: false, env: { ...process.env, ENV_FILE: '.env', V: '', RC: '' },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(checkVersions(expected, root), expected)
      assert.equal(git(root, 'cat-file', '-t', expected).stdout.trim(), 'tag')
      assert.equal(git(root, 'status', '--porcelain').stdout.trim(), '')
    })
  }
}

test('bare V works without RC and the shell entry point forwards RC', (t) => {
  const root = seedRepository(t)
  let result = runRelease(root, '0.2.30', { RC: '3' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(checkVersions('v0.2.30-rc.3', root), 'v0.2.30-rc.3')
  result = runRelease(root, '0.2.30', { RC: '' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(checkVersions('v0.2.30', root), 'v0.2.30')
})

for (const [version, rc] of [['0.2.30', '0'], ['0.2.30', '01'], ['0.2.30', '-1'],
  ['0.2.30', '1.2'], ['0.2.30', 'x'], ['0.2.30', ' 1'], ['0.2.30-beta.1', '3']]) {
  test(`invalid RC combination V=${version} RC=${rc} does not mutate versions`, (t) => {
    const root = seedRepository(t)
    const before = snapshotVersionFiles(root)
    const head = git(root, 'rev-parse', 'HEAD').stdout.trim()
    const result = runRelease(root, version, { RC: rc })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /RC/)
    assert.deepEqual(snapshotVersionFiles(root), before)
    assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), head)
    assert.equal(git(root, 'tag', '--list').stdout.trim(), '')
  })
}
