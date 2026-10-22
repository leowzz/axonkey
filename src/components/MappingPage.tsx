import type { ComponentProps, MutableRefObject, PointerEvent, ReactNode, RefObject } from 'react'
import type { BehaviorMap, ButtonId, InputId, TriggerBehaviors, TriggerType } from '../behaviorModel'
import type { HitPosition, Platform, RemoteButton } from '../appTypes'
import type { DeviceId } from '../deviceModel'
import { iconFor } from '../appConfig'
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
  remoteArtRef: RefObject<HTMLDivElement>
  editableButtons: RemoteButton[]
  markerRefs: MutableRefObject<Partial<Record<ButtonId, HTMLButtonElement>>>
  pressedId: ButtonId | null
  behaviors: BehaviorMap
  onWorkflowChange: (inputId: InputId, sequences: TriggerBehaviors) => void
  draggingId: ButtonId | null
  hitPositions: Record<ButtonId, HitPosition>
  handleHotspotPointerDown: (button: RemoteButton, event: PointerEvent<HTMLButtonElement>) => void
  handleHotspotPointerMove: (button: RemoteButton, event: PointerEvent<HTMLButtonElement>) => void
  finishHotspotDrag: (event: PointerEvent<HTMLButtonElement>) => void
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
  remoteArtRef,
  editableButtons,
  markerRefs,
  pressedId,
  behaviors,
  draggingId,
  hitPositions,
  handleHotspotPointerDown,
  handleHotspotPointerMove,
  finishHotspotDrag,
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
          <div className="remote-art" ref={remoteArtRef}>
            <img src="/rc003-remote-keymap.png" alt="小米 RC003 遥控器" />
            {editableButtons.map((button) => (
              <button
                key={button.id}
                ref={(node) => { if (node) markerRefs.current[button.id] = node }}
                type="button"
                aria-label={button.label}
                className={`hotspot hotspot-${button.icon} ${activeId === button.id ? 'active' : ''} ${pressedId === button.id ? 'pressed' : ''} ${Object.values(behaviors[button.id]).some((list) => list.length > 0) ? 'mapped' : ''} ${draggingId === button.id ? 'dragging' : ''}`}
                style={{ left: `${hitPositions[button.id].x}%`, top: `${hitPositions[button.id].y}%` }}
                onClick={() => selectBehaviorTarget(button.id, 'click')}
                onPointerDown={(event) => handleHotspotPointerDown(button, event)}
                onPointerMove={(event) => handleHotspotPointerMove(button, event)}
                onPointerUp={finishHotspotDrag}
                onPointerCancel={finishHotspotDrag}
              >{button.icon === 'center' ? <span className="center-dot" /> : iconFor(button.icon, 13)}</button>
            ))}
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
