import { useContext, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Platform } from '../appTypes'
import type { SavedSequence } from '../savedSequences'
import { BehaviorLibraryContext } from '../cloud/BehaviorLibraryContext'
import { findSharedSequence, submitSequence, withdrawSequence } from '../cloud/behaviorLibrary'
import type { SharedSequence } from '../cloud/behaviorLibrary'

export function BehaviorShareDialog({
  sequence,
  platform,
  preview,
  onClose,
}: {
  sequence: SavedSequence
  platform: Platform
  preview: string[]
  onClose: () => void
}) {
  const account = useContext(BehaviorLibraryContext)!
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [item, setItem] = useState<SharedSequence | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let active = true
    setLoading(true)
    setLoaded(false)
    setError('')
    if (!account.userId || !account.accountReady) {
      setLoading(false)
      return
    }
    void findSharedSequence(account.client, sequence.id)
      .then(value => {
        if (active) {
          setItem(value)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (active) setError('无法读取分享状态，请重试')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [account.client, account.userId, account.accountReady, sequence.id, attempt])

  async function run(action: () => Promise<SharedSequence>) {
    setBusy(true)
    setError('')
    try {
      setItem(await action())
    } catch (error) {
      setError(error instanceof Error ? error.message : '提交失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  const pending = item?.latest_version.status === 'pending'
  const status =
    item?.status === 'blocked'
      ? '已下架'
      : pending
        ? item?.published_version_id
          ? '新版待审核 · 旧版仍公开'
          : '待审核'
        : item?.published_version_id
          ? '已公开'
          : item?.latest_version.status === 'rejected'
            ? '未通过审核'
            : item
              ? '已撤回'
              : ''

  return (
    <dialog
      ref={dialog}
      className="behavior-dialog workflow-library-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        if (busy) event.preventDefault()
        else onClose()
      }}
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          if (!busy && loaded && !pending)
            void run(() =>
              submitSequence(
                account.client,
                sequence,
                platform,
                note,
                !!item && (!item.published_version_id || item.latest_version.status !== 'approved'),
              ),
            )
        }}
      >
        <header className="behavior-dialog-head">
          <h2 id={titleId}>分享「{sequence.name}」</h2>
          <button type="button" className="dialog-close" aria-label="关闭分享" disabled={busy} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="behavior-dialog-body">
          <p className="workflow-library-description">
            审核通过后公开到社区。请确认下列内容不含私密文本或个人路径。适用于
            {platform === 'macos' ? ' macOS' : ' Windows'}。
          </p>
          <ol className="workflow-library-steps">
            {preview.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ol>
          {status && (
            <p role="status" className="workflow-share-status">
              {status}
            </p>
          )}
          {(item?.block_reason || item?.latest_version.review_note) && (
            <p className="workflow-share-status">{item.block_reason || item.latest_version.review_note}</p>
          )}
          {!pending && (
            <details className="workflow-share-note" open>
              <summary>备注（可选）</summary>
              <textarea
                aria-label="分享备注"
                maxLength={1000}
                value={note}
                disabled={busy}
                onChange={event => setNote(event.target.value)}
              />
            </details>
          )}
          {loading && <p role="status">正在读取分享状态…</p>}
          {error && (
            <p className="behavior-launch-error" role="alert">
              {error}{' '}
              <button
                type="button"
                className="dialog-secondary"
                disabled={busy}
                onClick={() => retry(value => value + 1)}
              >
                重新读取
              </button>
            </p>
          )}
        </div>
        <footer className="behavior-dialog-actions">
          <div className="behavior-dialog-buttons">
            {!account.userId ? (
              <button
                type="button"
                className="button primary"
                disabled={!account.accountReady}
                onClick={account.onLogin}
              >
                登录后分享
              </button>
            ) : (
              <>
                {pending && (
                  <button
                    type="button"
                    className="dialog-secondary"
                    disabled={busy || !loaded}
                    onClick={() => void run(() => withdrawSequence(account.client, item!, false))}
                  >
                    撤回申请
                  </button>
                )}
                {item?.published_version_id && (
                  <button
                    type="button"
                    className="dialog-secondary"
                    disabled={busy || !loaded}
                    onClick={() => void run(() => withdrawSequence(account.client, item, true))}
                  >
                    取消公开
                  </button>
                )}
                {!pending && (
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy || !loaded || item?.status === 'blocked'}
                  >
                    {busy ? '提交中…' : item ? '重新提交审核' : '确认提交'}
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </form>
    </dialog>
  )
}
