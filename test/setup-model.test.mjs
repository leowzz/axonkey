import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activateSetupStep,
  completeSetupStep,
  createDefaultSetupState,
  parseStoredSetup,
  setLegacyCleanupProbe,
  setSetupStepStatus,
  skipSetup,
} from '../src/setupModel.ts'

const clear = { frida: false, interception: false, interceptionFix: false, namedPipeServer: false }
const detected = { ...clear, frida: true, namedPipeServer: true }

test('legacy cleanup is inserted before Windows driver setup when detected', () => {
  let state = completeSetupStep(createDefaultSetupState(), 'welcome')
  assert.equal(state.currentStep, 'deviceConnection')

  state = setLegacyCleanupProbe(state, detected)
  assert.equal(state.currentStep, 'legacyCleanup')
  assert.equal(state.steps.legacyCleanup.status, 'active')
  assert.equal(state.legacyCleanup.components.frida, true)
})

test('legacy cleanup can be completed after a clear recheck', () => {
  let state = completeSetupStep(createDefaultSetupState(), 'welcome')
  state = setLegacyCleanupProbe(state, detected)
  state = setLegacyCleanupProbe(state, clear)
  assert.equal(state.currentStep, 'deviceConnection')
  assert.equal(state.steps.legacyCleanup.status, 'skipped')
  state = completeSetupStep(state, 'deviceConnection')
  assert.equal(state.currentStep, 'inputDriver')
})

test('old persisted setup data keeps the migration step hidden until detection', () => {
  const state = createDefaultSetupState()
  assert.equal(state.steps.legacyCleanup.status, 'skipped')
  assert.equal(state.currentStep, 'welcome')
})

test('reopening driver setup clears stale completion until the real probe confirms it', () => {
  let state = createDefaultSetupState()
  state = setSetupStepStatus(state, 'inputDriver', 'complete')
  state = activateSetupStep(state, 'inputDriver')
  assert.equal(state.steps.inputDriver.status, 'active')
  state = setSetupStepStatus(state, 'inputDriver', 'complete')
  assert.equal(state.steps.inputDriver.status, 'complete')
})

test('either legacy driver reopens cleanup even after setup was completed', () => {
  for (const component of ['interception', 'interceptionFix']) {
    const completed = skipSetup(createDefaultSetupState())
    const state = setLegacyCleanupProbe(completed, { ...clear, [component]: true })
    assert.equal(state.legacyCleanup.status, 'present')
    assert.equal(state.currentStep, 'legacyCleanup')
    assert.equal(state.steps.legacyCleanup.status, 'active')
    assert.equal(state.setupSkipped, false)
  }
})

test('old saved setup data defaults the repair service flag to false', () => {
  const saved = createDefaultSetupState()
  delete saved.legacyCleanup.components.interceptionFix
  assert.equal(parseStoredSetup(saved).legacyCleanup.components.interceptionFix, false)
  saved.legacyCleanup.components.interceptionFix = true
  assert.equal(parseStoredSetup(JSON.stringify(saved)).legacyCleanup.components.interceptionFix, true)
})

test('checking and failed probes retain the migration step until a clear result', () => {
  let state = setLegacyCleanupProbe(skipSetup(createDefaultSetupState()), { ...clear, interceptionFix: true })
  state = setLegacyCleanupProbe(state, clear, { checking: true })
  assert.equal(state.legacyCleanup.status, 'checking')
  assert.equal(state.currentStep, 'legacyCleanup')
  state = setLegacyCleanupProbe(state, clear, { error: 'cannot read status' })
  assert.equal(state.legacyCleanup.status, 'error')
  assert.equal(state.currentStep, 'legacyCleanup')
  assert.equal(state.steps.legacyCleanup.status, 'active')
  state = setLegacyCleanupProbe(state, clear)
  assert.equal(state.legacyCleanup.status, 'clear')
  assert.equal(state.steps.legacyCleanup.status, 'skipped')
})

test('stale component flags do not reopen migration while a check is pending or failed', () => {
  const completed = skipSetup(createDefaultSetupState())
  const stale = { ...clear, interceptionFix: true }
  for (const options of [{ checking: true }, { error: 'helper unavailable' }]) {
    const state = setLegacyCleanupProbe(completed, stale, options)
    assert.equal(state.currentStep, 'complete')
    assert.equal(state.steps.legacyCleanup.status, 'skipped')
  }
})
