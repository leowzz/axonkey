import {
  ArrowLeft,
  DatabaseBackup,
  ExternalLink,
  Info,
  LayoutDashboard,
  Power,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { DataBackupSettings } from './DataBackupSettings'
import type { DataBackupSettingsProps } from './DataBackupSettings'
import { SettingsHelp } from './SettingsHelp'
import { AutostartControl } from './AutostartControl'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { DriverActionKind, SetupState } from '../setupModel'

export type SettingsSection = 'startup' | 'permissions' | 'remote' | 'backup'

type SettingsPageProps = {
  onBack: () => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  enabled: boolean
  onToggleEnabled: () => void
  platform: Platform
  nativeRuntime: boolean
  showRemoteKeyGrid: boolean
  onShowRemoteKeyGridChange: (value: boolean) => void
  systemProbeState: 'loading' | 'ready' | 'error'
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  audioDriver: SetupState['drivers']['audio']
  onAudioAction: (action: DriverActionKind) => void
  stretchCompensation: boolean
  stretchError: string
  stretchUpdating: boolean
  onStretchCompensationChange: (enabled: boolean) => void
  audioRestarting: boolean
  audioRestartError: string
  onRestartAudio: () => void
  onProbeAudio: () => void
  onOpenSound: () => void
  onOpenDeviceSetup: () => void
  onOpenSignalMonitor: () => void
  signalMonitorOpening: boolean
  signalMonitorError: string
  onRequestPermission: (kind: MacPermissionKind) => void
  onOpenSettings: (kind: MacPermissionKind) => void
  onRefresh: () => void
  backup: Omit<DataBackupSettingsProps, 'nativeRuntime'>
}

export function SettingsPage({
  onBack,
  section,
  onSectionChange,
  enabled,
  onToggleEnabled,
  platform,
  nativeRuntime,
  showRemoteKeyGrid,
  onShowRemoteKeyGridChange,
  systemProbeState,
  permissions,
  inputAuthorizationStale,
  inputDriver,
  audioDriver,
  onAudioAction,
  stretchCompensation,
  stretchError,
  stretchUpdating,
  onStretchCompensationChange,
  audioRestarting,
  audioRestartError,
  onRestartAudio,
  onProbeAudio,
  onOpenSound,
  onOpenDeviceSetup,
  onOpenSignalMonitor,
  signalMonitorOpening,
  signalMonitorError,
  onRequestPermission,
  onOpenSettings,
  onRefresh,
  backup,
}: SettingsPageProps) {
  const currentSection = section
  const sections = [
    { id: 'startup' as const, label: '启动设置', icon: <Power size={16} /> },
    { id: 'permissions' as const, label: '设备与权限', icon: <ShieldCheck size={16} /> },
    { id: 'remote' as const, label: '页面布局', icon: <LayoutDashboard size={16} /> },
    { id: 'backup' as const, label: '数据备份', icon: <DatabaseBackup size={16} /> },
  ]
  const loading = systemProbeState === 'loading'
  const failed = systemProbeState === 'error'
  const items = [
    {
      kind: 'inputMonitoring' as const,
      title: '输入监控',
      description: '读取 RC003 遥控器的按键，让自定义映射能够响应。',
      granted: permissions.inputMonitoring && !inputAuthorizationStale,
      stale: inputAuthorizationStale,
    },
    {
      kind: 'accessibility' as const,
      title: '辅助功能',
      description: '发送映射后的按键、快捷键和文本。',
      granted: permissions.accessibility,
      stale: false,
    },
  ]
  const audioInstalled = audioDriver.status === 'installed' || audioDriver.status === 'restartRequired'
  const audioBusy = audioRestarting || audioDriver.action.status === 'running' || audioDriver.status === 'checking'
  const audioStatus = !nativeRuntime
    ? '未检测'
    : audioRestarting
      ? '重启中…'
      : audioDriver.action.status === 'running'
        ? '等待授权…'
        : {
            unknown: '未检测',
            checking: '检测中',
            missing: '未安装',
            installed: '已安装',
            restartRequired: '需要重启',
            error: '操作失败',
          }[audioDriver.status]
  const audioError =
    audioRestartError || audioDriver.action.error || (audioDriver.status === 'error' ? audioDriver.message : undefined)
  const grantedCount = items.filter(item => item.granted).length
  return (
    <div className="settings-page settings-form-page">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button type="button" className="settings-nav-back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>返回</span>
          </button>
          {sections.map(item => (
            <button
              key={item.id}
              id={`settings-nav-${item.id}`}
              type="button"
              aria-current={currentSection === item.id ? 'page' : undefined}
              aria-controls={`settings-panel-${item.id}`}
              onClick={() => onSectionChange(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          <label className="settings-nav-enable-control">
            <span>软件总开关</span>
            <button
              type="button"
              className={`settings-nav-enable-switch ${enabled ? 'on' : ''}`}
              aria-label="软件功能总开关"
              title={`软件总开关 · ${enabled ? '已开启' : '已暂停'}`}
              aria-pressed={enabled}
              onClick={onToggleEnabled}
            >
              <span />
            </button>
          </label>
        </nav>
        <div className="settings-panels">
          <section
            id="settings-panel-backup"
            aria-labelledby="settings-nav-backup"
            hidden={currentSection !== 'backup'}
          >
            <h3 className="settings-section-title">数据备份</h3>
            <DataBackupSettings {...backup} nativeRuntime={nativeRuntime} />
          </section>
          <section
            id="settings-panel-startup"
            aria-labelledby="settings-nav-startup"
            hidden={currentSection !== 'startup'}
          >
            <h3 className="settings-section-title">启动设置</h3>
            <AutostartControl supported={nativeRuntime && (platform === 'macos' || platform === 'windows')} />
          </section>
          <section
            id="settings-panel-permissions"
            aria-labelledby="settings-nav-permissions"
            hidden={currentSection !== 'permissions'}
          >
            <div className="settings-permissions-heading">
              <h3 className="settings-section-title">设备与权限</h3>
              <button
                type="button"
                className="settings-refresh"
                aria-label={loading ? '正在检测系统权限' : '重新检测系统权限'}
                title={loading ? '检测中' : '重新检测'}
                aria-busy={loading}
                disabled={!nativeRuntime || loading || platform === 'unsupported'}
                onClick={onRefresh}
              >
                <RotateCcw size={14} />
              </button>
            </div>
            {!nativeRuntime && (
              <p className="permission-drag-note">
                <Info size={17} />
                浏览器预览无法检测或更改系统权限，请在桌面版中操作。
              </p>
            )}
            {platform === 'macos' ? (
              <>
                <div className="settings-form-fields">
                  {items.map(item => {
                    const known = nativeRuntime && !loading && !failed
                    const granted = known && item.granted
                    return (
                      <section
                        key={item.kind}
                        className="settings-form-row"
                        aria-labelledby={`permission-label-${item.kind}`}
                      >
                        <span id={`permission-label-${item.kind}`} className="settings-form-label">
                          {item.title}：
                        </span>
                        <div className="settings-form-control">
                          <span className={`settings-permission-status ${granted ? 'granted' : ''}`} aria-live="polite">
                            {!nativeRuntime
                              ? '未检测'
                              : loading
                                ? '检测中'
                                : failed
                                  ? '检测失败'
                                  : item.stale
                                    ? '需要重新授权'
                                    : granted
                                      ? '已授权'
                                      : '未授权'}
                          </span>
                          <button
                            type="button"
                            className="dialog-secondary"
                            disabled={!nativeRuntime || loading}
                            onClick={() => (granted ? onOpenSettings(item.kind) : onRequestPermission(item.kind))}
                          >
                            {granted ? '打开设置' : item.stale ? '重新授权' : '开始授权'}
                            <ExternalLink size={14} />
                          </button>
                          <SettingsHelp id={`permission-help-${item.kind}`} label={item.title}>
                            {item.description}
                          </SettingsHelp>
                        </div>
                      </section>
                    )
                  })}
                  <section className="settings-form-row" aria-labelledby="settings-audio-label">
                    <span id="settings-audio-label" className="settings-form-label">
                      虚拟麦克风：
                    </span>
                    <div className="settings-form-control">
                      <span>MiRemoteV 2ch</span>
                      <span
                        className={`settings-permission-status ${nativeRuntime && audioInstalled && !audioBusy ? 'granted' : ''}`}
                        aria-live="polite"
                      >
                        {audioStatus}
                      </span>
                      <button
                        type="button"
                        className={`dialog-secondary ${audioInstalled ? 'danger' : ''}`}
                        disabled={!nativeRuntime || audioBusy}
                        onClick={() => onAudioAction(audioInstalled ? 'uninstall' : 'install')}
                      >
                        {audioInstalled ? '卸载' : '安装驱动'}
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || !audioInstalled || audioBusy}
                        aria-busy={audioRestarting}
                        onClick={onRestartAudio}
                      >
                        {audioRestarting ? '重启中…' : '重启驱动'}
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || audioBusy}
                        onClick={onProbeAudio}
                      >
                        <RotateCcw size={14} />
                        重新检测
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || audioBusy}
                        onClick={onOpenSound}
                      >
                        声音设置
                        <ExternalLink size={14} />
                      </button>
                      <SettingsHelp id="settings-audio-help" label="虚拟麦克风">
                        将 RC003 遥控器语音转发给语音输入法等应用。安装驱动后，还需在应用中选择 MiRemoteV 2ch
                        作为麦克风。切换声音设备后若没有声音，可点击“重启驱动”重新连接虚拟麦克风和遥控器；当前语音会中断，请连接恢复后再试。
                      </SettingsHelp>
                    </div>
                  </section>
                  <section className="settings-form-row" aria-labelledby="settings-audio-stretch-label">
                    <span id="settings-audio-stretch-label" className="settings-form-label">
                      语音补偿：
                    </span>
                    <div className="settings-form-control">
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={stretchCompensation}
                          disabled={!nativeRuntime || stretchUpdating || audioBusy}
                          onChange={event => onStretchCompensationChange(event.target.checked)}
                        />
                        软件拉伸补偿（实验）
                      </label>
                      {stretchUpdating && <span role="status">正在应用…</span>}
                      <SettingsHelp id="settings-audio-stretch-help" label="软件拉伸补偿">
                        默认关闭，更改自动保存。实验性功能，会拉长收到的声音；收包不稳定时可能加重停顿或拖音，无法恢复缺失的字。出现卡顿加重时请关闭。请松开语音键、等待尾音结束后切换，下次讲话生效。
                      </SettingsHelp>
                      {stretchError && (
                        <span role="alert" className="settings-form-error">
                          {stretchError}
                        </span>
                      )}
                    </div>
                  </section>
                  <div className="settings-form-row">
                    <span className="settings-form-label">语音输入法：</span>
                    <div className="settings-form-control">
                      <span>麦克风请选择 MiRemoteV 2ch</span>
                      <SettingsHelp id="settings-audio-input-help" label="语音输入法麦克风设置">
                        豆包输入法：设置 → 语音输入 → 麦克风选择 → MiRemoteV
                        2ch。其他语音输入法请在各自的音频设置中选择此设备。
                      </SettingsHelp>
                    </div>
                  </div>
                </div>
                {nativeRuntime && audioError && (
                  <div className="permission-drag-note" role="alert">
                    <Info size={17} />
                    <div>
                      <strong>虚拟麦克风需要处理</strong>
                      <span>{audioError}</span>
                    </div>
                  </div>
                )}
                {grantedCount < 2 && (
                  <div className="permission-drag-note">
                    <Info size={17} />
                    <div>
                      <strong>{inputAuthorizationStale ? '需要重新授权当前应用' : '系统列表中没有 Axonkey？'}</strong>
                      <span>
                        {inputAuthorizationStale
                          ? (inputDriver.message ?? '当前应用的输入监控授权已失效，请重新授权后再使用按键映射。')
                          : '点击开始授权后，可通过授权小窗在 Finder 中定位应用，再将 Axonkey.app 拖入系统设置列表。'}
                      </span>
                    </div>
                  </div>
                )}
              </>
            ) : platform === 'windows' ? (
              <>
                <section className="settings-platform-note" aria-labelledby="windows-device-settings-title">
                  <span className="settings-platform-note-icon">
                    <ShieldCheck size={24} />
                  </span>
                  <div className="settings-platform-note-copy">
                    <h3 id="windows-device-settings-title">Windows 设备服务</h3>
                    <p>每台 RC003 的按键驱动在设备工作区单独连接和管理。</p>
                  </div>
                </section>
                <div className="settings-form-fields settings-device-fields">
                  <section className="settings-form-row" aria-labelledby="settings-device-setup-label">
                    <span id="settings-device-setup-label" className="settings-form-label">
                      设备设置：
                    </span>
                    <div className="settings-form-control">
                      <span>旧驱动清理、CABLE Input 与设备级驱动清理</span>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime}
                        onClick={onOpenDeviceSetup}
                      >
                        打开设备设置
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </section>
                  <section className="settings-form-row" aria-labelledby="settings-windows-audio-label">
                    <span id="settings-windows-audio-label" className="settings-form-label">
                      CABLE Input：
                    </span>
                    <div className="settings-form-control">
                      <span
                        className={`settings-permission-status ${nativeRuntime && audioInstalled && !audioBusy ? 'granted' : ''}`}
                      >
                        {audioStatus}
                      </span>
                      <button
                        type="button"
                        className={`dialog-secondary ${audioInstalled ? 'danger' : ''}`}
                        disabled={!nativeRuntime || audioBusy}
                        onClick={() => onAudioAction(audioInstalled ? 'uninstall' : 'install')}
                      >
                        {audioInstalled ? '卸载' : '安装驱动'}
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || !audioInstalled || audioBusy}
                        aria-busy={audioRestarting}
                        onClick={onRestartAudio}
                      >
                        {audioRestarting ? '重启中…' : '重启驱动'}
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || audioBusy}
                        onClick={onProbeAudio}
                      >
                        <RotateCcw size={14} />
                        重新检测
                      </button>
                      <button
                        type="button"
                        className="dialog-secondary"
                        disabled={!nativeRuntime || audioBusy}
                        onClick={onOpenSound}
                      >
                        声音设置
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <section className="settings-platform-note">
                <Info size={28} />
                <h3>当前系统暂不支持</h3>
                <p>请在 macOS 或 Windows 桌面版中配置系统权限。</p>
              </section>
            )}
            {platform === 'macos' && (
              <div className="settings-form-fields settings-device-fields">
                <section className="settings-form-row" aria-labelledby="settings-signal-label">
                  <span id="settings-signal-label" className="settings-form-label">
                    语音链路监测：
                  </span>
                  <div className="settings-form-control">
                    <button
                      type="button"
                      className="dialog-secondary"
                      disabled={!nativeRuntime || signalMonitorOpening}
                      aria-busy={signalMonitorOpening}
                      onClick={onOpenSignalMonitor}
                    >
                      {signalMonitorOpening ? '正在打开…' : '打开监测'}
                    </button>
                    <SettingsHelp id="settings-signal-help" label="语音链路监测">
                      查看遥控器蓝牙信号、语音收包速度、音频波形和应用音频队列的实时图表，排查卡顿与延迟。支持清空图表历史、标记位置和导出读数；清空历史不会清空音频队列。关闭窗口后停止监测。
                    </SettingsHelp>
                    {signalMonitorError && (
                      <span role="alert" className="settings-form-error">
                        {signalMonitorError}
                      </span>
                    )}
                  </div>
                </section>
              </div>
            )}
          </section>
          <section
            id="settings-panel-remote"
            aria-labelledby="settings-nav-remote"
            hidden={currentSection !== 'remote'}
          >
            <div className="settings-mouse-heading">
              <h3 className="settings-section-title">页面布局</h3>
              <span>更改自动保存</span>
            </div>
            <div className="settings-form-fields">
              <div className="settings-form-row">
                <span className="settings-form-label">按键列表：</span>
                <div className="settings-form-control">
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={showRemoteKeyGrid}
                      onChange={event => onShowRemoteKeyGridChange(event.target.checked)}
                    />
                    显示遥控器按键列表
                  </label>
                  <SettingsHelp id="remote-key-grid-help" label="显示遥控器按键列表">
                    默认开启。在映射页顶部显示所有遥控器按键；关闭后仍可通过左侧遥控器图选择按键。
                  </SettingsHelp>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
