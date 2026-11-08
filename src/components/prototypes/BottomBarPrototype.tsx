// Throwaway preview: three persistent bottom bars on the same route, selected by ?variant=A|B|C.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BatteryMedium,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Github,
  Keyboard,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X,
} from 'lucide-react'
import { DeviceWorkspaceHeader } from '../../devices/shared/DeviceWorkspaceHeader'
import { VariantA, VariantB, VariantC, type BottomBarTarget } from './BottomBarVariants'
import './BottomBarPrototype.css'

const brand = new URL('../../../src-tauri/icons/128x128@2x.png', import.meta.url).href
const variants = [
  { key: 'A', name: '单行导航', height: 36, detail: '整页切换 · 返回原编辑位置' },
  { key: 'B', name: '侧边面板', height: 36, detail: '右侧展开 · 编辑区保持可见' },
  { key: 'C', name: '底部面板', height: 32, detail: '向上展开 · 再点入口收起' },
] as const
const utilityTitles = { settings: '设置', account: '账号与同步', logs: '运行日志', about: '关于' }
const categories = ['启动设置', '设备与权限', '遥控器映射', '鼠标映射', '页面布局']
const keyNames = ['电源', '语音', '上', '左', '确定', '右', '下', '返回', '音量 +', '主页', '音量 −', '菜单']
type Variant = 'A' | 'B' | 'C'
type Utility = keyof typeof utilityTitles

export default function BottomBarPrototype() {
  const params = new URLSearchParams(location.search)
  const [variant, setVariant] = useState<Variant>(() => {
    const value = params.get('variant')
    return value === 'B' || value === 'C' ? value : 'A'
  })
  const [page, setPage] = useState<'devices' | 'editor'>(params.get('scene') === 'editor' ? 'editor' : 'devices')
  const [editorOpen, setEditorOpen] = useState(params.get('scene') === 'editor')
  const [utility, setUtility] = useState<Utility | null>(() => {
    const value = params.get('panel')
    return value === 'settings' || value === 'account' || value === 'logs' || value === 'about' ? value : null
  })
  const [category, setCategory] = useState('启动设置')
  const [selectedKey, setSelectedKey] = useState('确定')
  const [gesture, setGesture] = useState('单击')
  const [shortcut, setShortcut] = useState('右 Control')
  const [autostart, setAutostart] = useState(true)
  const [startHidden, setStartHidden] = useState(false)
  const [intercept, setIntercept] = useState(true)
  const [interval, setIntervalValue] = useState(0)
  const [scale, setScale] = useState('标准')
  const [device, setDevice] = useState('小米遥控器')
  const [email, setEmail] = useState('')
  const [switcherVisible, setSwitcherVisible] = useState(params.get('switcher') !== 'hidden')
  const lastTrigger = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const variantIndex = variants.findIndex(item => item.key === variant)
  const current = variants[variantIndex]

  const changeVariant = (next: Variant) => {
    setVariant(next)
    const url = new URL(location.href)
    url.searchParams.set('variant', next)
    history.replaceState(null, '', url)
  }

  const closeUtility = () => {
    setUtility(null)
    requestAnimationFrame(() => lastTrigger.current?.focus())
  }

  const navigate = (target: BottomBarTarget) => {
    if (target === 'devices' || target === 'editor') {
      setPage(target)
      if (target === 'editor') setEditorOpen(true)
      setUtility(null)
      return
    }
    if (target === utility) {
      closeUtility()
      return
    }
    lastTrigger.current = document.activeElement as HTMLElement
    setUtility(target)
  }

  useEffect(() => {
    if (utility) panelRef.current?.focus()
  }, [utility, variant])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && utility) {
        event.preventDefault()
        closeUtility()
        return
      }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const offset = event.key === 'ArrowRight' ? 1 : -1
      changeVariant(variants[(variantIndex + offset + variants.length) % variants.length].key)
    }
    const onPopState = () => {
      const value = new URLSearchParams(location.search).get('variant')
      setVariant(value === 'B' || value === 'C' ? value : 'A')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onPopState)
    }
  }, [variantIndex, utility])

  const openEditor = (name: string) => {
    setDevice(name)
    setPage('editor')
    setEditorOpen(true)
    setUtility(null)
  }

  const settingsFields = () => {
    switch (category) {
      case '启动设置':
        return (
          <>
            <SettingRow label="开机启动">
              <label>
                <input type="checkbox" checked={autostart} onChange={e => setAutostart(e.target.checked)} /> 开机时启动
                Axonkey
              </label>
            </SettingRow>
            <SettingRow label="启动窗口">
              <label>
                <input type="checkbox" checked={startHidden} onChange={e => setStartHidden(e.target.checked)} />{' '}
                启动后隐藏主窗口
              </label>
            </SettingRow>
          </>
        )
      case '设备与权限':
        return (
          <>
            <SettingRow label="辅助功能">
              <span className="bbp-permission">浏览器预览不检测系统权限</span>
            </SettingRow>
            <SettingRow label="输入监听">
              <span className="bbp-permission">请在桌面应用中查看</span>
            </SettingRow>
          </>
        )
      case '遥控器映射':
        return (
          <>
            <SettingRow label="独占拦截">
              <label>
                <input type="checkbox" checked={intercept} onChange={e => setIntercept(e.target.checked)} />{' '}
                拦截遥控器原始按键
              </label>
            </SettingRow>
            <SettingRow label="触发间隔">
              <input
                aria-label="触发间隔"
                className="bbp-number"
                type="number"
                min="0"
                max="1000"
                value={interval}
                onChange={e => setIntervalValue(Number(e.target.value))}
              />
              <span>毫秒</span>
            </SettingRow>
          </>
        )
      case '鼠标映射':
        return (
          <>
            <SettingRow label="鼠标映射">
              <label>
                <input type="checkbox" checked={intercept} onChange={e => setIntercept(e.target.checked)} />{' '}
                启用鼠标映射
              </label>
            </SettingRow>
            <SettingRow label="触发间隔">
              <input
                aria-label="鼠标触发间隔"
                className="bbp-number"
                type="number"
                min="0"
                max="1000"
                value={interval}
                onChange={e => setIntervalValue(Number(e.target.value))}
              />
              <span>毫秒</span>
            </SettingRow>
          </>
        )
      default:
        return (
          <SettingRow label="界面密度">
            <select aria-label="界面密度" value={scale} onChange={e => setScale(e.target.value)}>
              <option>标准</option>
              <option>紧凑</option>
            </select>
          </SettingRow>
        )
    }
  }

  const renderUtility = () => {
    if (utility === 'settings')
      return (
        <div className="bbp-settings">
          <nav aria-label="设置分类" className="bbp-categories">
            {categories.map((name, index) => {
              const Icon = [Monitor, ShieldCheck, Keyboard, SlidersHorizontal, Settings2][index]
              return (
                <button
                  key={name}
                  aria-current={category === name ? 'page' : undefined}
                  onClick={() => setCategory(name)}
                >
                  <Icon size={15} />
                  {name}
                </button>
              )
            })}
          </nav>
          <section className="bbp-settings-content" aria-label={category}>
            <h2>{category}</h2>
            <div className="bbp-fields">{settingsFields()}</div>
          </section>
        </div>
      )
    if (utility === 'account')
      return (
        <section className="bbp-account">
          <UserRound size={28} />
          <h2>账号与同步</h2>
          <p>无需登录即可使用全部本地功能。</p>
          <label htmlFor="bbp-email">邮箱</label>
          <input
            id="bbp-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <button className="bbp-primary" disabled title="交互预览不发送验证码">
            获取验证码
          </button>
        </section>
      )
    if (utility === 'logs')
      return (
        <section className="bbp-utility-content">
          <FileText size={24} />
          <h2>运行日志</h2>
          <p>桌面应用中，此入口打开本机日志目录。</p>
          <div className="bbp-demo-note">交互预览中不读取本机日志。</div>
        </section>
      )
    return (
      <section className="bbp-utility-content">
        <img className="bbp-about-icon" src={brand} alt="" />
        <h2>Axonkey</h2>
        <p>版本 1.8.13</p>
        <a href="https://github.com/leowzz/axonkey" target="_blank" rel="noreferrer">
          <Github size={16} />
          leowzz/axonkey
        </a>
      </section>
    )
  }

  const footerProps = {
    active: utility ?? page,
    editorOpen,
    deviceName: device,
    status: device === '系统鼠标' ? '系统输入源' : intercept ? '独占拦截中' : '已连接',
    onNavigate: navigate,
  }
  const Footer = variant === 'A' ? VariantA : variant === 'B' ? VariantB : VariantC

  return (
    <div
      className={`bbp-root bbp-variant-${variant}`}
      data-variant={variant}
      data-page={page}
      data-panel={utility ?? ''}
      data-selected-key={selectedKey}
    >
      <div className="bbp-titlebar">
        <div className="bbp-traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>Axonkey</span>
        <span className="bbp-preview-label">交互预览</span>
      </div>
      <div className="bbp-body">
        <div className="bbp-workspace" hidden={variant === 'A' && !!utility}>
          {page === 'devices' ? (
            <main className="bbp-home" aria-label="我的设备">
              <header className="bbp-home-heading">
                <div>
                  <img src={brand} alt="" />
                  <span>Axonkey</span>
                  <h1>我的设备</h1>
                </div>
                <button className="bbp-button" disabled title="预览使用示例设备">
                  <Plus size={17} />
                  手动添加设备
                </button>
              </header>
              <h2>我的设备</h2>
              <div className="bbp-device-grid">
                <DeviceCard
                  name="小米遥控器"
                  image="/rc003-remote-cutout.png"
                  description="实例 0ab0–0 · RC003"
                  status={intercept ? '独占拦截中' : '已连接'}
                  onClick={() => openEditor('小米遥控器')}
                  remote
                />
                <DeviceCard
                  name="系统鼠标"
                  image="/mouse-device.svg"
                  description="按键、滚轮和屏幕边缘"
                  status="系统输入源"
                  onClick={() => openEditor('系统鼠标')}
                />
              </div>
              <details className="bbp-discovery" open>
                <summary>
                  <ChevronDown size={16} />
                  发现设备 <span>0</span>
                  <button
                    onClick={e => {
                      e.preventDefault()
                      navigate('settings')
                      setCategory('设备与权限')
                    }}
                  >
                    找不到设备？
                  </button>
                </summary>
                <button className="bbp-refresh" aria-label="刷新设备" title="预览使用示例设备" disabled>
                  <RefreshCw size={16} />
                </button>
              </details>
            </main>
          ) : (
            <main className="bbp-editor" aria-label={`${device}编辑`}>
              <DeviceWorkspaceHeader
                deviceName={device}
                onBackToDevices={() => navigate('devices')}
                onOpenSettings={() => {
                  setCategory(device === '系统鼠标' ? '鼠标映射' : '遥控器映射')
                  navigate('settings')
                }}
                profileControls={
                  <button className="bbp-profile" disabled title="预览使用默认配置">
                    默认配置 <ChevronDown size={13} />
                  </button>
                }
              />
              <aside className="bbp-device-rail">
                <div className="bbp-status">
                  <span className="bbp-dot" />
                  {intercept ? '独占拦截中' : '已连接'}
                  <span className="bbp-battery">
                    <BatteryMedium size={15} />
                    46%
                  </span>
                </div>
                <img
                  className={`bbp-remote ${device === '系统鼠标' ? 'bbp-mouse' : ''}`}
                  src={device === '系统鼠标' ? '/mouse-device.svg' : '/rc003-remote-keymap.svg'}
                  alt={device}
                />
                <div className="bbp-rail-caption">{device === '系统鼠标' ? '系统输入源' : 'RC003 · 0ab0–0'}</div>
              </aside>
              <section className="bbp-mapping">
                <div className="bbp-key-picker" aria-label="选择按键">
                  {(device === '系统鼠标' ? ['左键', '右键', '中键', '滚轮上', '滚轮下', '侧键'] : keyNames).map(
                    (name, index) => (
                      <button key={name} aria-pressed={selectedKey === name} onClick={() => setSelectedKey(name)}>
                        <span>{index + 1}</span>
                        {name}
                      </button>
                    ),
                  )}
                </div>
                <div className="bbp-mapping-scroll">
                  <div className="bbp-mapping-heading">
                    <h2>{selectedKey}</h2>
                    <span>
                      <Check size={14} />
                      本地草稿
                    </span>
                  </div>
                  <div className="bbp-gestures" role="group" aria-label="触发方式">
                    {['单击', '双击', '长按'].map(name => (
                      <button key={name} aria-pressed={gesture === name} onClick={() => setGesture(name)}>
                        {name}
                        <small>{name === '单击' ? shortcut : '未配置'}</small>
                      </button>
                    ))}
                  </div>
                  <div className="bbp-sequence">
                    <div className="bbp-sequence-header">
                      <h3>当前序列</h3>
                      <button className="bbp-text-button" onClick={() => setShortcut('未配置')}>
                        清空
                      </button>
                    </div>
                    <div className="bbp-action-card">
                      <span className="bbp-action-icon">
                        <Keyboard size={20} />
                      </span>
                      <div>
                        <strong>键盘快捷键</strong>
                        <input aria-label="键盘快捷键" value={shortcut} onChange={e => setShortcut(e.target.value)} />
                      </div>
                      <span className="bbp-key-badge">{shortcut}</span>
                    </div>
                    <button
                      className="bbp-add-action"
                      onClick={() => setShortcut(shortcut === '空格' ? '右 Control' : '空格')}
                    >
                      <Plus size={16} />
                      添加行为
                    </button>
                  </div>
                  <div className="bbp-options">
                    <h3>触发选项</h3>
                    <label>
                      <input type="checkbox" defaultChecked />
                      释放后执行
                    </label>
                    <label>
                      <input type="checkbox" />
                      阻止按键原有功能
                    </label>
                  </div>
                  <div className="bbp-options">
                    <h3>重复执行</h3>
                    <SettingRow label="触发间隔">
                      <input
                        aria-label="编辑触发间隔"
                        className="bbp-number"
                        type="number"
                        min="0"
                        value={interval}
                        onChange={e => setIntervalValue(Number(e.target.value))}
                      />
                      毫秒
                    </SettingRow>
                  </div>
                  <div className="bbp-options bbp-last-option">
                    <h3>长按行为</h3>
                    <label>
                      <input type="checkbox" />
                      按住时循环执行当前序列
                    </label>
                  </div>
                </div>
              </section>
            </main>
          )}
        </div>
        {utility && (
          <section
            ref={panelRef}
            tabIndex={-1}
            className={`bbp-panel bbp-panel-${variant}`}
            aria-label={utilityTitles[utility]}
          >
            <header className="bbp-panel-header">
              {variant === 'A' ? (
                <button className="bbp-return" onClick={closeUtility}>
                  <ArrowLeft size={16} />
                  {page === 'editor' ? `返回${device}` : '返回我的设备'}
                </button>
              ) : (
                <h1>{utilityTitles[utility]}</h1>
              )}
              {variant === 'A' && <h1>{utilityTitles[utility]}</h1>}
              <button
                className="bbp-close"
                aria-label={variant === 'A' ? '返回工作区' : '关闭面板'}
                title="关闭 · Esc"
                onClick={closeUtility}
              >
                <X size={17} />
              </button>
            </header>
            {renderUtility()}
          </section>
        )}
      </div>
      <Footer {...footerProps} />
      {import.meta.env.DEV && switcherVisible && (
        <div className="bbp-switcher" aria-label="原型方案切换">
          <button aria-label="上一方案" onClick={() => changeVariant(variants[(variantIndex + 2) % 3].key)}>
            <ArrowLeft size={17} />
          </button>
          <div className="bbp-switcher-label" aria-live="polite">
            <strong>
              {current.key} · {current.name}
              <em>{current.height}px</em>
            </strong>
            <small>{current.detail}</small>
          </div>
          <button aria-label="下一方案" onClick={() => changeVariant(variants[(variantIndex + 1) % 3].key)}>
            <ArrowRight size={17} />
          </button>
          <span className="bbp-switcher-divider" />
          <button
            className="bbp-scene-switch"
            onClick={() => (page === 'devices' ? openEditor(device) : navigate('devices'))}
          >
            {page === 'devices' ? '进入设备编辑' : '查看首页'}
            <ChevronRight size={14} />
          </button>
          <button className="bbp-hide-switcher" aria-label="收起方案切换" onClick={() => setSwitcherVisible(false)}>
            <X size={13} />
          </button>
        </div>
      )}
      {import.meta.env.DEV && !switcherVisible && (
        <button className="bbp-show-switcher" onClick={() => setSwitcherVisible(true)} title="显示方案切换">
          {variant} · 切换方案
        </button>
      )}
    </div>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bbp-setting-row">
      <span className="bbp-setting-label">{label}：</span>
      <div className="bbp-setting-control">{children}</div>
    </div>
  )
}

function DeviceCard({
  name,
  image,
  description,
  status,
  onClick,
  remote,
}: {
  name: string
  image: string
  description: string
  status: string
  onClick: () => void
  remote?: boolean
}) {
  return (
    <button className="bbp-device-card" onClick={onClick} aria-label={`编辑${name}`}>
      <div className="bbp-device-main">
        <div className="bbp-device-art">
          <img src={image} alt="" />
        </div>
        <div>
          <strong>{name}</strong>
          <p>{description}</p>
        </div>
      </div>
      <div className="bbp-device-summary">
        <div>
          <span className={remote ? 'bbp-connected' : ''}>
            {remote ? <Check size={14} /> : <span className="bbp-dot bbp-dot-muted" />}
            {status}
          </span>
          {remote && (
            <small>
              <BatteryMedium size={13} />
              46%
            </small>
          )}
        </div>
        <div>
          <small>当前配置</small>
          <strong>默认配置（云端副本）</strong>
        </div>
      </div>
    </button>
  )
}
