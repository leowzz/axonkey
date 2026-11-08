import { libraryItemId, parseSequenceImport, serializeSequence } from './behaviorModel.ts'
import type { Behavior } from './behaviorModel.ts'

export const savedSequencesStorageKey = 'axonkey.saved-sequences.v1'
export type SavedSequence = { id: string; name: string; sequence: string; libraryItemIds?: (string | null)[] }

export function savedSequenceBehaviors(saved: Pick<SavedSequence, 'sequence' | 'libraryItemIds'>): Behavior[] | null {
  const behaviors = parseSequenceImport(saved.sequence)
  if (!behaviors || saved.libraryItemIds === undefined) return behaviors
  if (!Array.isArray(saved.libraryItemIds) || saved.libraryItemIds.length !== behaviors.length) return null
  for (const [index, source] of saved.libraryItemIds.entries()) {
    if (source === null) continue
    const itemId = libraryItemId(source)
    if (!itemId) return null
    behaviors[index].libraryItemId = itemId
  }
  return behaviors
}

export function savedSequenceContent(behaviors: Behavior[]): Pick<SavedSequence, 'sequence' | 'libraryItemIds'> {
  const libraryItemIds = behaviors.map(behavior => behavior.libraryItemId ?? null)
  return { sequence: serializeSequence(behaviors), ...(libraryItemIds.some(Boolean) ? { libraryItemIds } : {}) }
}

export function parseSavedSequences(value: string | null): SavedSequence[] {
  if (value === null) return []
  const entries: unknown = JSON.parse(value)
  if (!Array.isArray(entries)) throw new Error('Invalid saved sequences')
  const ids = new Set<string>()
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid saved sequence')
    const { id, name, sequence, libraryItemIds } = entry as Partial<SavedSequence>
    const behaviors = savedSequenceBehaviors({ sequence: sequence as string, libraryItemIds })
    if (typeof id !== 'string' || !id || ids.has(id) || typeof name !== 'string' || !name.trim() || !behaviors?.length)
      throw new Error('Invalid saved sequence')
    ids.add(id)
    return { id, name: name.trim(), ...savedSequenceContent(behaviors) }
  })
}

export function createSavedSequence(name: string, behaviors: Behavior[]): SavedSequence {
  const cleanName = name.trim().slice(0, 40)
  if (!cleanName || !behaviors.length) throw new Error('A name and sequence are required')
  return { id: crypto.randomUUID(), name: cleanName, ...savedSequenceContent(behaviors) }
}
