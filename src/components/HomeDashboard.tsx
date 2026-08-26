import {
  AudioLines,
  Bluetooth,
  CheckCircle2,
  ChevronRight,
  Command,
  Keyboard,
  LoaderCircle,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { SetupState, SetupStepId } from '../setupModel'
import { audioGainMax, audioGainMin } from '../appConfig'
import type { ReactNode } from 'react'

type HomeStatusTone = 'ready' | 'warning' | 'error' | 'checking' | 'muted'

type HomeDashboardProps = {
  platform: Platform
  nativeRuntime: boolean
  systemProbeState: 'loading' | 'ready' | 'error'
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  audioDriver: SetupState['drivers']['audio']
  device: SetupState['device']
  batteryLevel: number | null
  audioGain: number
  enabled: boolean
  onRequestPermission: (kind: MacPermissionKind) => void
  onRefresh: () => void
  onAudioGainChange: (gain: number) => void
  onOpenStep: (step: SetupStepId) => void
  onOpenMapping: () => void
}

type HomeStatusCardProps = {
  icon: ReactNode
  title: string
  status: string
  detail: string
  tone: HomeStatusTone
  action?: ReactNode
}

function HomeStatusCard({ icon, title, status, detail, tone, action }: HomeStatusCardProps) {
  return <article className={`home-status-card ${tone}`}>
    <div className="home-status-card-head">
      <span className="home-status-icon">{icon}</span>
      <div><h3>{title}</h3><span className="home-status-label"><span className="home-status-dot" />{status}</span></div>
    </div>
    <p>{detail}</p>
    {action && <div className="home-status-action">{action}</div>}
  </article>
}

type HomeAudioCardProps = {
  macOS: boolean
  driver: SetupState['drivers']['audio']
  probePending: boolean
  gain: number
  onGainChange: (gain: number) => void
  onRefresh: () => void
}

function HomeAudioCard({ macOS, driver, probePending, gain, onGainChange, onRefresh }: HomeAudioCardProps) {
  const presentation = driverStatusPresentation(probePending ? 'checking' : driver.status)
  const detail = probePending
    ? `正在检查 ${macOS ? 'MiRemoteV 2ch 与 RC003 语音通道' : 'VB-CABLE 虚拟麦克风'}。`
    : driver.message ?? (macOS
    ? '将 RC003 语音写入 MiRemoteV 2ch；增益只作用于这一路音频。'
    : 'VB-CABLE 仅提供虚拟录音设备，Axonkey 当前不直接处理 Windows 音频流。')
  return <article className={`home-status-card home-audio-card ${presentation.tone}`}>
    <div className="home-status-card-head">
      <span className="home-status-icon"><AudioLines size={19} /></span>
      <div><h3>音频驱动</h3><span className="home-status-label"><span className="home-status-dot" />{presentation.label}</span></div>
    </div>
    <p>{detail}</p>
    <div className="home-audio-controls">
      <div className="home-audio-control-head"><label htmlFor="audio-gain">输入增益</label><strong>{gain} dB</strong></div>
      <input id="audio-gain" type="range" min={audioGainMin} max={audioGainMax} step="1" value={gain} disabled={!macOS} onChange={(event) => onGainChange(Number(event.target.value))} />
      <div className="home-audio-scale" aria-hidden="true"><span>-30 dB</span><span>0 dB</span><span>30 dB</span></div>
    </div>
    <div className="home-audio-actions">
      <button type="button" className="dialog-secondary" onClick={onRefresh}><RotateCcw size={14} /> 重新检测</button>
    </div>
  </article>
}

function driverStatusPresentation(status: SetupState['drivers']['audio']['status']): { label: string; tone: HomeStatusTone } {
  switch (status) {
    case 'installed': return { label: '已安装', tone: 'ready' }
    case 'restartRequired': return { label: '需要重启', tone: 'warning' }
    case 'checking': return { label: '检测中', tone: 'checking' }
    case 'error': return { label: '检测失败', tone: 'error' }
    case 'missing': return { label: '未安装', tone: 'warning' }
    default: return { label: '未检测', tone: 'muted' }
  }
}

export function HomeDashboard({
  platform,
  nativeRuntime,
  systemProbeState,
  permissions,
  inputAuthorizationStale,
  inputDriver,
  audioDriver,
  device,
  batteryLevel,
  audioGain,
  enabled,
  onRequestPermission,
  onRefresh,
  onAudioGainChange,
  onOpenStep,
  onOpenMapping,
}: HomeDashboardProps) {
  const macOS = platform === 'macos'
  const systemProbeLoading = nativeRuntime && systemProbeState === 'loading'
  const audioProbeLoading = nativeRuntime && (audioDriver.status === 'unknown' || audioDriver.status === 'checking')
  const inputProbeLoading = nativeRuntime && (systemProbeLoading || inputDriver.status === 'checking')
  const deviceProbeLoading = nativeRuntime && (systemProbeLoading || device.status === 'checking')
  const inputReady = !inputProbeLoading && macOS && permissions.inputMonitoring && !inputAuthorizationStale
  const inputTone: HomeStatusTone = inputProbeLoading
    ? 'checking'
    : inputAuthorizationStale || inputDriver.status === 'error'
    ? 'error'
    : inputReady || (!macOS && inputDriver.status === 'installed')
      ? 'ready'
      : inputDriver.status === 'checking' ? 'checking' : 'warning'
  const inputStatus = inputProbeLoading
    ? '检测中'
    : inputAuthorizationStale
    ? '需要重新授权'
    : inputReady || (!macOS && inputDriver.status === 'installed')
      ? '已授权'
      : macOS ? '未授权' : inputDriver.status === 'checking' ? '检测中' : '需要检查'
  const inputDetail = inputProbeLoading
    ? '正在检查输入监控与 RC003 输入服务。'
    : inputAuthorizationStale
    ? '当前构建的输入监控授权已失效，电源键、返回键等映射不会收到按键。'
    : inputDriver.message ?? (macOS ? '允许 Axonkey 读取 RC003 原始 HID 按键报告。' : '检查 OpenInputBridge 按键服务。')
  const audioPresentation = driverStatusPresentation(audioProbeLoading ? 'checking' : audioDriver.status)
  const deviceConnected = !deviceProbeLoading && device.status === 'connected'
  const deviceTone: HomeStatusTone = deviceProbeLoading ? 'checking' : deviceConnected ? 'ready' : device.status === 'checking' ? 'checking' : 'warning'
  const deviceStatus = deviceProbeLoading ? '检测中' : deviceConnected ? '已连接' : device.status === 'checking' ? '检测中' : '未连接'
  const deviceDetail = deviceProbeLoading
    ? '正在检查 RC003 蓝牙连接与输入服务。'
    : deviceConnected
    ? `${device.message ?? 'RC003 已被系统识别。'}${batteryLevel === null ? '' : ` 当前电量 ${batteryLevel}%。`}`
    : device.message ?? '请在系统蓝牙设置中配对并唤醒 RC003。'
  const accessibilityReady = !macOS || permissions.accessibility
  const accessibilityLoading = nativeRuntime && systemProbeLoading
  const allReady = !systemProbeLoading && !audioProbeLoading && !inputProbeLoading && !deviceProbeLoading && inputTone === 'ready' && accessibilityReady && audioPresentation.tone === 'ready' && deviceTone === 'ready'
  const pageLoading = systemProbeLoading || audioProbeLoading || inputProbeLoading || deviceProbeLoading

  return <div className="home-page">
    <section className={`home-summary ${pageLoading ? 'loading' : allReady ? 'ready' : 'attention'}`}>
      <div className="home-summary-icon">{pageLoading ? <LoaderCircle className="home-summary-loading-icon" size={24} /> : allReady ? <CheckCircle2 size={24} /> : <ShieldCheck size={24} />}</div>
      <div className="home-summary-copy"><span className="section-kicker">系统状态</span><h2>{pageLoading ? '正在检查运行环境' : allReady ? '运行环境已就绪' : '有项目需要处理'}</h2><p>{pageLoading ? '正在检查权限、驱动和设备连接，请稍候。' : allReady ? '权限、设备和音频通道均已检查，可以直接使用 RC003。' : inputAuthorizationStale ? '请重新授权当前 Axonkey 构建，按键映射才能恢复。' : '从下方状态卡处理缺失的权限、驱动或设备连接。'}</p></div>
      <button type="button" className="button home-refresh-button" onClick={onRefresh} disabled={pageLoading}><RotateCcw size={15} /> {pageLoading ? '检测中' : '重新检测'}</button>
    </section>

    <div className="home-status-grid">
      <HomeStatusCard
        icon={<Keyboard size={19} />}
        title="输入监控"
        status={inputStatus}
        tone={inputTone}
        detail={inputDetail}
        action={macOS
          ? <button type="button" className="dialog-secondary" onClick={() => onRequestPermission('inputMonitoring')}><ShieldCheck size={14} /> {inputAuthorizationStale ? '重新授权' : permissions.inputMonitoring ? '重新打开设置' : '开始授权'}</button>
          : <button type="button" className="dialog-secondary" onClick={() => onOpenStep('inputDriver')}><Settings2 size={14} /> 检查驱动</button>}
      />
      <HomeStatusCard
        icon={<Command size={19} />}
        title="辅助功能"
        status={accessibilityLoading ? '检测中' : macOS ? permissions.accessibility ? '已授权' : '未授权' : '系统不需要'}
        tone={accessibilityLoading ? 'checking' : macOS ? permissions.accessibility ? 'ready' : 'warning' : 'muted'}
        detail={accessibilityLoading ? '正在检查 Axonkey 是否可以发送映射后的按键、快捷键和文本。' : macOS ? '允许 Axonkey 发送映射后的按键、快捷键和文本。' : 'Windows 通过输入服务发送映射结果。'}
        action={macOS && <button type="button" className="dialog-secondary" onClick={() => onRequestPermission('accessibility')}><ShieldCheck size={14} /> {permissions.accessibility ? '重新打开设置' : '开始授权'}</button>}
      />
      <HomeAudioCard
        macOS={macOS}
        driver={audioDriver}
        probePending={audioProbeLoading}
        gain={audioGain}
        onGainChange={onAudioGainChange}
        onRefresh={onRefresh}
      />
      <HomeStatusCard
        icon={<Bluetooth size={19} />}
        title="小米遥控器 RC003"
        status={deviceStatus}
        tone={deviceTone}
        detail={deviceDetail}
        action={<button type="button" className="dialog-secondary" onClick={() => onOpenStep('deviceConnection')}><Bluetooth size={14} /> 连接设置</button>}
      />
    </div>

    <section className="home-tools">
      <div><span className="section-kicker">快捷入口</span><h2>常用入口</h2></div>
      <div className="home-tool-actions">
        <button type="button" className="home-tool-button" onClick={onOpenMapping}><Keyboard size={17} /><span><strong>按键映射</strong><small>{enabled ? '自定义功能已启用' : '自定义功能未启用'}</small></span><ChevronRight size={16} /></button>
        <button type="button" className="home-tool-button" onClick={() => onOpenStep('inputDriver')}><Settings2 size={17} /><span><strong>完整设置</strong><small>权限、驱动与设备检测</small></span><ChevronRight size={16} /></button>
      </div>
    </section>
  </div>
}
