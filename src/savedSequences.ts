import { parseSequenceImport, serializeSequence } from './behaviorModel.ts'
import type { Behavior } from './behaviorModel.ts'

export const savedSequencesStorageKey = 'axonkey.saved-sequences.v1'
export type SavedSequence = { id: string; name: string; sequence: string }

export function parseSavedSequences(value: string | null): SavedSequence[] {
  if (value === null) return []
  const entries: unknown = JSON.parse(value)
  if (!Array.isArray(entries)) throw new Error('Invalid saved sequences')
  const ids = new Set<string>()
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid saved sequence')
    const { id, name, sequence } = entry as Partial<SavedSequence>
    const behaviors = parseSequenceImport(sequence)
    if (typeof id !== 'string' || !id || ids.has(id) || typeof name !== 'string' || !name.trim() || !behaviors?.length) throw new Error('Invalid saved sequence')
    ids.add(id)
    return { id, name: name.trim(), sequence: serializeSequence(behaviors) }
  })
}

export function createSavedSequence(name: string, behaviors: Behavior[]): SavedSequence {
  const cleanName = name.trim().slice(0, 40)
  if (!cleanName || !behaviors.length) throw new Error('A name and sequence are required')
  return { id: crypto.randomUUID(), name: cleanName, sequence: serializeSequence(behaviors) }
}
