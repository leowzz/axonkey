import { appStorage } from './appStorage.ts'

export const deviceInputSelectionStorageKey = 'axonkey.device-input-selection.v1'

export function getStoredDeviceInput<Id extends string>(deviceId: string, inputIds: readonly Id[]): Id {
  const selected = readSelections()[deviceId]
  return inputIds.find(id => id === selected) ?? inputIds[0]
}

export function storeDeviceInput(deviceId: string, inputId: string): void {
  try {
    const selections = readSelections()
    selections[deviceId] = inputId
    appStorage.setItem(deviceInputSelectionStorageKey, JSON.stringify(selections))
  } catch {
    // Selection remains usable when storage is unavailable.
  }
}

function readSelections(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(appStorage.getItem(deviceInputSelectionStorageKey) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Missing or invalid UI state falls back to the first input.
  }
  return {}
}
