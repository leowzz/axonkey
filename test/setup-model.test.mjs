import assert from 'node:assert/strict'
import test from 'node:test'
import { activateSetupStep, completeSetupStep, createDefaultSetupState, parseStoredSetup, setSetupStepStatus, skipSetup } from '../src/setupModel.ts'

test('setup proceeds without owning legacy driver cleanup', () => {
  const state = completeSetupStep(createDefaultSetupState(), 'welcome')
  assert.equal(state.currentStep, 'deviceConnection')
  assert.equal(Object.hasOwn(state, 'legacyCleanup'), false)
  assert.equal(Object.hasOwn(state.steps, 'legacyCleanup'), false)
})

test('old cleanup page migrates to device connection and cleanup flags are discarded', () => {
  const saved = { ...createDefaultSetupState(), currentStep: 'legacyCleanup', legacyCleanup: { status: 'present', action: { status: 'succeeded' } } }
  saved.steps.legacyCleanup = { status: 'active', visited: true }
  const restored = parseStoredSetup(JSON.stringify(saved))
  assert.equal(restored.currentStep, 'deviceConnection')
  assert.equal(Object.hasOwn(restored, 'legacyCleanup'), false)
  assert.equal(Object.hasOwn(restored.steps, 'legacyCleanup'), false)
})

test('completed setup remains complete regardless of stale cleanup metadata', () => {
  const saved = { ...skipSetup(createDefaultSetupState()), legacyCleanup: { status: 'present' } }
  assert.equal(parseStoredSetup(saved).currentStep, 'complete')
})

test('reopening driver setup clears stale completion until the real probe confirms it', () => {
  let state = createDefaultSetupState()
  state = setSetupStepStatus(state, 'inputDriver', 'complete')
  state = activateSetupStep(state, 'inputDriver')
  assert.equal(state.steps.inputDriver.status, 'active')
  state = setSetupStepStatus(state, 'inputDriver', 'complete')
  assert.equal(state.steps.inputDriver.status, 'complete')
})
