import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Search, Trash2, X } from 'lucide-react'
import { Vector } from 'sequential-workflow-designer'
import type { DesignerApi, StepDefinition, ToolboxGroupConfiguration } from 'sequential-workflow-designer'

export type WorkflowToolboxPalette = {
  name: string
  groups: ToolboxGroupConfiguration[]
}

export function WorkflowToolbox({
  api,
  palettes,
  iconUrls,
  selectedCategory,
  onCategoryChange,
  onAddStep,
  addLabel,
  getStepPreview,
  onRemoveSavedSequence,
  savedError,
}: {
  api: DesignerApi
  palettes: WorkflowToolboxPalette[]
  iconUrls: Record<string, string>
  selectedCategory: string
  onCategoryChange: (category: string) => void
  onAddStep: (step: StepDefinition) => void
  addLabel: string
  getStepPreview: (step: StepDefinition) => string[]
  onRemoveSavedSequence?: (id: string) => void
  savedError?: string
}) {
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<StepDefinition | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dragOrigin = useRef({ x: 0, y: 0 })
  const previewTitleId = useId()
  useEffect(() => setQuery(''), [selectedCategory])
  useEffect(() => {
    if (preview) dialogRef.current?.showModal()
  }, [preview])
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [query, selectedCategory])

  const filter = query.trim().toLocaleLowerCase()
  const mine = selectedCategory === '已保存/已保存'
  const categories = palettes
    .filter(palette => palette.name !== '已保存')
    .flatMap(palette =>
      palette.groups.map(group => ({
        id: `${palette.name}/${group.name}`,
        palette: palette.name,
        ...group,
      })),
    )
    .filter(group => group.steps.length > 0)
  const currentCategory = categories.some(group => group.id === selectedCategory) ? selectedCategory : 'all'
  const groups = mine
    ? palettes
        .filter(palette => palette.name === '已保存')
        .flatMap(palette => palette.groups.map(group => ({ ...group, id: '已保存/已保存', palette: '我的' })))
    : categories
  const visibleGroups = groups
    .filter(group => mine || filter || currentCategory === 'all' || group.id === currentCategory)
    .map(group => ({
      ...group,
      steps: group.steps.filter(step =>
        `${group.palette} ${group.name} ${step.name} ${step.properties.description ?? ''}`
          .toLocaleLowerCase()
          .includes(filter),
      ),
    }))
    .filter(group => group.steps.length > 0)

  return (
    <>
      <h2 className="workflow-toolbox-title">行为库</h2>
      <div className="workflow-toolbox-search sqd-toolbox-filter">
        <label className="workflow-toolbox-search-field">
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <input
            className="sqd-toolbox-filter-input"
            type="search"
            aria-label={mine ? '搜索我的行为' : '搜索基础行为'}
            placeholder={mine ? '搜索我的行为' : '搜索基础行为'}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
      </div>
      <nav className="workflow-toolbox-tabs" aria-label="行为来源">
        <button
          type="button"
          aria-pressed={!mine}
          onClick={() => {
            setQuery('')
            onCategoryChange('all')
          }}
        >
          基础
        </button>
        <button
          type="button"
          aria-pressed={mine}
          onClick={() => {
            setQuery('')
            onCategoryChange('已保存/已保存')
          }}
        >
          我的
        </button>
      </nav>
      {!mine && (
        <nav className="workflow-toolbox-categories" aria-label="行为分类">
          <button
            type="button"
            aria-pressed={!filter && currentCategory === 'all'}
            onClick={() => {
              setQuery('')
              onCategoryChange('all')
            }}
          >
            全部
          </button>
          {categories.map(group => (
            <button
              type="button"
              key={group.id}
              aria-pressed={!filter && currentCategory === group.id}
              onClick={() => {
                setQuery('')
                onCategoryChange(group.id)
              }}
            >
              {group.name}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={listRef}
        className="workflow-toolbox-list"
        aria-label={filter ? '行为搜索结果' : mine ? '我的行为' : '基础行为'}
      >
        {mine && savedError ? (
          <p className="workflow-toolbox-empty" role="alert">
            {savedError}
          </p>
        ) : (
          <>
            {visibleGroups.map(group => (
              <section key={group.id} aria-label={group.name}>
                {!mine && (currentCategory === 'all' || filter) && (
                  <h3 className="sqd-toolbox-group-title">{group.name}</h3>
                )}
                {group.steps.map(step => (
                  <div
                    key={String(step.properties.savedSequenceId ?? step.type)}
                    className={`sqd-toolbox-item sqd-type-${step.type}`}
                  >
                    <button
                      type="button"
                      className="workflow-toolbox-item-main"
                      aria-label={`查看${step.name}`}
                      onMouseDown={event => {
                        if (event.button !== 0) return
                        dragOrigin.current = { x: event.clientX, y: event.clientY }
                        event.preventDefault()
                        event.stopPropagation()
                        api.toolbox.tryDrag(new Vector(event.clientX, event.clientY), step)
                      }}
                      onTouchStart={event => {
                        if (event.touches.length !== 1) return
                        event.stopPropagation()
                        const touch = event.touches[0]
                        dragOrigin.current = { x: touch.clientX, y: touch.clientY }
                        api.toolbox.tryDrag(new Vector(touch.clientX, touch.clientY), step)
                      }}
                      onClick={event => {
                        if (
                          event.detail === 0 ||
                          Math.hypot(event.clientX - dragOrigin.current.x, event.clientY - dragOrigin.current.y) < 5
                        )
                          setPreview(step)
                      }}
                    >
                      <span className="sqd-toolbox-item-icon">
                        <img
                          className="sqd-toolbox-item-icon-image"
                          src={iconUrls[step.type]}
                          alt=""
                          draggable={false}
                        />
                      </span>
                      <span className="sqd-toolbox-item-text">{step.name}</span>
                    </button>
                    <button
                      type="button"
                      className="workflow-toolbox-add"
                      aria-label={`${addLabel}：${step.name}`}
                      title={addLabel}
                      onClick={() => onAddStep(step)}
                    >
                      <Plus size={15} aria-hidden="true" />
                    </button>
                    {typeof step.properties.savedSequenceId === 'string' && onRemoveSavedSequence && (
                      <button
                        type="button"
                        className="icon-button workflow-saved-remove"
                        aria-label={`删除已保存的${step.name}`}
                        title="删除"
                        onClick={() => onRemoveSavedSequence(step.properties.savedSequenceId as string)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {visibleGroups.length === 0 && (
              <p className="workflow-toolbox-empty">{mine && !filter ? '暂无已保存的行为序列' : '没有匹配的行为'}</p>
            )}
          </>
        )}
      </div>
      {preview &&
        createPortal(
          <dialog
            ref={dialogRef}
            className="behavior-dialog workflow-library-dialog"
            aria-labelledby={previewTitleId}
            onCancel={() => setPreview(null)}
          >
            <header className="behavior-dialog-head">
              <h2 id={previewTitleId}>{preview.name}</h2>
              <button type="button" className="dialog-close" aria-label="关闭行为详情" onClick={() => setPreview(null)}>
                <X size={17} />
              </button>
            </header>
            <div className="behavior-dialog-body">
              {typeof preview.properties.description === 'string' && preview.properties.description && (
                <p className="workflow-library-description">{preview.properties.description}</p>
              )}
              <ol className="workflow-library-steps">
                {getStepPreview(preview).map((description, index) => (
                  <li key={index}>{description}</li>
                ))}
              </ol>
            </div>
            <footer className="behavior-dialog-actions">
              <span>
                {typeof preview.properties.savedSequenceId === 'string'
                  ? '添加副本，不改变已保存的序列'
                  : '添加后可编辑行为参数'}
              </span>
              <div className="behavior-dialog-buttons">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    onAddStep(preview)
                    setPreview(null)
                  }}
                >
                  {addLabel}
                </button>
              </div>
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  )
}
