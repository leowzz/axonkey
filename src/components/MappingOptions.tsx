import { Download, MoreHorizontal, RotateCcw, SlidersHorizontal, Upload } from 'lucide-react'
import { useEffect, useRef } from 'react'

type MappingOptionsProps = {
  onImport: () => void
  onExport: () => void
  onReset: () => void
  flowEditor: boolean
  onFlowEditorChange: (enabled: boolean) => void
  audioCalibration?: { disabled: boolean; onOpen: () => void }
}

export function MappingOptions({ onImport, onExport, onReset, flowEditor, onFlowEditorChange, audioCalibration }: MappingOptionsProps) {
  const menuRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  return <details ref={menuRef} className="mapping-options"
    onBlur={(event) => {
      // Clicking a label or a non-focusing control can blur the summary before click.
      // Pointer dismissal is handled outside the menu; only close for known focus moves.
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.currentTarget.open = false
        event.currentTarget.querySelector('summary')?.focus()
      }
    }}>
    <summary aria-label="更多映射操作" title="更多映射操作"><MoreHorizontal size={19} /></summary>
    <div className="mapping-options-menu">
      <button type="button" onClick={onImport}><Download size={15} /> 导入配置</button>
      <button type="button" onClick={onExport}><Upload size={15} /> 导出配置</button>
      <button type="button" onClick={onReset}><RotateCcw size={15} /> 恢复默认映射</button>
      {audioCalibration && <button type="button" disabled={audioCalibration.disabled} title={audioCalibration.disabled ? '请在桌面应用中校准音量' : undefined} onClick={audioCalibration.disabled ? undefined : () => {
        if (menuRef.current) menuRef.current.open = false
        audioCalibration.onOpen()
      }}><SlidersHorizontal size={15} /> 校准音量</button>}
      <label><input type="checkbox" checked={flowEditor} onChange={(event) => onFlowEditorChange(event.target.checked)} /> 启用新编辑器</label>
    </div>
  </details>
}
