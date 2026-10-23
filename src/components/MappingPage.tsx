import type { ComponentProps, MutableRefObject, ReactNode, RefObject } from 'react'
import type { BehaviorMap, ButtonId, InputId, TriggerBehaviors, TriggerType, SwitchProfileBehavior } from '../behaviorModel'
import type { Platform, RemoteButton } from '../appTypes'
import type { DeviceId } from '../deviceModel'
import { RemoteControl } from './RemoteControl'
import { BatteryDebugControls } from './BatteryIndicator'
import { BehaviorEditor } from './BehaviorEditor'
import { DeviceSelector, DeviceStatusCard } from './DeviceRail'
import type { DeviceStatus } from './DeviceRail'
import { MappingKeyGrid, MappingTriggerSelector } from './MappingComponents'
import { MouseInputModel, MouseControlPicker, MouseTriggerSelector } from './MouseMapping'

export type MappingPageProps = {
  debugMode: boolean
  selectedDeviceId: DeviceId
  selectBehaviorTarget: (buttonId: InputId, trigger: TriggerType, reveal?: boolean) => void
  activeId: ButtonId
  mappingMainRef: RefObject<HTMLElement>
  deviceStatus: DeviceStatus
  isMouse: boolean
  selectedBehavior: { buttonId: InputId; trigger: TriggerType }
  adjustPreviewBattery: ComponentProps<typeof BatteryDebugControls>['onAdjust']
  editableButtons: RemoteButton[]
  pressedId: ButtonId | null
  behaviors: BehaviorMap
  onRequestProfileSwitch: (inputId: InputId, trigger: TriggerType, behavior: SwitchProfileBehavior) => void
  onWorkflowChange: (inputId: InputId, sequences: TriggerBehaviors) => void | false
  platform: Platform
  toolbar: ReactNode
  showRemoteKeyGrid: boolean
  showMouseKeyGrid: boolean
  rowRefs: MutableRefObject<Partial<Record<InputId, HTMLElement>>>
  behaviorEditorProps: ComponentProps<typeof BehaviorEditor>
}

export function MappingPage({
  debugMode,
  selectedDeviceId,
  selectBehaviorTarget,
  activeId,
  mappingMainRef,
  deviceStatus,
  isMouse,
  selectedBehavior,
  adjustPreviewBattery,
  editableButtons,
  pressedId,
  behaviors,
  platform,
  toolbar,
  showRemoteKeyGrid,
  showMouseKeyGrid,
  rowRefs,
  behaviorEditorProps,
}: MappingPageProps) {
  return <div className="mapping-page">
    <div className={`mapping-workbench ${debugMode ? 'debug-mode' : ''}`}>
      <aside className="mapping-device-rail panel-surface">
        <DeviceSelector selectedId={selectedDeviceId} onSelect={(id) => {
          selectBehaviorTarget(id === 'rc003' ? activeId : 'mouse.top.up', 'click', false)
          mappingMainRef.current?.scrollTo({ top: 0 })
        }} />
        <DeviceStatusCard status={deviceStatus} />
        {isMouse ? <MouseInputModel activeId={selectedBehavior.buttonId} onSelect={(id) => { selectBehaviorTarget(id, 'click', false); mappingMainRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }} /> : <>
        {debugMode && <BatteryDebugControls onAdjust={adjustPreviewBattery} />}
        <div className="remote-stage">
          <div className="remote-art">
            <RemoteControl
              buttons={editableButtons}
              activeId={activeId}
              pressedId={pressedId}
              mappedIds={editableButtons.filter(button => Object.values(behaviors[button.id]).some(list => list.length > 0)).map(button => button.id)}
              onSelect={id => selectBehaviorTarget(id, 'click')}
            />
          </div>
        </div>
        </>}
      </aside>

      <section ref={mappingMainRef} className="mapping-main" aria-label="设备映射工作区">
        <section className="key-picker" aria-labelledby="key-picker-title">
          <div className="key-picker-head">
            <div className="key-picker-heading">
            <h2 id="key-picker-title">{isMouse ? '输入部位' : '按键'}</h2>
          {!isMouse && showRemoteKeyGrid && <MappingKeyGrid
            platform={platform}
            buttons={editableButtons}
            behaviors={behaviors}
            activeId={activeId}
            pressedId={pressedId}
            rowRefs={rowRefs}
            onSelect={(buttonId) => selectBehaviorTarget(buttonId, 'click')}
          />}
            </div>
            {toolbar}
          </div>
          {isMouse && showMouseKeyGrid && <MouseControlPicker activeId={selectedBehavior.buttonId} onSelect={(id, trigger) => selectBehaviorTarget(id, trigger, false)} />}
        </section>
        {isMouse && <MouseTriggerSelector rowRefs={rowRefs} behaviors={behaviors} activeId={selectedBehavior.buttonId} platform={platform} trigger={selectedBehavior.trigger} onSelect={(id, trigger) => selectBehaviorTarget(id, trigger, false)} />}
        {!isMouse && <MappingTriggerSelector
          platform={platform}
          button={editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]}
          behaviors={behaviors[selectedBehavior.buttonId]}
          trigger={selectedBehavior.trigger}
          onSelect={(trigger) => selectBehaviorTarget(selectedBehavior.buttonId, trigger)}
        />}
        <BehaviorEditor {...behaviorEditorProps} />
      </section>
    </div>
  </div>
}
