import assert from 'node:assert/strict'
import test from 'node:test'
import { gainAdjustedLevel, gainLevelTone, suggestedAudioGain } from '../src/audioGain.ts'

test('gain estimate preserves silence and exposes clipping instead of hiding it', () => {
  assert.equal(gainAdjustedLevel(0, 30), 0)
  assert.equal(gainAdjustedLevel(0.1, 20), 1)
  assert.equal(gainAdjustedLevel(0.5, 20), 5)
  assert.equal(gainAdjustedLevel(0.5, 0), 0.5)
  assert.equal(gainAdjustedLevel(1, -20), 0.1)
})

test('suggestion targets -12 dBFS with bounded gain and rejects insufficient or clipped input', () => {
  assert.equal(suggestedAudioGain(0.1, -30, 30), 8)
  assert.equal(suggestedAudioGain(0.004, -30, 30), 30)
  assert.equal(suggestedAudioGain(0.9, -5, 30), -5)
  for (const peak of [0, 0.001, 1, NaN, Infinity]) {
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
