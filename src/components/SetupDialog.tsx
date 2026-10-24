import {
  AudioLines,
  Bluetooth,
  Check,
  CheckCircle2,
  ChevronRight,
  Command,
  Download,
  ExternalLink,
  FolderOpen,
  Info,
  Keyboard,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import type { DriverActionKind, DriverKind, SetupState, SetupStepId } from '../setupModel'
import { isSetupComplete } from '../setupModel'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'

type SetupDialogProps = {
  platform: Platform
  macPermissions: MacPermissions
  state: SetupState
  onClose: () => void
  onOpenStep: (step: SetupStepId) => void
  onCompleteStep: () => void
  onSkipStep: () => void
  onSkipAll: () => void
  onReset: () => void
  onDriverAction: (driver: DriverKind, action: DriverActionKind) => void
  onProbeAudio: () => void
  onProbeLegacyCleanup: () => void
  onCleanupLegacy: () => void
  onOpenSystemSettings: (page: 'bluetooth' | 'sound' | 'services' | MacPermissionKind) => void
  onRequestMacPermission: (kind: MacPermissionKind) => void
  onOpenExternalPage: (page: 'vbcable') => void
  onCheckDevice: () => void
  onMarkDeviceConnected: () => void
  onFinish: () => void
}

const windowsSetupStepLabels: Record<SetupStepId, string> = {
  welcome: '开始',
  legacyCleanup: '卸载旧驱动',
  inputDriver: '集成设备',
  deviceConnection: '连接设备',
  complete: '完成',
}

const macSetupStepLabels: Record<SetupStepId, string> = {
  ...windowsSetupStepLabels,
  inputDriver: '权限与音频',
}

const windowsSetupSteps: SetupStepId[] = ['welcome', 'legacyCleanup', 'deviceConnection', 'inputDriver', 'complete']
const macSetupSteps: SetupStepId[] = ['inputDriver', 'deviceConnection']

export function SetupDialog({ platform, macPermissions, state, onClose, onOpenStep, onCompleteStep, onSkipStep, onSkipAll, onReset, onDriverAction, onProbeAudio, onProbeLegacyCleanup, onCleanupLegacy, onOpenSystemSettings, onRequestMacPermission, onOpenExternalPage, onCheckDevice, onMarkDeviceConnected, onFinish }: SetupDialogProps) {
  const step = state.currentStep
  const setupStepLabels = platform === 'macos' ? macSetupStepLabels : windowsSetupStepLabels
  const visibleSteps = platform === 'macos'
    ? macSetupSteps
    : windowsSetupSteps.filter((stepId) => stepId !== 'legacyCleanup' || state.steps.legacyCleanup.status !== 'skipped')
  return <div className="setup-backdrop" role="presentation">
    <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <aside className="setup-progress">
        <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>{platform === 'macos' ? '2 步完成设置' : '遥控器集成'}</span></div></div>
        <div className="setup-step-list">
          {visibleSteps.map((stepId, index) => {
            const status = state.steps[stepId].status
            const statusClass = status === 'complete' || status === 'skipped' ? status : ''
            return <button type="button" key={stepId} className={`setup-step ${step === stepId ? 'active' : ''} ${statusClass}`} onClick={() => onOpenStep(stepId)}>
              <span className="setup-step-index">{status === 'complete' ? <Check size={12} /> : index + 1}</span>
              <span>{setupStepLabels[stepId]}</span>
              {status === 'skipped' && <small>已跳过</small>}
            </button>
          })}
        </div>
        <button type="button" className="setup-skip-all" disabled={step === 'legacyCleanup' && state.legacyCleanup.status === 'present'} onClick={state.setupSkipped || isSetupComplete(state) ? onReset : onSkipAll}>{state.setupSkipped || isSetupComplete(state) ? '重新运行引导' : '跳过整个引导'}</button>
      </aside>
      <div className="setup-content">
        <button type="button" className="dialog-close setup-close" aria-label="关闭引导" onClick={onClose}><X size={17} /></button>
        {step === 'welcome' && <div className="setup-screen">
          <span className="setup-hero-icon"><Settings2 size={24} /></span>
          <span className="section-kicker">FIRST RUN</span>
          <h2 id="setup-title">{platform === 'macos' ? '准备好权限与遥控器' : '准备集成遥控器'}</h2>
          <p className="setup-lead">{platform === 'macos'
            ? '整个过程只在本机完成。Axonkey 需要读取 RC003 输入并向当前应用发送映射后的按键。'
            : '整个过程只在本机完成。连接遥控器后，分别准备按键控制和语音输入；系统操作会请求管理员授权，并根据结果提示重新连接或重启 Windows。'}</p>
          <div className="setup-summary-grid">
            {platform === 'macos' ? <>
              <div><Keyboard size={18} /><strong>输入监控</strong><span>仅监听目标 RC003 的 HID 报告</span></div>
              <div><Command size={18} /><strong>辅助功能</strong><span>发送映射后的按键与文本</span></div>
              <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 macOS 蓝牙配对并唤醒</span></div>
            </> : <>
              <div><Keyboard size={18} /><strong>按键控制</strong><span>为当前 RC003 读取按键并执行映射</span></div>
              <div><AudioLines size={18} /><strong>语音输入</strong><span>按需将遥控器语音传给输入法或其他应用</span></div>
              <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 Windows 蓝牙配对并唤醒</span></div>
            </>}
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onCompleteStep}>{platform === 'macos' ? '开始设置' : '开始集成'} <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'inputDriver' && (platform === 'macos'
          ? <MacPermissionsSetupScreen
            permissions={macPermissions}
            state={state}
            onRequest={onRequestMacPermission}
            onAudioAction={onDriverAction}
            onProbeAudio={onProbeAudio}
            onOpenSound={() => onOpenSystemSettings('sound')}
            onContinue={onCompleteStep}
            onSkip={onSkipStep}
          />
          : <DriversSetupScreen
            state={state}
            onAction={onDriverAction}
            onProbeAudio={onProbeAudio}
            onContinue={onCompleteStep}
            onOpenSettings={() => onOpenSystemSettings('sound')}
            onOpenVendorPage={() => onOpenExternalPage('vbcable')}
          />)}
        {step === 'legacyCleanup' && platform === 'windows' && <LegacyCleanupScreen
          state={state}
          onRecheck={onProbeLegacyCleanup}
          onCleanup={onCleanupLegacy}
          onContinue={onCompleteStep}
        />}
        {step === 'deviceConnection' && <div className="setup-screen">
          <span className="setup-hero-icon"><Bluetooth size={24} /></span>
          <span className="section-kicker">DEVICE</span>
          <h2 id="setup-title">连接小米遥控器 RC003</h2>
          <p className="setup-lead">先在{platform === 'macos' ? '系统' : ' Windows'}蓝牙设置中完成配对，再按遥控器任意按键将它唤醒。Axonkey 只处理 VID 2717 / PID 32B8 的目标设备。</p>
          <div className={`setup-status-panel ${state.device.status}`}><span className="setup-status-dot" /><div><strong>{state.device.status === 'connected' ? 'RC003 已连接' : state.device.status === 'checking' ? '正在检查设备' : '尚未确认连接'}</strong><span>{state.device.message ?? '打开系统设置完成蓝牙配对，然后返回这里检查。'}</span></div></div>
          <div className="setup-inline-actions"><button type="button" className="dialog-secondary" onClick={() => onOpenSystemSettings('bluetooth')}><Bluetooth size={14} /> 打开蓝牙设置</button><button type="button" className="dialog-secondary" onClick={onCheckDevice}><RotateCcw size={14} /> 重新检测</button><button type="button" className="dialog-secondary" onClick={onMarkDeviceConnected}><Check size={14} /> 我已连接</button></div>
          <div className="setup-actions"><button type="button" className="setup-text-button" onClick={platform === 'macos' ? () => { onSkipStep(); onFinish() } : onSkipStep}>稍后连接</button><button type="button" className="button primary setup-primary" disabled={state.device.status !== 'connected'} onClick={platform === 'macos' ? onFinish : onCompleteStep}>{platform === 'macos' ? '完成设置' : '继续'} <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'complete' && <div className="setup-screen setup-complete">
          <span className="setup-hero-icon success"><Check size={26} /></span>
          <span className="section-kicker">READY</span>
          <h2 id="setup-title">{platform === 'macos' ? '基本设置已完成' : '集成设置已完成'}</h2>
          <p className="setup-lead">{platform === 'macos' ? '映射配置会自动保存。以后点击顶部的设备状态卡，可以重新打开这里检查系统权限或 RC003 连接。' : '映射配置会自动保存。以后从设备集成入口重新打开这里，可以检查按键控制、语音输入或 RC003 连接。'}</p>
          <div className="setup-result-list">
            {platform === 'macos' ? <>
              <span><Keyboard size={15} /> 输入监控：{macPermissions.inputMonitoring ? '已授权' : '稍后授权'}</span>
              <span><Command size={15} /> 辅助功能：{macPermissions.accessibility ? '已授权' : '稍后授权'}</span>
              <span><AudioLines size={15} /> MiRemoteV 2ch：{driverStatusLabel(state.drivers.audio.status)}</span>
            </> : <>
              <span><Keyboard size={15} /> 按键控制：{integrationStatusLabel(state.drivers.input.status)}</span>
              <span><AudioLines size={15} /> 语音输入：{integrationStatusLabel(state.drivers.audio.status)}</span>
            </>}
            <span><Bluetooth size={15} /> RC003：{state.device.status === 'connected' ? '已连接' : '稍后连接'}</span>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onFinish}>进入按键映射</button></div>
        </div>}
      </div>
    </section>
  </div>
}

type LegacyCleanupScreenProps = {
  state: SetupState
  onRecheck: () => void
  onCleanup: () => void
  onContinue: () => void
}

function LegacyCleanupScreen({ state, onRecheck, onCleanup, onContinue }: LegacyCleanupScreenProps) {
  const cleanup = state.legacyCleanup
  const items = [
    {
      key: 'interception' as const,
      title: 'Interception 旧键盘驱动',
      description: '旧版全局键盘过滤驱动会和 Quarbor HID 驱动冲突。请使用旧版 Axonkey 的卸载入口或原驱动安装器执行卸载。',
    },
    {
      key: 'interceptionFix' as const,
      title: 'AxonkeyInterceptionFix 修复服务',
      description: '旧版驱动修复服务已不再需要。点击“一键卸载旧组件”移除服务及其安装目录。',
    },
    {
      key: 'frida' as const,
      title: 'Frida 运行组件',
      description: '退出旧版输入辅助工具和 Frida 相关进程，再删除旧版 Axonkey 安装目录中残留的 Frida 文件。',
    },
    {
      key: 'namedPipeServer' as const,
      title: 'NamedPipeServer 服务',
      description: '在 Windows 服务中停止并删除旧 NamedPipeServer 服务。当前版本使用 Quarbor 的按设备管道，不需要这个服务。',
    },
  ]
  const present = items.filter((item) => cleanup.components[item.key])
  const ready = cleanup.status === 'clear' && present.length === 0
  const cleanupRunning = cleanup.action.status === 'running'
  const cleanupWaitingForRestart = cleanup.action.status === 'succeeded'
  return <div className="setup-screen legacy-cleanup-screen">
    <span className="setup-hero-icon"><ShieldAlert size={24} /></span>
    <span className="section-kicker">MIGRATION</span>
    <h2 id="setup-title">先卸载旧驱动</h2>
    <p className="setup-lead">检测到旧版输入组件。请先完成清理，再安装新的 Quarbor HID 驱动，避免两个输入链路同时接管 RC003。</p>
    <div className={`legacy-cleanup-summary ${ready ? 'ready' : cleanup.status === 'checking' ? 'checking' : ''}`} aria-live="polite">
      <span className="setup-status-dot" />
      <div><strong>{ready ? '旧组件已清理' : cleanup.status === 'checking' ? '正在检查旧组件…' : cleanup.status === 'error' ? '旧驱动检测失败' : '仍有旧组件需要处理'}</strong><span>{ready ? '可以继续安装新的 Quarbor HID 驱动。' : cleanup.message ?? '完成下面列出的卸载操作后，点击“重新检测”。'}</span></div>
    </div>
    {!ready && <div className="legacy-cleanup-list">
      {(present.length > 0 ? present : items).map((item) => <section key={item.key} className={`legacy-cleanup-item ${cleanup.components[item.key] ? 'present' : 'clear'}`}>
        <div className="legacy-cleanup-item-heading"><span className="setup-status-dot" /><strong>{item.title}</strong><span>{cleanup.components[item.key] ? '检测到' : '未检测到'}</span></div>
        <p>{item.description}</p>
      </section>)}
    </div>}
    {cleanup.action.status === 'failed' && <div className="setup-status-panel error" aria-live="polite"><span className="setup-status-dot" /><div><strong>自动清理未完成</strong><span>{cleanup.action.error ?? '请查看日志后重试，或使用 Windows 服务管理器手动清理。'}</span></div></div>}
    {cleanup.action.status === 'succeeded' && <div className="setup-status-panel success" aria-live="polite"><span className="setup-status-dot" /><div><strong>卸载已完成，请重启</strong><span>请点击“重新检测”确认旧组件已清理；如果 Windows 仍占用文件，可以稍后再次运行卸载。</span></div></div>}
    <div className="legacy-cleanup-actions">
      <button type="button" className="button primary" disabled={cleanupRunning || cleanupWaitingForRestart || cleanup.status === 'checking'} onClick={onCleanup}><ShieldCheck size={14} /> {cleanupWaitingForRestart ? '等待重启' : cleanupRunning ? '正在卸载旧组件…' : '一键卸载旧组件'}</button>
      <button type="button" className="dialog-secondary" disabled={cleanup.status === 'checking' || cleanupRunning} onClick={onRecheck}><RotateCcw size={14} /> {cleanup.status === 'checking' ? '检测中…' : '重新检测'}</button>
    </div>
    <div className="setup-actions"><button type="button" className="button primary setup-primary" disabled={!ready} onClick={onContinue}>继续连接 RC003 <ChevronRight size={15} /></button></div>
  </div>
}

type MacPermissionsSetupScreenProps = {
  permissions: MacPermissions
  state: SetupState
  onRequest: (kind: MacPermissionKind) => void
  onAudioAction: (driver: DriverKind, action: DriverActionKind) => void
  onProbeAudio: () => void
  onOpenSound: () => void
  onContinue: () => void
  onSkip: () => void
}

function MacPermissionsSetupScreen({ permissions, state, onRequest, onAudioAction, onProbeAudio, onOpenSound, onContinue, onSkip }: MacPermissionsSetupScreenProps) {
  const ready = permissions.inputMonitoring && permissions.accessibility
  const grantedCount = Number(permissions.inputMonitoring) + Number(permissions.accessibility)
  const activeKind: MacPermissionKind | null = !permissions.inputMonitoring
    ? 'inputMonitoring'
    : !permissions.accessibility ? 'accessibility' : null
  const items = [
    {
      kind: 'inputMonitoring' as const,
      title: '输入监控',
      description: '允许 IOKit 读取目标 RC003 的原始 HID 按键报告。',
      granted: permissions.inputMonitoring,
      icon: <Keyboard size={18} />,
    },
    {
      kind: 'accessibility' as const,
      title: '辅助功能',
      description: '允许 CoreGraphics 发送映射后的按键、快捷键和文本。',
      granted: permissions.accessibility,
      icon: <Command size={18} />,
    },
  ]
  const audio = state.drivers.audio
  const inputAuthorizationError = state.drivers.input.status === 'error'
    ? state.drivers.input.message
    : null
  const audioInstalled = isDriverInstalled(state, 'audio')
  const audioRunning = audio.action.status === 'running'
  return <div className="setup-screen mac-permission-screen">
    <span className="section-kicker">SYSTEM ACCESS</span>
    <h2 id="setup-title">先完成两项必要授权</h2>
    <p className="setup-lead">按顺序操作即可。每次授权都会打开对应的系统设置，并保留一个置顶小窗协助完成添加。</p>

    <div className={`permission-progress-summary ${ready ? 'ready' : ''}`} aria-live="polite">
      <span className="permission-progress-icon"><ShieldCheck size={24} /></span>
      <div><strong>{ready ? '系统权限已就绪' : `已完成 ${grantedCount} / 2`}</strong><span>{ready ? 'Axonkey 可以拦截原始按键并执行你的映射。' : '只突出当前需要完成的一项，授权后会自动刷新。'}</span></div>
      <span className="permission-progress-count">{grantedCount}/2</span>
    </div>

    <div className="mac-permission-list">
      {items.map((item, index) => {
        const current = activeKind === item.kind
        const waiting = !item.granted && !current
        return <section key={item.kind} className={`mac-permission-step ${item.granted ? 'granted' : current ? 'current' : 'waiting'}`}>
          <div className="permission-step-number">{item.granted ? <Check size={16} /> : index + 1}</div>
          <span className="permission-step-icon">{item.icon}</span>
          <div className="permission-step-copy"><div><h3>{item.title}</h3><span className="permission-status-label">{item.granted ? '已授权' : current ? '现在完成' : '下一步'}</span></div><p>{item.description}</p></div>
          {current && <button type="button" className="button primary permission-request-button" onClick={() => onRequest(item.kind)}>开始授权 <ExternalLink size={15} /></button>}
          {item.granted && <CheckCircle2 className="permission-complete-icon" size={21} />}
          {waiting && <span className="permission-waiting-label">完成上一步后继续</span>}
        </section>
      })}
    </div>

    <section className={`mac-audio-setup ${audio.status}`}>
      <span className="permission-step-icon"><AudioLines size={18} /></span>
      <div className="mac-audio-copy">
        <div><h3>MiRemoteV 2ch 虚拟麦克风</h3><span className="permission-status-label">{driverStatusLabel(audio.status)}</span></div>
        <p>{audio.action.error ?? audio.message ?? '安装后，Axonkey 会将 RC003 语音转发到虚拟麦克风。'}</p>
        <p>请将语音输入法的麦克风设为 <strong>MiRemoteV 2ch</strong>，以接收遥控器语音。</p>
        <p>豆包输入法：设置 → 语音输入 → 麦克风选择。</p>
      </div>
      <div className="mac-audio-actions">
        {!audioInstalled && <button type="button" className="dialog-secondary" disabled={audioRunning} onClick={() => onAudioAction('audio', 'install')}><Download size={14} /> {audioRunning ? '等待授权…' : '安装驱动'}</button>}
        {audioInstalled && <button type="button" className="dialog-secondary danger" disabled={audioRunning} onClick={() => onAudioAction('audio', 'uninstall')}><Trash2 size={14} /> {audioRunning ? '等待授权…' : '卸载'}</button>}
        <button type="button" className="dialog-secondary" disabled={audioRunning || audio.status === 'checking'} onClick={onProbeAudio}><RotateCcw size={14} /> {audio.status === 'checking' ? '检测中' : '重新检测'}</button>
        <button type="button" className="dialog-secondary" disabled={audioRunning} onClick={onOpenSound}><Settings2 size={14} /> 声音设置</button>
      </div>
    </section>

    {inputAuthorizationError
      ? <div className="permission-drag-note"><Info size={17} /><div><strong>需要重新授权当前构建</strong><span>{inputAuthorizationError}</span></div></div>
      : !ready && <div className="permission-drag-note"><Info size={17} /><div><strong>系统列表中没有 Axonkey？</strong><span>授权小窗可以在 Finder 中定位当前应用，再将 Axonkey.app 拖入系统设置列表。</span></div></div>}
    <div className="setup-actions"><button type="button" className="setup-text-button" onClick={onSkip}>稍后授权</button><button type="button" className="button primary setup-primary" disabled={!ready} onClick={onContinue}>继续 <ChevronRight size={15} /></button></div>
  </div>
}

export type MacPermissionHelperWindowProps = {
  activePermission: MacPermissionKind
  permissions: MacPermissions
  onOpenSettings: (kind: MacPermissionKind) => void
  onRevealApp: () => void
  onRefresh: () => void
  onClose: () => void
}

export function MacPermissionHelperWindow({ activePermission, permissions, onOpenSettings, onRevealApp, onRefresh, onClose }: MacPermissionHelperWindowProps) {
  const ready = permissions.inputMonitoring && permissions.accessibility
  const activeTitle = activePermission === 'inputMonitoring' ? '输入监控' : '辅助功能'
  return <main className="permission-helper-shell">
    <header className="permission-helper-header">
      <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>授权助手 · 保持置顶</span></div></div>
      <button type="button" className="dialog-close" aria-label="返回完整窗口" onClick={onClose}><X size={17} /></button>
    </header>

    <section className="permission-helper-content">
      <span className="section-kicker">{ready ? 'PERMISSIONS READY' : `CURRENT · ${activePermission === 'inputMonitoring' ? '1 / 2' : '2 / 2'}`}</span>
      <h1>{ready ? '两项权限都已打开' : `在系统设置中允许${activeTitle}`}</h1>
      <p className="permission-helper-lead">{ready ? '状态已自动刷新，可以返回引导继续连接遥控器。' : '若列表中已有 Axonkey，直接打开右侧开关；没有时按下面两步添加。'}</p>

      <div className="permission-helper-status" aria-live="polite">
        <span className={permissions.inputMonitoring ? 'granted' : activePermission === 'inputMonitoring' ? 'active' : ''}><Keyboard size={15} /> 输入监控 <strong>{permissions.inputMonitoring ? '已授权' : '待授权'}</strong></span>
        <span className={permissions.accessibility ? 'granted' : activePermission === 'accessibility' ? 'active' : ''}><Command size={15} /> 辅助功能 <strong>{permissions.accessibility ? '已授权' : '待授权'}</strong></span>
      </div>

      {!ready && <div className="permission-drag-guide">
        <div className="permission-drag-visual" aria-hidden="true"><span className="permission-app-tile"><span className="brand-mark">A</span>Axonkey.app</span><ChevronRight size={18} /><span className="permission-settings-tile"><Settings2 size={18} />系统设置</span></div>
        <ol><li>点击“在 Finder 中显示”，找到高亮的 Axonkey.app。</li><li>将它拖到已打开的系统授权列表，再打开开关。</li></ol>
      </div>}

      <div className="permission-helper-actions">
        {!ready && <button type="button" className="button primary" onClick={onRevealApp}><FolderOpen size={16} /> 在 Finder 中显示</button>}
        {!ready && <button type="button" className="dialog-secondary" onClick={() => onOpenSettings(activePermission)}><ExternalLink size={15} /> 再次打开系统设置</button>}
      </div>
    </section>

    <footer className="permission-helper-footer">
      <button type="button" className="setup-text-button permission-refresh-button" onClick={onRefresh}><RotateCcw size={14} /> 重新检测</button>
      <button type="button" className={`button ${ready ? 'primary' : 'permission-return-button'}`} onClick={onClose}>{ready ? '继续连接遥控器' : '返回引导'} <ChevronRight size={15} /></button>
    </footer>
  </main>
}

type DriversSetupScreenProps = {
  state: SetupState
  onAction: (driver: DriverKind, action: DriverActionKind) => void
  onProbeAudio: () => void
  onContinue: () => void
  onOpenSettings: () => void
  onOpenVendorPage: () => void
}

function driverStatusLabel(status: SetupState['drivers']['input']['status']) {
  const labels = { unknown: '未检查', checking: '检查中', missing: '未安装', installed: '已安装', restartRequired: '等待重启', error: '操作失败' }
  return labels[status]
}

function integrationStatusLabel(status: SetupState['drivers']['input']['status']) {
  const labels = { unknown: '未检查', checking: '检查中', missing: '待集成', installed: '已就绪', restartRequired: '等待重启', error: '操作失败' }
  return labels[status]
}

function isDriverInstalled(state: SetupState, kind: DriverKind) {
  const status = state.drivers[kind].status
  return status === 'installed' || status === 'restartRequired'
}

type DriverSetupItemProps = Pick<DriversSetupScreenProps, 'state' | 'onAction' | 'onProbeAudio' | 'onOpenSettings' | 'onOpenVendorPage'> & {
  kind: DriverKind
  disabled: boolean
}

function DriverSetupItem({ kind, state, onAction, onProbeAudio, onOpenSettings, onOpenVendorPage, disabled }: DriverSetupItemProps) {
  const driver = state.drivers[kind]
  const running = driver.action.status === 'running'
  const installed = isDriverInstalled(state, kind)
  const inputInstallBlocked = kind === 'input' && !installed && state.device.status !== 'connected'
  const message = driver.action.error ?? driver.message ?? (kind === 'input'
    ? '集成后，Axonkey 可以读取这台遥控器的按键输入。'
    : '启用时会安装 VB-Audio VB-CABLE（Donationware），提供 CABLE Output 虚拟麦克风。')
  return <section className={`driver-setup-item ${driver.status}`}>
    <div className="driver-setup-heading">
      <span className="driver-setup-icon">{kind === 'input' ? <Keyboard size={18} /> : <AudioLines size={18} />}</span>
      <div><h3>{kind === 'input' ? '按键控制' : '语音输入'}</h3><p>{kind === 'input' ? '读取当前遥控器的按键并执行自定义映射。' : '将遥控器语音传给输入法或其他应用。'}</p></div>
      <span className="driver-status-chip"><span className="setup-status-dot" /> {integrationStatusLabel(driver.status)}</span>
    </div>
    <p className="driver-setup-message">{message}</p>
    {inputInstallBlocked && driver.action.status !== 'failed' && <div className="setup-status-panel disconnected" aria-live="polite"><span className="setup-status-dot" /><div><strong>{state.device.status === 'checking' ? '正在检查 RC003 连接状态' : '暂时无法集成按键控制'}</strong><span>{state.device.status === 'checking' ? '请等待设备检测完成。' : '请先连接并唤醒小米遥控器 RC003，再为这台设备集成按键控制。'}</span></div></div>}
    {driver.action.status === 'failed' && <div className="setup-status-panel error" aria-live="assertive"><span className="setup-status-dot" /><div><strong>{driver.action.kind === 'install' ? kind === 'input' ? '按键控制集成失败，请重试。' : '语音输入启用失败，请重试。' : '移除失败，请重试。'}</strong></div></div>}
    {kind === 'audio' && <p className="driver-setup-message">微信输入法语音输入可能压低其他媒体音量，甚至中断播放。麦克风请选择 CABLE Output；系统和应用的扬声器输出请保留真实扬声器或耳机，不要选择 CABLE Input 等虚拟设备。Axonkey 会自行向 CABLE Input 写入遥控器语音。</p>}
    <div className="driver-setup-actions">
      {!installed && <button type="button" className="dialog-secondary" disabled={disabled || inputInstallBlocked} onClick={() => onAction(kind, 'install')}><Download size={14} /> {running ? '等待系统操作…' : kind === 'audio' ? '启用语音输入' : '集成按键控制'}</button>}
      {kind === 'input' && <button type="button" className="dialog-secondary danger" disabled={disabled} onClick={() => onAction(kind, 'uninstall')}><Trash2 size={14} /> {running ? '等待系统操作…' : '移除按键集成'}</button>}
      {kind === 'audio' && installed && <button type="button" className="dialog-secondary danger" disabled={disabled} onClick={() => onAction(kind, 'uninstall')}><Trash2 size={14} /> {running ? '等待系统操作…' : '卸载语音输入支持'}</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled || driver.status === 'checking'} onClick={onProbeAudio}><RotateCcw size={14} /> {driver.status === 'checking' ? '检测中' : '重新检测'}</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled} onClick={onOpenSettings}><Settings2 size={14} /> 声音设置</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled} onClick={onOpenVendorPage}><ExternalLink size={14} /> VB-Audio 官网</button>}
    </div>
  </section>
}

function DriversSetupScreen({ state, onAction, onProbeAudio, onContinue, onOpenSettings, onOpenVendorPage }: DriversSetupScreenProps) {
  const anyRunning = (['input', 'audio'] as const).some((kind) => state.drivers[kind].action.status === 'running')
  const inputInstalled = isDriverInstalled(state, 'input')
  const restartRequired = (['input', 'audio'] as const).some((kind) => state.drivers[kind].restartRequired)
  return <div className="setup-screen drivers-setup-screen">
    <span className="setup-hero-icon"><Download size={24} /></span>
    <span className="section-kicker">DEVICE INTEGRATION</span>
    <h2 id="setup-title">完成遥控器集成</h2>
    <p className="setup-lead">连接并唤醒 RC003 后，为这台遥控器集成按键控制，并按需启用语音输入。按键控制仅绑定当前遥控器的设备实例。</p>
    <div className="driver-setup-list">
      <DriverSetupItem kind="input" state={state} onAction={onAction} onProbeAudio={onProbeAudio} onOpenSettings={onOpenSettings} onOpenVendorPage={onOpenVendorPage} disabled={anyRunning} />
      <DriverSetupItem kind="audio" state={state} onAction={onAction} onProbeAudio={onProbeAudio} onOpenSettings={onOpenSettings} onOpenVendorPage={onOpenVendorPage} disabled={anyRunning} />
    </div>
    <div className="driver-restart-notice"><RotateCcw size={16} /><div><strong>按操作结果重新连接设备或重启 Windows</strong><span>集成前必须连接并唤醒 RC003；如果设备在操作过程中断开，页面会显示具体失败原因。移除按键集成会执行该设备的卸载操作，支持离线设备。安装和卸载时会请求管理员授权，是否需要重启以安装器返回结果为准。</span></div></div>
    <div className="setup-actions"><button type="button" className="button primary setup-primary" disabled={anyRunning || !inputInstalled} onClick={onContinue}>{inputInstalled ? restartRequired ? '继续，稍后重启' : '继续' : '完成按键集成后继续'} <ChevronRight size={15} /></button></div>
  </div>
}
