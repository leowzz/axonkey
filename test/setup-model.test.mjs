import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activateSetupStep,
  completeSetupStep,
  createDefaultSetupState,
  setLegacyCleanupProbe,
  setSetupStepStatus,
} from '../src/setupModel.ts'

const clear = { frida: false, interception: false, namedPipeServer: false }
const detected = { frida: true, interception: false, namedPipeServer: true }

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
