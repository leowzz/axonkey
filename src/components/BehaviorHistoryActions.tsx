import { RedoCircle, UndoCircle } from 'reicon-react'

type BehaviorHistoryActionsProps = {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

export function BehaviorHistoryActions({ canUndo, canRedo, onUndo, onRedo }: BehaviorHistoryActionsProps) {
  return (
    <div className="mapping-history-actions" role="group" aria-label="行为编辑历史">
      <button
        type="button"
        className="behavior-history-button"
        title="撤销"
        aria-label="撤销行为更改"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <UndoCircle size={15} weight="Outline" />
      </button>
      <button
        type="button"
        className="behavior-history-button"
        title="重做"
        aria-label="重做行为更改"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <RedoCircle size={15} weight="Outline" />
      </button>
    </div>
  )
}
