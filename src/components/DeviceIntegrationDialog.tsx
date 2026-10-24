import { useEffect, useRef } from 'react'
import { Bluetooth, ChevronRight, Info, Mouse, X } from 'lucide-react'
import type { Platform } from '../appTypes'
import type { DeviceId } from '../deviceModel'
import './DeviceIntegrationDialog.css'

type DeviceIntegrationDialogProps = {
  platform: Platform
  nativeRuntime: boolean
  onSelect: (deviceId: DeviceId) => void
  onClose: () => void
}

export function DeviceIntegrationDialog({ platform, nativeRuntime, onSelect, onClose }: DeviceIntegrationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-integration-close]')?.focus()

    return () => {
      if (root) root.inert = wasInert
      document.body.style.overflow = previousOverflow
      if ((previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) && previousFocus.isConnected) {
        previousFocus.focus()
      } else {
        document.querySelector<HTMLButtonElement>('.my-devices-integrate')?.focus()
      }
    }
  }, [])

  const remoteNextStep = platform === 'windows'
    ? '继续完成连接与设备集成。'
    : platform === 'macos'
      ? '继续连接引导，检查输入监控和辅助功能权限。'
      : '打开连接引导，查看设备准备步骤。'

  return <div
    className="behavior-dialog-backdrop device-integration-backdrop"
    role="presentation"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons?.[0]
      const last = buttons?.[buttons.length - 1]
      const focusInside = dialogRef.current?.contains(document.activeElement)
      if (event.shiftKey && (document.activeElement === first || !focusInside)) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !focusInside)) {
        event.preventDefault()
        first?.focus()
      }
    }}
  >
    <section
      ref={dialogRef}
      className="behavior-dialog device-integration-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="device-integration-title"
      aria-describedby={nativeRuntime ? 'device-integration-description' : 'device-integration-description device-integration-preview'}
    >
      <header className="behavior-dialog-head">
        <h2 id="device-integration-title">集成设备</h2>
        <button type="button" className="dialog-close" data-integration-close aria-label="关闭集成设备" onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="behavior-dialog-body device-integration-body">
        <p id="device-integration-description" className="device-integration-description">选择设备，继续完成连接与系统设置。</p>
        {!nativeRuntime && <p id="device-integration-preview" className="device-integration-preview">
          <Info size={15} aria-hidden="true" />
          <span>当前为浏览器预览，无法检测、连接设备或修改系统权限。</span>
        </p>}
        <div className="device-integration-options">
          <button type="button" className="device-integration-option" data-device-id="rc003" onClick={() => onSelect('rc003')}>
            <Bluetooth className="device-integration-icon" size={23} aria-hidden="true" />
            <span className="device-integration-copy">
              <strong>小米遥控器 RC003</strong>
              <span>在系统蓝牙设置中配对并唤醒遥控器。</span>
              <small>{remoteNextStep}</small>
            </span>
            <ChevronRight className="device-integration-arrow" size={17} aria-hidden="true" />
          </button>
          <button type="button" className="device-integration-option" data-device-id="mouse" onClick={() => onSelect('mouse')}>
            <Mouse className="device-integration-icon" size={23} aria-hidden="true" />
            <span className="device-integration-copy">
              <strong>系统鼠标</strong>
              <span>全部系统鼠标共用输入，统一配置按键与滚轮映射。</span>
              <small>{platform === 'windows' ? '继续配置鼠标映射。' : '继续系统设置，查看所需权限。'}</small>
            </span>
            <ChevronRight className="device-integration-arrow" size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  </div>
}
