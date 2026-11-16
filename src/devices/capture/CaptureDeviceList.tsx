import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  Plug,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from 'lucide-react'
import {
  buildCaptureDeviceTree,
  diffCandidatesWithSnapshot,
  formatHidUsageRole,
  formatVidPid,
  safetyBadgeLabel,
  transportLabel,
  type CaptureAncestorNode,
  type CaptureCandidate,
  type CaptureDeviceSnapshot,
  type CaptureSessionStatus,
  type CaptureSnapshotEntry,
  type CaptureTreeFolderNode,
  type CaptureTreeLeafItem,
} from './model'

export type CaptureDeviceListProps = {
  native: boolean
  candidates: readonly CaptureCandidate[]
  baselineSnapshot?: CaptureDeviceSnapshot | null
  selectedTargetId: string | null
  sessionStatus: CaptureSessionStatus | null
  loading: boolean
  busyInstanceId: string | null
  includeGatt: boolean
  onIncludeGattChange: (value: boolean) => void
  onRefresh: (includeGatt?: boolean) => void
  onSelectCandidate: (candidate: CaptureCandidate) => void
  onRequestAttachDriver: (candidate: CaptureCandidate) => void
  onDetachDriver: (candidate: CaptureCandidate) => void
  onStartSession: (candidate: CaptureCandidate) => void
  onStopSession: () => void
}

type CandidateFilter = 'all' | 'safe' | 'bound' | 'changed'
type CandidateViewMode = 'tree' | 'list'

function matchesCandidateQuery(
  item: {
    displayName: string
    instanceId: string
    transport: string
    vid: number | null
    pid: number | null
    usagePage: number | null
    usage: number | null
    ancestors?: readonly CaptureAncestorNode[]
  },
  gattTexts: readonly (string | null | undefined)[],
  q: string,
): boolean {
  if (!q) return true
  const vidPid = formatVidPid(item.vid, item.pid).toLowerCase()
  const usageRole = formatHidUsageRole(item.usagePage, item.usage)?.toLowerCase() ?? ''
  const ancestorText = (item.ancestors ?? [])
    .map(a => a.label)
    .join(' ')
    .toLowerCase()
  const gattText = gattTexts.filter(Boolean).join(' ').toLowerCase()
  return (
    item.displayName.toLowerCase().includes(q) ||
    item.instanceId.toLowerCase().includes(q) ||
    vidPid.includes(q) ||
    transportLabel(item.transport).toLowerCase().includes(q) ||
    usageRole.includes(q) ||
    ancestorText.includes(q) ||
    gattText.includes(q)
  )
}

export function CaptureDeviceList({
  native,
  candidates,
  baselineSnapshot = null,
  selectedTargetId,
  sessionStatus,
  loading,
  busyInstanceId,
  includeGatt,
  onIncludeGattChange,
  onRefresh,
  onSelectCandidate,
  onRequestAttachDriver,
  onDetachDriver,
  onStartSession,
  onStopSession,
}: CaptureDeviceListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CandidateFilter>('all')
  const [viewMode, setViewMode] = useState<CandidateViewMode>('tree')
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())

  const snapshotDiff = useMemo(
    () => diffCandidatesWithSnapshot(candidates, baselineSnapshot),
    [baselineSnapshot, candidates],
  )
  const changedCount = snapshotDiff.addedIds.size + snapshotDiff.removedEntries.length

  const leafItems = useMemo<CaptureTreeLeafItem[]>(() => {
    const q = query.trim().toLowerCase()
    const items: CaptureTreeLeafItem[] = []

    for (const candidate of candidates) {
      const isAdded = snapshotDiff.addedIds.has(candidate.targetId)
      if (filter === 'safe' && candidate.safetyTier !== 'safe') continue
      if (filter === 'bound' && !candidate.boundToQuarbor) continue
      if (filter === 'changed' && !isAdded) continue
      if (
        !matchesCandidateQuery(
          candidate,
          [candidate.gattInfo?.manufacturer, candidate.gattInfo?.modelNumber, candidate.gattInfo?.softwareRevision],
          q,
        )
      ) {
        continue
      }
      items.push({
        kind: 'live',
        key: `live:${candidate.targetId}`,
        diff: isAdded ? 'added' : 'unchanged',
        displayName: candidate.displayName,
        transport: candidate.transport,
        vid: candidate.vid,
        pid: candidate.pid,
        usagePage: candidate.usagePage,
        usage: candidate.usage,
        ancestors: candidate.ancestors ?? [],
        candidate,
      })
    }

    if (baselineSnapshot && (filter === 'all' || filter === 'changed')) {
      for (const entry of snapshotDiff.removedEntries) {
        if (!matchesCandidateQuery(entry, [], q)) continue
        items.push({
          kind: 'removed',
          key: `removed:${entry.targetId}`,
          diff: 'removed',
          displayName: entry.displayName,
          transport: entry.transport,
          vid: entry.vid,
          pid: entry.pid,
          usagePage: entry.usagePage,
          usage: entry.usage,
          ancestors: entry.ancestors,
          entry,
        })
      }
    }

    return items
  }, [baselineSnapshot, candidates, filter, query, snapshotDiff])

  const treeRoots = useMemo(() => buildCaptureDeviceTree(leafItems), [leafItems])
  const boundCount = candidates.filter(item => item.boundToQuarbor).length

  const toggleFolder = (folderId: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  const renderLeafItem = (item: CaptureTreeLeafItem, showAncestorHint: boolean) => {
    if (item.kind === 'removed') {
      return <CaptureRemovedCard key={item.key} entry={item.entry} showAncestorHint={showAncestorHint} />
    }
    const candidate = item.candidate
    const selected = selectedTargetId === candidate.targetId
    const isActiveSession =
      Boolean(sessionStatus?.active) &&
      (sessionStatus?.targetId === candidate.targetId || sessionStatus?.instanceId === candidate.instanceId)
    const busy = busyInstanceId === candidate.instanceId
    return (
      <CaptureCandidateCard
        key={item.key}
        candidate={candidate}
        diff={item.diff}
        selected={selected}
        isActiveSession={isActiveSession}
        busy={busy}
        busyLocked={busyInstanceId !== null}
        native={native}
        showAncestorHint={showAncestorHint}
        onSelectCandidate={onSelectCandidate}
        onRequestAttachDriver={onRequestAttachDriver}
        onDetachDriver={onDetachDriver}
        onStartSession={onStartSession}
        onStopSession={onStopSession}
      />
    )
  }

  const renderTreeFolder = (folder: CaptureTreeFolderNode, depth: number) => {
    const collapsed = collapsedFolders.has(folder.id)
    const FolderIcon = collapsed ? Folder : FolderOpen
    const ChevronIcon = collapsed ? ChevronRight : ChevronDown
    return (
      <div
        key={folder.id}
        className={`capture-tree-branch${folder.kind === 'bus' ? ' is-bus' : ''}`}
        role="treeitem"
        aria-expanded={!collapsed}
      >
        <button
          type="button"
          className={`capture-tree-folder${folder.kind === 'bus' ? ' is-bus' : ''}`}
          data-folder-id={folder.id}
          onClick={() => toggleFolder(folder.id)}
        >
          <ChevronIcon size={13} className="capture-tree-chevron" aria-hidden="true" />
          <FolderIcon size={14} className="capture-tree-folder-icon" aria-hidden="true" />
          <span className="capture-tree-folder-label" title={folder.label}>
            {folder.label}
          </span>
          <span className="capture-tree-folder-badges">
            {folder.addedCount > 0 && <span className="capture-diff-badge is-added">+{folder.addedCount}</span>}
            {folder.removedCount > 0 && <span className="capture-diff-badge is-removed">-{folder.removedCount}</span>}
            <span className="capture-tree-count">{folder.totalCount}</span>
          </span>
        </button>

        {!collapsed && (
          <div className="capture-tree-children" role="group">
            {folder.children.map(child => renderTreeFolder(child, depth + 1))}
            {folder.items.map(item => renderLeafItem(item, false))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="capture-device-step">
      <div className="capture-device-toolbar">
        <div className="capture-search-box">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索设备名、VID:PID、父级路径或实例 ID"
            aria-label="搜索候选设备"
          />
        </div>
        <div className="capture-view-toggle" role="group" aria-label="设备展示视图">
          <button
            type="button"
            className="capture-view-btn"
            aria-pressed={viewMode === 'tree'}
            title="目录树形图"
            onClick={() => setViewMode('tree')}
          >
            <FolderTree size={13} aria-hidden="true" />
            <span>树形</span>
          </button>
          <button
            type="button"
            className="capture-view-btn"
            aria-pressed={viewMode === 'list'}
            title="平铺列表"
            onClick={() => setViewMode('list')}
          >
            <List size={13} aria-hidden="true" />
            <span>列表</span>
          </button>
        </div>
        <button
          type="button"
          className="capture-icon-btn"
          aria-label="刷新候选设备"
          title="刷新候选设备"
          disabled={!native || loading}
          onClick={() => onRefresh(includeGatt)}
        >
          <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />
        </button>
      </div>

      <div className="capture-filter-bar">
        <div className="capture-filter-pills" role="group" aria-label="设备筛选">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            全部 ({candidates.length})
          </button>
          <button type="button" aria-pressed={filter === 'safe'} onClick={() => setFilter('safe')}>
            推荐安全
          </button>
          <button type="button" aria-pressed={filter === 'bound'} onClick={() => setFilter('bound')}>
            已挂载 ({boundCount})
          </button>
          {(changedCount > 0 || filter === 'changed') && (
            <button
              type="button"
              className={changedCount > 0 ? 'has-diff' : undefined}
              aria-pressed={filter === 'changed'}
              onClick={() => setFilter('changed')}
            >
              变化 ({changedCount})
            </button>
          )}
        </div>

        <label className="capture-inline-check">
          <input
            type="checkbox"
            checked={includeGatt}
            disabled={!native || loading}
            onChange={event => {
              const next = event.target.checked
              onIncludeGattChange(next)
              if (native) onRefresh(next)
            }}
          />
          <span>读取蓝牙信息</span>
        </label>
      </div>

      {!native ? (
        <div className="capture-empty-box">
          <strong>需在桌面应用枚举实体设备</strong>
          <span>浏览器预览无法扫描本机 USB / 蓝牙 HID 设备。</span>
        </div>
      ) : leafItems.length === 0 ? (
        <div className="capture-empty-box">
          <strong>{loading ? '正在扫描物理设备…' : '未找到匹配的候选设备'}</strong>
          {!loading && <span>蓝牙遥控器请先在系统蓝牙设置完成配对后点击刷新。</span>}
        </div>
      ) : viewMode === 'tree' ? (
        <div className="capture-tree" role="tree" aria-label="物理设备目录树">
          {treeRoots.map(root => renderTreeFolder(root, 0))}
        </div>
      ) : (
        <div className="capture-candidate-list" role="list" aria-label="物理设备候选列表">
          {leafItems.map(item => renderLeafItem(item, true))}
        </div>
      )}
    </div>
  )
}

type CaptureCandidateCardProps = {
  candidate: CaptureCandidate
  diff: 'added' | 'unchanged'
  selected: boolean
  isActiveSession: boolean
  busy: boolean
  busyLocked: boolean
  native: boolean
  showAncestorHint: boolean
  onSelectCandidate: (candidate: CaptureCandidate) => void
  onRequestAttachDriver: (candidate: CaptureCandidate) => void
  onDetachDriver: (candidate: CaptureCandidate) => void
  onStartSession: (candidate: CaptureCandidate) => void
  onStopSession: () => void
}

function CaptureCandidateCard({
  candidate,
  diff,
  selected,
  isActiveSession,
  busy,
  busyLocked,
  native,
  showAncestorHint,
  onSelectCandidate,
  onRequestAttachDriver,
  onDetachDriver,
  onStartSession,
  onStopSession,
}: CaptureCandidateCardProps) {
  const blocked = candidate.safetyTier === 'blocked'
  const SafetyIcon =
    candidate.safetyTier === 'safe' ? ShieldCheck : candidate.safetyTier === 'caution' ? ShieldAlert : ShieldX
  const usageRole = formatHidUsageRole(candidate.usagePage, candidate.usage)
  const ancestorPath =
    showAncestorHint && candidate.ancestors && candidate.ancestors.length > 0
      ? candidate.ancestors.map(a => a.label).join(' / ')
      : null

  return (
    <div
      role="listitem"
      data-target-id={candidate.targetId}
      data-selected={selected || undefined}
      data-safety={candidate.safetyTier}
      data-diff={diff === 'added' ? 'added' : undefined}
      className={`capture-candidate-card${selected ? ' is-selected' : ''}${isActiveSession ? ' is-session-active' : ''}${diff === 'added' ? ' is-added' : ''}`}
      onClick={() => onSelectCandidate(candidate)}
    >
      <div className="capture-candidate-top">
        <div className="capture-candidate-title-row">
          <strong className="capture-candidate-name">{candidate.displayName}</strong>
          {diff === 'added' && <span className="capture-diff-badge is-added">+ 新增</span>}
          <span className="capture-tag is-transport">{transportLabel(candidate.transport)}</span>
          <span className="capture-tag is-vidpid">{formatVidPid(candidate.vid, candidate.pid)}</span>
          {candidate.usagePage !== null && candidate.usage !== null && (
            <span className="capture-tag is-usage">
              {`0x${candidate.usagePage.toString(16).toUpperCase().padStart(2, '0')}:0x${candidate.usage.toString(16).toUpperCase().padStart(2, '0')}`}
            </span>
          )}
          {usageRole && <span className="capture-tag is-role">{usageRole}</span>}
        </div>

        <span className={`capture-safety-badge is-${candidate.safetyTier}`}>
          <SafetyIcon size={12} aria-hidden="true" />
          {safetyBadgeLabel(candidate.safetyTier)}
        </span>
      </div>

      <div className="capture-candidate-meta">
        <span className={`capture-driver-state ${candidate.boundToQuarbor ? 'is-bound' : 'is-native'}`}>
          {candidate.boundToQuarbor ? 'Quarbor 已拦截' : candidate.recoveryActive ? '已恢复 · 待重连' : '系统原驱动'}
        </span>
        {candidate.registeredKind && (
          <span className="capture-registered-pill">内置型号：{candidate.registeredKind}</span>
        )}
        {candidate.gattInfo?.modelNumber && (
          <span className="capture-gatt-meta">型号 {candidate.gattInfo.modelNumber}</span>
        )}
        {ancestorPath && (
          <span className="capture-ancestor-path" title={ancestorPath}>
            {ancestorPath}
          </span>
        )}
        <code className="capture-instance-id" title={candidate.instanceId}>
          {candidate.instanceId}
        </code>
      </div>

      {candidate.safetyReason && (
        <p className={`capture-safety-reason is-${candidate.safetyTier}`} role={blocked ? 'note' : undefined}>
          {candidate.safetyReason}
        </p>
      )}

      <div className="capture-candidate-actions" onClick={event => event.stopPropagation()}>
        {!candidate.boundToQuarbor ? (
          <button
            type="button"
            className="capture-btn-primary"
            disabled={!native || blocked || busyLocked}
            onClick={() => onRequestAttachDriver(candidate)}
          >
            <PlugZap size={13} aria-hidden="true" />
            {busy ? '正在挂载…' : '挂载拦截驱动'}
          </button>
        ) : (
          <button
            type="button"
            className="capture-btn-warning"
            disabled={!native || busyLocked}
            onClick={() => onDetachDriver(candidate)}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {busy ? '正在恢复…' : '恢复原驱动'}
          </button>
        )}

        {isActiveSession ? (
          <button type="button" className="capture-btn-secondary" disabled={!native || busy} onClick={onStopSession}>
            断开会话
          </button>
        ) : (
          <button
            type="button"
            className={candidate.boundToQuarbor ? 'capture-btn-primary' : 'capture-btn-secondary'}
            disabled={!native || blocked || busyLocked}
            onClick={() => onStartSession(candidate)}
          >
            <Plug size={13} aria-hidden="true" />
            {candidate.boundToQuarbor ? '连接采集' : '直接监听'}
          </button>
        )}
      </div>
    </div>
  )
}

function CaptureRemovedCard({ entry, showAncestorHint }: { entry: CaptureSnapshotEntry; showAncestorHint: boolean }) {
  const usageRole = formatHidUsageRole(entry.usagePage, entry.usage)
  const ancestorPath =
    showAncestorHint && entry.ancestors.length > 0 ? entry.ancestors.map(a => a.label).join(' / ') : null
  return (
    <div
      role="listitem"
      data-removed-target-id={entry.targetId}
      data-diff="removed"
      className="capture-candidate-card is-removed"
    >
      <div className="capture-candidate-top">
        <div className="capture-candidate-title-row">
          <strong className="capture-candidate-name">{entry.displayName}</strong>
          <span className="capture-diff-badge is-removed">- 已消失</span>
          <span className="capture-tag is-transport">{transportLabel(entry.transport)}</span>
          <span className="capture-tag is-vidpid">{formatVidPid(entry.vid, entry.pid)}</span>
          {entry.usagePage !== null && entry.usage !== null && (
            <span className="capture-tag is-usage">
              {`0x${entry.usagePage.toString(16).toUpperCase().padStart(2, '0')}:0x${entry.usage.toString(16).toUpperCase().padStart(2, '0')}`}
            </span>
          )}
          {usageRole && <span className="capture-tag is-role">{usageRole}</span>}
        </div>
      </div>

      <div className="capture-candidate-meta">
        {ancestorPath && (
          <span className="capture-ancestor-path" title={ancestorPath}>
            {ancestorPath}
          </span>
        )}
        <code className="capture-instance-id" title={entry.instanceId}>
          {entry.instanceId}
        </code>
      </div>
    </div>
  )
}
