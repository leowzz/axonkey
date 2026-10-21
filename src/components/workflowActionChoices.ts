import type { Behavior } from '../behaviorModel.ts'

export type WorkflowActionChoicePreset = 'mouseButton' | 'volumeControl' | 'mediaTrack'
type ChoiceBehavior = { type: 'mouse'; button: 'left' | 'right' } | { type: 'key'; key: string }
export type WorkflowActionChoice = { label: string; stepType: string; behavior: ChoiceBehavior }
type ChoiceGroup = { preset: WorkflowActionChoicePreset; title: string; label: string; options: WorkflowActionChoice[] }

export const workflowActionChoiceGroups: ChoiceGroup[] = [
  { preset: 'mouseButton', title: '鼠标按键', label: '按键', options: [
    { label: '左键', stepType: 'mouseLeft', behavior: { type: 'mouse', button: 'left' } },
    { label: '右键', stepType: 'mouseRight', behavior: { type: 'mouse', button: 'right' } },
  ] },
  { preset: 'volumeControl', title: '音量控制', label: '音量动作', options: [
    { label: '增大音量', stepType: 'volumeUp', behavior: { type: 'key', key: 'VolumeUp' } },
    { label: '减小音量', stepType: 'volumeDown', behavior: { type: 'key', key: 'VolumeDown' } },
    { label: '静音', stepType: 'volumeMute', behavior: { type: 'key', key: 'VolumeMute' } },
  ] },
  { preset: 'mediaTrack', title: '曲目切换', label: '曲目动作', options: [
    { label: '上一首', stepType: 'mediaPrevious', behavior: { type: 'key', key: 'MediaPrevious' } },
    { label: '下一首', stepType: 'mediaNext', behavior: { type: 'key', key: 'MediaNext' } },
  ] },
]

export function isWorkflowActionChoiceSelected(behavior: Behavior, option: WorkflowActionChoice) {
  const value = option.behavior
  return value.type === 'mouse'
    ? behavior.type === 'mouse' && behavior.button === value.button
    : behavior.type === 'key' && behavior.key === value.key
}

export function workflowActionChoiceGroup(behavior: Behavior) {
  return workflowActionChoiceGroups.find((group) => group.options.some((option) => isWorkflowActionChoiceSelected(behavior, option)))
}

export function workflowActionChoiceStep(type: string) {
  return workflowActionChoiceGroups.find((group) => group.preset === type || group.options.some((option) => option.stepType === type))
}
