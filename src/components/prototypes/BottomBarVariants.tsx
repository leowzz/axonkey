import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FileText,
  Github,
  Info,
  LayoutGrid,
  MoreHorizontal,
  Settings2,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import './BottomBarVariants.css'

export type BottomBarTarget = 'devices' | 'editor' | 'settings' | 'account' | 'logs' | 'about'

export type BottomBarProps = {
  active: BottomBarTarget
  editorOpen: boolean
  deviceName: string
  status: string
  onNavigate: (target: BottomBarTarget) => void
}

function FooterButton({
  target,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  target: BottomBarTarget
  label: string
  icon: LucideIcon
  active: BottomBarTarget
  onNavigate: BottomBarProps['onNavigate']
}) {
  return (
    <button
      className={`bbp-footer-button${active === target ? ' bbp-footer-button-active' : ''}`}
      type="button"
      onClick={() => onNavigate(target)}
      aria-label={label}
      title={label}
      aria-current={active === target ? 'page' : undefined}
    >
      <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

export function VariantA(props: BottomBarProps) {
  return (
    <footer className="bbp-footer bbp-footer-a">
      <nav className="bbp-footer-group" aria-label="页面导航">
        <FooterButton {...props} target="devices" label="设备" icon={LayoutGrid} />
        {props.editorOpen && (
          <FooterButton {...props} target="editor" label={props.deviceName} icon={SlidersHorizontal} />
        )}
        <FooterButton {...props} target="settings" label="设置" icon={Settings2} />
        <FooterButton {...props} target="account" label="账号与同步" icon={UserRound} />
        <FooterButton {...props} target="logs" label="运行日志" icon={FileText} />
        <FooterButton {...props} target="about" label="关于" icon={Info} />
      </nav>
      <div className="bbp-footer-group bbp-footer-meta">
        <a
          className="bbp-footer-link"
          href="https://github.com/leowzz/axonkey"
          target="_blank"
          rel="noreferrer"
          aria-label="GitHub 项目"
          title="GitHub 项目"
        >
          <Github size={15} strokeWidth={1.8} aria-hidden="true" />
        </a>
        <span className="bbp-footer-version">1.8.13</span>
      </div>
    </footer>
  )
}

export function VariantB(props: BottomBarProps) {
  return (
    <footer className="bbp-footer bbp-footer-b">
      <div className="bbp-footer-group bbp-footer-context">
        <FooterButton {...props} target="devices" label="设备" icon={LayoutGrid} />
        {props.editorOpen && (
          <>
            <ChevronRight className="bbp-footer-chevron" size={13} aria-hidden="true" />
            <FooterButton {...props} target="editor" label={props.deviceName} icon={SlidersHorizontal} />
            <span className="bbp-footer-status">
              <span className="bbp-footer-status-dot" />
              {props.status}
            </span>
          </>
        )}
      </div>
      <nav className="bbp-footer-group" aria-label="工具面板">
        <FooterButton {...props} target="settings" label="设置" icon={Settings2} />
        <FooterButton {...props} target="account" label="账号" icon={UserRound} />
        <FooterButton {...props} target="logs" label="日志" icon={FileText} />
        <FooterButton {...props} target="about" label="关于" icon={Info} />
      </nav>
    </footer>
  )
}

export function VariantC(props: BottomBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenuOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  return (
    <footer className="bbp-footer bbp-footer-c">
      <nav className="bbp-footer-group bbp-footer-tabs" aria-label="工作区">
        <FooterButton {...props} target="devices" label="设备" icon={LayoutGrid} />
        {props.editorOpen && (
          <FooterButton {...props} target="editor" label={props.deviceName} icon={SlidersHorizontal} />
        )}
      </nav>
      <nav className="bbp-footer-group" aria-label="工具面板">
        <FooterButton {...props} target="settings" label="设置" icon={Settings2} />
        <FooterButton {...props} target="account" label="账号" icon={UserRound} />
        <div className="bbp-footer-menu-anchor" ref={menuRef}>
          <button
            ref={moreButtonRef}
            className={`bbp-footer-button${menuOpen || props.active === 'logs' || props.active === 'about' ? ' bbp-footer-button-active' : ''}`}
            type="button"
            aria-label="更多"
            title="更多"
            aria-expanded={menuOpen}
            aria-controls="bbp-more-menu"
            onClick={() => setMenuOpen(open => !open)}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
            <span>更多</span>
          </button>
          {menuOpen && (
            <div className="bbp-footer-menu" id="bbp-more-menu" aria-label="更多工具">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  props.onNavigate('logs')
                }}
              >
                <FileText size={15} aria-hidden="true" />
                运行日志
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  props.onNavigate('about')
                }}
              >
                <Info size={15} aria-hidden="true" />
                关于 Axonkey
              </button>
              <a
                href="https://github.com/leowzz/axonkey"
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
              >
                <Github size={15} aria-hidden="true" />
                GitHub 项目
              </a>
              <span className="bbp-footer-menu-version">版本 1.8.13</span>
            </div>
          )}
        </div>
      </nav>
    </footer>
  )
}
