import type { CSSProperties } from 'react'
import { Mouse } from 'lucide-react'
import { SettingsHelp } from '../../components/SettingsHelp'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

export type { DeviceSettingsPageProps as SystemMouseSettingsPageProps } from '../types'
import type { DeviceSettingsPageProps as SystemMouseSettingsPageProps } from '../types'

export function SystemMouseSettingsPage({ onBackToDevices, showMouseKeyGrid, onShowMouseKeyGridChange, mouseIgnoreScrollAcceleration, onMouseIgnoreScrollAccelerationChange, mouseScrollSensitivity, onMouseScrollSensitivityChange, mouseVerticalScrollIntervalMs, onMouseVerticalScrollIntervalMsChange, mouseHorizontalScrollIntervalMs, onMouseHorizontalScrollIntervalMsChange, mouseEdgeWidth, onMouseEdgeWidthChange, mouseKeyHoldMs, onMouseKeyHoldMsChange }: SystemMouseSettingsPageProps) {
  return <div className="device-settings-page settings-form-page">
    <DeviceWorkspaceHeader deviceName="系统鼠标" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="系统鼠标设置分类">
        <button type="button" aria-current="page"><Mouse size={16} /><span>鼠标映射</span></button>
      </nav>
      <section className="device-settings-panel settings-panels" aria-labelledby="system-mouse-mapping-title">
          <div className="settings-mouse-heading"><h2 id="system-mouse-mapping-title" className="settings-section-title">鼠标映射</h2><span>更改自动保存</span></div>
          <div className="settings-form-fields">
            <div className="settings-form-row">
              <span className="settings-form-label">按键列表：</span>
              <div className="settings-form-control">
                <label className="settings-checkbox"><input type="checkbox" checked={showMouseKeyGrid} onChange={(event) => onShowMouseKeyGridChange(event.target.checked)} />显示鼠标按键列表</label>
                <SettingsHelp id="mouse-key-grid-help" label="显示鼠标按键列表">默认关闭。开启后在映射页顶部显示鼠标按键和滚轮列表；关闭后仍可通过左侧鼠标图选择按键。</SettingsHelp>
              </div>
            </div>
            <div className="settings-form-row">
              <span className="settings-form-label">滚动加速：</span>
              <div className="settings-form-control">
                <label className="settings-checkbox"><input type="checkbox" checked={mouseIgnoreScrollAcceleration} onChange={(event) => onMouseIgnoreScrollAccelerationChange(event.target.checked)} />忽略滚动加速</label>
                <SettingsHelp id="mouse-ignore-acceleration-help" label="忽略滚动加速">按事件次数触发，避免快速滚动时触发量激增。100% 灵敏度下每条事件触发一次；不会过滤惯性产生的额外事件。默认开启。</SettingsHelp>
              </div>
            </div>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor="mouse-scroll-sensitivity">滚动灵敏度：</label>
              <div className="settings-form-control">
                <div className="settings-sensitivity-control">
                  <input id="mouse-scroll-sensitivity" type="range" min={25} max={400} step={25}
                    style={{ '--sensitivity-progress': `${(mouseScrollSensitivity - 25) / 375 * 100}%` } as CSSProperties}
                    aria-valuetext={`${mouseScrollSensitivity}%`} value={mouseScrollSensitivity}
                    onChange={(event) => onMouseScrollSensitivityChange(Number(event.target.value))} />
                  <output htmlFor="mouse-scroll-sensitivity">{mouseScrollSensitivity}<span>%</span></output>
                </div>
                <SettingsHelp id="mouse-scroll-sensitivity-help" label="滚动灵敏度">调高可让轻微滚动更容易触发；调低可减少误触。适用于所有滚轮映射。范围 25%–400%，默认 100%。</SettingsHelp>
              </div>
            </div>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor="mouse-edge-width">边缘生效宽度：</label>
              <div className="settings-form-control">
                <input id="mouse-edge-width" className="settings-number" type="number" min={1} max={100} step={1} value={mouseEdgeWidth}
                  onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) onMouseEdgeWidthChange(Math.max(1, Math.min(100, Math.round(value)))) }} />
                <span>px</span>
                <SettingsHelp id="mouse-edge-width-help" label="边缘生效宽度">顶部、左侧和右侧边缘共用，适用于滚动和鼠标按键映射。范围 1–100，默认 8。按屏幕坐标计算：Windows 为像素，macOS 为点；顶部角落优先使用上边缘规则。</SettingsHelp>
              </div>
            </div>
            {([
              { id: 'vertical-interval', label: '垂直触发间隔', value: mouseVerticalScrollIntervalMs, max: 10000, step: 10, onChange: onMouseVerticalScrollIntervalMsChange, help: '向上、向下共用间隔。设为 100 毫秒时，每次触发后 100 毫秒内忽略同轴滚动，不补发；两轴独立计时。默认 50 毫秒；设为 0 时不限制触发间隔。' },
              { id: 'horizontal-interval', label: '横向触发间隔', value: mouseHorizontalScrollIntervalMs, max: 10000, step: 10, onChange: onMouseHorizontalScrollIntervalMsChange, help: '向左、向右共用间隔。设为 100 毫秒时，每次触发后 100 毫秒内忽略同轴滚动，不补发；两轴独立计时。默认 50 毫秒；设为 0 时不限制触发间隔。' },
              { id: 'key-hold-ms', label: '按键保持时间', value: mouseKeyHoldMs, max: 1000, step: 1, onChange: onMouseKeyHoldMsChange, help: '按下到松开的间隔。若按键或快捷键漏识别，可尝试 50 毫秒；数值越大，连续触发越慢。默认 10 毫秒；设为 0 时即时释放。' },
            ] as const).map(({ id, label, value, max, step, onChange, help }) => <div key={id} className="settings-form-row">
              <label className="settings-form-label" htmlFor={`mouse-${id}`}>{label}：</label>
              <div className="settings-form-control">
                <input id={`mouse-${id}`} className="settings-number" type="number" min={0} max={max} step={step} value={value}
                  onChange={(event) => { const ms = Number(event.target.value); if (Number.isFinite(ms)) onChange(Math.max(0, Math.min(max, Math.round(ms)))) }} />
                <span>毫秒</span>
                <SettingsHelp id={`mouse-${id}-help`} label={label}>{help}</SettingsHelp>
              </div>
            </div>)}
          </div>
      </section>
    </div>
  </div>
}
