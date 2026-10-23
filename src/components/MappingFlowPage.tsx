import { useState } from 'react'
import { RemoteControl } from './RemoteControl'
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
  editableButtons,
  pressedId,
  behaviors,
  onWorkflowChange,
  onRequestProfileSwitch,
  platform,
  toolbar,
  showRemoteKeyGrid,
  showMouseKeyGrid,
  rowRefs,
  behaviorEditorProps,
}: MappingPageProps) {
  const [toolboxCategory, setToolboxCategory] = useState('常用行为/常用行为')
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

      <section ref={mappingMainRef} className="mapping-main" aria-label="设备映射流程图工作区">
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
        <WorkflowAxonkey key={selectedBehavior.buttonId} platform={platform} button={behaviorEditorProps.button} sequences={behaviors[selectedBehavior.buttonId]} onChange={onWorkflowChange} onRequestProfileSwitch={onRequestProfileSwitch} toolboxCategory={toolboxCategory} onToolboxCategoryChange={setToolboxCategory} />
      </section>
    </div>
  </div>
}
