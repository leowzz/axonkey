import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { SettingsHelp } from './SettingsHelp'

type FixStatus = { installed: boolean; configured: boolean; restartRequired: boolean; serviceState: string; exitCode: number }

export function InterceptionFixControl({ supported }: { supported: boolean }) {
  const [status, setStatus] = useState<FixStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function refresh() {
    if (!supported) return
    setBusy(true)
    setError('')
    try { setStatus(await invoke<FixStatus>('interception_fix_action', { action: 'status' })) }
    catch (cause) { setError(String(cause)); setStatus(null) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [supported])
  async function change(action: 'install' | 'uninstall') {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await invoke('interception_fix_action', { action })
      setMessage(action === 'install' ? '已安装，请重启 Windows 后测试重连。' : '已卸载启动服务，请重启 Windows 完成回滚。')
      setStatus(await invoke<FixStatus>('interception_fix_action', { action: 'status' }))
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  const label = !supported ? '仅桌面版可用' : busy ? '处理中…' : !status ? '未检测' : !status.installed ? '未安装' : !status.configured ? '配置异常' : status.restartRequired ? '等待重启' : status.exitCode !== 0 ? '服务执行异常' : '已安装'
  return <section className="settings-form-fields settings-interception-fix" aria-label="重连兼容修复">
    <div className="settings-form-row">
      <span className="settings-form-label">重连兼容修复：</span>
      <div className="settings-form-control">
        <span role="status">{label}</span>
        <button type="button" className="dialog-secondary" disabled={!supported || busy || !status || status.installed} onClick={() => void change('install')}>补装并授权</button>
        <button type="button" className="dialog-secondary" disabled={!supported || busy} onClick={() => void change('uninstall')}>卸载修复</button>
        <button type="button" className="dialog-secondary" disabled={!supported || busy} onClick={() => void refresh()}>重新检测</button>
        <SettingsHelp id="interception-fix-help" label="重连兼容修复">Windows 输入驱动的一部分，用于改善断连或睡眠后遥控器无输入。安装 Interception 时会一起安装系统启动服务，影响所有使用 Interception 的设备，需管理员授权。保留普通权限访问（lockdown=no）。安装和卸载后都需重启 Windows；不保证已失效设备能立即恢复，也不还原以前修改过的权限。卸载 Axonkey 前请先卸载输入驱动。</SettingsHelp>
      </div>
    </div>
    <p className="permission-drag-note">随 Interception 输入驱动自动安装；安装或卸载后需重启 Windows。</p>
    {message && <p role="status" className="permission-drag-note">{message}</p>}
    {error && <p role="alert" className="permission-drag-note">操作未完成：{error}</p>}
  </section>
}
