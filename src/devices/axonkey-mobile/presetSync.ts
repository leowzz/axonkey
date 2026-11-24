import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { createBehavior, normalizeBehavior, type Behavior, type TriggerBehaviors } from '../../behaviorModel.ts'
import { replaceInstanceProfileBehaviors, type InstanceProfileBehaviors } from '../integration/instanceProfiles.ts'
import { setDynamicSupportPackageOverride } from '../integration/model.ts'
import type { DeviceController } from '../integration/useDeviceInstances.ts'
import {
  buildDynamicMobileSupportPackage,
  type DeckSnapshot,
  type StarterPresetId,
  type VoicePresetKind,
} from './dynamicSvg.ts'

export interface TileActionBindingsDto {
  tap?: unknown[]
  double?: unknown[]
  long?: unknown[]
  holdKeys?: string[]
}

export interface MobilePresetAppliedPayload {
  revision: number
  snapshot: DeckSnapshot
  bindings?: Record<string, TileActionBindingsDto>
  behaviors?: Record<string, unknown>
}

function normalizeBehaviorArray(items: unknown, prefix: string): Behavior[] {
  if (!Array.isArray(items)) return []
  const out: Behavior[] = []
  items.forEach((raw, idx) => {
    const parsed = normalizeBehavior(raw, `${prefix}-${idx + 1}`)
    if (parsed) out.push(parsed)
  })
  return out
}

export function convertPresetPayloadToProfileBehaviors(
  payload: Pick<MobilePresetAppliedPayload, 'bindings' | 'behaviors'>,
): InstanceProfileBehaviors {
  const out: InstanceProfileBehaviors = {}

  if (payload.behaviors && typeof payload.behaviors === 'object') {
    for (const [tileId, rawTrig] of Object.entries(payload.behaviors)) {
      if (!rawTrig || typeof rawTrig !== 'object') continue
      const rec = rawTrig as { click?: unknown; doubleClick?: unknown; longPress?: unknown }
      const click = normalizeBehaviorArray(rec.click, `preset-${tileId}-click`)
      const doubleClick = normalizeBehaviorArray(rec.doubleClick, `preset-${tileId}-double`)
      const longPress = normalizeBehaviorArray(rec.longPress, `preset-${tileId}-long`)
      if (click.length > 0 || doubleClick.length > 0 || longPress.length > 0) {
        out[tileId] = { click, doubleClick, longPress }
      }
    }
    return out
  }

  if (payload.bindings && typeof payload.bindings === 'object') {
    for (const [tileId, binding] of Object.entries(payload.bindings)) {
      if (!binding || typeof binding !== 'object') continue
      let click = normalizeBehaviorArray(binding.tap, `preset-${tileId}-tap`)
      if (click.length === 0 && Array.isArray(binding.holdKeys) && binding.holdKeys.length > 0) {
        const cleanHold = binding.holdKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        if (cleanHold.length === 1) {
          click = [createBehavior({ type: 'key', key: cleanHold[0], id: `preset-${tileId}-hold` })]
        } else if (cleanHold.length > 1) {
          click = [createBehavior({ type: 'shortcut', keys: cleanHold, id: `preset-${tileId}-hold` })]
        }
      }
      const doubleClick = normalizeBehaviorArray(binding.double, `preset-${tileId}-double`)
      const longPress = normalizeBehaviorArray(binding.long, `preset-${tileId}-long`)
      if (click.length > 0 || doubleClick.length > 0 || longPress.length > 0) {
        out[tileId] = { click, doubleClick, longPress }
      }
    }
  }

  return out
}

export function voicePresetToTriggerBehaviors(voicePreset: VoicePresetKind): TriggerBehaviors {
  switch (voicePreset) {
    case 'doubao-alt':
      return { click: [createBehavior({ type: 'key', key: 'Alt' })], doubleClick: [], longPress: [] }
    case 'system-win-h':
      return { click: [createBehavior({ type: 'shortcut', keys: ['Win', 'H'] })], doubleClick: [], longPress: [] }
    case 'ctrl-win':
      return { click: [createBehavior({ type: 'shortcut', keys: ['Ctrl', 'Win'] })], doubleClick: [], longPress: [] }
    case 'pure-mic':
      return { click: [], doubleClick: [], longPress: [] }
  }
}

export function voicePresetToRustBinding(voicePreset: VoicePresetKind): TileActionBindingsDto {
  switch (voicePreset) {
    case 'doubao-alt':
      return { tap: [{ type: 'key', enabled: true, key: 'Alt' }], double: [], long: [], holdKeys: [] }
    case 'system-win-h':
      return { tap: [{ type: 'shortcut', enabled: true, keys: ['Win', 'H'] }], double: [], long: [], holdKeys: [] }
    case 'ctrl-win':
      return { tap: [{ type: 'shortcut', enabled: true, keys: ['Ctrl', 'Win'] }], double: [], long: [], holdKeys: [] }
    case 'pure-mic':
      return { tap: [], double: [], long: [], holdKeys: [] }
  }
}

export function inferActiveStarterPreset(snapshot: DeckSnapshot | null | undefined): StarterPresetId | null {
  if (!snapshot?.pages?.length) return null
  const firstId = snapshot.pages[0]?.id
  const secondId = snapshot.pages[1]?.id
  if (firstId === 'classic-remote' && secondId === 'daily-media') return 'daily-remote'
  if (firstId === 'vibe-coding') return 'vibe-coding'
  if (firstId === 'presentation-main') return 'presentation-media'
  if (firstId === 'custom-canvas') return 'blank-canvas'
  return null
}

export function inferVoicePresetFromSummary(summary: string | null | undefined): VoicePresetKind | null {
  const trimmed = summary?.trim() ?? ''
  if (!trimmed) return 'pure-mic'
  if (trimmed === 'Alt') return 'doubao-alt'
  if (trimmed === 'Win+H') return 'system-win-h'
  if (trimmed === 'Ctrl+Win') return 'ctrl-win'
  return null
}

let lastSyncedPresetRevision = 0

export function resetSyncedPresetRevisionForTest() {
  lastSyncedPresetRevision = 0
}

export async function applyPresetPayloadToDeviceController(
  controller: DeviceController,
  payload: MobilePresetAppliedPayload | null | undefined,
  targetInstanceId?: string,
): Promise<boolean> {
  if (!payload?.snapshot) return false
  if (payload.revision <= lastSyncedPresetRevision) return false
  lastSyncedPresetRevision = payload.revision

  try {
    const pkg = buildDynamicMobileSupportPackage(payload.snapshot, payload.snapshot.activePageId)
    setDynamicSupportPackageOverride('axonkeyMobile', pkg)
  } catch {
    /* Ignore malformed snapshot */
  }

  const nextBehaviors = convertPresetPayloadToProfileBehaviors(payload)
  const mobileInstances = controller.snapshot.store.instances.filter(
    inst => inst.kind === 'axonkeyMobile' && (!targetInstanceId || inst.id === targetInstanceId),
  )
  if (mobileInstances.length === 0) return false

  for (const inst of mobileInstances) {
    const effectiveId = controller.snapshot.runtime[inst.id]?.effectiveProfileId ?? inst.activeProfileId
    const targetProfile =
      inst.profiles.find(p => !p.quick && p.id === effectiveId) ?? inst.profiles.find(p => !p.quick) ?? inst.profiles[0]
    if (!targetProfile) continue
    await controller
      .update(inst.id, current => replaceInstanceProfileBehaviors(current, targetProfile.id, nextBehaviors))
      .catch(() => {})
  }
  return true
}

export function useAxonkeyMobilePresetSync(native: boolean, controller: DeviceController) {
  useEffect(() => {
    if (!native) return
    let alive = true
    const unlistenPromise = listen<MobilePresetAppliedPayload>('axonkey-mobile-preset-applied', event => {
      if (!alive) return
      void applyPresetPayloadToDeviceController(controller, event.payload)
    })
    return () => {
      alive = false
      void unlistenPromise.then(unlisten => unlisten())
    }
  }, [controller, native])
}
