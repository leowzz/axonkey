import type { Behavior, SwitchProfileBehavior, TriggerType } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { behaviorSummary, triggerLabels } from '../appConfig'
import { WorkflowStepDialog } from './WorkflowStepDialog'

export function ProfileSwitchConfirmDialog({ button, trigger, behavior, targets, activeProfileId, platform, onCancel, onConfirm }: {
  button: MappingInput
  trigger: TriggerType
  behavior: SwitchProfileBehavior
  targets: { id: string; name: string; behaviors: Behavior[] }[]
  activeProfileId: string
  platform: Platform
  onCancel: () => void
  onConfirm: (behavior: SwitchProfileBehavior) => void
}) {
  const location = [button.label, button.contextLabel, button.triggerLabel ?? triggerLabels[trigger]].filter(Boolean).join(' · ')
  const empty = trigger === 'click' || button.inheritDefault ? button.originalLabel ?? '保留原按键' : '未设置'
  return <WorkflowStepDialog
    edit={{ stepId: behavior.id, trigger, behavior, onSave: (next) => { if (next.type === 'switchProfile') onConfirm(next) } }}
    platform={platform} button={button} onClose={onCancel}
    title="切换配置文件 · 覆盖确认" saveLabel="确认覆盖并放入" saveTone="warning"
  >
    <section className="profile-switch-overwrites" aria-label="将覆盖的配置和行为">
      <p>将覆盖所有配置文件中「{location}」的现有序列，该位置仅保留“切换配置文件”行为。</p>
      <ul>{targets.map((target) => <li key={target.id}>
        <strong>{target.name}{target.id === activeProfileId ? '（当前）' : ''}</strong>
        {target.behaviors.length > 0 ? <ol>{target.behaviors.map((item) => <li key={item.id}>
          {!item.enabled && '已停用 · '}{item.type === 'paste' ? `粘贴：${item.text || '空文本'}` : item.type === 'openApp' ? `打开应用：${item.path}` : behaviorSummary(item, platform)}
        </li>)}</ol> : <span>{empty}</span>}
      </li>)}</ul>
    </section>
  </WorkflowStepDialog>
}
