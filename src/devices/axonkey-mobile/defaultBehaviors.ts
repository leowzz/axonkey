import { createBehavior } from '../../behaviorModel.ts'
import type { Behavior, TriggerBehaviors } from '../../behaviorModel.ts'

function triggers(click: Behavior[] = [], doubleClick: Behavior[] = [], longPress: Behavior[] = []): TriggerBehaviors {
  return { click, doubleClick, longPress }
}

const keyAct = (key: string) => createBehavior({ type: 'key', key })
const shortcutAct = (keys: readonly string[]) => createBehavior({ type: 'shortcut', keys })
const pasteAct = (text: string, title?: string) => createBehavior({ type: 'paste', text, title })

export function createDefaultAxonkeyMobileBehaviors(): Record<string, TriggerBehaviors> {
  return {
    'remote.esc': triggers([keyAct('Esc')]),
    'remote.menu': triggers([shortcutAct(['Ctrl', 'K'])]),
    'remote.home': triggers([shortcutAct(['Ctrl', 'L'])]),
    'remote.back': triggers([keyAct('Backspace')], [], [shortcutAct(['Ctrl', 'Z'])]),
    'remote.up': triggers([keyAct('Up')]),
    'remote.down': triggers([keyAct('Down')]),
    'remote.left': triggers([keyAct('Left')]),
    'remote.right': triggers([keyAct('Right')]),
    'remote.ok': triggers([keyAct('Enter')], [shortcutAct(['Ctrl', 'Enter'])]),
    'remote.vol_up': triggers([keyAct('VolumeUp')]),
    'remote.vol_down': triggers([keyAct('VolumeDown')]),
    'remote.mute': triggers([keyAct('VolumeMute')]),
    'remote.q1': triggers([pasteAct('继续执行，完成后汇报验证结果。', '继续执行'), keyAct('Enter')]),
    'remote.q2': triggers([shortcutAct(['Ctrl', 'Enter'])]),
    'remote.q3': triggers([shortcutAct(['Ctrl', 'Z'])], [shortcutAct(['Ctrl', 'Y'])]),
    'remote.q4': triggers([keyAct('MediaPlayPause')]),
    'mobile.voice': triggers([keyAct('Alt')]),
  }
}
