export const audioCalibrationThresholds = { low: -24, high: -6, clipping: 0 } as const
export type CalibrationWaveformPoint = { t: number; peak: number }

export function calibrationWaveform(
  points: CalibrationWaveformPoint[],
  gain: number,
  now: number,
  forwarding: boolean,
) {
  const valid = points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.peak) && p.peak >= 0)
  const end = forwarding ? now : (valid[valid.length - 1]?.t ?? now)
  const start = end - 10_000
  return {
    start,
    end,
    points: valid
      .filter(p => p.t >= start && p.t <= end)
      .map(p => {
        const level = gainAdjustedLevel(p.peak, gain)
        return { t: p.t, db: level > 0 ? 20 * Math.log10(level) : -60 }
      }),
  }
}

export const idleVoiceBarLevels = [0.22, 0.45, 0.72, 0.92, 0.64, 0.38, 0.22] as const

export function gainAdjustedLevel(level: number, gain: number) {
  return level > 0 && Number.isFinite(level) ? level * 10 ** (gain / 20) : 0
}

export function normalizeAudioAmplitude(level: number, gain: number) {
  const adjusted = gainAdjustedLevel(level, gain)
  if (!(adjusted > 0)) return 0
  const db = 20 * Math.log10(adjusted)
  return Math.max(0, Math.min(1, (db + 54) / 54))
}

export function nextVoiceAmplitudeBars(
  previous: readonly number[],
  rms: number,
  peak: number,
  gain: number,
): { bars: number[]; tone: ReturnType<typeof gainLevelTone> } {
  const level = Math.max(rms, peak * 0.65)
  const amplitude = normalizeAudioAmplitude(level, gain)
  const tone = gainLevelTone(gainAdjustedLevel(peak, gain))
  const size = previous.length || idleVoiceBarLevels.length
  const next = size > 1 ? previous.slice(-(size - 1)) : []
  while (next.length < size - 1) next.unshift(0)
  next.push(amplitude)
  return { bars: next, tone }
}

export function suggestedAudioGain(peak: number, minimum: number, maximum: number): number | null {
  if (!Number.isFinite(peak) || peak <= 0 || peak >= 0.999) return null
  return Math.max(minimum, Math.min(maximum, Math.round(-12 - 20 * Math.log10(peak))))
}

export function gainLevelTone(peak: number): 'silent' | 'low' | 'good' | 'hot' | 'clipping' {
  if (!(peak > 0)) return 'silent'
  if (peak >= 1) return 'clipping'
  const decibels = 20 * Math.log10(peak)
  if (decibels > audioCalibrationThresholds.high) return 'hot'
  return decibels < audioCalibrationThresholds.low ? 'low' : 'good'
}

export type AudioTestMeasurement = {
  maximum: number
  completed: boolean
  suggestedGain: number | null
}

export const initialAudioTestMeasurement: AudioTestMeasurement = {
  maximum: 0,
  completed: false,
  suggestedGain: null,
}

export function audioTestMeasurementReducer(
  state: AudioTestMeasurement,
  action: { type: 'sample'; peak: number } | { type: 'reset' } | { type: 'finish'; minimum: number; maximum: number },
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
