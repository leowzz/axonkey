import type { Platform } from '../appTypes.ts'
import { createBehavior, normalizeBehavior } from '../behaviorModel.ts'
import type { Behavior, TriggerBehaviors, TriggerType } from '../behaviorModel.ts'
import { behaviorSummary } from '../behaviorSummary.ts'
import type { CatalogDeviceModel, CloudDevicePreset, CloudDevicePresetPlatform } from '../cloud/deviceModelCatalog.ts'
import type { InstanceProfile, ProfileDisplayConfig } from './integration/model.ts'

export type DevicePresetOption = {
  id: string
  slug: string
  name: string
  description: string
  platform: CloudDevicePresetPlatform
  isDefault: boolean
  quick: boolean
  promptMode: boolean
  sortOrder: number
  behaviors: Record<string, TriggerBehaviors>
  display?: ProfileDisplayConfig
  source: 'cloud' | 'bundled'
}

const MAX_PROFILE_NAME_LENGTH = 40
const TRIGGER_TYPES: readonly TriggerType[] = ['click', 'doubleClick', 'longPress']

function createUniqueId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizePresetProfileName(name: string, existingNames: readonly string[] = []): string {
  const base = name.trim().slice(0, MAX_PROFILE_NAME_LENGTH) || '预制配置'
  const taken = new Set(existingNames.map(item => item.trim()).filter(Boolean))
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` (${index})`
    const candidate = `${base.slice(0, MAX_PROFILE_NAME_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}

function normalizeDisplay(raw: unknown): ProfileDisplayConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const mode = record.mode === 'custom' ? 'custom' : record.mode === 'auto' ? 'auto' : null
  if (!mode) return undefined
  return {
    mode,
    line1: typeof record.line1 === 'string' ? record.line1 : '',
    line2: typeof record.line2 === 'string' ? record.line2 : '',
  }
}

export function normalizePresetBehaviors(raw: Record<string, unknown>): Record<string, TriggerBehaviors> {
  const normalized: Record<string, TriggerBehaviors> = {}
  for (const [inputId, entry] of Object.entries(raw)) {
    if (!inputId.trim() || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const buckets: TriggerBehaviors = { click: [], doubleClick: [], longPress: [] }
    let hasActions = false
    for (const trigger of TRIGGER_TYPES) {
      const list = record[trigger]
      if (!Array.isArray(list)) continue
      const actions: Behavior[] = []
      for (const rawBehavior of list) {
        const parsed = normalizeBehavior(rawBehavior)
        if (parsed) actions.push(parsed)
      }
      buckets[trigger] = actions
      if (actions.length > 0) hasActions = true
    }
    if (hasActions) {
      normalized[inputId] = buckets
    }
  }
  return normalized
}

type MouseRoleKeys = {
  up?: string
  down?: string
  left?: string
  right?: string
  confirm?: string
  back?: string
  home?: string
  menu?: string
  wheelUp?: string
  wheelDown?: string
  volUp?: string
  volDown?: string
  mute?: string
  play?: string
  pageUp?: string
  pageDown?: string
  browserBack?: string
  browserForward?: string
  delete?: string
}

function makeTrigger(
  click: Behavior[] = [],
  doubleClick: Behavior[] = [],
  longPress: Behavior[] = [],
): TriggerBehaviors {
  return { click, doubleClick, longPress }
}

const keyAct = (key: string) => createBehavior({ type: 'key', key })
const cursorAct = (direction: 'up' | 'down' | 'left' | 'right', distance = 28) =>
  createBehavior({ type: 'cursorMove', direction, distance })
const wheelAct = (direction: 'up' | 'down' | 'left' | 'right') => createBehavior({ type: 'wheel', direction })
const mouseAct = (button: 'left' | 'right' | 'back' | 'forward') => createBehavior({ type: 'mouse', button })

function buildMouseControlBehaviors(keys: MouseRoleKeys): Record<string, TriggerBehaviors> {
  const out: Record<string, TriggerBehaviors> = {}
  if (keys.up) out[keys.up] = makeTrigger([cursorAct('up')])
  if (keys.down) out[keys.down] = makeTrigger([cursorAct('down')])
  if (keys.left) out[keys.left] = makeTrigger([cursorAct('left')])
  if (keys.right) out[keys.right] = makeTrigger([cursorAct('right')])
  if (keys.confirm) {
    out[keys.confirm] = makeTrigger([mouseAct('left')], [mouseAct('left'), mouseAct('left')], [mouseAct('right')])
  }
  if (keys.back) out[keys.back] = makeTrigger([mouseAct('right')], [], [keyAct('Esc')])
  if (keys.home) out[keys.home] = makeTrigger([keyAct('Space')], [keyAct('Enter')])
  if (keys.menu) out[keys.menu] = makeTrigger([wheelAct('down')], [], [wheelAct('up')])
  if (keys.wheelUp) out[keys.wheelUp] = makeTrigger([wheelAct('up')])
  if (keys.wheelDown) out[keys.wheelDown] = makeTrigger([wheelAct('down')])
  if (keys.volUp) out[keys.volUp] = makeTrigger([keyAct('VolumeUp')], [wheelAct('up')])
  if (keys.volDown) out[keys.volDown] = makeTrigger([keyAct('VolumeDown')], [wheelAct('down')])
  if (keys.mute) out[keys.mute] = makeTrigger([keyAct('VolumeMute')])
  if (keys.play) out[keys.play] = makeTrigger([keyAct('MediaPlayPause')])
  if (keys.pageUp) out[keys.pageUp] = makeTrigger([keyAct('PageUp')])
  if (keys.pageDown) out[keys.pageDown] = makeTrigger([keyAct('PageDown')])
  if (keys.browserBack) out[keys.browserBack] = makeTrigger([mouseAct('back')])
  if (keys.browserForward) out[keys.browserForward] = makeTrigger([mouseAct('forward')])
  if (keys.delete) out[keys.delete] = makeTrigger([keyAct('Esc')])
  return out
}

function buildMediaBehaviors(
  keys: Required<Pick<MouseRoleKeys, 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back'>> & {
    home?: string
    play?: string
    next?: string
    prev?: string
    volUp?: string
    volDown?: string
    mute?: string
    pageUp?: string
    pageDown?: string
    delete?: string
  },
): Record<string, TriggerBehaviors> {
  const out: Record<string, TriggerBehaviors> = {
    [keys.up]: makeTrigger([wheelAct('up')]),
    [keys.down]: makeTrigger([wheelAct('down')]),
    [keys.left]: makeTrigger([keyAct('Left')]),
    [keys.right]: makeTrigger([keyAct('Right')]),
    [keys.confirm]: makeTrigger([keyAct('Space')], [keyAct('Enter')]),
    [keys.back]: makeTrigger([keyAct('Esc')], [], [mouseAct('back')]),
  }
  if (keys.home) out[keys.home] = makeTrigger([keyAct('MediaPlayPause')])
  if (keys.play) out[keys.play] = makeTrigger([keyAct('MediaPlayPause')])
  if (keys.next) out[keys.next] = makeTrigger([keyAct('MediaNext')])
  if (keys.prev) out[keys.prev] = makeTrigger([keyAct('MediaPrevious')])
  if (keys.volUp) out[keys.volUp] = makeTrigger([keyAct('VolumeUp')])
  if (keys.volDown) out[keys.volDown] = makeTrigger([keyAct('VolumeDown')])
  if (keys.mute) out[keys.mute] = makeTrigger([keyAct('VolumeMute')])
  if (keys.pageUp) out[keys.pageUp] = makeTrigger([keyAct('PageUp')])
  if (keys.pageDown) out[keys.pageDown] = makeTrigger([keyAct('PageDown')])
  if (keys.delete) out[keys.delete] = makeTrigger([keyAct('Esc')])
  return out
}

function bundledPreset(
  kind: string,
  slug: string,
  name: string,
  description: string,
  behaviors: Record<string, TriggerBehaviors>,
  options: { isDefault?: boolean; sortOrder?: number } = {},
): DevicePresetOption {
  return {
    id: `bundled:${kind}:${slug}`,
    slug,
    name,
    description,
    platform: 'all',
    isDefault: options.isDefault ?? true,
    quick: false,
    promptMode: false,
    sortOrder: options.sortOrder ?? 10,
    behaviors,
    source: 'bundled',
  }
}

const cmiotMouseKeys: MouseRoleKeys = {
  up: 'cmiotA15.up',
  down: 'cmiotA15.down',
  left: 'cmiotA15.left',
  right: 'cmiotA15.right',
  confirm: 'cmiotA15.confirm',
  back: 'cmiotA15.back',
  home: 'cmiotA15.home',
  menu: 'cmiotA15.menu',
  wheelUp: 'cmiotA15.channelUp',
  wheelDown: 'cmiotA15.channelDown',
  volUp: 'cmiotA15.volumeUp',
  volDown: 'cmiotA15.volumeDown',
  mute: 'cmiotA15.mute',
  play: 'cmiotA15.power',
  browserBack: 'cmiotA15.m',
  browserForward: 'cmiotA15.settings',
}

const cmiotMediaKeys = {
  up: 'cmiotA15.up',
  down: 'cmiotA15.down',
  left: 'cmiotA15.left',
  right: 'cmiotA15.right',
  confirm: 'cmiotA15.confirm',
  back: 'cmiotA15.back',
  home: 'cmiotA15.home',
  pageUp: 'cmiotA15.channelUp',
  pageDown: 'cmiotA15.channelDown',
  volUp: 'cmiotA15.volumeUp',
  volDown: 'cmiotA15.volumeDown',
  mute: 'cmiotA15.mute',
  prev: 'cmiotA15.m',
  next: 'cmiotA15.settings',
  play: 'cmiotA15.power',
}

const BUNDLED_PRESETS_BY_KIND: Record<string, DevicePresetOption[]> = {
  rc003: [
    bundledPreset(
      'rc003',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键左键点击、返回键右键，开箱即用操控电脑。',
      buildMouseControlBehaviors({
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        confirm: 'confirm',
        back: 'back',
        home: 'home',
        menu: 'menu',
        wheelUp: 'tv',
        volUp: 'volumeUp',
        volDown: 'volumeDown',
        play: 'power',
      }),
      { isDefault: true, sortOrder: 10 },
    ),
    bundledPreset(
      'rc003',
      'media-reading',
      '影音与阅读',
      '方向键与音量键适配视频播放、网页长文滚动及电子书翻页。',
      buildMediaBehaviors({
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        confirm: 'confirm',
        back: 'back',
        home: 'home',
        next: 'menu',
        prev: 'tv',
        volUp: 'volumeUp',
        volDown: 'volumeDown',
        mute: 'power',
      }),
      { isDefault: false, sortOrder: 20 },
    ),
    bundledPreset(
      'rc003',
      'presentation',
      '演示翻页',
      '适合 PPT / Keynote 演讲：上下左右翻页、F5 开始放映、B 键黑屏。',
      {
        up: makeTrigger([keyAct('PageUp')]),
        left: makeTrigger([keyAct('PageUp')]),
        down: makeTrigger([keyAct('PageDown')]),
        right: makeTrigger([keyAct('PageDown')]),
        confirm: makeTrigger([keyAct('PageDown')]),
        home: makeTrigger([keyAct('F5')], [], [keyAct('Esc')]),
        back: makeTrigger([keyAct('Esc')]),
        menu: makeTrigger([keyAct('B')]),
        volumeUp: makeTrigger([keyAct('VolumeUp')]),
        volumeDown: makeTrigger([keyAct('VolumeDown')]),
      },
      { isDefault: false, sortOrder: 30 },
    ),
  ],
  cmiotA15: [
    bundledPreset(
      'cmiotA15',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、频道键滚轮翻页，适合日常轻量控制。',
      buildMouseControlBehaviors(cmiotMouseKeys),
      { isDefault: true, sortOrder: 10 },
    ),
    bundledPreset(
      'cmiotA15',
      'media-reading',
      '影音与阅读',
      '频道键上下翻页，方向键快进与滚轮滚动，适配视频播放与长文档浏览。',
      buildMediaBehaviors(cmiotMediaKeys),
      { isDefault: false, sortOrder: 20 },
    ),
  ],
  rc313: [
    bundledPreset(
      'rc313',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、频道键滚轮翻页，适合日常轻量控制。',
      buildMouseControlBehaviors(cmiotMouseKeys),
      { isDefault: true, sortOrder: 10 },
    ),
    bundledPreset(
      'rc313',
      'media-reading',
      '影音与阅读',
      '频道键上下翻页，方向键快进与滚轮滚动，适配视频播放与长文档浏览。',
      buildMediaBehaviors(cmiotMediaKeys),
      { isDefault: false, sortOrder: 20 },
    ),
  ],
  xmBt29: [
    bundledPreset(
      'xmBt29',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、频道键滚轮翻页，删除键返回 Esc。',
      buildMouseControlBehaviors({ ...cmiotMouseKeys, delete: 'xmBt29.delete' }),
      { isDefault: true, sortOrder: 10 },
    ),
    bundledPreset(
      'xmBt29',
      'media-reading',
      '影音与阅读',
      '频道键上下翻页，方向键快进与滚轮滚动，适配视频播放与长文档浏览。',
      buildMediaBehaviors({ ...cmiotMediaKeys, delete: 'xmBt29.delete' }),
      { isDefault: false, sortOrder: 20 },
    ),
  ],
  obeRcuR5: [
    bundledPreset(
      'obeRcuR5',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、定位键向上滚屏。',
      buildMouseControlBehaviors({
        up: 'obeRcuR5.up',
        down: 'obeRcuR5.down',
        left: 'obeRcuR5.left',
        right: 'obeRcuR5.right',
        confirm: 'obeRcuR5.confirm',
        back: 'obeRcuR5.back',
        home: 'obeRcuR5.home',
        wheelUp: 'obeRcuR5.locate',
        volUp: 'obeRcuR5.volumeUp',
        volDown: 'obeRcuR5.volumeDown',
        play: 'obeRcuR5.power',
      }),
    ),
  ],
  tclRc802a: [
    bundledPreset(
      'tclRc802a',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、侧键翻页与音量控制。',
      buildMouseControlBehaviors({
        up: 'tcl-rc802a.up',
        down: 'tcl-rc802a.down',
        left: 'tcl-rc802a.left',
        right: 'tcl-rc802a.right',
        confirm: 'tcl-rc802a.confirm',
        back: 'tcl-rc802a.back',
        home: 'tcl-rc802a.home',
        menu: 'tcl-rc802a.menu',
        wheelUp: 'tcl-rc802a.settings',
        pageUp: 'tcl-rc802a.sideUpper',
        pageDown: 'tcl-rc802a.sideLower',
        play: 'tcl-rc802a.sideFunction',
        volUp: 'tcl-rc802a.volumeUp',
        volDown: 'tcl-rc802a.volumeDown',
        mute: 'tcl-rc802a.mute',
      }),
    ),
  ],
  tclRc902n: [
    bundledPreset(
      'tclRc902n',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、菜单与功能键快速翻页。',
      buildMouseControlBehaviors({
        up: 'tcl-rc902n.up',
        down: 'tcl-rc902n.down',
        left: 'tcl-rc902n.left',
        right: 'tcl-rc902n.right',
        confirm: 'tcl-rc902n.confirm',
        back: 'tcl-rc902n.back',
        home: 'tcl-rc902n.home',
        menu: 'tcl-rc902n.menu',
        wheelUp: 'tcl-rc902n.settings',
        pageUp: 'tcl-rc902n.layers',
        pageDown: 'tcl-rc902n.tiles',
        play: 'tcl-rc902n.tv',
        volUp: 'tcl-rc902n.volumeUp',
        volDown: 'tcl-rc902n.volumeDown',
        mute: 'tcl-rc902n.mute',
      }),
    ),
  ],
  tclRc902v: [
    bundledPreset(
      'tclRc902v',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、频道键上下滚屏。',
      buildMouseControlBehaviors({
        up: 'tcl-rc902v.up',
        down: 'tcl-rc902v.down',
        left: 'tcl-rc902v.left',
        right: 'tcl-rc902v.right',
        confirm: 'tcl-rc902v.confirm',
        back: 'tcl-rc902v.back',
        home: 'tcl-rc902v.home',
        menu: 'tcl-rc902v.menu',
        wheelUp: 'tcl-rc902v.channelUp',
        wheelDown: 'tcl-rc902v.channelDown',
        play: 'tcl-rc902v.media',
        volUp: 'tcl-rc902v.volumeUp',
        volDown: 'tcl-rc902v.volumeDown',
        mute: 'tcl-rc902v.mute',
      }),
    ),
  ],
  hisenseRcf3b65: [
    bundledPreset(
      'hisenseRcf3b65',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、返回键右键菜单。',
      buildMouseControlBehaviors({
        up: 'hisense-rcf3b65.up',
        down: 'hisense-rcf3b65.down',
        left: 'hisense-rcf3b65.left',
        right: 'hisense-rcf3b65.right',
        confirm: 'hisense-rcf3b65.confirm',
        back: 'hisense-rcf3b65.back',
        home: 'hisense-rcf3b65.home',
        menu: 'hisense-rcf3b65.menu',
        wheelUp: 'hisense-rcf3b65.settings',
        play: 'hisense-rcf3b65.pointer',
        volUp: 'hisense-rcf3b65.volumeUp',
        volDown: 'hisense-rcf3b65.volumeDown',
      }),
    ),
  ],
  phicommDb1R: [
    bundledPreset(
      'phicommDb1R',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键左键、返回键右键，极简 12 键上手。',
      buildMouseControlBehaviors({
        up: 'phicomm-db1-r.up',
        down: 'phicomm-db1-r.down',
        left: 'phicomm-db1-r.left',
        right: 'phicomm-db1-r.right',
        confirm: 'phicomm-db1-r.confirm',
        back: 'phicomm-db1-r.back',
        home: 'phicomm-db1-r.home',
        menu: 'phicomm-db1-r.menu',
        play: 'phicomm-db1-r.ottPower',
        volUp: 'phicomm-db1-r.volumeUp',
        volDown: 'phicomm-db1-r.volumeDown',
      }),
    ),
  ],
  oneplusRc001a: [
    bundledPreset(
      'oneplusRc001a',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、OK 键左键点击、返回键右键、一加键向上滚动。',
      buildMouseControlBehaviors({
        up: 'oneplus.up',
        down: 'oneplus.down',
        left: 'oneplus.left',
        right: 'oneplus.right',
        confirm: 'oneplus.ok',
        back: 'oneplus.back',
        home: 'oneplus.home',
        menu: 'oneplus.menu',
        wheelUp: 'oneplus.oneplus',
        volUp: 'oneplus.volume.up',
        volDown: 'oneplus.volume.down',
      }),
    ),
  ],
  rmfTx800c: [
    bundledPreset(
      'rmfTx800c',
      'mouse-control',
      '飞鼠操控',
      '方向键移动光标、确认键点击、设置与菜单键上下滚动。',
      buildMouseControlBehaviors({
        up: 'rmf-tx800c.up',
        down: 'rmf-tx800c.down',
        left: 'rmf-tx800c.left',
        right: 'rmf-tx800c.right',
        confirm: 'rmf-tx800c.confirm',
        back: 'rmf-tx800c.back',
        home: 'rmf-tx800c.home',
        menu: 'rmf-tx800c.menu',
        wheelUp: 'rmf-tx800c.settings',
        play: 'rmf-tx800c.tv',
        volUp: 'rmf-tx800c.volumeUp',
        volDown: 'rmf-tx800c.volumeDown',
        mute: 'rmf-tx800c.mute',
      }),
    ),
  ],
  xboxBluetooth: [
    bundledPreset(
      'xboxBluetooth',
      'gamepad-mouse',
      '手柄飞鼠',
      '左摇杆移动光标、右摇杆四向滚轮、A/B 对应鼠标左右键、肩键控制浏览器前进后退。',
      {
        'xbox.ls.up': makeTrigger([cursorAct('up', 24)]),
        'xbox.ls.down': makeTrigger([cursorAct('down', 24)]),
        'xbox.ls.left': makeTrigger([cursorAct('left', 24)]),
        'xbox.ls.right': makeTrigger([cursorAct('right', 24)]),
        'xbox.rs.up': makeTrigger([wheelAct('up')]),
        'xbox.rs.down': makeTrigger([wheelAct('down')]),
        'xbox.rs.left': makeTrigger([wheelAct('left')]),
        'xbox.rs.right': makeTrigger([wheelAct('right')]),
        'xbox.a': makeTrigger([mouseAct('left')]),
        'xbox.b': makeTrigger([mouseAct('right')]),
        'xbox.x': makeTrigger([keyAct('Space')]),
        'xbox.y': makeTrigger([keyAct('Enter')]),
        'xbox.lb': makeTrigger([mouseAct('back')]),
        'xbox.rb': makeTrigger([mouseAct('forward')]),
        'xbox.lt': makeTrigger([keyAct('PageUp')]),
        'xbox.rt': makeTrigger([keyAct('PageDown')]),
        'xbox.dpad.up': makeTrigger([keyAct('Up')]),
        'xbox.dpad.down': makeTrigger([keyAct('Down')]),
        'xbox.dpad.left': makeTrigger([keyAct('Left')]),
        'xbox.dpad.right': makeTrigger([keyAct('Right')]),
        'xbox.menu': makeTrigger([keyAct('Esc')]),
      },
    ),
  ],
  kivoK18Lite: [
    bundledPreset(
      'kivoK18Lite',
      'media-deck',
      '桌面媒体与效率台',
      '顶行控制媒体播放与音量，下方按键提供光标移动、点击、翻页与浏览导航。',
      {
        'kivo.k18Lite.k01': makeTrigger([keyAct('MediaPrevious')]),
        'kivo.k18Lite.k02': makeTrigger([keyAct('MediaPlayPause')]),
        'kivo.k18Lite.k03': makeTrigger([keyAct('MediaNext')]),
        'kivo.k18Lite.k04': makeTrigger([keyAct('VolumeMute')]),
        'kivo.k18Lite.k05': makeTrigger([keyAct('VolumeDown')]),
        'kivo.k18Lite.k06': makeTrigger([keyAct('VolumeUp')]),
        'kivo.k18Lite.k07': makeTrigger([wheelAct('up')]),
        'kivo.k18Lite.k08': makeTrigger([cursorAct('up')]),
        'kivo.k18Lite.k09': makeTrigger([wheelAct('down')]),
        'kivo.k18Lite.k10': makeTrigger([cursorAct('left')]),
        'kivo.k18Lite.k11': makeTrigger([mouseAct('left')], [], [mouseAct('right')]),
        'kivo.k18Lite.k12': makeTrigger([cursorAct('right')]),
        'kivo.k18Lite.k13': makeTrigger([mouseAct('back')]),
        'kivo.k18Lite.k14': makeTrigger([cursorAct('down')]),
        'kivo.k18Lite.k15': makeTrigger([mouseAct('forward')]),
        'kivo.k18Lite.k16': makeTrigger([keyAct('PageUp')]),
        'kivo.k18Lite.k17': makeTrigger([keyAct('Space')]),
        'kivo.k18Lite.k18': makeTrigger([keyAct('PageDown')]),
      },
    ),
  ],
  g17Touch: [
    bundledPreset(
      'g17Touch',
      'numpad-mouse',
      '触控滑条与小键盘操控',
      '数字区九宫格控制光标与左右键，触控滑条滚屏，顶部触控键控制媒体与静音。',
      {
        'g17.touch.swipeUp': makeTrigger([wheelAct('up')]),
        'g17.touch.swipeDown': makeTrigger([wheelAct('down')]),
        'g17.touch.t1': makeTrigger([keyAct('MediaPrevious')]),
        'g17.touch.t2': makeTrigger([keyAct('MediaPlayPause')]),
        'g17.touch.t3': makeTrigger([keyAct('MediaNext')]),
        'g17.touch.t4': makeTrigger([keyAct('VolumeMute')]),
        'g17.touch.k8': makeTrigger([cursorAct('up')]),
        'g17.touch.k2': makeTrigger([cursorAct('down')]),
        'g17.touch.k4': makeTrigger([cursorAct('left')]),
        'g17.touch.k6': makeTrigger([cursorAct('right')]),
        'g17.touch.k5': makeTrigger([mouseAct('left')], [], [mouseAct('right')]),
        'g17.touch.k0': makeTrigger([mouseAct('right')]),
        'g17.touch.enter': makeTrigger([keyAct('Enter')]),
        'g17.touch.add': makeTrigger([keyAct('VolumeUp')]),
        'g17.touch.sub': makeTrigger([keyAct('VolumeDown')]),
        'g17.touch.dot': makeTrigger([keyAct('Esc')]),
      },
    ),
  ],
}

function cloudPresetToOption(preset: CloudDevicePreset): DevicePresetOption {
  const display = normalizeDisplay(preset.display)
  return {
    id: preset.id,
    slug: preset.slug,
    name: preset.name,
    description: preset.description,
    platform: preset.platform,
    isDefault: preset.is_default && !preset.quick,
    quick: preset.quick,
    promptMode: preset.quick && preset.prompt_mode,
    sortOrder: preset.sort_order,
    behaviors: normalizePresetBehaviors(preset.behaviors),
    ...(display ? { display } : {}),
    source: 'cloud',
  }
}

function filterAndSortPresets(presets: readonly DevicePresetOption[], platform: Platform): DevicePresetOption[] {
  return presets
    .filter(item => item.platform === 'all' || item.platform === platform)
    .slice()
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.slug.localeCompare(b.slug)
    })
}

export function getBundledPresetsForKind(kind: string): DevicePresetOption[] {
  return (BUNDLED_PRESETS_BY_KIND[kind] ?? []).map(item => ({
    ...item,
    behaviors: clonePresetBehaviors(item.behaviors, false),
  }))
}

export function getPresetsForDevice(
  kind: string,
  catalogModel?: Pick<CatalogDeviceModel, 'presets'> | null,
  platform: Platform = 'macos',
): DevicePresetOption[] {
  const cloud = filterAndSortPresets((catalogModel?.presets ?? []).map(cloudPresetToOption), platform)
  if (cloud.length > 0) return cloud
  return filterAndSortPresets(getBundledPresetsForKind(kind), platform)
}

export function pickDefaultPreset(presets: readonly DevicePresetOption[]): DevicePresetOption | undefined {
  return presets.find(item => item.isDefault && !item.quick) ?? presets.find(item => !item.quick)
}

export function countConfiguredInputs(behaviors: Record<string, TriggerBehaviors> | undefined): number {
  if (!behaviors) return 0
  let count = 0
  for (const triggers of Object.values(behaviors)) {
    if (
      triggers &&
      ((triggers.click?.length ?? 0) > 0 ||
        (triggers.doubleClick?.length ?? 0) > 0 ||
        (triggers.longPress?.length ?? 0) > 0)
    ) {
      count += 1
    }
  }
  return count
}

export function clonePresetBehaviors(
  behaviors: Record<string, TriggerBehaviors>,
  freshIds = true,
): Record<string, TriggerBehaviors> {
  const next: Record<string, TriggerBehaviors> = {}
  for (const [inputId, triggers] of Object.entries(behaviors)) {
    next[inputId] = {
      click: triggers.click.map(item => ({ ...item, ...(freshIds ? { id: createUniqueId('act') } : {}) })),
      doubleClick: triggers.doubleClick.map(item => ({ ...item, ...(freshIds ? { id: createUniqueId('act') } : {}) })),
      longPress: triggers.longPress.map(item => ({ ...item, ...(freshIds ? { id: createUniqueId('act') } : {}) })),
    }
  }
  return next
}

export function materializePresetToProfile(
  preset: DevicePresetOption,
  options: {
    profileId?: string
    name?: string
    existingNames?: readonly string[]
  } = {},
): InstanceProfile {
  const name = options.name?.trim()
    ? options.name.trim().slice(0, MAX_PROFILE_NAME_LENGTH)
    : normalizePresetProfileName(preset.name, options.existingNames)
  return {
    id: options.profileId ?? createUniqueId('profile'),
    name,
    behaviors: clonePresetBehaviors(preset.behaviors, true),
    ...(preset.display ? { display: { ...preset.display } } : {}),
    ...(preset.quick ? { quick: true, ...(preset.promptMode ? { promptMode: true } : {}) } : {}),
  }
}

export function summarizePresetHighlights(
  preset: DevicePresetOption,
  inputs?: readonly { id: string; label: string }[],
  platform: Platform = 'macos',
): string[] {
  const labelById = new Map((inputs ?? []).map(item => [item.id, item.label]))
  const highlights: string[] = []
  let groupedCursorDirections = 0
  let groupedWheelVertical = 0

  for (const [inputId, triggers] of Object.entries(preset.behaviors)) {
    const primary = triggers.click[0] ?? triggers.doubleClick[0] ?? triggers.longPress[0]
    if (!primary) continue
    if (primary.type === 'cursorMove') {
      groupedCursorDirections += 1
      continue
    }
    if (primary.type === 'wheel' && (primary.direction === 'up' || primary.direction === 'down')) {
      groupedWheelVertical += 1
      continue
    }
    const keyLabel = labelById.get(inputId) ?? inputId.split('.').pop() ?? inputId
    const actionLabel = behaviorSummary(primary, platform)
    highlights.push(`${keyLabel} → ${actionLabel}`)
  }

  const leading: string[] = []
  if (groupedCursorDirections >= 2) leading.push('方向/摇杆 → 光标移动')
  if (groupedWheelVertical >= 2) leading.push('上下/频道 → 页面滚屏')
  return [...leading, ...highlights].slice(0, 6)
}
