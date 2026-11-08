export const deviceInputSelectionStorageKey = 'axonkey.device-input-selection.v1'

export function getStoredDeviceInput<Id extends string>(deviceId: string, inputIds: readonly Id[]): Id {
  const selected = readSelections()[deviceId]
  return inputIds.find(id => id === selected) ?? inputIds[0]
}

export function storeDeviceInput(deviceId: string, inputId: string): void {
  try {
    const selections = readSelections()
    selections[deviceId] = inputId
    window.localStorage.setItem(deviceInputSelectionStorageKey, JSON.stringify(selections))
  } catch {
    // Selection remains usable when local storage is unavailable.
  }
}

function readSelections(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(deviceInputSelectionStorageKey) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Missing or invalid UI state falls back to the first input.
  }
  return {}
}
