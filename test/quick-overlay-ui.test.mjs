import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})

const { buildQuickOverlayView, summarizeQuickTrigger } = await import('../src/components/quickOverlayModel.ts')
const { applyLocalCustomDevices } = await import('../src/cloud/deviceModelCatalog.ts')

test('quick overlay view resolves trigger exit key, preserves full prompt text, and excludes trigger key from executable cards', () => {
  const longPrompt =
    '请作为资深架构师审查当前选中的代码，重点指出潜在的数据竞争、未处理的错误分支以及可简化的抽象，不要重写无关逻辑。'

  const view = buildQuickOverlayView(
    {
      revision: 3,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '书房遥控器',
      profileId: 'quick-ai',
      profileName: 'AI 编程提示词',
      triggerInput: 'xiaomi.rc003.menu',
      pressed: ['xiaomi.rc003.up'],
      preview: false,
      behaviors: {
        menu: {
          click: [{ id: '1', type: 'paste', text: '不会被执行，因为再次按触发键直接退出', enabled: true }],
        },
        'xiaomi.rc003.up': {
          click: [
            { id: '2', type: 'paste', text: longPrompt, enabled: true },
            { id: '3', type: 'delay', ms: 30, enabled: true },
            { id: '4', type: 'key', key: 'Enter', enabled: true },
          ],
        },
        down: {
          click: [{ id: '5', type: 'shortcut', keys: ['Win', 'K'], enabled: true }],
          longPress: [{ id: '6', type: 'paste', text: '生成精简的单元测试用例', enabled: true }],
        },
      },
    },
    'macos',
  )

  assert.equal(view.isMouse, false)
  assert.equal(view.profileName, 'AI 编程提示词')
  assert.equal(view.deviceName, '书房遥控器')
  assert.equal(view.triggerInputId, 'menu')
  assert.ok(view.triggerLabel && view.triggerLabel.length > 0)
  assert.deepEqual(view.pressedIds, ['up'])
  assert.deepEqual(view.mappedIds, ['up', 'down'])

  const upCard = view.items.find(item => item.inputId === 'up')
  assert.ok(upCard)
  assert.equal(upCard.triggers.length, 1)
  assert.equal(upCard.triggers[0].kind, 'prompt')
  assert.equal(upCard.triggers[0].badge, '粘贴并发送')
  assert.equal(upCard.triggers[0].text, longPrompt)

  const downCard = view.items.find(item => item.inputId === 'down')
  assert.ok(downCard)
  assert.equal(downCard.triggers.length, 2)
  assert.equal(downCard.triggers[0].triggerLabel, '单击')
  assert.match(downCard.triggers[0].text, /Cmd \+ K/)
  assert.equal(downCard.triggers[1].triggerLabel, '长按')
  assert.equal(downCard.triggers[1].text, '生成精简的单元测试用例')
})

test('quick overlay view supports system mouse and custom SVG devices', () => {
  const mouseView = buildQuickOverlayView(
    {
      revision: 7,
      sourceId: 'mouse',
      deviceKind: 'mouse',
      deviceName: '系统鼠标',
      profileId: 'mouse-q1',
      profileName: '鼠标快捷面板',
      triggerInput: 'mouse.global.buttonMiddle',
      pressed: [],
      preview: false,
      behaviors: {
        'mouse.global.buttonBack': {
          click: [{ id: '1', type: 'paste', text: '总结当前网页核心结论', enabled: true }],
        },
        'mouse.top.up': {
          click: [{ id: '2', type: 'key', key: 'F12', enabled: true }],
        },
      },
    },
    'windows',
  )

  assert.equal(mouseView.isMouse, true)
  assert.equal(mouseView.triggerInputId, 'mouse.global.buttonMiddle')
  assert.equal(mouseView.items.length, 2)
  const topWheel = mouseView.items.find(item => item.inputId === 'mouse.top.up')
  assert.ok(topWheel)
  assert.ok(topWheel.contextLabel)
  assert.equal(topWheel.triggers[0].triggerLabel, '滚动')

  const customSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="200" height="120" viewBox="0 0 200 120"
     data-ak-schema="axonkey.device/1"
     data-ak-device="studio.pad2"
     data-ak-revision="1"
     data-ak-status="active">
  <metadata>
    <ak:device schema="axonkey.device/1" id="studio.pad2" vendor="Studio" model="Pad2" revision="1" display-name="双键宏板" status="active">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xB099" usage-page="0xFF60" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="btns" direction="input" report-id="0x01" length="2" encoding="bit-field" prefix="0x01" state-group="btns" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="studio.pad2.k1" label="宏键一" short="M1" icon="center" kind="button" target="#k1" order="0" original="false" binding="captured"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x01" /></ak:input>
        <ak:input id="studio.pad2.k2" label="宏键二" short="M2" icon="center" kind="button" target="#k2" order="1" original="false" binding="captured"><ak:source report="btns" offset="1" bit="0" width="8" equals="0x02" /></ak:input>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="k1"><rect x="10" y="10" width="80" height="80" /></g>
  <g id="k2"><rect x="110" y="10" width="80" height="80" /></g>
  <path data-ak-region="studio.pad2.k1" data-ak-anchor="50 50" d="M10 10h80v80h-80z" />
  <path data-ak-region="studio.pad2.k2" data-ak-anchor="150 50" d="M110 10h80v80h-80z" />
</svg>`

  applyLocalCustomDevices([
    {
      kind: 'studioPad2',
      deviceId: 'studio.pad2',
      name: '双键宏板',
      model: 'Pad2',
      vendor: 'Studio',
      svg: customSvg,
      filePath: 'custom-devices/studio-pad2.svg',
    },
  ])

  const customView = buildQuickOverlayView(
    {
      revision: 8,
      sourceId: 'pad-1',
      deviceKind: 'studioPad2',
      deviceName: '桌面双键板',
      profileId: 'pad-q1',
      profileName: '剪辑提示',
      triggerInput: 'studio.pad2.k1',
      pressed: [],
      preview: true,
      behaviors: {
        'studio.pad2.k2': {
          click: [{ id: '1', type: 'typeText', text: 'git status -sb', enabled: true }],
        },
      },
    },
    'macos',
  )

  assert.equal(customView.triggerLabel, '宏键一')
  assert.equal(customView.items.length, 1)
  assert.equal(customView.items[0].label, '宏键二')
  assert.equal(customView.items[0].short, 'M2')
  assert.equal(customView.items[0].triggers[0].badge, '输入')
  assert.equal(customView.items[0].triggers[0].text, 'git status -sb')

  applyLocalCustomDevices([])
})

test('summarizeQuickTrigger highlights embedded prompt inside multi-step sequences', () => {
  const detail = summarizeQuickTrigger(
    'click',
    [
      { id: '1', type: 'shortcut', keys: ['Win', 'L'], enabled: true },
      { id: '2', type: 'delay', ms: 80, enabled: true },
      { id: '3', type: 'paste', text: '解释当前报错原因并给出最小修复方案', enabled: true },
      { id: '4', type: 'key', key: 'Enter', enabled: true },
    ],
    'macos',
  )
  assert.ok(detail)
  assert.equal(detail.kind, 'sequence')
  assert.equal(detail.badge, '4 步序列')
  assert.equal(detail.text, '解释当前报错原因并给出最小修复方案')
  assert.match(detail.stepsSummary ?? '', /粘贴文本/)

  assert.equal(
    summarizeQuickTrigger('click', [{ id: '1', type: 'key', key: 'A', enabled: false }], 'macos'),
    null,
  )
  assets.deregister()
})
