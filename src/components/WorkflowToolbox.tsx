import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Plus, Search, Share2, Star, Trash2, X } from 'lucide-react'
import { Vector } from 'sequential-workflow-designer'
import type { DesignerApi, StepDefinition, ToolboxGroupConfiguration } from 'sequential-workflow-designer'

import type { Platform } from '../appTypes'
import { BehaviorLibraryContext } from '../cloud/BehaviorLibraryContext'
import { useBehaviorLibrary } from '../cloud/useBehaviorLibrary'
import { useLibraryRecommendations } from '../cloud/useLibraryRecommendations'
import { BehaviorShareDialog } from './BehaviorShareDialog'

export type WorkflowToolboxPalette = {
  name: string
  groups: ToolboxGroupConfiguration[]
}

const builtInSourceLabel = '内置'

const categoryCodes: Record<string, string> = {
  键盘: 'keyboard',
  鼠标: 'mouse',
  媒体: 'media',
  媒体控制: 'media',
  文本: 'text',
  系统与命令: 'system',
  流程控制: 'control',
  控制: 'control',
  常用行为: 'common',
  组合行为: 'composite',
}

export function WorkflowToolbox({
  api,
  platform = 'windows',
  palettes,
  iconUrls,
  selectedCategory,
  onCategoryChange,
  onAddStep,
  onStepPointerDown,
  allowStep,
  addLabel,
  getStepPreview,
  onRemoveSavedSequence,
  savedError,
}: {
  api: DesignerApi | null
  platform?: Platform
  palettes: WorkflowToolboxPalette[]
  iconUrls: Record<string, string>
  selectedCategory: string
  onCategoryChange: (category: string) => void
  onAddStep: (step: StepDefinition, keyboard?: boolean) => void
  onStepPointerDown?: (event: PointerEvent<HTMLButtonElement>, step: StepDefinition) => void
  allowStep?: (step: StepDefinition) => boolean
  addLabel: string
  getStepPreview: (step: StepDefinition) => string[]
  onRemoveSavedSequence?: (id: string) => void
  savedError?: string
}) {
  const account = useContext(BehaviorLibraryContext)
  const [sharing, setSharing] = useState<StepDefinition | null>(null)
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
  const terms = filter ? filter.split(/\s+/).filter(Boolean) : []
  const mine = selectedCategory === '已保存/已保存'
  const cloudView =
    account && (selectedCategory === 'recommended' || selectedCategory === 'community') ? selectedCategory : null
  const cloud = useBehaviorLibrary(
    account?.client,
    platform,
    cloudView,
    query.trim(),
    palettes
      .filter(palette => palette.name !== '已保存')
      .flatMap(palette => palette.groups.flatMap(group => group.steps)),
  )
  const canLoadMore = Boolean(cloudView && cloud.nextCursor && !cloud.loading && !cloud.error)
  useEffect(() => {
    const list = listRef.current
    if (canLoadMore && list && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight <= 72) {
      void cloud.more()
    }
  }, [canLoadMore, cloud.steps.length, cloud.nextCursor, filter])
  const recommendations = useLibraryRecommendations(
    account?.client,
    account?.userId,
    !!account?.debugMode && account.accountReady,
    platform,
  )
  const localFallback = !!cloudView && !cloud.steps.length && (cloudView === 'recommended' || !!cloud.error)
  const sourceLabel = mine
    ? '我的'
    : cloudView === 'recommended'
      ? '推荐'
      : cloudView === 'community'
        ? '社区'
        : builtInSourceLabel
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
  const fallbackSteps = categories.flatMap(group =>
    group.steps.filter(step => Boolean(step.properties.recommendedFallback)),
  )
  const fallbackGroups =
    fallbackSteps.length > 0
      ? [{ id: 'fallback', name: '本地常用', palette: builtInSourceLabel, steps: fallbackSteps }]
      : categories.filter(group => group.palette === '常用行为' || group.palette === '组合行为')
  const currentCategory = categories.some(group => group.id === selectedCategory) ? selectedCategory : 'all'
  const groups = cloudView
    ? localFallback
      ? fallbackGroups
      : [{ id: cloudView, name: sourceLabel, palette: sourceLabel, steps: cloud.steps }]
    : mine
      ? palettes
          .filter(palette => palette.name === '已保存')
          .flatMap(palette => palette.groups.map(group => ({ ...group, id: '已保存/已保存', palette: '我的' })))
      : categories
  const visibleGroups = groups
    .filter(group => cloudView || mine || filter || currentCategory === 'all' || group.id === currentCategory)
    .map(group => ({
      ...group,
      steps: group.steps.filter(step => {
        if (allowStep && !allowStep(step)) return false
        if (!terms.length) return true
        const haystack =
          `${group.palette} ${group.name} ${step.name} ${step.properties.description ?? ''} ${step.properties.keywords ?? ''} ${step.properties.author ?? ''}`.toLocaleLowerCase()
        return terms.every(term => haystack.includes(term))
      }),
    }))
    .filter(group => group.steps.length > 0)

  return (
    <>
      <header className="workflow-toolbox-heading">
        <h2 className="workflow-toolbox-title">行为库</h2>
        <div className="workflow-toolbox-search sqd-toolbox-filter">
          <label className="workflow-toolbox-search-field">
            <Search size={15} strokeWidth={1.8} aria-hidden="true" />
            <input
              className="sqd-toolbox-filter-input"
              type="search"
              aria-label={`搜索${sourceLabel}行为`}
              placeholder={`搜索${sourceLabel}行为`}
              maxLength={64}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="workflow-toolbox-search-clear"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
      </header>
      <nav className="workflow-toolbox-tabs" aria-label="行为来源">
        {(account
          ? [
              ['all', builtInSourceLabel],
              ['recommended', '推荐'],
              ['community', '社区'],
              ['已保存/已保存', '我的'],
            ]
          : [
              ['all', builtInSourceLabel],
              ['已保存/已保存', '我的'],
            ]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === 'all' ? !mine && !cloudView : selectedCategory === id}
            onClick={() => {
              setQuery('')
              onCategoryChange(id)
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {(recommendations.error || recommendations.notice) && (
        <div className="workflow-library-feedback workflow-recommendation-feedback">
          {recommendations.error ? (
            <span role="alert">
              {recommendations.error}{' '}
              <button
                type="button"
                onClick={recommendations.retry}
                disabled={recommendations.loading || recommendations.busy}
              >
                刷新
              </button>
            </span>
          ) : (
            <span role="status">{recommendations.notice}</span>
          )}
        </div>
      )}
      {!mine && !cloudView && categories.length > 0 && (
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
        aria-label={filter ? '行为搜索结果' : `${sourceLabel}行为`}
        onScroll={event => {
          const list = event.currentTarget
          if (canLoadMore && list.scrollHeight - list.scrollTop - list.clientHeight <= 72) {
            void cloud.more()
          }
        }}
      >
        {cloudView && (
          <div className="workflow-library-feedback">
            {cloud.loading && !cloud.steps.length && <span role="status">加载中…</span>}
            {cloud.error && (
              <span role="alert">
                {cloud.error}，{cloud.steps.length ? '当前列表仍可使用' : '可使用本地行为'}{' '}
                <button type="button" onClick={cloud.retry} disabled={cloud.loading}>
                  重试
                </button>
              </span>
            )}
            {localFallback && <span>本地常用</span>}
            {!!cloud.skipped && <span>部分行为需更新客户端后使用</span>}
          </div>
        )}
        {mine && savedError ? (
          <p className="workflow-toolbox-empty" role="alert">
            {savedError}
          </p>
        ) : (
          <>
            {visibleGroups.map(group => (
              <section key={group.id} aria-label={group.name}>
                {!mine && !cloudView && (currentCategory === 'all' || filter) && (
                  <h3 className="sqd-toolbox-group-title">{group.name}</h3>
                )}
                {group.steps.map(step => {
                  const recommended = recommendations.itemFor(step)?.recommend_enabled === true
                  const description = typeof step.properties.description === 'string' ? step.properties.description : ''
                  const author = typeof step.properties.author === 'string' ? step.properties.author : ''
                  const subtitle = description || (author ? `作者：${author}` : '')
                  const hasDetailPreview =
                    step.type === 'savedSequence' ||
                    step.type === 'textAndEnter' ||
                    step.type === 'deleteAllText' ||
                    Boolean(step.properties.savedSequenceId) ||
                    Boolean(step.properties.libraryItemId)
                  return (
                    <div
                      key={String(step.properties.libraryItemId ?? step.properties.savedSequenceId ?? step.type)}
                      className={`sqd-toolbox-item sqd-type-${step.type}`}
                    >
                      <button
                        type="button"
                        className="workflow-toolbox-item-main"
                        aria-label={`${addLabel}：${step.name}`}
                        aria-description={subtitle || undefined}
                        title={subtitle ? `${step.name} — ${subtitle}` : step.name}
                        onPointerDown={event => onStepPointerDown?.(event, step)}
                        onMouseDown={event => {
                          if (event.button !== 0) return
                          dragOrigin.current = { x: event.clientX, y: event.clientY }
                          if (!api) return
                          event.preventDefault()
                          event.stopPropagation()
                          api.toolbox.tryDrag(new Vector(event.clientX, event.clientY), step)
                        }}
                        onTouchStart={event => {
                          if (event.touches.length !== 1) return
                          event.stopPropagation()
                          const touch = event.touches[0]
                          dragOrigin.current = { x: touch.clientX, y: touch.clientY }
                          api?.toolbox.tryDrag(new Vector(touch.clientX, touch.clientY), step)
                        }}
                        onClick={event => {
                          if (
                            event.detail === 0 ||
                            Math.hypot(event.clientX - dragOrigin.current.x, event.clientY - dragOrigin.current.y) < 5
                          ) {
                            onAddStep(step, event.detail === 0)
                          }
                        }}
                      >
                        <span
                          className="sqd-toolbox-item-icon"
                          data-keycap={iconUrls[step.type]?.includes('data-keycap') || undefined}
                        >
                          <img
                            className="sqd-toolbox-item-icon-image"
                            src={iconUrls[step.type]}
                            alt=""
                            draggable={false}
                          />
                        </span>
                        <span className="workflow-toolbox-item-content">
                          <span className="sqd-toolbox-item-text">{step.name}</span>
                          {subtitle && (
                            <span className="workflow-toolbox-item-desc" aria-hidden="true">
                              {subtitle}
                            </span>
                          )}
                        </span>
                        <Plus size={14} className="workflow-toolbox-item-plus" aria-hidden="true" />
                      </button>
                      {hasDetailPreview && (
                        <button
                          type="button"
                          className="icon-button workflow-toolbox-preview"
                          aria-label={`查看${step.name}详情`}
                          title="查看详情"
                          onClick={() => setPreview(step)}
                        >
                          <Eye size={14} aria-hidden="true" />
                        </button>
                      )}
                      {account && typeof step.properties.savedSequenceId === 'string' && (
                        <button
                          type="button"
                          className="icon-button workflow-saved-share"
                          aria-label={`分享${step.name}`}
                          title="分享"
                          onClick={() => setSharing(step)}
                        >
                          <Share2 size={14} aria-hidden="true" />
                        </button>
                      )}
                      {recommendations.isAdmin && (
                        <button
                          type="button"
                          className="icon-button workflow-recommendation"
                          aria-label={`${recommended ? '取消推荐' : '设为推荐'}：${step.name}`}
                          aria-pressed={recommended}
                          title={recommended ? '取消推荐' : '设为推荐（所有用户可见）'}
                          disabled={recommendations.busy}
                          onClick={() => {
                            void recommendations.toggle(step, categoryCodes[group.name] ?? 'common').then(changed => {
                              if (changed) cloud.retry()
                            })
                          }}
                        >
                          <Star size={14} fill={recommended ? 'currentColor' : 'none'} aria-hidden="true" />
                        </button>
                      )}
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
                  )
                })}
              </section>
            ))}
            {visibleGroups.length === 0 && (!cloudView || (!cloud.loading && !cloud.error)) && (
              <p className="workflow-toolbox-empty">
                {mine && !filter
                  ? '暂无已保存的行为序列'
                  : cloudView === 'community' && !filter
                    ? '暂无社区行为'
                    : '没有匹配的行为'}
              </p>
            )}
          </>
        )}
        {cloudView && cloud.steps.length > 0 && cloud.loading && (
          <div className="workflow-library-loading" role="status">
            加载中…
          </div>
        )}
      </div>
      {sharing &&
        account &&
        createPortal(
          <BehaviorShareDialog
            key={`${account.userId}/${sharing.properties.savedSequenceId}`}
            sequence={{
              id: sharing.properties.savedSequenceId as string,
              name: sharing.name,
              sequence: sharing.properties.sequence as string,
              libraryItemIds: sharing.properties.libraryItemIds as (string | null)[] | undefined,
            }}
            platform={platform}
            preview={getStepPreview(sharing)}
            onClose={() => setSharing(null)}
          />,
          document.body,
        )}
      {preview &&
        createPortal(
          <dialog
            ref={dialogRef}
            className="behavior-dialog workflow-library-dialog"
            aria-labelledby={previewTitleId}
            onCancel={() => setPreview(null)}
            onClose={() => setPreview(null)}
            onClick={event => {
              if (event.target === event.currentTarget) setPreview(null)
            }}
          >
            <header className="behavior-dialog-head">
              <h2 id={previewTitleId}>{preview.name}</h2>
              <button type="button" className="dialog-close" aria-label="关闭行为详情" onClick={() => setPreview(null)}>
                <X size={17} />
              </button>
            </header>
            <div className="behavior-dialog-body">
              {typeof preview.properties.author === 'string' && preview.properties.author && (
                <p className="workflow-library-description">{preview.properties.author}</p>
              )}
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
                  onClick={event => {
                    onAddStep(preview, event.detail === 0)
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
