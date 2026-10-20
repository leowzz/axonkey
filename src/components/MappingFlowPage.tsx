import { iconFor } from '../appConfig'
import { BatteryDebugControls } from './BatteryIndicator'
import { DeviceSelector, DeviceStatusCard } from './DeviceRail'
import { MappingKeyGrid } from './MappingComponents'
import { MouseInputModel, MouseControlPicker } from './MouseMapping'
import type { MappingPageProps } from './MappingPage'
import { WorkflowAxonkey } from './WorkflowAxonkey'

export function MappingFlowPage({
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
  onWorkflowChange,
  draggingId,
  hitPositions,
  handleHotspotPointerDown,
  handleHotspotPointerMove,
  finishHotspotDrag,
  platform,
  autoSaveState,
  nativeRuntime,
  enabled,
  onRetryApply,
  toolbar,
  showRemoteKeyGrid,
  rowRefs,
  behaviorEditorProps,
}: MappingPageProps) {
  return <div className="mapping-page mapping-flow-page">
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
  
      <section ref={mappingMainRef} className="mapping-main" aria-label="设备映射流程图工作区">
        <section className="key-picker" aria-labelledby="key-picker-title">
          <div className="key-picker-head">
            <div className="key-picker-heading">
            <h2 id="key-picker-title">{isMouse ? '输入部位' : '按键'} <span className={`auto-save-state ${autoSaveState}`}>{autoSaveState === 'error' ? '应用失败' : autoSaveState === 'saving' ? '保存中' : !nativeRuntime ? '已保存 · 预览' : enabled ? '已保存并生效' : '已保存 · 未开启'}</span>{autoSaveState === 'error' && <button type="button" className="reset-button" onClick={onRetryApply}>重试</button>}</h2>
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
          {isMouse && <MouseControlPicker activeId={selectedBehavior.buttonId} onSelect={(id, trigger) => selectBehaviorTarget(id, trigger, false)} />}
        </section>
        <WorkflowAxonkey key={selectedBehavior.buttonId} platform={platform} button={behaviorEditorProps.button} sequences={behaviors[selectedBehavior.buttonId]} onChange={onWorkflowChange} />
      </section>
    </div>
  </div>
}
