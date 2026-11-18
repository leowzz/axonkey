import { useState } from 'react'
import { appStorage } from '../appStorage.ts'

export const mappingPanelLayoutStorageKey = 'axonkey.mapping-panel-layout.v1'
export type MappingPanelWidths = { diagram?: number; library?: number }

export function readMappingPanelWidths(deviceId: string): MappingPanelWidths {
  const entry = readLayouts()[deviceId]
  if (!entry || typeof entry !== 'object') return {}
  const result: MappingPanelWidths = {}
  for (const panel of ['diagram', 'library'] as const) {
    const value = (entry as Record<string, unknown>)[panel]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[panel] = value
  }
  return result
}

export function storeMappingPanelWidths(deviceId: string, widths: MappingPanelWidths) {
  try {
    appStorage.setItem(mappingPanelLayoutStorageKey, JSON.stringify({ ...readLayouts(), [deviceId]: widths }))
  } catch {
    // Layout changes remain usable when local storage is unavailable.
  }
}

export function useMappingPanelWidths(deviceId: string) {
  const [state, setState] = useState(() => ({ deviceId, widths: readMappingPanelWidths(deviceId) }))
  const widths = state.deviceId === deviceId ? state.widths : readMappingPanelWidths(deviceId)
  const resize = (panel: keyof MappingPanelWidths, width: number | undefined) => {
    const next = { ...widths, [panel]: width }
    setState({ deviceId, widths: next })
    storeMappingPanelWidths(deviceId, next)
  }
  return { widths, resize }
}

function readLayouts(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(appStorage.getItem(mappingPanelLayoutStorageKey) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Corrupt preferences fall back to automatic sizing.
  }
  return {}
}
