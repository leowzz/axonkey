import {
  AudioLines,
  BatteryMedium,
  Bluetooth,
  Check,
  CheckCircle2,
  ChevronRight,
  Command,
  Keyboard,
  LoaderCircle,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { audioGainMax, audioGainMin } from '../appConfig'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { SetupState, SetupStepId } from '../setupModel'
import type { CSSProperties, ReactNode } from 'react'

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

type HomeStatusRowProps = {
  icon: ReactNode
  title: string
  status: string
  detail: string
  tone: HomeStatusTone
  action?: ReactNode
  children?: ReactNode
}

function HomeStatusRow({ icon, title, status, detail, tone, action, children }: HomeStatusRowProps) {
  return <article className={`home-status-row ${tone}`}>
    <span className="home-status-icon">{icon}</span>
    <div className="home-status-copy">
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
    </div>
    <div className="home-status-tools">
      <span className="home-status-label"><span className="home-status-dot" />{status}</span>
      {action}
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
        : 'warning'
  const inputStatus = inputProbeLoading
    ? '检测中'
    : inputAuthorizationStale
      ? '需要重新授权'
      : inputReady || (!macOS && inputDriver.status === 'installed')
        ? '已授权'
        : macOS ? '未授权' : '需要检查'
  const inputDetail = inputProbeLoading
    ? '正在检查输入监控与 RC003 输入服务。'
    : inputAuthorizationStale
      ? '当前构建的输入监控授权已失效，按键映射暂时不会生效。'
      : inputDriver.message ?? (macOS ? '读取 RC003 原始 HID 按键报告。' : '检查 OpenInputBridge 按键服务。')
  const audioPresentation = driverStatusPresentation(audioProbeLoading ? 'checking' : audioDriver.status)
  const audioDetail = audioProbeLoading
    ? `正在检查 ${macOS ? 'MiRemoteV 2ch 与 RC003 语音通道' : 'VB-CABLE 虚拟麦克风'}。`
    : audioDriver.message ?? (macOS
      ? '将 RC003 语音写入 MiRemoteV 2ch，增益仅作用于这一路音频。'
      : 'VB-CABLE 提供虚拟录音设备，Axonkey 不直接处理 Windows 音频流。')
  const deviceConnected = !deviceProbeLoading && device.status === 'connected'
  const deviceTone: HomeStatusTone = deviceProbeLoading ? 'checking' : deviceConnected ? 'ready' : 'warning'
  const deviceStatus = deviceProbeLoading ? '检测中' : deviceConnected ? '已连接' : '未连接'
  const deviceDetail = deviceProbeLoading
    ? '正在检查 RC003 蓝牙连接与输入服务。'
    : deviceConnected
      ? device.message ?? 'RC003 已被系统识别，可以接收按键。'
      : device.message ?? '请在系统蓝牙设置中配对并唤醒 RC003。'
  const accessibilityLoading = nativeRuntime && systemProbeLoading
  const accessibilityTone: HomeStatusTone = accessibilityLoading
    ? 'checking'
    : macOS ? permissions.accessibility ? 'ready' : 'warning' : 'muted'
  const accessibilityStatus = accessibilityLoading
    ? '检测中'
    : macOS ? permissions.accessibility ? '已授权' : '未授权' : '系统不需要'
  const allReady = !systemProbeLoading
    && !audioProbeLoading
    && !inputProbeLoading
    && !deviceProbeLoading
    && inputTone === 'ready'
    && accessibilityTone !== 'warning'
    && audioPresentation.tone === 'ready'
    && deviceTone === 'ready'
  const pageLoading = systemProbeLoading || audioProbeLoading || inputProbeLoading || deviceProbeLoading
  const readyCount = [inputTone, accessibilityTone, audioPresentation.tone, deviceTone]
    .filter((tone) => tone === 'ready' || tone === 'muted').length
  const heroTone: HomeStatusTone = pageLoading ? 'checking' : allReady ? 'ready' : inputAuthorizationStale ? 'error' : 'warning'
  const heroTitle = pageLoading
    ? '正在检查 RC003'
    : allReady
      ? 'RC003 已就绪'
      : inputAuthorizationStale
        ? '需要重新授权'
        : deviceConnected ? '完成设置即可使用' : '等待 RC003 连接'
  const heroDescription = pageLoading
    ? '正在确认权限、音频通道和设备连接。'
    : allReady
      ? '按键、语音和系统权限均已就绪。现在可以直接编辑遥控器行为。'
      : inputAuthorizationStale
        ? '当前应用身份没有有效的输入监控权限，请先完成授权。'
        : deviceConnected
          ? '设备已连接，处理剩余系统项目后即可开始使用。'
          : '唤醒遥控器或打开连接设置，Axonkey 会自动刷新状态。'
  const recommendedStep: SetupStepId = inputTone !== 'ready' || accessibilityTone === 'warning' || audioPresentation.tone !== 'ready'
    ? 'inputDriver'
    : 'deviceConnection'
  const audioGainProgress = ((audioGain - audioGainMin) / (audioGainMax - audioGainMin)) * 100
  const audioGainStyle = { '--home-audio-progress': `${audioGainProgress}%` } as CSSProperties

  return <div className="home-page">
    <section className={`home-hero ${heroTone}`} aria-labelledby="home-device-title">
      <div className="home-hero-copy">
        <div className="home-eyebrow"><span className="home-state-mark" /> RC003 CONTROL SURFACE</div>
        <h2 id="home-device-title">{heroTitle}</h2>
        <p>{heroDescription}</p>
        <div className="home-hero-actions">
          <button type="button" className="home-primary-action" onClick={onOpenMapping}>
            <Keyboard size={16} /> 编辑按键映射 <ChevronRight size={15} />
          </button>
          <button type="button" className="home-secondary-action" onClick={() => onOpenStep(recommendedStep)}>
            <Settings2 size={15} /> {allReady ? '完整设置' : '处理待办'}
          </button>
          <button type="button" className="home-icon-action" aria-label={pageLoading ? '检测中' : '重新检测'} title={pageLoading ? '检测中' : '重新检测'} onClick={onRefresh} disabled={pageLoading}>
            <RotateCcw className={pageLoading ? 'home-summary-loading-icon' : ''} size={15} />
          </button>
        </div>
      </div>

      <div className="home-device-visual" aria-label={`小米 RC003 ${deviceStatus}`}>
        <div className="home-device-model"><span>MI</span><strong>RC003</strong></div>
        <img src="/rc003-remote-cutout.png" alt="小米 RC003 蓝牙遥控器" />
        <div className="home-device-telemetry">
          <span><span className={`home-status-dot ${deviceTone}`} />{deviceStatus}</span>
          <span className="home-device-divider" />
          <span><BatteryMedium size={14} />{batteryLevel === null ? '电量未知' : `${batteryLevel}%`}</span>
        </div>
      </div>
    </section>

    <div className="home-content-grid">
      <section className="home-health" aria-labelledby="home-health-title">
        <header className="home-section-head">
          <h2 id="home-health-title">运行检查</h2>
          <span className="home-check-count"><strong>{readyCount}</strong> / 4 就绪</span>
        </header>

        <div className="home-status-list">
          <HomeStatusRow
            icon={<Keyboard size={18} />}
            title="输入监控"
            status={inputStatus}
            tone={inputTone}
            detail={inputDetail}
            action={macOS
              ? <button type="button" className="home-row-action" onClick={() => onRequestPermission('inputMonitoring')}>{inputAuthorizationStale ? '重新授权' : permissions.inputMonitoring ? '打开设置' : '开始授权'}<ChevronRight size={13} /></button>
              : <button type="button" className="home-row-action" onClick={() => onOpenStep('inputDriver')}>检查驱动<ChevronRight size={13} /></button>}
          />
          <HomeStatusRow
            icon={<Command size={18} />}
            title="辅助功能"
            status={accessibilityStatus}
            tone={accessibilityTone}
            detail={accessibilityLoading ? '正在检查系统是否允许 Axonkey 发送映射后的输入。' : macOS ? '发送映射后的按键、快捷键和文本。' : 'Windows 通过输入服务发送映射结果。'}
            action={macOS && <button type="button" className="home-row-action" onClick={() => onRequestPermission('accessibility')}>{permissions.accessibility ? '打开设置' : '开始授权'}<ChevronRight size={13} /></button>}
          />
          <HomeStatusRow
            icon={<AudioLines size={18} />}
            title="语音通道"
            status={audioPresentation.label}
            tone={audioPresentation.tone}
            detail={audioDetail}
            action={<button type="button" className="home-row-action" onClick={() => onOpenStep('inputDriver')}>音频设置<ChevronRight size={13} /></button>}
          >
            <div className="home-audio-control">
              <label htmlFor="audio-gain">输入增益</label>
              <input id="audio-gain" type="range" min={audioGainMin} max={audioGainMax} step="1" value={audioGain} style={audioGainStyle} disabled={!macOS} onChange={(event) => onAudioGainChange(Number(event.target.value))} />
              <strong>{audioGain} dB</strong>
            </div>
          </HomeStatusRow>
          <HomeStatusRow
            icon={<Bluetooth size={18} />}
            title="设备连接"
            status={deviceStatus}
            tone={deviceTone}
            detail={deviceDetail}
            action={<button type="button" className="home-row-action" onClick={() => onOpenStep('deviceConnection')}>连接设置<ChevronRight size={13} /></button>}
          />
        </div>
      </section>

      <aside className="home-sidebar" aria-label="快捷操作">
        <section className="home-quick-actions">
          <h2>快捷操作</h2>
          <button type="button" className="home-quick-button" onClick={onOpenMapping}>
            <span className="home-quick-icon"><Keyboard size={17} /></span>
            <span><strong>按键映射</strong><small>{enabled ? '自定义功能已启用' : '自定义功能未启用'}</small></span>
            <ChevronRight size={15} />
          </button>
          <button type="button" className="home-quick-button" onClick={() => onOpenStep('inputDriver')}>
            <span className="home-quick-icon"><ShieldCheck size={17} /></span>
            <span><strong>系统设置</strong><small>权限、驱动与音频</small></span>
            <ChevronRight size={15} />
          </button>
          <button type="button" className="home-quick-button" onClick={onRefresh} disabled={pageLoading}>
            <span className="home-quick-icon">{pageLoading ? <LoaderCircle className="home-summary-loading-icon" size={17} /> : <CheckCircle2 size={17} />}</span>
            <span><strong>{pageLoading ? '正在检测' : '运行检测'}</strong><small>刷新所有本机状态</small></span>
            <ChevronRight size={15} />
          </button>
        </section>

        <div className="home-local-note">
          <Check size={15} />
          <div><strong>数据只保存在本机</strong><span>映射和诊断信息不会上传。</span></div>
        </div>
      </aside>
    </div>
  </div>
}
