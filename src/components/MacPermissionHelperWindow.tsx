import { ChevronRight, Command, ExternalLink, FolderOpen, Keyboard, RotateCcw, Settings2, X } from 'lucide-react'
import type { MacPermissionKind, MacPermissions } from '../appTypes'

export type MacPermissionHelperWindowProps = {
  activePermission: MacPermissionKind
  permissions: MacPermissions
  onOpenSettings: (kind: MacPermissionKind) => void
  onRevealApp: () => void
  onRefresh: () => void
  onClose: () => void
}

export function MacPermissionHelperWindow({
  activePermission,
  permissions,
  onOpenSettings,
  onRevealApp,
  onRefresh,
  onClose,
}: MacPermissionHelperWindowProps) {
  const ready = permissions.inputMonitoring && permissions.accessibility
  const activeTitle = activePermission === 'inputMonitoring' ? '输入监控' : '辅助功能'
  return (
    <main className="permission-helper-shell">
      <header className="permission-helper-header">
        <div className="permission-helper-brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>Axonkey</strong>
            <span>授权助手 · 保持置顶</span>
          </div>
        </div>
        <button type="button" className="dialog-close" aria-label="返回完整窗口" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <section className="permission-helper-content">
        <span className="section-kicker">
          {ready ? 'PERMISSIONS READY' : `CURRENT · ${activePermission === 'inputMonitoring' ? '1 / 2' : '2 / 2'}`}
        </span>
        <h1>{ready ? '两项权限都已打开' : `在系统设置中允许${activeTitle}`}</h1>
        <p className="permission-helper-lead">
          {ready
            ? '状态已自动刷新，可以返回主窗口。'
            : '若列表中已有 Axonkey，直接打开右侧开关；没有时按下面两步添加。'}
        </p>

        <div className="permission-helper-status" aria-live="polite">
          <span
            className={permissions.inputMonitoring ? 'granted' : activePermission === 'inputMonitoring' ? 'active' : ''}
          >
            <Keyboard size={15} /> 输入监控 <strong>{permissions.inputMonitoring ? '已授权' : '待授权'}</strong>
          </span>
          <span
            className={permissions.accessibility ? 'granted' : activePermission === 'accessibility' ? 'active' : ''}
          >
            <Command size={15} /> 辅助功能 <strong>{permissions.accessibility ? '已授权' : '待授权'}</strong>
          </span>
        </div>

        {!ready && (
          <div className="permission-drag-guide">
            <div className="permission-drag-visual" aria-hidden="true">
              <span className="permission-app-tile">
                <span className="brand-mark">A</span>Axonkey.app
              </span>
              <ChevronRight size={18} />
              <span className="permission-settings-tile">
                <Settings2 size={18} />
                系统设置
              </span>
            </div>
            <ol>
              <li>点击“在 Finder 中显示”，找到高亮的 Axonkey.app。</li>
              <li>将它拖到已打开的系统授权列表，再打开开关。</li>
            </ol>
          </div>
        )}

        <div className="permission-helper-actions">
          {!ready && (
            <button type="button" className="button primary" onClick={onRevealApp}>
              <FolderOpen size={16} /> 在 Finder 中显示
            </button>
          )}
          {!ready && (
            <button type="button" className="dialog-secondary" onClick={() => onOpenSettings(activePermission)}>
              <ExternalLink size={15} /> 再次打开系统设置
            </button>
          )}
        </div>
      </section>

      <footer className="permission-helper-footer">
        <button type="button" className="permission-refresh-button" onClick={onRefresh}>
          <RotateCcw size={14} /> 重新检测
        </button>
        <button type="button" className={`button ${ready ? 'primary' : 'permission-return-button'}`} onClick={onClose}>
          返回主窗口 <ChevronRight size={15} />
        </button>
      </footer>
    </main>
  )
}
