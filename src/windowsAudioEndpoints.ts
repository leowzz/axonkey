import type { AudioProbe, WindowsAudioEndpoint, WindowsAudioOutput } from './appTypes'

export type AudioOutputPresentation = {
  label: string
  detail: string
  tone: 'ready' | 'warning' | 'error' | 'checking' | 'muted'
}

export function windowsOutputPresentation(output?: WindowsAudioOutput | null): AudioOutputPresentation {
  if (!output) return { label: '未检测', detail: '尚未取得音频设备状态，请重新检测。', tone: 'muted' }
  const name = output.selectedEndpointName || '已选择的播放端'
  const states: Record<WindowsAudioOutput['state'], AudioOutputPresentation> = {
    selectionRequired: { label: '需要选择设备', detail: '请选择虚拟音频播放端，应用会按设备 ID 记住选择。', tone: 'warning' },
    adapterMissing: { label: '未发现设备', detail: '未发现受支持的虚拟音频设备。请检查设备或安装 VB-CABLE 后重新检测。', tone: 'warning' },
    enumerationFailed: { label: '检测失败', detail: '无法读取音频设备信息，请重新检测。', tone: 'error' },
    endpointDisabled: { label: '设备已禁用', detail: `「${name}」已禁用，请在 Windows 声音设置中启用。`, tone: 'warning' },
    endpointUnavailable: { label: '设备不可用', detail: `「${name}」已断开或设备 ID 已失效，请等待恢复或重新选择。`, tone: 'warning' },
    unsupportedFormat: { label: '格式不支持', detail: `「${name}」不支持所需音频格式，请检查声音设置或重新选择。`, tone: 'error' },
    openFailed: { label: '打开失败', detail: `无法打开「${name}」，请检查设备占用或重新选择。`, tone: 'error' },
    configError: { label: '配置失败', detail: '音频设备绑定无法读取或保存，请处理错误后重试。', tone: 'error' },
    switching: { label: '正在切换', detail: '正在验证设备并打开音频流，请稍候。', tone: 'checking' },
    ready: { label: '输出已就绪', detail: `语音播放端：${name}。`, tone: 'ready' },
  }
  // The native response can transiently omit state, or introduce a newer value.
  // Treat unrecognized data as unknown rather than claiming the route is ready.
  const result: AudioOutputPresentation = Object.prototype.hasOwnProperty.call(states, output.state)
    ? states[output.state]
    : { label: '状态未知', detail: '尚无法确认语音播放端状态，请重新检测。', tone: 'warning' }
  return output.error ? { ...result, detail: `${result.detail} ${output.error}` } : result
}

export function windowsAudioPresentation(probe?: AudioProbe | null): AudioOutputPresentation {
  const output = windowsOutputPresentation(probe?.output)
  if (probe?.output?.state !== 'ready') return output
  if (probe.error) return { label: '语音连接异常', detail: `${output.detail} ${probe.error}`, tone: 'error' }
  if (!probe.bluetoothConnected) return { label: '等待遥控器', detail: `${output.detail} 请唤醒遥控器并连接语音通道。`, tone: 'warning' }
  if (probe.forwarding) return { label: '正在转发', detail: `正在将遥控器语音转发到「${probe.output.selectedEndpointName || '已选择的播放端'}」。`, tone: 'ready' }
  return { label: '已就绪', detail: `${output.detail} 按住语音键开始讲话。`, tone: 'ready' }
}

export function audioTestReady(platform: string, probe?: AudioProbe | null) {
  return !!probe && !probe.error && probe.bluetoothConnected
    && (platform === 'windows' ? probe.output?.state === 'ready' : probe.driverInstalled)
}

export function endpointOptionLabel(endpoint: WindowsAudioEndpoint) {
  const state = { active: '', disabled: ' · 已禁用', unplugged: ' · 已断开', notPresent: ' · 不在场' }[endpoint.state]
  // Names and channel counts are display-only, never selection criteria.
  return `${endpoint.name || '未命名设备'} · ${endpoint.id.slice(-13)}${state}`
}

export function captureEndpointsFor(endpoints: WindowsAudioEndpoint[], renderId: string) {
  const render = endpoints.find((endpoint) => endpoint.id === renderId && endpoint.direction === 'render')
  return render ? endpoints.filter((endpoint) => endpoint.direction === 'capture' && endpoint.adapterId === render.adapterId) : []
}
