import { useState } from 'react'
import type { InputId } from '../behaviorModel'
import { devices } from '../devices/index.ts'
import { RemoteControl } from '../devices/shared/RemoteControl'
import { BatteryDebugControls } from './BatteryIndicator'
import { DeviceStatusCard } from './DeviceRail'
import { DeviceWorkspaceHeader } from '../devices/shared/DeviceWorkspaceHeader'
import { MouseInputModel, MouseControlPicker, MouseScopeSelector } from './MouseMapping'
import type { MappingPageProps } from './MappingPage'
import { defaultWorkflowSplitRatio } from './workflowSplitLayout'
import { WorkflowAxonkey } from './WorkflowAxonkey'

export function MappingFlowPage({
  debugMode,
  selectedDeviceId,
  activeDeviceId,
  deviceOptions,
  onSelectDevice,
  onBackToDevices,
  onOpenSettings,
  profileControls,
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
  showMouseKeyGrid,
  behaviorEditorProps,
  remoteView,
}: MappingPageProps) {
  const [splitRatio, setSplitRatio] = useState(defaultWorkflowSplitRatio)
  const [toolboxCategory, setToolboxCategory] = useState('recommended')
  return (
    <div className="mapping-page mapping-flow-page">
      <div className={`mapping-workbench ${debugMode ? 'debug-mode' : ''}`}>
        <DeviceWorkspaceHeader
          deviceName={
            selectedDeviceId === 'mouse' ? '系统鼠标' : devices.find(device => device.id === selectedDeviceId)!.name
          }
          activeDeviceId={activeDeviceId}
          deviceOptions={deviceOptions}
          onSelectDevice={onSelectDevice}
          profileControls={profileControls}
          onBackToDevices={onBackToDevices}
          onOpenSettings={onOpenSettings}
        />
        <aside className="mapping-device-rail panel-surface">
          <DeviceStatusCard status={deviceStatus} />
          {isMouse ? (
            <MouseInputModel
              activeId={selectedBehavior.buttonId}
              onSelect={id => {
                selectBehaviorTarget(id, 'click', false)
                mappingMainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            />
          ) : (
            <>
              {debugMode && <BatteryDebugControls onAdjust={adjustPreviewBattery} />}
              <div className="remote-stage">
                <div className="remote-art">
                  <RemoteControl
                    activeId={activeId}
                    pressedId={pressedId}
                    mappedIds={editableButtons
                      .filter(button => Object.values(behaviors[button.id]).some(list => list.length > 0))
                      .map(button => button.id)}
                    onSelect={id => selectBehaviorTarget(id as InputId, 'click')}
                    remoteView={remoteView}
                  />
                </div>
              </div>
            </>
          )}
        </aside>

        <section ref={mappingMainRef} className="mapping-main" aria-label="设备映射流程图工作区">
          <WorkflowAxonkey
            header={
              <>
                {' '}
                <section className="key-picker" aria-labelledby="key-picker-title">
                  <div className="key-picker-head">
                    <div className="key-picker-heading">
                      <h2 id="key-picker-title">{behaviorEditorProps.button.label}</h2>
                    </div>
                    {toolbar}
                  </div>
                  {isMouse && showMouseKeyGrid && (
                    <MouseControlPicker
                      activeId={selectedBehavior.buttonId}
                      onSelect={(id, trigger) => selectBehaviorTarget(id, trigger, false)}
                    />
                  )}
                </section>
                {isMouse && (
                  <div className="mouse-flow-context">
                    <MouseScopeSelector
                      behaviors={behaviors}
                      activeId={selectedBehavior.buttonId}
                      onSelect={id => selectBehaviorTarget(id, 'click', false)}
                    />
                    {behaviorEditorProps.button.inheritDefault && (
                      <span className="mouse-flow-inheritance">未配置的触发方式沿用任意位置</span>
                    )}
                  </div>
                )}{' '}
              </>
            }
            splitRatio={splitRatio}
            onSplitRatioChange={setSplitRatio}
            platform={platform}
            button={behaviorEditorProps.button}
            sequences={behaviors[selectedBehavior.buttonId]}
            onChange={onWorkflowChange}
            onRequestProfileSwitch={onRequestProfileSwitch}
            toolboxCategory={toolboxCategory}
            onToolboxCategoryChange={setToolboxCategory}
          />
        </section>
      </div>
    </div>
  )
}
