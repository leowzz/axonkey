import assert from 'node:assert/strict'
import test from 'node:test'
import { audioCalibrationThresholds, calibrationWaveform, audioTestMeasurementReducer, initialAudioTestMeasurement, gainAdjustedLevel, gainLevelTone, suggestedAudioGain } from '../src/audioGain.ts'

test('gain estimate preserves silence and exposes clipping instead of hiding it', () => {
  assert.equal(gainAdjustedLevel(0, 30), 0)
  assert.equal(gainAdjustedLevel(0.1, 20), 1)
  assert.equal(gainAdjustedLevel(0.5, 20), 5)
  assert.equal(gainAdjustedLevel(0.5, 0), 0.5)
  assert.equal(gainAdjustedLevel(1, -20), 0.1)
})

test('suggestion includes quiet input and rejects silent, invalid or clipped input', () => {
  assert.equal(suggestedAudioGain(0.1, -30, 30), 8)
  assert.equal(suggestedAudioGain(0.004, -30, 30), 30)
  assert.equal(suggestedAudioGain(0.9, -5, 30), -5)
  assert.equal(suggestedAudioGain(0.001, -30, 30), 30)
  assert.equal(suggestedAudioGain(1 / 32768, -30, 30), 30)
  for (const peak of [0, -0.001, 1, NaN, Infinity]) {
    assert.equal(suggestedAudioGain(peak, -30, 30), null)
  }
})

test('feedback distinguishes silence, low volume, reference range, headroom and clipping', () => {
  assert.equal(gainLevelTone(0), 'silent')
  assert.equal(gainLevelTone(0.01), 'low')
  assert.equal(gainLevelTone(0.25), 'good')
  assert.equal(gainLevelTone(0.8), 'hot')
  assert.equal(gainLevelTone(1), 'clipping')
  assert.equal(gainLevelTone(2), 'clipping')
})


test('recommendation is calculated once after the whole measurement and frozen until reset', () => {
  let state = audioTestMeasurementReducer(initialAudioTestMeasurement, { type: 'sample', peak: 0.1 })
  state = audioTestMeasurementReducer(state, { type: 'sample', peak: 0.25 })
  state = audioTestMeasurementReducer(state, { type: 'sample', peak: 0 })
  assert.equal(state.maximum, 0.25)
  assert.equal(state.suggestedGain, null)
  assert.equal(state.completed, false)
  state = audioTestMeasurementReducer(state, { type: 'finish', minimum: -30, maximum: 30 })
  assert.equal(state.completed, true)
  assert.equal(state.suggestedGain, 0)
  assert.strictEqual(audioTestMeasurementReducer(state, { type: 'sample', peak: 1 }), state)
  assert.strictEqual(audioTestMeasurementReducer(state, { type: 'finish', minimum: 10, maximum: 30 }), state)
  assert.deepEqual(audioTestMeasurementReducer(state, { type: 'reset' }), initialAudioTestMeasurement)
})

test('empty measurements cannot finish and clipped measurements never recommend gain', () => {
  const finish = { type: 'finish', minimum: -30, maximum: 30 }
  assert.strictEqual(audioTestMeasurementReducer(initialAudioTestMeasurement, finish), initialAudioTestMeasurement)
  const clipped = audioTestMeasurementReducer(initialAudioTestMeasurement, { type: 'sample', peak: 1 })
  const result = audioTestMeasurementReducer(clipped, finish)
  assert.equal(result.completed, true)
  assert.equal(result.suggestedGain, null)
})

test('calibration waveform follows gain, keeps missing intervals and freezes at the last sample on release', () => {
  const points = [{t: 1000, peak: .1}, {t: 2000, peak: 0}, {t: 2500, peak: 1}]
  const live = calibrationWaveform(points, 20, 3000, true)
  assert.equal(live.end, 3000)
  assert.equal(live.points[0].db, 0)
  assert.equal(live.points[1].db, -60)
  assert.equal(live.points[2].db, 20)
  assert.equal(live.points.length, 3)
  assert.equal(calibrationWaveform(points, 0, 50000, false).end, 2500)
  assert.equal(calibrationWaveform(points, 0, 50000, true).points.length, 0)
  assert.equal(calibrationWaveform([{t:NaN,peak:1},{t:1,peak:Infinity}], 0, 10, true).points.length, 0)
  assert.equal(audioCalibrationThresholds.low, -24)
  assert.equal(audioCalibrationThresholds.high, -6)
  assert.equal(audioCalibrationThresholds.clipping, 0)
})
