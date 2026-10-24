import { createBehavior, createEmptyBehaviorMap, serializeSequence } from '../../src/behaviorModel.ts'
import { devices } from '../../src/deviceModel.ts'

export function legacySampleData() {
  const first = createEmptyBehaviorMap()
  first.power.click = [createBehavior({ type: 'key', key: 'Esc', id: 'key' }), createBehavior({ type: 'delay', ms: 50, id: 'wait' })]
  first['mouse.top.up'].click = [createBehavior({ type: 'shortcut', keys: ['RCtrl', 'A'], id: 'shortcut' })]
  const second = createEmptyBehaviorMap()
  second.voice.longPress = [createBehavior({ type: 'switchProfile', direction: 'previous', wrap: true, id: 'profile' })]
  second['mouse.right.buttonLeft'].doubleClick = [createBehavior({ type: 'disabled', id: 'off', enabled: false })]
  const live = structuredClone(second)
  live.tv.click = [createBehavior({ type: 'paste', text: '尚未持久化的编辑\n第二行', id: 'text' })]
  return {
    profiles: [{ id: 'work', name: '工作', behaviors: first }, { id: 'play', name: '娱乐', behaviors: second }],
    activeProfileId: 'play', behaviors: live,
    savedSequences: [{ id: 'saved', name: '粘贴并确认', sequence: serializeSequence([
      createBehavior({ type: 'paste', text: '多行\n文本' }), createBehavior({ type: 'key', key: 'Enter' }),
    ]) }],
    settings: { enabled: false, mouseEnabled: true, showRemoteKeyGrid: false, showMouseKeyGrid: true, mouseIgnoreScrollAcceleration: false, mouseScrollSensitivity: 175, mouseVerticalScrollIntervalMs: 0, mouseHorizontalScrollIntervalMs: 75, mouseKeyHoldMs: 10, mouseEdgeWidth: 15 },
    audio: { gain: -6, stretchCompensation: true }, preferences: { sidebarCollapsed: true },
  }
}

export function sampleData() {
  const legacy = legacySampleData()
  const profiles = devices.flatMap(device => legacy.profiles.map(profile => {
    const behaviors = createEmptyBehaviorMap()
    for (const id of device.inputIds) behaviors[id] = structuredClone(profile.behaviors[id])
    return { id: `${device.id}:${profile.id}`, name: profile.name, deviceId: device.id, behaviors }
  }))
  const behaviors = createEmptyBehaviorMap()
  const activeProfileIds = { rc003: 'rc003:play', mouse: 'mouse:work' }
  for (const device of devices) {
    const active = profiles.find(profile => profile.id === activeProfileIds[device.id])
    for (const id of device.inputIds) behaviors[id] = structuredClone(active.behaviors[id])
  }
  behaviors.tv = structuredClone(legacy.behaviors.tv)
  behaviors['mouse.top.down'].click = [createBehavior({ type: 'key', key: 'PageDown', id: 'live-mouse' })]
  const { activeProfileId: _, ...rest } = legacy
  return { ...rest, profiles, activeProfileIds, behaviors }
}

export function legacyBackup() {
  const data = legacySampleData()
  return {
    format: 'axonkey-backup', version: 1, exportedAt: '2026-10-22T10:02:03.000Z', appVersion: '1.0.14',
    activeProfileId: data.activeProfileId,
    profiles: data.profiles.map(profile => {
      const map = profile.id === data.activeProfileId ? data.behaviors : profile.behaviors
      return { id: profile.id, name: profile.name, devices: Object.fromEntries(devices.map(device => [device.id, {
        keys: Object.fromEntries(device.inputIds.map(id => [device.id === 'mouse' ? id.replace(/^mouse\./, '') : id, structuredClone(map[id])])),
      }])) }
    }),
    savedBehaviors: [{ id: 'saved', name: '粘贴并确认', behaviors: [createBehavior({ type: 'paste', text: '多行\n文本', id: 'saved-paste' }), createBehavior({ type: 'key', key: 'Enter', id: 'saved-enter' })] }],
    settings: data.settings, audio: data.audio, preferences: data.preferences,
  }
}
