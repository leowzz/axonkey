import { Download, X } from 'lucide-react'

type Props = {
  deviceName: string
  status: 'idle' | 'running' | 'error'
  error?: string
  onInstall: () => void
  onClose: () => void
}

export function ManagedDriverDialog({ deviceName, status, error, onInstall, onClose }: Props) {
  const running = status === 'running'
  return (
    <div className="behavior-dialog-backdrop" role="presentation">
      <section
        className="behavior-dialog managed-driver-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-driver-title"
      >
        <header className="behavior-dialog-head">
          <h2 id="managed-driver-title">连接 {deviceName} 的按键驱动</h2>
          <button type="button" aria-label="关闭驱动引导" className="dialog-close" onClick={onClose} disabled={running}>
            <X size={17} />
          </button>
        </header>
        <div className="behavior-dialog-body">
          <p>这台小米遥控器需要单独安装 Quarbor Universal 驱动，安装后 Axonkey 才能连接它自己的输入通道。</p>
          {status === 'error' ? (
            <p className="managed-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="integration-attention">请保持设备连接，并允许 Windows 弹出的管理员授权。</p>
          )}
        </div>
        <footer className="managed-dialog-footer">
          <button type="button" onClick={onClose} disabled={running}>
            稍后处理
          </button>
          <button type="button" className="managed-primary" onClick={onInstall} disabled={running}>
            <Download size={15} /> {running ? '正在安装…' : '安装驱动'}
          </button>
        </footer>
      </section>
    </div>
  )
}
