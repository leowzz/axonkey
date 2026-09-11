export function gainAdjustedLevel(level: number, gain: number) {
  return level > 0 && Number.isFinite(level) ? level * 10 ** (gain / 20) : 0
}

export function suggestedAudioGain(peak: number, minimum: number, maximum: number): number | null {
  if (!Number.isFinite(peak) || peak <= 0 || peak >= 0.999) return null
  return Math.max(minimum, Math.min(maximum, Math.round(-12 - 20 * Math.log10(peak))))
}

export function gainLevelTone(peak: number): 'silent' | 'low' | 'good' | 'hot' | 'clipping' {
  if (!(peak > 0)) return 'silent'
  if (peak >= 1) return 'clipping'
  const decibels = 20 * Math.log10(peak)
  if (decibels > -6) return 'hot'
  return decibels < -24 ? 'low' : 'good'
}

export type AudioTestMeasurement = {
  maximum: number
  completed: boolean
  suggestedGain: number | null
}

export const initialAudioTestMeasurement: AudioTestMeasurement = {
  maximum: 0, completed: false, suggestedGain: null,
}

export function audioTestMeasurementReducer(state: AudioTestMeasurement, action:
  | { type: 'sample'; peak: number }
  | { type: 'reset' }
  | { type: 'finish'; minimum: number; maximum: number }
): AudioTestMeasurement {
  if (action.type === 'reset') return initialAudioTestMeasurement
  if (state.completed) return state
  if (action.type === 'sample') {
    if (!Number.isFinite(action.peak) || action.peak <= state.maximum) return state
    return { ...state, maximum: action.peak }
  }
  if (state.maximum <= 0) return state
  return {
    ...state,
    completed: true,
    suggestedGain: suggestedAudioGain(state.maximum, action.minimum, action.maximum),
  }
}
