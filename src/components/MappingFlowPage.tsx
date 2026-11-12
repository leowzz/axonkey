import { useState } from 'react'
import { triggerSummary } from '../appConfig'
import type { InputId } from '../behaviorModel'
import { devices } from '../devices/index.ts'
import { RemoteControl } from '../devices/shared/RemoteControl'
import { BatteryDebugControls } from './BatteryIndicator'
import { DeviceRecordingStatus } from './DeviceRail'
import { DeviceWorkspaceHeader } from '../devices/shared/DeviceWorkspaceHeader'
import { MouseInputModel, MouseControlPicker, MouseScopeSelector } from './MouseMapping'
import type { MappingPageProps } from './MappingPage'
import { defaultWorkflowSplitRatio } from './workflowSplitLayout'
import { WorkflowAxonkey } from './WorkflowAxonkey'

export function MappingFlowPage({
  debugMode,
  selectedDeviceId,
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
  switcherItems,
  onOpenAddDevice,
  globalControls,
  topNotice,
}: MappingPageProps) {
  const [splitRatio, setSplitRatio] = useState(defaultWorkflowSplitRatio)
  const [toolboxCategory, setToolboxCategory] = useState('recommended')
  const [railMode, setRailMode] = useState<'diagram' | 'list'>('diagram')
  const primaryRow = deviceStatus.rows[0]
  const mappedRemoteIds = editableButtons
    .filter(button => Object.values(behaviors[button.id]).some(list => list.some(item => item.enabled)))
    .map(button => button.id)
  return (
    <div className="mapping-page mapping-flow-page">
      <div className={`mapping-workbench ${debugMode ? 'debug-mode' : ''}`}>
        <DeviceWorkspaceHeader
          deviceName={
            selectedDeviceId === 'mouse' ? '系统鼠标' : devices.find(device => device.id === selectedDeviceId)!.name
          }
          profileControls={profileControls}
          onBackToDevices={onBackToDevices}
          onOpenSettings={onOpenSettings}
          switcherItems={switcherItems}
          onOpenAddDevice={onOpenAddDevice}
          globalControls={globalControls}
          statusControls={
            <section className="managed-instance-status" aria-label={deviceStatus.title}>
              {primaryRow && (
                <span
                  className={`managed-instance-connection${primaryRow.tone === 'ready' ? ' ready' : primaryRow.tone === 'warning' ? ' warning' : ''}`}
                  title={
                    typeof primaryRow.value === 'string' ? `${primaryRow.label}：${primaryRow.value}` : primaryRow.label
                  }
                >
                  {primaryRow.value}
                </span>
              )}
              {deviceStatus.toggle && (
                <button
                  type="button"
                  role="switch"
                  className={`switch ${deviceStatus.toggle.checked ? 'on' : ''}`}
                  aria-checked={deviceStatus.toggle.checked}
                  aria-label="启用鼠标映射"
                  onClick={deviceStatus.toggle.onChange}
                >
                  <span />
                </button>
              )}
            </section>
          }
        />
        {topNotice}
        <aside className="mapping-device-rail panel-surface">
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
              <div className="rail-mode-tabs" role="tablist" aria-label="按键视图">
                <button
                  type="button"
                  role="tab"
                  className={`rail-tab${railMode === 'diagram' ? ' active' : ''}`}
                  aria-selected={railMode === 'diagram'}
                  onClick={() => setRailMode('diagram')}
                >
                  遥控器
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`rail-tab${railMode === 'list' ? ' active' : ''}`}
                  aria-selected={railMode === 'list'}
                  onClick={() => setRailMode('list')}
                >
                  已配速览{mappedRemoteIds.length > 0 ? ` (${mappedRemoteIds.length})` : ''}
                </button>
              </div>
              {debugMode && <BatteryDebugControls onAdjust={adjustPreviewBattery} />}
              {railMode === 'diagram' ? (
                <div className="remote-stage">
                  <div className="remote-art">
                    <RemoteControl
                      activeId={activeId}
                      pressedId={pressedId}
                      mappedIds={mappedRemoteIds}
                      onSelect={id => selectBehaviorTarget(id as InputId, 'click')}
                      remoteView={remoteView}
                    />
                  </div>
                </div>
              ) : (
                <div className="rail-keymap-list" role="listbox" aria-label="按键已配速览">
                  {editableButtons.map(button => {
                    const isSelected = activeId === button.id
                    const isMapped = mappedRemoteIds.includes(button.id)
                    return (
                      <button
                        key={button.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`rail-keymap-row${isSelected ? ' selected' : ''}${isMapped ? ' mapped' : ''}`}
                        onClick={() => selectBehaviorTarget(button.id, 'click')}
                      >
                        <span className="rail-keymap-head">
                          <span>{button.label}</span>
                          {isMapped && <span className="rail-keymap-dot" aria-hidden="true" />}
                        </span>
                        <span className="rail-keymap-summary">
                          {triggerSummary(behaviors[button.id].click, 'click', platform)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {deviceStatus.recording !== undefined && (
                <div className="rail-voice-strip">
                  <DeviceRecordingStatus recording={deviceStatus.recording} />
                </div>
              )}
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
