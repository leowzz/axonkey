import { useEffect, useRef, useState } from 'react'
import appIconUrl from '../../src-tauri/icons/128x128@2x.png'
import { CableDriverContent } from './CableDriverDialog'
import type { CableDriverController } from '../hooks/useCableDriver'
import { DeviceDiscoverySection, type DeviceDiscoveryProps } from '../devices/integration/DeviceHub'
import './UserGuideDialog.css'

export function UserGuideDialog({
  saving,
  error,
  onComplete,
  cableDriver,
  nativeRuntime,
  onOpenSound,
  deviceDiscovery,
}: {
  saving: boolean
  error: string
  onComplete: () => void
  cableDriver: CableDriverController
  nativeRuntime: boolean
  onOpenSound: () => void
  deviceDiscovery: Omit<DeviceDiscoveryProps, 'guide' | 'onIntegrated'>
}) {
  const [page, setPage] = useState<'welcome' | 'driver' | 'devices' | 'complete'>('welcome')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    titleRef.current?.focus()
  }, [page])

  const continueGuide = () => {
    if (page === 'welcome') {
      setPage('driver')
      void cableDriver.probe()
    } else if (page === 'driver') {
      setPage('devices')
      void deviceDiscovery.controller.refresh()
    } else {
      setPage('complete')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={`user-guide-dialog${page === 'devices' ? ' user-guide-device-dialog' : ''}`}
      aria-labelledby="user-guide-title"
      aria-busy={saving}
      onCancel={event => event.preventDefault()}
    >
      <header className="user-guide-header">
        <span>使用指南</span>
        <button type="button" className="dialog-secondary" disabled={saving} onClick={onComplete}>
          跳过指南
        </button>
      </header>
      <div className={`user-guide-body user-guide-${page}`}>
        {page === 'welcome' ? (
          <>
            <img src={appIconUrl} alt="Axonkey 应用图标" width={80} height={80} />
            <h2 id="user-guide-title" ref={titleRef} tabIndex={-1}>
              欢迎使用 Axonkey
            </h2>
            <p>自定义遥控器和鼠标按键，轻松执行快捷键与组合操作，还能将支持语音的遥控器用作无线麦克风。</p>
          </>
        ) : page === 'driver' ? (
          <>
            <h2 id="user-guide-title" ref={titleRef} tabIndex={-1}>
              推荐安装虚拟声卡驱动
            </h2>
            <p className="user-guide-intro">
              使用无线麦克风功能时，推荐安装 VB-CABLE Virtual Audio
              Device，将遥控器语音提供给录音或语音输入软件。你也可以暂不安装，或使用其他虚拟麦克风软件。
            </p>
            <CableDriverContent controller={cableDriver} nativeRuntime={nativeRuntime} onOpenSound={onOpenSound} />
          </>
        ) : page === 'devices' ? (
          <>
            <h2 id="user-guide-title" ref={titleRef} tabIndex={-1}>
              选择一个你想要添加的设备
            </h2>
            <DeviceDiscoverySection {...deviceDiscovery} guide onIntegrated={() => setPage('complete')} />
          </>
        ) : (
          <h2 id="user-guide-title" ref={titleRef} tabIndex={-1}>
            完成，可以开始了
          </h2>
        )}
      </div>
      {error && (
        <p className="user-guide-error" role="alert">
          {error}
        </p>
      )}
      <footer className="user-guide-footer">
        {page !== 'welcome' && (
          <button
            type="button"
            className="dialog-secondary"
            disabled={saving}
            onClick={() => setPage(page === 'complete' ? 'devices' : page === 'devices' ? 'driver' : 'welcome')}
          >
            上一步
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={saving}
          onClick={page === 'complete' ? onComplete : continueGuide}
        >
          {saving ? '保存中…' : page === 'complete' ? '完成' : '继续'}
        </button>
      </footer>
    </dialog>
  )
}
