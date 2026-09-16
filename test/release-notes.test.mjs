import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectReleaseChanges, generateReleaseNotes, summarizeRelease, responsesUrl } from '../scripts/generate-release-notes.mjs'

const config = { endpoint: 'https://example.com', apiKey: 'test-only', model: 'test-model', input: 'commits' }
const completed = { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### 修复\n- 修复问题。' }] }] }

test('normalizes Responses endpoint paths', () => {
  for (const base of ['https://example.com', 'https://example.com/', 'https://example.com/v1', 'https://example.com/v1/responses']) assert.equal(responsesUrl(base), 'https://example.com/v1/responses')
  assert.throws(() => responsesUrl('http://example.com'))
})

test('extracts only completed assistant text and sends Responses configuration', async () => {
  const notes = await summarizeRelease({ ...config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/v1/responses')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-only')
    const body = JSON.parse(options.body)
    assert.equal(body.model, config.model)
    assert.equal(body.store, false)
    assert.equal(body.stream, false)
    return { ok: true, json: async () => completed }
  } })
  assert.equal(notes, '### 修复\n- 修复问题。')
})

test('HTTP failure, invalid JSON, refusal, empty and incomplete results cause fallback', async () => {
  for (const data of [{ status: 'incomplete', output: completed.output }, { status: 'failed' }, { status: 'completed', output: [] }, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }]) {
    await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: true, json: async () => data }) }))
  }
  await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: false }) }))
  await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('invalid JSON') } }) }))
})

test('aborts a stalled request at its deadline', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(summarizeRelease({ ...config, timeoutMs: 10, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), { name: 'TimeoutError' })
  } finally { clearTimeout(keepAlive) }
})

function releaseRepository(t) {
  const root = mkdtempSync(join(tmpdir(), 'axonkey-release-notes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Release Test')
  git('config', 'user.email', 'release-test@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
  const commit = (tag, file) => {
    writeFileSync(join(root, file), `${file}\n`)
    git('add', '.')
    git('commit', '-qm', `Add ${file}`)
    git('tag', '-a', tag, '-m', tag)
    return git('rev-parse', 'HEAD')
  }
  const first = commit('v1.0.0', 'initial.txt')
  const failed = commit('v1.0.1', 'failed-release-feature.txt')
  commit('v1.0.2', 'draft-release-feature.txt')
  const preview = commit('v1.1.0-rc.1', 'preview-feature.txt')
  const current = commit('v1.1.0', 'current-feature.txt')
  const published = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-01T00:00:00Z', ...extra })
  const pages = [
    [published('v1.1.0'), published('v1.1.0-rc.1', { prerelease: true }), published('v1.0.2', { draft: true, published_at: null })],
    [published('v1.0.0')],
  ]
  const run = (program, args) => {
    if (program === 'git') return git(...args)
    assert.equal(program, 'gh')
    assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/test/axonkey/releases?per_page=100'])
    return JSON.stringify(pages)
  }
  return { git, commit, first, failed, preview, current, pages, published, options: { tag: 'v1.1.0', repo: 'test/axonkey', run } }
}

test('diff starts at the published stable commit and includes failed tags, drafts and previews across API pages', (t) => {
  const fixture = releaseRepository(t)
  const { input, fallback } = collectReleaseChanges(fixture.options)
  const changes = JSON.parse(input)
  assert.equal(changes.previousVersion, 'v1.0.0')
  assert.equal(changes.previousCommit, fixture.first)
  assert.equal(changes.currentCommit, fixture.current)
  for (const file of ['failed-release-feature.txt', 'draft-release-feature.txt', 'preview-feature.txt', 'current-feature.txt']) {
    assert.ok(changes.diff.includes(`+${file}`))
    assert.ok(changes.commits.includes(`Add ${file}`))
    assert.ok(fallback.includes(`Add ${file}`))
  }
  assert.ok(!changes.diff.includes('initial.txt'))
  assert.ok(!fallback.includes('Add initial.txt'))
  assert.ok(fallback.includes(`${fixture.first}...${fixture.current}`))
})

test('selects the closest published ancestor regardless of API order, excluding other branches and future commits', (t) => {
  const fixture = releaseRepository(t)
  fixture.pages[1].push(fixture.published('v1.0.1'))
  fixture.commit('v1.2.0', 'future.txt')
  fixture.git('checkout', '--detach', fixture.first)
  fixture.commit('v2.0.0', 'other-branch.txt')
  fixture.pages[0].unshift(fixture.published('v1.2.0'), fixture.published('v2.0.0'))
  const changes = JSON.parse(collectReleaseChanges(fixture.options).input)
  assert.equal(changes.previousCommit, fixture.failed)
  assert.equal(changes.currentCommit, fixture.current)
  assert.ok(!changes.diff.includes('future.txt'))
  assert.ok(!changes.diff.includes('other-branch.txt'))
})

test('preview release uses the previous published preview commit', (t) => {
  const fixture = releaseRepository(t)
  fixture.commit('v1.1.0-rc.2', 'next-preview.txt')
  fixture.pages[0] = fixture.pages[0].filter(release => release.tag_name !== 'v1.1.0')
  const changes = JSON.parse(collectReleaseChanges({ ...fixture.options, tag: 'v1.1.0-rc.2' }).input)
  assert.equal(changes.previousCommit, fixture.preview)
  assert.ok(!changes.diff.includes('failed-release-feature.txt'))
  assert.ok(changes.diff.includes('next-preview.txt'))
})

test('first published release includes the root commit despite existing failed tags and drafts', (t) => {
  const fixture = releaseRepository(t)
  fixture.pages.splice(0, fixture.pages.length, [fixture.published('v1.0.2', { draft: true })])
  const { input, fallback } = collectReleaseChanges(fixture.options)
  const changes = JSON.parse(input)
  assert.equal(changes.previousCommit, null)
  assert.equal(changes.previousVersion, null)
  assert.ok(changes.diff.includes('+initial.txt'))
  assert.ok(fallback.includes('Add initial.txt'))
})

test('LLM receives the commit range and code diff; missing configuration and provider failure retain that range', async (t) => {
  const fixture = releaseRepository(t)
  const generated = await generateReleaseNotes({ ...fixture.options, ...config, fetchImpl: async (_, options) => {
    const changes = JSON.parse(JSON.parse(options.body).input)
    assert.equal(changes.previousCommit, fixture.first)
    assert.ok(changes.diff.includes('+failed-release-feature.txt'))
    return { ok: true, json: async () => completed }
  } })
  assert.equal(generated.usedLlm, true)
  assert.equal(generated.notes, '### 修复\n- 修复问题。')
  for (const llm of [{}, { ...config, fetchImpl: async () => { throw new Error('provider unavailable') } }]) {
    const result = await generateReleaseNotes({ ...fixture.options, ...llm })
    assert.equal(result.usedLlm, false)
    assert.ok(result.notes.includes('Add failed-release-feature.txt'))
    assert.ok(!result.notes.includes('Add initial.txt'))
  }
})

test('release lookup failure is not mistaken for the first release', async (t) => {
  const fixture = releaseRepository(t)
  await assert.rejects(generateReleaseNotes({ ...fixture.options, run: (program, args) => {
    if (program === 'gh') throw new Error('release lookup failed')
    return fixture.options.run(program, args)
  } }), /release lookup failed/)
})
