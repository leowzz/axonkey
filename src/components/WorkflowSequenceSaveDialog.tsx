import { useState } from 'react'
import { X } from 'lucide-react'

export function WorkflowSequenceSaveDialog({ initialName, onClose, onSave }: {
  initialName: string
  onClose: () => void
  onSave: (name: string) => string | null
}) {
  const [name, setName] = useState(initialName.slice(0, 40))
  const [error, setError] = useState('')
  return <div className="behavior-dialog-backdrop workflow-step-editor" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <form className="behavior-dialog" role="dialog" aria-modal="true" aria-labelledby="save-sequence-title" onSubmit={(event) => {
      event.preventDefault()
      if (name.trim()) setError(onSave(name.trim()) ?? '')
    }}>
      <header className="behavior-dialog-head">
        <h2 id="save-sequence-title">另存序列</h2>
        <button type="button" className="dialog-close" aria-label="关闭另存" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        <div className="behavior-dialog-field">
          <label htmlFor="saved-sequence-name">行为名称</label>
          <input id="saved-sequence-name" autoFocus maxLength={40} value={name} onFocus={(event) => event.target.select()} onChange={(event) => { setName(event.target.value); setError('') }} aria-describedby={error ? 'saved-sequence-error' : undefined} />
          {error && <p id="saved-sequence-error" className="behavior-launch-error" role="alert">{error}</p>}
        </div>
      </div>
      <footer className="behavior-dialog-actions">
        <span>保存后可从行为库拖入其他泳道</span>
        <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!name.trim()}>保存</button></div>
      </footer>
    </form>
  </div>
}
