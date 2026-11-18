import { useRef } from 'react'
import { Accessibility, ArrowRight, Check, ExternalLink, FolderOpen, Keyboard, RotateCcw } from 'lucide-react'
import appIconUrl from '../../src-tauri/icons/128x128@2x.png'
import type { MacPermissionKind, MacPermissions } from '../appTypes'

export type MacPermissionHelperWindowProps = {
  activePermission: MacPermissionKind
  permissions: MacPermissions
  nativeTitlebar?: boolean
  onSelectPermission: (kind: MacPermissionKind) => void
  onOpenSettings: (kind: MacPermissionKind) => void
  onStartAppDrag: () => void
  onRevealApp: () => void
  onRefresh: () => void
  onClose: () => void
}

export function MacPermissionHelperWindow({
  activePermission,
  permissions,
  nativeTitlebar = false,
  onSelectPermission,
  onOpenSettings,
  onStartAppDrag,
  onRevealApp,
  onRefresh,
  onClose,
}: MacPermissionHelperWindowProps) {
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  const ready = permissions.inputMonitoring && permissions.accessibility
  const activeTitle = activePermission === 'inputMonitoring' ? '输入监控' : '辅助功能'

  const tabs: Array<{ kind: MacPermissionKind; label: string; granted: boolean }> = [
    { kind: 'inputMonitoring', label: '输入监控', granted: permissions.inputMonitoring },
    { kind: 'accessibility', label: '辅助功能', granted: permissions.accessibility },
  ]

  return (
    <main className="permission-helper-shell">
      {nativeTitlebar && <div className="native-titlebar" data-tauri-drag-region aria-hidden="true" />}

      <div className="permission-helper-body">
        <div className="permission-helper-tabs" role="group" aria-label="系统权限">
          {tabs.map(tab => {
            const active = !ready && activePermission === tab.kind
            return (
              <button
                key={tab.kind}
                type="button"
                className={`permission-helper-tab ${tab.granted ? 'granted' : active ? 'active' : ''}`}
                aria-current={active ? 'step' : undefined}
                aria-label={`${tab.label}（${tab.granted ? '已授权' : '待授权'}）`}
                onClick={() => onSelectPermission(tab.kind)}
              >
                {tab.kind === 'inputMonitoring' ? (
                  <Keyboard size={15} aria-hidden="true" />
                ) : (
                  <Accessibility size={15} aria-hidden="true" />
                )}
                <span>{tab.label}</span>
                {tab.granted ? (
                  <Check size={14} className="permission-tab-check" aria-hidden="true" />
                ) : (
                  <span className="permission-tab-dot" aria-hidden="true" />
                )}
              </button>
            )
          })}
        </div>

        <section className="permission-drop-stage" aria-live="polite">
          {ready ? (
            <div className="permission-ready-state">
              <div className="permission-ready-icon">
                <img src={appIconUrl} alt="" draggable={false} />
                <span className="permission-ready-badge" aria-hidden="true">
                  <Check size={13} strokeWidth={3} />
                </span>
              </div>
              <strong>权限已就绪</strong>
            </div>
          ) : (
            <>
              <div className="permission-drag-flow">
                <div
                  role="button"
                  tabIndex={0}
                  className="permission-draggable-app"
                  aria-label="按住拖动 Axonkey.app 到系统设置列表"
                  onDragStart={event => event.preventDefault()}
                  onPointerDown={event => {
                    if (event.button !== 0) return
                    dragOriginRef.current = { x: event.clientX, y: event.clientY }
                  }}
                  onPointerMove={event => {
                    const origin = dragOriginRef.current
                    if (!origin) return
                    if ((event.buttons & 1) === 0) {
                      dragOriginRef.current = null
                      return
                    }
                    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 3) {
                      dragOriginRef.current = null
                      onStartAppDrag()
                    }
                  }}
                  onPointerUp={() => {
                    dragOriginRef.current = null
                  }}
                  onPointerCancel={() => {
                    dragOriginRef.current = null
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onRevealApp()
                    }
                  }}
                >
                  <img src={appIconUrl} alt="" draggable={false} />
                  <span>Axonkey.app</span>
                </div>

                <ArrowRight size={18} className="permission-drag-arrow" aria-hidden="true" />

                <button
                  type="button"
                  className="permission-target-pane"
                  aria-label={`打开${activeTitle}设置`}
                  onClick={() => onOpenSettings(activePermission)}
                >
                  <span className="permission-target-icon" aria-hidden="true">
                    {activePermission === 'inputMonitoring' ? <Keyboard size={22} /> : <Accessibility size={22} />}
                  </span>
                  <span className="permission-target-label">
                    {activeTitle}
                    <ExternalLink size={11} aria-hidden="true" />
                  </span>
                </button>
              </div>
              <p className="permission-stage-hint">拖入右侧列表并打开开关</p>
            </>
          )}
        </section>

        <footer className="permission-helper-footer">
          <div className="permission-helper-tools">
            {!ready && (
              <button
                type="button"
                className="permission-icon-button"
                title="在 Finder 中显示"
                aria-label="在 Finder 中显示"
                onClick={onRevealApp}
              >
                <FolderOpen size={15} />
              </button>
            )}
            <button
              type="button"
              className="permission-icon-button"
              title="重新检测"
              aria-label="重新检测"
              onClick={onRefresh}
            >
              <RotateCcw size={15} />
            </button>
          </div>

          <button
            type="button"
            className={`button ${ready ? 'primary' : 'permission-return-button'}`}
            onClick={onClose}
          >
            {ready ? '完成' : '返回主窗口'}
          </button>
        </footer>
      </div>
    </main>
  )
}
