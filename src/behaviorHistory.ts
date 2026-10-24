import type { BehaviorMap } from './behaviorModel'
import type { DeviceId } from './deviceModel'
import { mergeDeviceBehaviors } from './deviceProfiles.ts'

export type BehaviorHistory = {
  past: BehaviorMap[]
  present: BehaviorMap
  future: BehaviorMap[]
}

export type BehaviorHistoryAction =
  | { type: 'change'; update: (current: BehaviorMap) => BehaviorMap }
  | { type: 'replace'; present: BehaviorMap }
  | { type: 'rebaseDevice'; deviceId: DeviceId; behaviors: BehaviorMap }
  | { type: 'undo' }
  | { type: 'redo' }

const historyLimit = 100

export function createBehaviorHistory(present: BehaviorMap): BehaviorHistory {
  return { past: [], present, future: [] }
}

export function behaviorHistoryReducer(state: BehaviorHistory, action: BehaviorHistoryAction): BehaviorHistory {
  switch (action.type) {
    case 'replace':
      return { past: [], present: action.present, future: [] }
    case 'rebaseDevice': {
      const rebase = (behaviors: BehaviorMap) => mergeDeviceBehaviors(behaviors, action.deviceId, action.behaviors)
      return { past: state.past.map(rebase), present: rebase(state.present), future: state.future.map(rebase) }
    }
    case 'change': {
      const present = action.update(state.present)
      if (present === state.present) return state
      return {
        past: [...state.past, state.present].slice(-historyLimit),
        present,
        future: [],
      }
    }
    case 'undo': {
      const present = state.past[state.past.length - 1]
      if (!present) return state
      return {
        past: state.past.slice(0, -1),
        present,
        future: [state.present, ...state.future].slice(0, historyLimit),
      }
    }
    case 'redo': {
      const present = state.future[0]
      if (!present) return state
      return {
        past: [...state.past, state.present].slice(-historyLimit),
        present,
        future: state.future.slice(1),
      }
    }
  }
}
