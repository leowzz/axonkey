import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes.ts'
import { normalizeBehavior, parseSequenceImport, serializeSequence } from '../behaviorModel.ts'
import type { SavedSequence } from '../savedSequences.ts'
import type { RelayClient } from './relayClient.ts'

const endpoint = '/v2/behavior-library'
export type LibraryView = 'recommended' | 'community'
export type LibraryPage = { steps: StepDefinition[]; nextCursor: string; skipped: number }
export type SharedSequence = {
  id: string
  revision: number
  source_sequence_key: string
  status: 'active' | 'blocked'
  block_reason?: string
  published_version_id: string | null
  latest_version: { id: string; status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; review_note?: string }
}

// Decode at the cloud boundary. Never adopt only part of a sequence.
export function parseLibraryPage(value: unknown, platform: Platform, builtins: StepDefinition[]): LibraryPage {
  const page = value as { items?: unknown[]; next_cursor?: unknown } | null
  if (!page || !Array.isArray(page.items) || (page.next_cursor !== undefined && typeof page.next_cursor !== 'string'))
    throw new Error('行为库响应无法读取')
  const steps: StepDefinition[] = []
  let skipped = 0
  for (const raw of page.items) {
    const item = raw as {
      id?: unknown
      version_id?: unknown
      title?: unknown
      source?: unknown
      content_schema_version?: unknown
      platforms?: unknown
      author_display_name?: unknown
      content?: { kind?: unknown; preset?: unknown; behaviors?: unknown }
    } | null
    let step: StepDefinition | undefined
    if (
      item &&
      typeof item.id === 'string' &&
      typeof item.version_id === 'string' &&
      typeof item.title === 'string' &&
      item.title.trim() &&
      (item.source === 'official' || item.source === 'community') &&
      item.content_schema_version === 1 &&
      Array.isArray(item.platforms) &&
      item.platforms.includes(platform)
    ) {
      if (item.content?.kind === 'builtin' && item.source === 'official') {
        const builtin = builtins.find(step => step.type === item.content?.preset)
        if (builtin) step = structuredClone(builtin)
      } else if (
        item.content?.kind === 'sequence' &&
        Array.isArray(item.content.behaviors) &&
        item.content.behaviors.length > 0 &&
        item.content.behaviors.length <= 100
      ) {
        const behaviors = item.content.behaviors.map(entry => normalizeBehavior(entry))
        if (
          behaviors.every(entry => entry !== null) &&
          (behaviors.length === 1 || !behaviors.some(entry => entry?.type === 'switchProfile'))
        ) {
          step = {
            componentType: 'task',
            type: 'savedSequence',
            name: item.title,
            properties: { sequence: serializeSequence(behaviors) },
          }
        }
      }
      if (step) {
        step.name = item.title
        step.properties = {
          ...step.properties,
          libraryItemId: item.id,
          libraryVersionId: item.version_id,
          author: typeof item.author_display_name === 'string' ? item.author_display_name : '',
        }
        steps.push(step)
      }
    }
    if (!step) skipped++
  }
  return { steps, nextCursor: (page.next_cursor as string) ?? '', skipped }
}

export async function fetchLibraryPage(
  client: RelayClient,
  platform: Platform,
  view: LibraryView,
  query: string,
  cursor: string,
  builtins: StepDefinition[],
) {
  const params = new URLSearchParams({ app_id: 'axonkey', platform, view, limit: '25' })
  if (query) params.set('q', query)
  if (cursor) params.set('cursor', cursor)
  return parseLibraryPage(await client.request('GET', `${endpoint}?${params}`, undefined, false), platform, builtins)
}

export async function findSharedSequence(client: RelayClient, sequenceId: string): Promise<SharedSequence | null> {
  for (let offset = 0; ; offset += 100) {
    const page = await client.request<{ items: SharedSequence[]; total: number }>(
      'GET',
      `${endpoint}/mine?app_id=axonkey&limit=100&offset=${offset}`,
    )
    const found = page.items.find(item => item.source_sequence_key === sequenceId)
    if (found) return found
    if (!page.items.length || offset + page.items.length >= page.total) return null
  }
}

export function submitSequence(
  client: RelayClient,
  sequence: SavedSequence,
  platform: Platform,
  note: string,
  resubmit: boolean,
) {
  const behaviors = parseSequenceImport(sequence.sequence)
  if (!behaviors?.length) throw new Error('此序列无法分享，请重新保存')
  return client.request<SharedSequence>('POST', `${endpoint}/submissions`, {
    app_id: 'axonkey',
    source_sequence_key: sequence.id,
    confirmed: true,
    submission_note: note.trim(),
    resubmit,
    snapshot: {
      title: sequence.name,
      category_code: 'composite',
      platforms: [platform],
      content_schema_version: 1,
      content: { kind: 'sequence', behaviors },
    },
  })
}

export async function withdrawSequence(client: RelayClient, item: SharedSequence, unpublish: boolean) {
  const updated = await client.request<Omit<SharedSequence, 'latest_version'>>(
    'POST',
    `${endpoint}/mine/${encodeURIComponent(item.id)}/${unpublish ? 'unpublish' : 'withdraw'}?app_id=axonkey`,
    { version_id: unpublish ? item.published_version_id : item.latest_version.id },
    true,
    { ifMatch: `"behavior-library:${item.id}:${item.revision}"` },
  )
  return {
    ...updated,
    latest_version: {
      ...item.latest_version,
      status: item.latest_version.status === 'pending' ? ('withdrawn' as const) : item.latest_version.status,
    },
  }
}

export async function recordLibraryAddition(client: RelayClient, itemId: string, platform: Platform) {
  try {
    await client.request(
      'POST',
      `${endpoint}/${encodeURIComponent(itemId)}/additions`,
      { app_id: 'axonkey', platform, count: 1 },
      false,
    )
  } catch {
    // Popularity statistics must never delay or roll back a local edit.
  }
}
