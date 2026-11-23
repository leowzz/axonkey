import { parseRuntimeDescriptorSvg } from '../shared/descriptorSvg.ts'
import {
  getLocalCloudDescriptorOverrides,
  packageFor,
  resetRuntimeSupportPackages,
  setDynamicSupportPackageOverride,
  setRuntimeSupportPackages,
  subscribeSupportPackages,
} from '../integration/model.ts'
import {
  buildDynamicMobileSupportPackage,
  escapeXml,
  normalizePageZones,
  packBentoTiles,
  synthesizeMobileDescriptorSvg,
  type DeckSnapshot,
  type MobileDeckPage,
  type MobileTile,
} from './dynamicSvg.ts'

type TestFn = () => void
const registeredSuites: Array<[string, TestFn]> = []

function defineTest(name: string, fn: TestFn) {
  registeredSuites.push([name, fn])
}

function assertOk(condition: unknown, message = 'Expected truthy value'): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message?: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(message ?? `Deep equality failed:\nActual:   ${a}\nExpected: ${b}`)
  }
}

function makeTile(id: string, label: string, overrides: Partial<MobileTile> = {}): MobileTile {
  return {
    id,
    label,
    icon: 'sparkles',
    accent: 'slate',
    colSpan: 1,
    rowSpan: 1,
    mode: 'gesture',
    ...overrides,
  }
}

function makeBaseSnapshot(pages: MobileDeckPage[], activePageId = pages[0]?.id ?? 'default'): DeckSnapshot {
  return {
    version: 1,
    activePageId,
    trackpadSplit: 0,
    pointerSensitivity: 1.4,
    scrollSensitivity: 1.0,
    doubleClickWindowMs: 300,
    longPressWindowMs: 600,
    voiceBindingSummary: 'Alt',
    pages,
  }
}

defineTest('packBentoTiles places 1x1, 2x1, 1x2, and 2x2 tiles using dense row-major first-fit', () => {
  const tiles: MobileTile[] = [
    makeTile('tall', '音量+', { colSpan: 1, rowSpan: 2 }), // (0,0) w=1 h=2 -> occupies (0,0),(0,1)
    makeTile('wide', '继续执行', { colSpan: 2, rowSpan: 1 }), // (1,0) w=2 h=1 -> occupies (1,0),(2,0)
    makeTile('small-a', '确认', { colSpan: 1, rowSpan: 1 }), // (1,1) w=1 h=1 -> occupies (1,1)
    makeTile('hero', '大动作垫', { colSpan: 2, rowSpan: 2 }), // cannot fit at (2,1), goes to (0,2) w=2 h=2
    makeTile('hole-filler', '补位键', { colSpan: 1, rowSpan: 1 }), // dense hole-fill into (2,1)!
    makeTile('side-2', '右下1', { colSpan: 1, rowSpan: 2 }), // fills (2,2)..(2,3)!
  ]

  const packed = packBentoTiles(tiles, 3)
  assertEqual(packed.columns, 3)
  assertEqual(packed.totalRows, 4)
  assertDeepEqual(
    packed.items.map(item => ({
      id: item.tile.id,
      col: item.col,
      row: item.row,
      colSpan: item.colSpan,
      rowSpan: item.rowSpan,
    })),
    [
      { id: 'tall', col: 0, row: 0, colSpan: 1, rowSpan: 2 },
      { id: 'wide', col: 1, row: 0, colSpan: 2, rowSpan: 1 },
      { id: 'small-a', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { id: 'hero', col: 0, row: 2, colSpan: 2, rowSpan: 2 },
      { id: 'hole-filler', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      { id: 'side-2', col: 2, row: 2, colSpan: 1, rowSpan: 2 },
    ],
  )
})

defineTest('normalizePageZones handles Classic Remote, legacy grid, and orphan tile rescue', () => {
  const classicPage: MobileDeckPage = {
    id: 'classic-remote',
    name: '经典遥控器',
    layout: 'remote',
    columns: 3,
    tiles: [
      makeTile('remote.esc', '退出', { icon: 'esc', accent: 'rose' }),
      makeTile('remote.menu', '菜单', { icon: 'search', accent: 'blue' }),
      makeTile('remote.home', '主页', { icon: 'command' }),
      makeTile('remote.back', '返回', { icon: 'undo' }),
      makeTile('remote.up', '上', { icon: 'arrow-up' }),
      makeTile('remote.vol_up', '音量+', { icon: 'volume-up' }),
      makeTile('remote.left', '左', { icon: 'arrow-left' }),
      makeTile('remote.ok', '确认', { icon: 'enter', accent: 'blue' }),
      makeTile('remote.right', '右', { icon: 'arrow-right' }),
      makeTile('remote.mute', '静音', { icon: 'volume-mute' }),
      makeTile('remote.down', '下', { icon: 'arrow-down' }),
      makeTile('remote.vol_down', '音量-', { icon: 'volume-mute' }),
      makeTile('remote.q1', 'Q1'),
      makeTile('remote.q2', 'Q2'),
      makeTile('remote.q3', 'Q3'),
      makeTile('remote.q4', 'Q4'),
    ],
  }

  const classicZones = normalizePageZones(classicPage)
  assertEqual(classicZones.length, 3)
  assertEqual(classicZones[0].kind, 'bento-grid')
  assertEqual(classicZones[0].columns, 3)
  assertDeepEqual(classicZones[0].tileIds, ['remote.esc', 'remote.menu', 'remote.home'])
  assertEqual(classicZones[1].kind, 'dpad-3x3')
  assertEqual(classicZones[1].tileIds.length, 9)
  assertEqual(classicZones[1].tileIds[4], 'remote.ok')
  assertEqual(classicZones[2].kind, 'bento-grid')
  assertEqual(classicZones[2].columns, 2)
  assertDeepEqual(classicZones[2].tileIds, ['remote.q1', 'remote.q2', 'remote.q3', 'remote.q4'])

  // Orphan rescue when only pointer-pad is declared in zones
  const mixedWithOrphan: MobileDeckPage = {
    id: 'mixed-1',
    name: '混排页',
    columns: 4,
    tiles: [makeTile('t1', '键1'), makeTile('t2', '键2')],
    zones: [{ id: 'z-pad', kind: 'pointer-pad', pointerMode: 'trackpad', tileIds: [] }],
  }
  const rescued = normalizePageZones(mixedWithOrphan)
  assertEqual(rescued.length, 2)
  assertEqual(rescued[0].kind, 'pointer-pad')
  assertEqual(rescued[1].kind, 'bento-grid')
  assertEqual(rescued[1].columns, 4)
  assertDeepEqual(rescued[1].tileIds, ['t1', 't2'])
})

defineTest('XML escaping and special tile IDs pass strict parseRuntimeDescriptorSvg validation', () => {
  assertEqual(
    escapeXml(`A & B <script>"x"</script> 'y'\x00`),
    'A &amp; B &lt;script&gt;&quot;x&quot;&lt;/script&gt; &apos;y&apos;',
  )

  const trickyPage: MobileDeckPage = {
    id: 'custom<page>&1',
    name: `测试 <Bento> & "引号" '单引号'`,
    columns: 3,
    tiles: [
      makeTile('tile.custom.1', `保存 & 提交 <Ctrl+S>`, {
        actionSummary: `Ctrl+"Shift"+<Enter> & 'Alt'`,
        colSpan: 2,
        rowSpan: 1,
        accent: 'blue',
        icon: 'save',
      }),
      // Colliding sanitized DOM IDs ('tile.a-b' vs 'tile.a_b' vs 'tile/a-b')
      makeTile('tile.a-b', '键 A-B', { icon: 'terminal', accent: 'violet', mode: 'hold', actionSummary: '按住 Shift' }),
      makeTile('tile/a-b', '键 /A-B', { icon: 'code', accent: 'emerald', rowSpan: 2 }),
      makeTile('tile:a-b', '   ', { icon: 'unknown-custom-icon', accent: 'amber' }),
    ],
  }

  const snapshot = makeBaseSnapshot([trickyPage])
  snapshot.voiceBindingSummary = `Win+"H" & <Alt>`

  const svg = synthesizeMobileDescriptorSvg(snapshot)
  assertOk(!svg.includes('<script>'), 'raw unescaped tag must never appear in SVG')
  const parsed = parseRuntimeDescriptorSvg(svg, {
    kind: 'axonkeyMobile',
    name: 'Axonkey Mobile',
    model: 'Axonkey Mobile',
  })

  assertEqual(parsed.supportPackage.kind, 'axonkeyMobile')
  assertEqual(parsed.supportPackage.inputs.length, 5) // 4 custom tiles + mobile.voice
  assertEqual(parsed.supportPackage.inputs[0].id, 'tile.custom.1')
  assertEqual(parsed.supportPackage.inputs[0].label, '保存 & 提交 <Ctrl+S>')
  assertEqual(parsed.supportPackage.inputs[4].id, 'mobile.voice')
  assertDeepEqual(parsed.remoteView.voice, {
    engine: 'axonkey-mobile.pcm',
    transport: 'network',
    triggerModes: ['hold', 'click'],
  })
})

defineTest(
  'buildDynamicMobileSupportPackage succeeds across Classic Remote, Multi-Span Bento, Mixed Pointer+Keys, and Blank pages',
  () => {
    const classicPage: MobileDeckPage = {
      id: 'classic-remote',
      name: '经典遥控器',
      layout: 'remote',
      columns: 3,
      tiles: [
        makeTile('remote.esc', '退出/中断', { icon: 'esc', accent: 'rose' }),
        makeTile('remote.menu', '命令菜单', { icon: 'search', accent: 'blue' }),
        makeTile('remote.home', '主页/对话', { icon: 'command' }),
        makeTile('remote.back', '返回', { icon: 'undo' }),
        makeTile('remote.up', '上', { icon: 'arrow-up' }),
        makeTile('remote.vol_up', '音量+', { icon: 'volume-up' }),
        makeTile('remote.left', '左', { icon: 'arrow-left' }),
        makeTile('remote.ok', '确认', { icon: 'enter', accent: 'blue', actionSummary: 'Enter' }),
        makeTile('remote.right', '右', { icon: 'arrow-right' }),
        makeTile('remote.mute', '静音', { icon: 'volume-mute' }),
        makeTile('remote.down', '下', { icon: 'arrow-down' }),
        makeTile('remote.vol_down', '音量-', { icon: 'volume-mute' }),
        makeTile('remote.q1', '继续执行', { icon: 'sparkles', accent: 'blue' }),
        makeTile('remote.q2', '接受变更', { icon: 'check', accent: 'emerald' }),
        makeTile('remote.q3', '撤销', { icon: 'undo', accent: 'amber' }),
        makeTile('remote.q4', '播放/暂停', { icon: 'play', accent: 'violet' }),
      ],
    }

    const bentoPage: MobileDeckPage = {
      id: 'bento-pro',
      name: '多尺寸 Bento',
      layout: 'grid',
      columns: 4,
      tiles: [
        makeTile('b.hero', 'AI 执行', {
          colSpan: 2,
          rowSpan: 2,
          accent: 'blue',
          icon: 'sparkles',
          actionSummary: 'Ctrl+Enter',
        }),
        makeTile('b.vol_plus', '音量+', { colSpan: 1, rowSpan: 2, accent: 'emerald', icon: 'volume-up', mode: 'hold' }),
        makeTile('b.esc', '中断', { colSpan: 1, rowSpan: 1, accent: 'rose', icon: 'esc' }),
        makeTile('b.undo', '撤销', { colSpan: 1, rowSpan: 1, accent: 'amber', icon: 'undo' }),
        makeTile('b.wide', '粘贴提示词', { colSpan: 2, rowSpan: 1, accent: 'violet', icon: 'clipboard' }),
      ],
    }

    const mixedPage: MobileDeckPage = {
      id: 'mixed-pad',
      name: '触控+快捷混排',
      columns: 3,
      tiles: [
        makeTile('m.up', '上移', { icon: 'arrow-up' }),
        makeTile('m.left', '左移', { icon: 'arrow-left' }),
        makeTile('m.ok', '回车', { icon: 'enter', accent: 'blue' }),
        makeTile('m.right', '右移', { icon: 'arrow-right' }),
        makeTile('m.down', '下移', { icon: 'arrow-down' }),
        makeTile('m.copy', '复制', { icon: 'copy' }),
        makeTile('m.paste', '粘贴', { icon: 'clipboard' }),
        makeTile('m.run', '运行', { colSpan: 2, rowSpan: 1, icon: 'play', accent: 'emerald' }),
      ],
      zones: [
        { id: 'z-pointer', kind: 'pointer-pad', pointerMode: 'relative', tileIds: [] },
        {
          id: 'z-dpad',
          kind: 'dpad-3x3',
          tileIds: ['', 'm.up', '', 'm.left', 'm.ok', 'm.right', '', 'm.down', ''],
        },
        {
          id: 'z-bento',
          kind: 'bento-grid',
          columns: 2,
          tileIds: ['m.copy', 'm.paste', 'm.run'],
        },
      ],
    }

    const blankPage: MobileDeckPage = {
      id: 'blank',
      name: '空白页',
      columns: 3,
      tiles: [],
    }

    const snapshot = makeBaseSnapshot([classicPage, bentoPage, mixedPage, blankPage], 'classic-remote')

    const pkgClassic = buildDynamicMobileSupportPackage(snapshot, 'classic-remote')
    assertEqual(pkgClassic.inputs.length, 17)
    assertEqual(pkgClassic.inputs.find(i => i.id === 'remote.vol_down')?.icon, 'volumeDown')

    const pkgBento = buildDynamicMobileSupportPackage(snapshot, 'bento-pro')
    assertEqual(pkgBento.inputs.length, 6) // 5 bento tiles + mobile.voice
    assertEqual(pkgBento.remoteView?.ariaLabel, 'Axonkey Mobile · 多尺寸 Bento')

    const pkgMixed = buildDynamicMobileSupportPackage(snapshot, 'mixed-pad')
    assertEqual(pkgMixed.inputs.length, 9) // 5 dpad (4 blank corners skipped) + 3 bento + mobile.voice

    const pkgBlank = buildDynamicMobileSupportPackage(snapshot, 'blank')
    assertEqual(pkgBlank.inputs.length, 1) // mobile.voice always present
    assertEqual(pkgBlank.inputs[0].id, 'mobile.voice')
  },
)

defineTest(
  'setDynamicSupportPackageOverride updates subscribers cleanly without triggering cloud-override warnings',
  () => {
    resetRuntimeSupportPackages()
    try {
      let notifications = 0
      const unsubscribe = subscribeSupportPackages(() => {
        notifications += 1
      })

      // Simulate a cloud descriptor existing for axonkeyMobile
      const bundledMobile = packageFor('axonkeyMobile')
      setRuntimeSupportPackages([{ ...bundledMobile, name: 'Axonkey Mobile Cloud' }])
      assertEqual(getLocalCloudDescriptorOverrides().length, 0)

      const customSnapshot = makeBaseSnapshot([
        {
          id: 'custom-v3',
          name: '自定义测试页',
          columns: 2,
          tiles: [makeTile('custom.btn1', '专属宏 1', { colSpan: 2, rowSpan: 2, accent: 'emerald' })],
        },
      ])
      const dynamicPkg = buildDynamicMobileSupportPackage(customSnapshot)

      const beforeNotifications = notifications
      const changed = setDynamicSupportPackageOverride('axonkeyMobile', dynamicPkg)
      assertEqual(changed, true)
      assertEqual(notifications, beforeNotifications + 1)
      assertDeepEqual(
        packageFor('axonkeyMobile').inputs.map(i => i.id),
        ['custom.btn1', 'mobile.voice'],
      )
      // Crucial: zero false cloud-override warnings!
      assertEqual(getLocalCloudDescriptorOverrides().length, 0)

      // Clearing override restores cloud/bundled package cleanly
      const cleared = setDynamicSupportPackageOverride('axonkeyMobile', null)
      assertEqual(cleared, true)
      assertEqual(packageFor('axonkeyMobile').name, 'Axonkey Mobile Cloud')

      unsubscribe()
    } finally {
      resetRuntimeSupportPackages()
    }
  },
)

const globalTestEnv = globalThis as {
  it?: (name: string, fn: TestFn) => void
  __vitest_worker__?: unknown
}
if (typeof globalTestEnv.it === 'function') {
  for (const [name, fn] of registeredSuites) {
    globalTestEnv.it(name, fn)
  }
} else {
  const runnerSpec = globalTestEnv.__vitest_worker__ ? 'vit' + 'est' : 'node:' + 'test'
  void (import(runnerSpec) as Promise<{ test: (name: string, fn: TestFn) => void }>)
    .then(mod => {
      for (const [name, fn] of registeredSuites) {
        mod.test(name, fn)
      }
    })
    .catch(() => {
      for (const [, fn] of registeredSuites) fn()
    })
}
