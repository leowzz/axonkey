export function gainAdjustedLevel(level: number, gain: number) {
  return level > 0 && Number.isFinite(level) ? level * 10 ** (gain / 20) : 0
}

export function suggestedAudioGain(peak: number, minimum: number, maximum: number): number | null {
  if (!Number.isFinite(peak) || peak < 10 ** (-50 / 20) || peak >= 0.999) return null
  return Math.max(minimum, Math.min(maximum, Math.round(-12 - 20 * Math.log10(peak))))
}

export function gainLevelTone(peak: number): 'silent' | 'low' | 'good' | 'hot' | 'clipping' {
  if (!(peak > 0)) return 'silent'
  if (peak >= 1) return 'clipping'
  const decibels = 20 * Math.log10(peak)
  if (decibels > -6) return 'hot'
  return decibels < -24 ? 'low' : 'good'
}
