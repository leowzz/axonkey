import { createBehavior, createEmptyBehaviorMap, serializeSequence } from '../../src/behaviorModel.ts'
import { devices } from '../../src/deviceModel.ts'

function profileData() {
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
    settings: { cmiotA15RecordingMode: 'hold', enabled: false, mouseEnabled: true, showRemoteKeyGrid: false, showMouseKeyGrid: true, mouseIgnoreScrollAcceleration: false, mouseScrollSensitivity: 175, mouseVerticalScrollIntervalMs: 0, mouseHorizontalScrollIntervalMs: 75, mouseKeyHoldMs: 10, mouseEdgeWidth: 15 },
    audio: { gain: -6, stretchCompensation: true }, preferences: { sidebarCollapsed: true },
  }
}

export function sampleData() {
  const data = profileData()
  const profiles = devices.flatMap(device => data.profiles.map(profile => {
    const behaviors = createEmptyBehaviorMap()
    for (const id of device.inputIds) behaviors[id] = structuredClone(profile.behaviors[id])
    return { id: `${device.id}:${profile.id}`, name: profile.name, deviceId: device.id, behaviors }
  }))
  const behaviors = createEmptyBehaviorMap()
  const activeProfileIds = { rc003: 'rc003:play', cmiotA15: 'cmiotA15:work', mouse: 'mouse:work' }
  for (const device of devices) {
    const active = profiles.find(profile => profile.id === activeProfileIds[device.id])
    for (const id of device.inputIds) behaviors[id] = structuredClone(active.behaviors[id])
  }
  behaviors.tv = structuredClone(data.behaviors.tv)
  behaviors['mouse.top.down'].click = [createBehavior({ type: 'key', key: 'PageDown', id: 'live-mouse' })]
  const { activeProfileId: _, ...rest } = data
  return { ...rest, profiles, activeProfileIds, behaviors }
}
