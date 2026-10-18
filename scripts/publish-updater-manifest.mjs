import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, isPrerelease, repositoryRoot } from './version.mjs'

function stableVersion(manifest) {
  if (typeof manifest?.version !== 'string' || isPrerelease(manifest.version)) {
    throw new Error('Update manifests require a stable version')
  }
  return manifest.version
}

export function publishUpdaterManifest({ manifestPath, root = repositoryRoot }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version = stableVersion(manifest)
  const path = `v${version.split('.')[0]}/latest.json`
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  const temporary = mkdtempSync(join(tmpdir(), 'axonkey-update-index-'))
  // A private index leaves the checked-out release and any working changes untouched.
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  }
  const git = (args, input) => execFileSync('git', args, {
    cwd: root, env, input, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  const ref = 'refs/heads/updates'
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const parent = git(['ls-remote', '--heads', 'origin', ref]).split(/\s+/)[0]
      if (parent) {
        git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', parent])
        if (git(['ls-tree', '--name-only', parent, '--', path])) {
          const previous = JSON.parse(git(['show', `${parent}:${path}`]))
          const previousVersion = stableVersion(previous)
          if (previousVersion.split('.')[0] !== version.split('.')[0]) throw new Error('Invalid channel major')
          if (compareVersions(previousVersion, version) > 0 || JSON.stringify(previous) === JSON.stringify(manifest)) {
            return { updated: false, version: previousVersion, path }
          }
        }
      }
      git(['read-tree', ...(parent ? [parent] : ['--empty'])])
      const blob = git(['hash-object', '-w', '--stdin'], content)
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
      const tree = git(['write-tree'])
      const commit = git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], `Update v${version.split('.')[0]} manifest to ${version}\n`)
      try {
        git(['push', 'origin', `${commit}:${ref}`])
        return { updated: true, version, path }
      } catch (error) {
        // Another release may have published concurrently; reload before retrying.
        if (attempt === 2) throw error
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = publishUpdaterManifest({
      manifestPath: resolve(process.argv[2] || 'release-assets/latest.json'), root: process.cwd(),
    })
    console.log(`${result.updated ? 'Published' : 'Kept'} ${result.path} at ${result.version}.`)
  } catch {
    console.error('Unable to publish update manifest; check the manifest, repository write permissions and updates branch.')
    process.exitCode = 1
  }
}
