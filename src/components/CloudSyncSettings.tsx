import { useEffect, useState } from 'react'
import type { CloudSyncController } from '../cloud/useCloudSync'
import { SettingsHelp } from './SettingsHelp'
import './CloudSyncSettings.css'

export function CloudSyncSettings({ cloud }: { cloud: CloudSyncController }) {
  const [channel, setChannel] = useState<'email' | 'sms'>('email')
  const [targets, setTargets] = useState({ email: '', sms: '' })
  const target = targets[channel]
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [codeSent, setCodeSent] = useState<{ channel: 'email' | 'sms'; target: string } | null>(null)
  useEffect(() => {
    if (!cooldown) return
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])
  return (
    <div className="cloud-settings">
      <h3 className="settings-section-title">账号与同步</h3>
      <p className="cloud-local-note">无需登录即可使用全部本地功能。</p>
      {!cloud.user ? (
        <form
          className="settings-form-fields"
          onSubmit={event => {
            event.preventDefault()
            void cloud.login(channel, target, code)
          }}
        >
          <div className="settings-form-row">
            <span className="settings-form-label" id="cloud-channel-label">
              登录方式：
            </span>
            <div className="settings-form-control">
              <div className="cloud-login-methods" role="group" aria-labelledby="cloud-channel-label">
                {(['email', 'sms'] as const).map(method => (
                  <button
                    key={method}
                    type="button"
                    aria-pressed={channel === method}
                    disabled={cloud.busy}
                    onClick={() => {
                      if (channel === method) return
                      setChannel(method)
                      setCode('')
                      cloud.clearFeedback()
                    }}
                  >
                    {method === 'email' ? '邮箱登录' : '手机登录'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="cloud-target">
              {channel === 'email' ? '邮箱：' : '手机号：'}
            </label>
            <div className="settings-form-control">
              <input
                id="cloud-target"
                type={channel === 'email' ? 'email' : 'tel'}
                autoComplete={channel === 'email' ? 'email' : 'tel'}
                placeholder={channel === 'email' ? 'name@example.com' : '中国大陆手机号'}
                required
                value={target}
                disabled={cloud.busy}
                onChange={event => {
                  setTargets(current => ({ ...current, [channel]: event.target.value }))
                  setCode('')
                  cloud.clearFeedback()
                }}
              />
            </div>
          </div>
          <div className="settings-form-row cloud-code-row">
            <label className="settings-form-label" htmlFor="cloud-code">
              验证码：
            </label>
            <div className="cloud-code-field">
              <div className="settings-form-control">
                <input
                  id="cloud-code"
                  className="cloud-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  disabled={cloud.busy}
                  onChange={event => setCode(event.target.value)}
                />
                <button
                  type="button"
                  className="dialog-secondary"
                  disabled={cloud.busy || cooldown > 0 || !target.trim()}
                  onClick={() =>
                    void cloud.sendCode(channel, target, seconds => {
                      setCooldown(seconds)
                      setCodeSent({ channel, target })
                    })
                  }
                >
                  {cooldown > 0 ? `${cooldown} 秒后重发` : '获取验证码'}
                </button>
              </div>
              <p className="cloud-code-status" role="status">
                {codeSent?.channel === channel && codeSent.target === target ? '验证码已发送' : ''}
              </p>
            </div>
          </div>
          <div className="settings-form-row">
            <span />
            <div className="settings-form-control">
              <button
                type="submit"
                className="button primary"
                disabled={cloud.busy || !target.trim() || !/^\d{6}$/.test(code)}
              >
                {cloud.busy ? '处理中…' : '登录'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="settings-form-fields">
          <div className="settings-form-row">
            <span className="settings-form-label">当前账号：</span>
            <div className="settings-form-control">
              <span className="cloud-account">{cloud.user.email || cloud.user.phone}</span>
              <button
                className="dialog-secondary"
                type="button"
                disabled={cloud.busy}
                onClick={() => void cloud.logout()}
              >
                退出登录
              </button>
            </div>
          </div>
          <div className="settings-form-row">
            <span className="settings-form-label">自动同步：</span>
            <div className="settings-form-control">
              <label>
                <input
                  type="checkbox"
                  checked={cloud.autoSync}
                  disabled={cloud.busy}
                  onChange={event => cloud.setAutoSync(event.target.checked)}
                />
                将本机修改同步到云端
              </label>
              <SettingsHelp id="cloud-sync-help" label="自动同步说明">
                登录不会自动上传。开启后同步设备配置、鼠标映射、个人行为库和软件设置；不上传实物绑定、驱动和系统权限。本机删除设备不会删除云端备份。云端配置需要手动恢复。
              </SettingsHelp>
            </div>
          </div>
          <div className="settings-form-row">
            <span className="settings-form-label">云端配置：</span>
            <div className="settings-form-control">
              <button
                type="button"
                className="button primary"
                disabled={cloud.busy || !cloud.ready}
                onClick={() => void cloud.sync()}
              >
                同步一次
              </button>
              <button
                type="button"
                className="dialog-secondary"
                disabled={cloud.busy || !cloud.ready}
                onClick={() => void cloud.fetchRestore()}
              >
                从云端恢复
              </button>
            </div>
          </div>
          <div className="settings-form-row">
            <span className="settings-form-label">最近同步：</span>
            <div className="settings-form-control">
              {cloud.busy ? '处理中…' : cloud.lastSync ? new Date(cloud.lastSync).toLocaleString() : '尚未同步'}
            </div>
          </div>
        </div>
      )}
      {(cloud.error || cloud.message || cloud.conflict || cloud.pendingRestore) && (
        <div className="settings-form-fields cloud-feedback">
          <div className="settings-form-row">
            <span />
            <div className="cloud-feedback-content">
              {cloud.error && (
                <p className="cloud-error" role="alert">
                  {cloud.error}
                </p>
              )}
              {cloud.message && (
                <p className="cloud-message" role="status">
                  {cloud.message}
                </p>
              )}
              {cloud.conflict && cloud.user && !cloud.pendingRestore && (
                <div className="cloud-confirm" role="region" aria-label="选择同步配置">
                  <p>
                    {cloud.conflict === 'initial'
                      ? '首次同步，云端已有配置。请选择使用哪一份。'
                      : '云端配置已更新。请选择使用哪一份。'}
                  </p>
                  <p>使用本机配置会更新云端对应配置，无法撤销。</p>
                  <div className="cloud-confirm-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={cloud.busy}
                      onClick={() => void cloud.sync(true)}
                    >
                      使用本机配置并同步
                    </button>
                    <button
                      type="button"
                      className="dialog-secondary"
                      disabled={cloud.busy}
                      onClick={() => void cloud.fetchRestore()}
                    >
                      从云端恢复
                    </button>
                  </div>
                </div>
              )}
              {cloud.pendingRestore && (
                <div className="cloud-confirm" role="region" aria-label="确认恢复云端配置">
                  <p>
                    将恢复 {cloud.pendingRestore.documents.length} 份设备配置
                    {cloud.pendingRestore.settings ? '及软件设置' : ''}
                    ，覆盖本机对应实例的配置，无法撤销。新设备需重新绑定实物。
                  </p>
                  <div className="cloud-confirm-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={cloud.busy}
                      onClick={() => void cloud.confirmRestore()}
                    >
                      确认恢复到本机
                    </button>
                    <button
                      type="button"
                      className="dialog-secondary"
                      disabled={cloud.busy}
                      onClick={cloud.cancelRestore}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
