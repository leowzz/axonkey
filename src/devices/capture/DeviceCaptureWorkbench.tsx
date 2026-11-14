import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { save } from '@tauri-apps/plugin-dialog'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileCode2,
  FolderOpen,
  Play,
  Radio,
  RotateCcw,
  SkipForward,
  Sparkles,
} from 'lucide-react'
import { CaptureDeviceList } from './CaptureDeviceList'
import { CaptureSafetyConfirmDialog, type CaptureSafetyDialogState } from './CaptureSafetyConfirmDialog'
import { CaptureSvgStage, type RawCaptureFrameItem } from './CaptureSvgStage'
import {
  accumulateProbeFrame,
  captureArmKey,
  captureCompileSvg,
  captureDetachDriver,
  captureAttachDriver,
  captureListCandidates,
  captureParseDraftSvg,
  captureSaveExport,
  captureSetLivePreviewSvg,
  captureStartSession,
  captureStopSession,
  compileCaptureSvgLocal,
  detectSampleCollisions,
  findUnregisteredBoundCandidates,
  formatHexShort,
  formatReportIdHex,
  formatVidPid,
  isTauriCaptureRuntime,
  listenCaptureEvents,
  nextPendingInputId,
  parseCaptureDraftSvgLocal,
  sanitizeAndExtractSvgStage,
  seedSamplesFromDraft,
  type CaptureCandidate,
  type CapturedKeySample,
  type CaptureSessionStatus,
  type CompiledCaptureResult,
  type DiscoveredProbeButton,
  type ParsedCaptureDraft,
  type SanitizedCaptureSvg,
} from './model'
import './DeviceCaptureWorkbench.css'

export type DeviceCaptureWorkbenchProps = {
  native?: boolean
  onBack: () => void
  onDevicesChanged?: () => void
  onToast?: (message: string) => void
}

type WorkbenchStep = 1 | 2 | 3 | 4
type KeyFilter = 'all' | 'pending' | 'captured'

type LiveHitEntry = {
  id: number
  inputId: string
  label: string
  pressed: boolean
  reportId: number
  hex: string
}

const MAX_RAW_FRAMES = 80
const MAX_LIVE_HITS = 10
const CLI_GENERATE_CMD = 'npm run generate:devices'

export function DeviceCaptureWorkbench({ native, onBack, onDevicesChanged, onToast }: DeviceCaptureWorkbenchProps) {
  const nativeRuntime = isTauriCaptureRuntime(native)
  const stepFileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<WorkbenchStep>(1)
  const [stageMode, setStageMode] = useState<'svg' | 'probe'>('svg')

  const [candidates, setCandidates] = useState<CaptureCandidate[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [includeGatt, setIncludeGatt] = useState(false)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [busyInstanceId, setBusyInstanceId] = useState<string | null>(null)
  const [sessionInstalledIds, setSessionInstalledIds] = useState<Set<string>>(() => new Set())
  const passthroughByInstanceRef = useRef<Map<string, boolean>>(new Map())

  const [sessionStatus, setSessionStatus] = useState<CaptureSessionStatus | null>(null)
  const [streamingReportIds, setStreamingReportIds] = useState<number[]>([])
  const [rawFrames, setRawFrames] = useState<RawCaptureFrameItem[]>([])
  const [discoveredProbeButtons, setDiscoveredProbeButtons] = useState<DiscoveredProbeButton[]>([])
  const [hideStreamingNoise, setHideStreamingNoise] = useState(true)
  const neutralByReportRef = useRef<Map<number, string>>(new Map())

  const [rawSvgContent, setRawSvgContent] = useState('')
  const [sanitizedSvg, setSanitizedSvg] = useState<SanitizedCaptureSvg | null>(null)
  const [draft, setDraft] = useState<ParsedCaptureDraft | null>(null)
  const [svgFileName, setSvgFileName] = useState<string | null>(null)
  const [svgError, setSvgError] = useState('')

  const [samples, setSamples] = useState<Map<string, CapturedKeySample>>(() => new Map())
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set())
  const [selectedInputId, setSelectedInputId] = useState<string | null>(null)
  const [armedWaiting, setArmedWaiting] = useState(false)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [keyFilter, setKeyFilter] = useState<KeyFilter>('all')
  const [lastCapturedInputId, setLastCapturedInputId] = useState<string | null>(null)

  const [livePressedIds, setLivePressedIds] = useState<Set<string>>(() => new Set())
  const [liveHits, setLiveHits] = useState<LiveHitEntry[]>([])
  const liveHitCounterRef = useRef(0)

  const [targetStatus, setTargetStatus] = useState<'active' | 'draft'>('active')
  const [compiled, setCompiled] = useState<CompiledCaptureResult | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [savingExport, setSavingExport] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [copiedCli, setCopiedCli] = useState(false)

  const [errorBanner, setErrorBanner] = useState('')
  const [infoBanner, setInfoBanner] = useState('')
  const [safetyDialog, setSafetyDialog] = useState<CaptureSafetyDialogState | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)

  const draftRef = useRef(draft)
  draftRef.current = draft
  const samplesRef = useRef(samples)
  samplesRef.current = samples
  const skippedIdsRef = useRef(skippedIds)
  skippedIdsRef.current = skippedIds
  const autoAdvanceRef = useRef(autoAdvance)
  autoAdvanceRef.current = autoAdvance
  const stepRef = useRef(step)
  stepRef.current = step

  const selectedCandidate = useMemo(
    () => candidates.find(item => item.targetId === selectedTargetId) ?? null,
    [candidates, selectedTargetId],
  )

  const unregisteredBound = useMemo(() => findUnregisteredBoundCandidates(candidates), [candidates])

  const refreshCandidates = useCallback(
    async (withGatt = includeGatt) => {
      if (!nativeRuntime) return
      setLoadingCandidates(true)
      try {
        const list = await captureListCandidates({ includeGatt: withGatt, native: nativeRuntime })
        setCandidates(list)
        setSelectedTargetId(current => {
          if (current && list.some(item => item.targetId === current)) return current
          return list.find(item => item.safetyTier === 'safe')?.targetId ?? list[0]?.targetId ?? null
        })
      } catch (err) {
        setErrorBanner(formatErr(err))
      } finally {
        setLoadingCandidates(false)
      }
    },
    [includeGatt, nativeRuntime],
  )

  useEffect(() => {
    if (nativeRuntime) {
      void refreshCandidates(false)
    }
  }, [nativeRuntime, refreshCandidates])

  const armKeySelection = useCallback(
    async (inputId: string | null) => {
      setSelectedInputId(inputId)
      if (!inputId) {
        setArmedWaiting(false)
        await captureArmKey(null, nativeRuntime).catch(() => {})
        return
      }
      setArmedWaiting(true)
      try {
        await captureArmKey(inputId, nativeRuntime)
      } catch (err) {
        setErrorBanner(formatErr(err))
      }
    },
    [nativeRuntime],
  )

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    void listenCaptureEvents(payload => {
      if (!active) return
      if (payload.kind === 'status') {
        setStreamingReportIds(prev => mergeReportIds(prev, payload.streamingReportIds))
        setSessionStatus(current =>
          current
            ? {
                ...current,
                active: payload.connected,
                frameCount: payload.frameCount,
                streamingReportIds: mergeReportIds(current.streamingReportIds, payload.streamingReportIds),
              }
            : {
                active: payload.connected,
                targetId: null,
                instanceId: null,
                transportMode: 'quarbor',
                driverVersion: null,
                supportsKeysend: false,
                supportsResetInput: false,
                frameCount: payload.frameCount,
                streamingReportIds: payload.streamingReportIds,
              },
        )
        if (payload.message) setInfoBanner(payload.message)
        return
      }

      if (payload.kind === 'rawFrame') {
        if (payload.isStreamingNoise) {
          setStreamingReportIds(prev => mergeReportIds(prev, [payload.reportId]))
        }
        setSessionStatus(current =>
          current ? { ...current, frameCount: Math.max(current.frameCount, payload.sequence) } : current,
        )
        setRawFrames(prev => [payload, ...prev].slice(0, MAX_RAW_FRAMES))
        setDiscoveredProbeButtons(prev => accumulateProbeFrame(prev, neutralByReportRef.current, payload))
        return
      }

      if (payload.kind === 'keyCaptured') {
        const { sample } = payload
        const nextSamples = new Map(samplesRef.current)
        nextSamples.set(sample.inputId, sample)
        samplesRef.current = nextSamples
        setSamples(nextSamples)
        setLastCapturedInputId(sample.inputId)

        setSkippedIds(prev => {
          if (!prev.has(sample.inputId)) return prev
          const copy = new Set(prev)
          copy.delete(sample.inputId)
          skippedIdsRef.current = copy
          return copy
        })

        const currentDraft = draftRef.current
        if (autoAdvanceRef.current && currentDraft && stepRef.current === 3) {
          const nextId = nextPendingInputId(currentDraft.inputs, nextSamples, sample.inputId, skippedIdsRef.current)
          setSelectedInputId(nextId ?? sample.inputId)
          setArmedWaiting(Boolean(nextId))
          void captureArmKey(nextId, nativeRuntime).catch(() => {})
          if (!nextId) {
            setInfoBanner('所有按键已完成采集，可进入步骤 4 实机试按与导出')
          }
        } else {
          setArmedWaiting(false)
          void captureArmKey(null, nativeRuntime).catch(() => {})
        }
        return
      }

      if (payload.kind === 'liveHit') {
        setLivePressedIds(prev => {
          const next = new Set(prev)
          if (payload.pressed) next.add(payload.inputId)
          else next.delete(payload.inputId)
          return next
        })
        const label = draftRef.current?.inputs.find(item => item.id === payload.inputId)?.label ?? payload.inputId
        liveHitCounterRef.current += 1
        setLiveHits(prev =>
          [
            {
              id: liveHitCounterRef.current,
              inputId: payload.inputId,
              label,
              pressed: payload.pressed,
              reportId: payload.reportId,
              hex: payload.hex,
            },
            ...prev,
          ].slice(0, MAX_LIVE_HITS),
        )
      }
    }, nativeRuntime).then(stop => {
      if (active) unlisten = stop
      else stop()
    })

    return () => {
      active = false
      unlisten?.()
      void captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
      void captureStopSession(nativeRuntime).catch(() => {})
    }
  }, [nativeRuntime])

  const startSessionForCandidate = useCallback(
    async (candidate: CaptureCandidate, passthroughOverride?: boolean) => {
      setErrorBanner('')
      try {
        const passthrough =
          passthroughOverride ?? passthroughByInstanceRef.current.get(candidate.instanceId.toUpperCase()) ?? false
        const status = await captureStartSession(
          {
            targetId: candidate.targetId,
            instanceId: candidate.instanceId,
            passthroughStandardKeys: passthrough,
          },
          nativeRuntime,
        )
        setSessionStatus(status)
        setStreamingReportIds(status.streamingReportIds)
        setSelectedTargetId(candidate.targetId)
      } catch (err) {
        setErrorBanner(formatErr(err))
      }
    },
    [nativeRuntime],
  )

  const performAttachDriver = useCallback(
    async (candidate: CaptureCandidate, allowCaution: boolean, passthrough = false) => {
      setErrorBanner('')
      setInfoBanner('')
      setBusyInstanceId(candidate.instanceId)
      passthroughByInstanceRef.current.set(candidate.instanceId.toUpperCase(), passthrough)
      try {
        const result = await captureAttachDriver(candidate.instanceId, allowCaution, nativeRuntime)
        await refreshCandidates(includeGatt)
        onDevicesChanged?.()
        if (result.cancelledByUser) {
          setInfoBanner('已取消 UAC 授权，未修改系统驱动')
          return false
        }
        if (!result.ok) {
          setErrorBanner(result.message || '驱动挂载未成功')
          return false
        }
        if (result.boundToQuarbor) {
          setSessionInstalledIds(prev => {
            const next = new Set(prev)
            next.add(candidate.instanceId.toUpperCase())
            return next
          })
        }
        if (result.rebootRequired) {
          setInfoBanner(result.message || '驱动已写入，系统提示需要重连设备或重启 Windows 生效')
        }
        return result.boundToQuarbor
      } catch (err) {
        setErrorBanner(formatErr(err))
        return false
      } finally {
        setBusyInstanceId(null)
      }
    },
    [includeGatt, nativeRuntime, onDevicesChanged, refreshCandidates],
  )

  const handleRequestAttach = async (candidate: CaptureCandidate) => {
    if (candidate.safetyTier === 'blocked') return
    if (candidate.safetyTier === 'caution') {
      setSafetyDialog({ mode: 'caution-pre-attach', candidate })
      return
    }
    const mounted = await performAttachDriver(candidate, false, false)
    if (mounted) {
      await startSessionForCandidate(candidate, false)
    }
  }

  const handleConfirmPreAttach = async (candidate: CaptureCandidate, passthroughStandardKeys: boolean) => {
    setDialogBusy(true)
    try {
      const mounted = await performAttachDriver(candidate, true, passthroughStandardKeys)
      if (mounted) {
        await startSessionForCandidate(candidate, passthroughStandardKeys)
        setSafetyDialog({ mode: 'caution-keepalive', candidate })
      } else {
        setSafetyDialog(null)
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const handleDetachDriver = useCallback(
    async (candidate: CaptureCandidate) => {
      setErrorBanner('')
      setBusyInstanceId(candidate.instanceId)
      try {
        if (sessionStatus?.active && sessionStatus.instanceId?.toUpperCase() === candidate.instanceId.toUpperCase()) {
          await captureStopSession(nativeRuntime).catch(() => {})
          setSessionStatus(null)
        }
        const result = await captureDetachDriver(candidate.instanceId, nativeRuntime)
        await refreshCandidates(includeGatt)
        onDevicesChanged?.()
        if (result.cancelledByUser) {
          setInfoBanner('已取消 UAC 授权，原拦截驱动仍处于挂载状态')
          return false
        }
        if (!result.ok) {
          setErrorBanner(result.message || '恢复原驱动失败')
          return false
        }
        setSessionInstalledIds(prev => {
          const next = new Set(prev)
          next.delete(candidate.instanceId.toUpperCase())
          return next
        })
        setInfoBanner(`已恢复 ${candidate.displayName} 的系统原驱动`)
        onToast?.(`已恢复 ${candidate.displayName} 原驱动`)
        return true
      } catch (err) {
        setErrorBanner(formatErr(err))
        return false
      } finally {
        setBusyInstanceId(null)
      }
    },
    [includeGatt, nativeRuntime, onDevicesChanged, onToast, refreshCandidates, sessionStatus],
  )

  const handleStopSession = async () => {
    try {
      await captureStopSession(nativeRuntime)
      setSessionStatus(null)
      setArmedWaiting(false)
      setLivePressedIds(new Set())
    } catch (err) {
      setErrorBanner(formatErr(err))
    }
  }

  const loadSvgContent = useCallback(
    async (svgText: string, fileName: string) => {
      setSvgError('')
      setErrorBanner('')
      setExportedPath(null)
      try {
        const sanitized = sanitizeAndExtractSvgStage(svgText)
        let parsed: ParsedCaptureDraft
        try {
          parsed = await captureParseDraftSvg(sanitized.svgContent, nativeRuntime)
        } catch {
          parsed = parseCaptureDraftSvgLocal(sanitized.svgContent)
        }

        const seeded = seedSamplesFromDraft(parsed)
        setRawSvgContent(sanitized.svgContent)
        setSanitizedSvg(sanitized)
        setDraft(parsed)
        setSvgFileName(fileName)
        setSamples(seeded)
        setSkippedIds(new Set())
        setLastCapturedInputId(null)
        setCompiled(null)

        const firstPending = nextPendingInputId(parsed.inputs, seeded) ?? parsed.inputs[0]?.id ?? null
        setSelectedInputId(firstPending)
        setStageMode('svg')
        setTargetStatus(seeded.size === parsed.inputs.length && parsed.inputs.length > 0 ? 'active' : 'draft')
      } catch (err) {
        setSvgError(formatErr(err))
      }
    },
    [nativeRuntime],
  )

  const handleStepFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await loadSvgContent(await file.text(), file.name)
  }

  const enterStep = async (nextStep: WorkbenchStep) => {
    if (step === 4 && nextStep !== 4) {
      setLivePressedIds(new Set())
      await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
    }
    setStep(nextStep)
    if (nextStep === 3 && draft) {
      const targetId =
        selectedInputId && draft.inputs.some(item => item.id === selectedInputId)
          ? selectedInputId
          : (nextPendingInputId(draft.inputs, samples, null, skippedIds) ?? draft.inputs[0]?.id ?? null)
      if (targetId && !samples.has(targetId)) {
        await armKeySelection(targetId)
      } else {
        setSelectedInputId(targetId)
      }
    }
  }

  const runCompileAndPreview = useCallback(
    async (desiredStatus: 'active' | 'draft') => {
      if (!rawSvgContent || !draft) return
      setCompiling(true)
      setErrorBanner('')
      try {
        await captureArmKey(null, nativeRuntime).catch(() => {})
        setArmedWaiting(false)
        const sampleList = [...samples.values()]
        let result: CompiledCaptureResult
        try {
          result = await captureCompileSvg(
            {
              draftSvg: rawSvgContent,
              candidate: selectedCandidate,
              samples: sampleList,
              targetStatus: desiredStatus,
            },
            nativeRuntime,
          )
        } catch (err) {
          if (!nativeRuntime) throw err
          result = compileCaptureSvgLocal(rawSvgContent, selectedCandidate, sampleList, desiredStatus)
          setInfoBanner(`后端严格校验提示：${formatErr(err)}（已切换草稿兼容预览）`)
        }
        setCompiled(result)
        await captureSetLivePreviewSvg(result.svgContent, nativeRuntime).catch(() => {})
      } catch (err) {
        setErrorBanner(formatErr(err))
      } finally {
        setCompiling(false)
      }
    },
    [draft, nativeRuntime, rawSvgContent, samples, selectedCandidate],
  )

  useEffect(() => {
    if (step === 4 && rawSvgContent && draft) {
      void runCompileAndPreview(targetStatus)
    }
  }, [step, rawSvgContent, draft, targetStatus, runCompileAndPreview])

  const collisions = useMemo(() => {
    const local = detectSampleCollisions(samples.values())
    if (!compiled?.collisions.length) return local
    const seen = new Set(local.map(c => `${c.firstInputId}|${c.secondInputId}|${c.reportId}`))
    const merged = [...local]
    for (const item of compiled.collisions) {
      const sig = `${item.firstInputId}|${item.secondInputId}|${item.reportId}`
      if (!seen.has(sig)) merged.push(item)
    }
    return merged
  }, [compiled?.collisions, samples])

  const collisionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of collisions) {
      ids.add(item.firstInputId)
      ids.add(item.secondInputId)
    }
    return ids
  }, [collisions])

  const handleSelectKeyFromStageOrList = (inputId: string) => {
    if (step !== 3 && draft) {
      setSelectedInputId(inputId)
      if (step === 2) {
        setStep(3)
        void armKeySelection(inputId)
      }
      return
    }
    void armKeySelection(inputId)
  }

  const handleSkipCurrentKey = () => {
    if (!draft || !selectedInputId) return
    const nextSkipped = new Set(skippedIds)
    nextSkipped.add(selectedInputId)
    setSkippedIds(nextSkipped)
    const nextId = nextPendingInputId(draft.inputs, samples, selectedInputId, nextSkipped)
    if (nextId) {
      void armKeySelection(nextId)
    } else {
      void armKeySelection(null)
    }
  }

  const handleRecaptureCurrentKey = () => {
    if (!selectedInputId) return
    setSamples(prev => {
      if (!prev.has(selectedInputId)) return prev
      const copy = new Map(prev)
      copy.delete(selectedInputId)
      return copy
    })
    void armKeySelection(selectedInputId)
  }

  const handleBindProbeToArmedKey = (probe: DiscoveredProbeButton) => {
    if (!selectedInputId) return
    const sample: CapturedKeySample = {
      inputId: selectedInputId,
      reportId: probe.reportId,
      pressHex: probe.pressHex,
      releaseHex: probe.releaseHex,
      pressLength: probe.pressLength,
      releaseLength: probe.releaseLength,
      holdCount: probe.hitCount,
      durationMs: 0,
    }
    const nextSamples = new Map(samples)
    nextSamples.set(selectedInputId, sample)
    setSamples(nextSamples)
    if (autoAdvance && draft) {
      const nextId = nextPendingInputId(draft.inputs, nextSamples, selectedInputId, skippedIds)
      setSelectedInputId(nextId ?? selectedInputId)
    }
    onToast?.(`已绑定 ${probe.label}`)
  }

  const handleExportRawProbeJson = () => {
    const payload = {
      schema: 'axonkey.capture-probe/1',
      exportedAt: new Date().toISOString(),
      candidate: selectedCandidate,
      sessionStatus,
      discoveredButtons: discoveredProbeButtons,
      recentFrames: rawFrames,
    }
    const fileBase = draft?.deviceId || selectedCandidate?.displayName.replace(/[^\w-]+/g, '-') || 'device-probe'
    downloadTextFile(`${fileBase}.capture.json`, JSON.stringify(payload, null, 2), 'application/json')
  }

  const handleSaveExport = async () => {
    if (!compiled || !draft) return
    setSavingExport(true)
    setErrorBanner('')
    try {
      if (nativeRuntime) {
        const chosen = await save({
          defaultPath: `${draft.deviceId}.svg`,
          filters: [{ name: 'Axonkey 设备 SVG', extensions: ['svg'] }],
        })
        if (!chosen) return
        const mdPath = chosen.replace(/\.svg$/i, '') + '.md'
        await captureSaveExport(
          {
            svgPath: chosen,
            svgContent: compiled.svgContent,
            markdownPath: mdPath,
            markdownContent: compiled.markdownSummary,
          },
          true,
        )
        setExportedPath(chosen)
        onToast?.('已保存 SVG 与采集记录')
      } else {
        downloadTextFile(`${draft.deviceId}.svg`, compiled.svgContent, 'image/svg+xml')
        downloadTextFile(`${draft.deviceId}.md`, compiled.markdownSummary, 'text/markdown')
        setExportedPath(`${draft.deviceId}.svg`)
        onToast?.('已下载 SVG 与采集记录')
      }
    } catch (err) {
      setErrorBanner(formatErr(err))
    } finally {
      setSavingExport(false)
    }
  }

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard?.writeText(CLI_GENERATE_CMD)
      setCopiedCli(true)
      setTimeout(() => setCopiedCli(false), 1800)
    } catch {
      /* Clipboard may be unavailable in restricted contexts. */
    }
  }

  const handleRequestClose = async () => {
    const sessionMountedUnregistered = candidates.filter(
      item => item.boundToQuarbor && !item.registeredKind && sessionInstalledIds.has(item.instanceId.toUpperCase()),
    )
    if (sessionMountedUnregistered.length > 0) {
      setSafetyDialog({ mode: 'exit-cleanup', candidates: sessionMountedUnregistered })
      return
    }
    await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
    await captureStopSession(nativeRuntime).catch(() => {})
    onBack()
  }

  const currentInput = useMemo(
    () => draft?.inputs.find(item => item.id === selectedInputId) ?? null,
    [draft, selectedInputId],
  )

  const filteredInputs = useMemo(() => {
    if (!draft) return []
    return draft.inputs.filter(item => {
      if (keyFilter === 'pending') return !samples.has(item.id)
      if (keyFilter === 'captured') return samples.has(item.id)
      return true
    })
  }, [draft, keyFilter, samples])

  const adaptedCount = draft ? draft.inputs.filter(item => samples.has(item.id)).length : 0
  const totalCount = draft?.inputs.length ?? 0

  return (
    <section className="capture-workbench" aria-label="适配新设备工作台">
      <header className="device-workspace-header capture-workbench-header">
        <div className="device-workspace-title">
          <button
            type="button"
            className="device-workspace-back"
            aria-label="返回我的设备"
            onClick={() => void handleRequestClose()}
          >
            <ArrowLeft size={15} />
            我的设备
          </button>
          <h1>适配新设备</h1>
          {selectedCandidate && (
            <span className="capture-header-device-pill">
              {selectedCandidate.displayName} · {formatVidPid(selectedCandidate.vid, selectedCandidate.pid)}
            </span>
          )}
        </div>

        <div className="capture-header-status" aria-live="polite">
          {sessionStatus?.active ? (
            <span className="capture-session-badge is-connected">
              <i aria-hidden="true" />
              会话已连接 · {sessionStatus.frameCount} 帧
            </span>
          ) : (
            <span className="capture-session-badge">
              <i aria-hidden="true" />
              {nativeRuntime ? '未连接采集会话' : '浏览器预览模式'}
            </span>
          )}
        </div>
      </header>

      {unregisteredBound.length > 0 && (
        <div className="capture-orphan-banner" role="region" aria-label="未注册拦截驱动提醒">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="capture-orphan-copy">
            当前有 {unregisteredBound.length} 台未注册设备挂载了 Quarbor 拦截驱动：
            {unregisteredBound.map(item => item.displayName).join('、')}
          </span>
          <div className="capture-orphan-actions">
            {unregisteredBound.map(item => (
              <button
                key={item.instanceId}
                type="button"
                disabled={busyInstanceId !== null}
                onClick={() => void handleDetachDriver(item)}
              >
                <RotateCcw size={12} aria-hidden="true" />
                恢复原驱动{unregisteredBound.length > 1 ? `（${item.displayName}）` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {errorBanner && (
        <p className="capture-top-alert is-error" role="alert">
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner('')}>
            知道了
          </button>
        </p>
      )}

      {infoBanner && !errorBanner && (
        <p className="capture-top-alert is-info" role="status">
          <span>{infoBanner}</span>
          <button type="button" onClick={() => setInfoBanner('')}>
            关闭
          </button>
        </p>
      )}

      <div className="capture-workbench-grid">
        <CaptureSvgStage
          stageMode={stageMode}
          onStageModeChange={setStageMode}
          sanitizedSvg={sanitizedSvg}
          draft={draft}
          svgFileName={svgFileName}
          svgError={svgError}
          samples={samples}
          armedInputId={step === 3 ? selectedInputId : null}
          bindTargetInputId={selectedInputId}
          livePressedIds={livePressedIds}
          collisionIds={collisionIds}
          armedInputLabel={currentInput?.label ?? null}
          onSelectKey={handleSelectKeyFromStageOrList}
          onLoadSvgText={loadSvgContent}
          rawFrames={rawFrames}
          discoveredProbeButtons={discoveredProbeButtons}
          hideStreamingNoise={hideStreamingNoise}
          onToggleHideStreamingNoise={setHideStreamingNoise}
          onClearProbe={() => {
            setRawFrames([])
            setDiscoveredProbeButtons([])
            neutralByReportRef.current.clear()
          }}
          onExportRawProbeJson={handleExportRawProbeJson}
          onBindProbeToArmedKey={handleBindProbeToArmedKey}
        />

        <aside className="capture-flow-panel" aria-label="按键适配步骤面板">
          <nav className="capture-step-tabs" aria-label="适配流程步骤">
            <button
              type="button"
              aria-current={step === 1 ? 'step' : undefined}
              className={`capture-step-tab${step === 1 ? ' is-active' : ''}${sessionStatus?.active ? ' is-done' : ''}`}
              onClick={() => void enterStep(1)}
            >
              <span className="capture-step-num">1</span>
              <span>设备拦截</span>
            </button>
            <button
              type="button"
              aria-current={step === 2 ? 'step' : undefined}
              className={`capture-step-tab${step === 2 ? ' is-active' : ''}${draft ? ' is-done' : ''}`}
              onClick={() => void enterStep(2)}
            >
              <span className="capture-step-num">2</span>
              <span>加载图稿</span>
            </button>
            <button
              type="button"
              aria-current={step === 3 ? 'step' : undefined}
              className={`capture-step-tab${step === 3 ? ' is-active' : ''}${totalCount > 0 && adaptedCount === totalCount ? ' is-done' : ''}`}
              onClick={() => void enterStep(3)}
            >
              <span className="capture-step-num">3</span>
              <span>逐键采集</span>
              {totalCount > 0 && (
                <small>
                  {adaptedCount}/{totalCount}
                </small>
              )}
            </button>
            <button
              type="button"
              aria-current={step === 4 ? 'step' : undefined}
              className={`capture-step-tab${step === 4 ? ' is-active' : ''}${exportedPath ? ' is-done' : ''}`}
              onClick={() => void enterStep(4)}
            >
              <span className="capture-step-num">4</span>
              <span>试按导出</span>
            </button>
          </nav>

          <div className="capture-step-body">
            {step === 1 && (
              <>
                <CaptureDeviceList
                  native={nativeRuntime}
                  candidates={candidates}
                  selectedTargetId={selectedTargetId}
                  sessionStatus={sessionStatus}
                  loading={loadingCandidates}
                  busyInstanceId={busyInstanceId}
                  includeGatt={includeGatt}
                  onIncludeGattChange={setIncludeGatt}
                  onRefresh={withGatt => void refreshCandidates(withGatt)}
                  onSelectCandidate={candidate => setSelectedTargetId(candidate.targetId)}
                  onRequestAttachDriver={candidate => void handleRequestAttach(candidate)}
                  onDetachDriver={candidate => void handleDetachDriver(candidate)}
                  onStartSession={candidate => void startSessionForCandidate(candidate)}
                  onStopSession={() => void handleStopSession()}
                />
                <div className="capture-step-footer">
                  <button type="button" className="capture-btn-secondary" onClick={() => setStageMode('probe')}>
                    <Radio size={13} aria-hidden="true" />
                    无图探针
                  </button>
                  <button type="button" className="capture-btn-primary" onClick={() => void enterStep(2)}>
                    下一步：加载图稿
                  </button>
                </div>
              </>
            )}

            {step === 2 && (
              <div className="capture-draft-step">
                <input
                  ref={stepFileInputRef}
                  type="file"
                  accept=".svg,image/svg+xml"
                  hidden
                  aria-label="在步骤二选择 SVG 图稿文件"
                  onChange={event => void handleStepFilePick(event)}
                />

                <div className="capture-drop-card">
                  <FileCode2 size={24} aria-hidden="true" />
                  <div className="capture-drop-copy">
                    <strong>{svgFileName ?? '选择设备草稿 SVG'}</strong>
                    <span>
                      {draft
                        ? `${draft.displayName} (${draft.deviceId}) · 已适配 ${adaptedCount} / ${totalCount}`
                        : '支持 docs/device-drafts/*.svg 或已部分采集的描述文件'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="capture-btn-primary"
                    onClick={() => stepFileInputRef.current?.click()}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    {draft ? '重新选择' : '选择 SVG'}
                  </button>
                </div>

                {svgError && (
                  <p className="capture-inline-error" role="alert">
                    {svgError}
                  </p>
                )}

                {draft && (
                  <div className="capture-draft-meta-card">
                    <div className="capture-meta-grid">
                      <span>设备标识</span>
                      <code>{draft.deviceId}</code>
                      <span>展示名称</span>
                      <strong>{draft.displayName}</strong>
                      {(draft.vendor || draft.model) && (
                        <>
                          <span>厂商 / 型号</span>
                          <span>{[draft.vendor, draft.model].filter(Boolean).join(' · ')}</span>
                        </>
                      )}
                      <span>适配进度</span>
                      <strong className="is-accent">
                        已适配 {adaptedCount} / {totalCount}
                      </strong>
                    </div>
                  </div>
                )}

                <div className="capture-step-footer">
                  <button type="button" className="capture-btn-secondary" onClick={() => void enterStep(1)}>
                    上一步
                  </button>
                  <button
                    type="button"
                    className="capture-btn-primary"
                    disabled={!draft || draft.inputs.length === 0}
                    onClick={() => void enterStep(3)}
                  >
                    进入逐键采集
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="capture-keys-step">
                {!draft ? (
                  <div className="capture-empty-box">
                    <strong>尚未加载设备 SVG 图稿</strong>
                    <button type="button" className="capture-btn-primary" onClick={() => void enterStep(2)}>
                      去加载 SVG 图稿
                    </button>
                  </div>
                ) : (
                  <>
                    <div
                      className={`capture-prompt-card${armedWaiting && sessionStatus?.active ? ' is-armed' : ''}`}
                      aria-live="polite"
                    >
                      {currentInput ? (
                        <>
                          <div className="capture-prompt-head">
                            <strong className="capture-prompt-title">请按下并松开【{currentInput.label}】</strong>
                            <code className="capture-prompt-id">{currentInput.id}</code>
                          </div>

                          <div className="capture-prompt-status-row">
                            {!sessionStatus?.active ? (
                              <span className="capture-prompt-hint is-warn">
                                {nativeRuntime
                                  ? '尚未连接设备会话，请先在步骤 1 连接设备或用无图探针绑定'
                                  : '预览模式：点击左侧热区或下方按键查看已存报文'}
                              </span>
                            ) : armedWaiting ? (
                              <span className="capture-prompt-hint is-waiting">正在等待实体按键按下与抬起…</span>
                            ) : samples.has(currentInput.id) ? (
                              <span className="capture-prompt-hint is-done">
                                已记录按下帧：{samples.get(currentInput.id)?.pressHex}
                              </span>
                            ) : (
                              <span className="capture-prompt-hint">点击「重采」开始监听该按键</span>
                            )}
                          </div>

                          <div className="capture-prompt-controls">
                            <button type="button" className="capture-btn-secondary" onClick={handleSkipCurrentKey}>
                              <SkipForward size={13} aria-hidden="true" />
                              跳过
                            </button>
                            <button type="button" className="capture-btn-secondary" onClick={handleRecaptureCurrentKey}>
                              <RotateCcw size={13} aria-hidden="true" />
                              重采
                            </button>
                            <label className="capture-inline-check capture-auto-advance">
                              <input
                                type="checkbox"
                                checked={autoAdvance}
                                onChange={event => setAutoAdvance(event.target.checked)}
                              />
                              <span>自动跳到下一键</span>
                            </label>
                          </div>
                        </>
                      ) : (
                        <strong>请选择任意按键开始采集</strong>
                      )}
                    </div>

                    {streamingReportIds.length > 0 && (
                      <div className="capture-noise-notice" role="status">
                        已自动忽略持续数据流报告 {streamingReportIds.map(id => formatReportIdHex(id)).join('、')}
                      </div>
                    )}

                    {collisions.length > 0 && (
                      <div className="capture-collision-alert" role="alert">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <div className="capture-collision-list">
                          {collisions.map(item => {
                            const firstLabel =
                              draft.inputs.find(i => i.id === item.firstInputId)?.label ?? item.firstInputId
                            const secondLabel =
                              draft.inputs.find(i => i.id === item.secondInputId)?.label ?? item.secondInputId
                            return (
                              <div
                                key={`${item.firstInputId}-${item.secondInputId}-${item.reportId}`}
                                className="capture-collision-row"
                              >
                                <span>
                                  按键冲突：【{firstLabel}】与【{secondLabel}】按下报文相同（
                                  <code>{formatHexShort(item.pressHex, 5)}</code>）
                                </span>
                                <button type="button" onClick={() => void armKeySelection(item.secondInputId)}>
                                  重采 {secondLabel}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <div className="capture-key-filter-bar">
                      <div className="capture-filter-pills" role="group" aria-label="按键状态筛选">
                        <button type="button" aria-pressed={keyFilter === 'all'} onClick={() => setKeyFilter('all')}>
                          全部 ({totalCount})
                        </button>
                        <button
                          type="button"
                          aria-pressed={keyFilter === 'pending'}
                          onClick={() => setKeyFilter('pending')}
                        >
                          待采集 ({totalCount - adaptedCount})
                        </button>
                        <button
                          type="button"
                          aria-pressed={keyFilter === 'captured'}
                          onClick={() => setKeyFilter('captured')}
                        >
                          已采集 ({adaptedCount})
                        </button>
                      </div>
                    </div>

                    <div className="capture-key-list" role="list" aria-label="设备按键采集列表">
                      {filteredInputs.map(item => {
                        const sample = samples.get(item.id)
                        const isSelected = selectedInputId === item.id
                        const hasCollision = collisionIds.has(item.id)
                        const justCaptured = lastCapturedInputId === item.id
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="listitem"
                            data-key-row={item.id}
                            aria-pressed={isSelected}
                            className={`capture-key-row${isSelected ? ' is-selected' : ''}${sample ? ' is-captured' : ''}${hasCollision ? ' is-collision' : ''}${justCaptured ? ' is-flash' : ''}`}
                            onClick={() => void armKeySelection(item.id)}
                          >
                            <span className="capture-key-dot" aria-hidden="true" />
                            <span className="capture-key-label">{item.label}</span>
                            {sample ? (
                              <code className="capture-key-hex" title={sample.pressHex}>
                                {formatHexShort(sample.pressHex, 5)}
                              </code>
                            ) : (
                              <span className="capture-key-pending">
                                {skippedIds.has(item.id) ? '已跳过' : '待采集'}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>

                    <div className="capture-step-footer">
                      <span className="capture-footer-summary">
                        已适配 {adaptedCount} / {totalCount}
                      </span>
                      <button
                        type="button"
                        className="capture-btn-primary"
                        onClick={() => {
                          setTargetStatus(adaptedCount === totalCount && totalCount > 0 ? 'active' : 'draft')
                          void enterStep(4)
                        }}
                      >
                        <Play size={13} aria-hidden="true" />
                        进入试按与导出
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="capture-export-step">
                {!draft ? (
                  <div className="capture-empty-box">
                    <strong>请先加载 SVG 图稿后再编译导出</strong>
                    <button type="button" className="capture-btn-primary" onClick={() => void enterStep(2)}>
                      去加载 SVG 图稿
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="capture-live-test-card">
                      <div className="capture-live-test-head">
                        <Sparkles size={15} aria-hidden="true" />
                        <strong>实机试按验证</strong>
                        <span className={`capture-validation-pill ${compiled?.validated ? 'is-ok' : 'is-draft'}`}>
                          {compiling ? '正在编译…' : compiled?.validated ? '解析校验通过' : '草稿待完善'}
                        </span>
                      </div>

                      {liveHits.length === 0 ? (
                        <p className="capture-empty-hint">
                          {sessionStatus?.active
                            ? '现在按下遥控器实体按键，左侧对应 SVG 热区将实时亮起绿色'
                            : '连接设备会话后，按下实体按键可实时核对左侧 SVG 热区高亮'}
                        </p>
                      ) : (
                        <div className="capture-live-hit-list" aria-label="实机试按命中记录">
                          {liveHits.map(hit => (
                            <div key={hit.id} className={`capture-live-hit-row ${hit.pressed ? 'is-down' : 'is-up'}`}>
                              <strong>{hit.label}</strong>
                              <span>{hit.pressed ? '按下' : '松开'}</span>
                              <code>{formatHexShort(hit.hex, 5)}</code>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="capture-export-options">
                      <div className="capture-status-choice" role="radiogroup" aria-label="导出状态">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={targetStatus === 'active'}
                          className={targetStatus === 'active' ? 'is-selected' : undefined}
                          onClick={() => setTargetStatus('active')}
                        >
                          正式启用 (active)
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={targetStatus === 'draft'}
                          className={targetStatus === 'draft' ? 'is-selected' : undefined}
                          onClick={() => setTargetStatus('draft')}
                        >
                          保留草稿 (draft)
                        </button>
                      </div>

                      {compiled && (
                        <div className="capture-compile-counts">
                          <span>已适配 {compiled.adaptedCount} 键</span>
                          <span>待采集 {compiled.pendingCount} 键</span>
                        </div>
                      )}
                    </div>

                    {collisions.length > 0 && (
                      <div className="capture-collision-alert" role="alert">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>存在 {collisions.length} 组相同按下报文冲突，建议返回步骤 3 重采确认</span>
                      </div>
                    )}

                    <button
                      type="button"
                      className="capture-btn-primary capture-export-btn"
                      disabled={!compiled || compiling || savingExport}
                      onClick={() => void handleSaveExport()}
                    >
                      <Download size={15} aria-hidden="true" />
                      {savingExport ? '正在保存…' : '保存 SVG 与采集记录'}
                    </button>

                    {exportedPath && (
                      <p className="capture-exported-path" role="status">
                        已输出：<code>{exportedPath}</code>
                      </p>
                    )}

                    <div className="capture-cli-next">
                      <div className="capture-cli-next-head">
                        <span>放入 public/device-descriptors/ 后生成索引</span>
                        <button
                          type="button"
                          className="capture-copy-btn"
                          onClick={() => void handleCopyCli()}
                          aria-label="复制设备索引生成命令"
                        >
                          {copiedCli ? <Check size={13} /> : <Copy size={13} />}
                          {copiedCli ? '已复制' : '复制'}
                        </button>
                      </div>
                      <code>{CLI_GENERATE_CMD}</code>
                    </div>

                    <div className="capture-step-footer">
                      <button type="button" className="capture-btn-secondary" onClick={() => void enterStep(3)}>
                        返回逐键采集
                      </button>
                      <button
                        type="button"
                        className="capture-btn-secondary"
                        disabled={compiling}
                        onClick={() => void runCompileAndPreview(targetStatus)}
                      >
                        重新编译
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {safetyDialog &&
        createPortal(
          <CaptureSafetyConfirmDialog
            state={safetyDialog}
            busy={dialogBusy}
            onCancel={() => setSafetyDialog(null)}
            onConfirmPreAttach={(candidate, passthrough) => void handleConfirmPreAttach(candidate, passthrough)}
            onConfirmKeepAlive={candidate => {
              setSafetyDialog(null)
              setInfoBanner(`已确认主输入正常，${candidate.displayName} 可开始采集`)
            }}
            onRollbackKeepAlive={candidate => {
              void (async () => {
                setDialogBusy(true)
                try {
                  await handleDetachDriver(candidate)
                } finally {
                  setDialogBusy(false)
                  setSafetyDialog(null)
                }
              })()
            }}
            onExitAndRestore={mountedList => {
              void (async () => {
                setDialogBusy(true)
                try {
                  await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
                  await captureStopSession(nativeRuntime).catch(() => {})
                  for (const item of mountedList) {
                    await handleDetachDriver(item)
                  }
                  setSafetyDialog(null)
                  onBack()
                } finally {
                  setDialogBusy(false)
                }
              })()
            }}
            onExitKeepDriver={() => {
              void (async () => {
                setDialogBusy(true)
                try {
                  await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
                  await captureStopSession(nativeRuntime).catch(() => {})
                  setSafetyDialog(null)
                  onBack()
                } finally {
                  setDialogBusy(false)
                }
              })()
            }}
          />,
          document.body,
        )}
    </section>
  )
}

function mergeReportIds(existing: readonly number[], incoming: readonly number[]): number[] {
  if (incoming.length === 0) return [...existing]
  const set = new Set([...existing, ...incoming])
  return [...set].sort((a, b) => a - b)
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
