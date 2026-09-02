import type { BehaviorMap } from './behaviorModel'

export type BehaviorHistory = {
  past: BehaviorMap[]
  present: BehaviorMap
  future: BehaviorMap[]
}

export type BehaviorHistoryAction =
  | { type: 'change'; update: (current: BehaviorMap) => BehaviorMap }
  | { type: 'undo' }
  | { type: 'redo' }

const historyLimit = 100

export function createBehaviorHistory(present: BehaviorMap): BehaviorHistory {
  return { past: [], present, future: [] }
}

export function behaviorHistoryReducer(state: BehaviorHistory, action: BehaviorHistoryAction): BehaviorHistory {
  switch (action.type) {
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
