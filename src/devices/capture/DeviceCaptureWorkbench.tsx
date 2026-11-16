import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { save } from '@tauri-apps/plugin-dialog'
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  Copy,
  Download,
  FileCode2,
  FolderOpen,
  GripVertical,
  Link2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  buildPreviewLocalCustomDeviceEntry,
  getLocalCloudDescriptorOverrides,
  upsertLocalCustomDevice,
  type LocalCustomDeviceEntry,
} from '../../cloud/deviceModelCatalog'
import { deviceDescriptors } from '../generatedDescriptors'
import type { DeviceKind } from '../integration/model'
import { CaptureDeviceList } from './CaptureDeviceList'
import { CaptureSafetyConfirmDialog, type CaptureSafetyDialogState } from './CaptureSafetyConfirmDialog'
import { CaptureSvgStage, type RawCaptureFrameItem } from './CaptureSvgStage'
import {
  HID_EVENT_DRAG_MIME,
  accumulatePairedHidEvent,
  accumulateProbeFrame,
  captureArmKey,
  captureAttachDriver,
  captureCompileSvg,
  captureDetachDriver,
  captureInstallLocalDevice,
  captureListCandidates,
  captureOpenLocalDevicesDir,
  captureParseDraftSvg,
  captureSaveExport,
  captureSetLivePreviewSvg,
  captureSetWorkbenchActive,
  captureStartSession,
  captureStopSession,
  clearSvgKeyDefinitions,
  compileCaptureSvgLocal,
  createHidPairTrackerState,
  detectSampleCollisions,
  findUnregisteredBoundCandidates,
  formatHexShort,
  formatReportIdHex,
  formatVidPid,
  getTempCaptureSnapshot,
  isInputDefined,
  isTauriCaptureRuntime,
  listenCaptureEvents,
  matchSamplesAgainstRawFrame,
  nextPendingInputId,
  normalizeHexBytes,
  parseCaptureDraftSvgLocal,
  sanitizeAndExtractSvgStage,
  seedSamplesFromDraft,
  setTempCaptureSnapshot,
  type CaptureCandidate,
  type CaptureDeviceSnapshot,
  type CapturedKeySample,
  type CaptureSessionStatus,
  type CompiledCaptureResult,
  type DiscoveredProbeButton,
  type PairedHidEventItem,
  type PairedHidEventSource,
  type ParsedCaptureDraft,
  type SanitizedCaptureSvg,
} from './model'
import './DeviceCaptureWorkbench.css'

export type DeviceCaptureWorkbenchProps = {
  native?: boolean
  onBack: () => void
  onDevicesChanged?: () => void
  onInstalledLocalDevice?: (kind: DeviceKind) => void
  onToast?: (message: string) => void
}

type WorkbenchStep = 1 | 2 | 3 | 4
type KeyFilter = 'all' | 'pending' | 'captured'
type StreamSubTab = 'events' | 'keys'

type LiveHitEntry = {
  id: number
  inputId: string
  label: string
  pressed: boolean
  reportId: number
  hex: string
}

type KeyTestRecord = {
  pressedNow: boolean
  verifiedPress: boolean
  verifiedRelease: boolean
  lastHex: string | null
}

type RepoSvgPreset = {
  slug: string
  label: string
  artworkUrl: string
  inputCount: number
}

const MAX_RAW_FRAMES = 80
const MAX_PAIRED_EVENTS = 60
const MAX_LIVE_HITS = 12
const EMPTY_STRING_SET: ReadonlySet<string> = new Set()
const CLI_GENERATE_CMD = 'npm run generate:devices'
const SKILL_SVG_PROMPT =
  '请使用 axonkey-device-svg 技能，根据设备实拍照片生成 docs/device-drafts/<device-id>.svg 规范图稿'

const REPO_SVG_PRESETS: readonly RepoSvgPreset[] = Object.entries(deviceDescriptors).map(([slug, item]) => ({
  slug,
  label: item.ariaLabel || slug,
  artworkUrl: item.artworkUrl,
  inputCount: item.inputs.length,
}))

export function DeviceCaptureWorkbench({
  native,
  onBack,
  onDevicesChanged,
  onInstalledLocalDevice,
  onToast,
}: DeviceCaptureWorkbenchProps) {
  const nativeRuntime = isTauriCaptureRuntime(native)
  const stepFileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<WorkbenchStep>(1)
  const [streamTab, setStreamTab] = useState<StreamSubTab>('events')
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(true)

  const [candidates, setCandidates] = useState<CaptureCandidate[]>([])
  const [candidatesInitialized, setCandidatesInitialized] = useState(false)
  const [baselineSnapshot, setBaselineSnapshot] = useState<CaptureDeviceSnapshot | null>(() => getTempCaptureSnapshot())
  const latestCandidatesRef = useRef<CaptureCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [includeGatt, setIncludeGatt] = useState(false)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [recordedCandidate, setRecordedCandidate] = useState<CaptureCandidate | null>(null)
  const [busyInstanceId, setBusyInstanceId] = useState<string | null>(null)
  const [sessionInstalledIds, setSessionInstalledIds] = useState<Set<string>>(() => new Set())
  const passthroughByInstanceRef = useRef<Map<string, boolean>>(new Map())

  const [sessionStatus, setSessionStatus] = useState<CaptureSessionStatus | null>(null)
  const [streamingReportIds, setStreamingReportIds] = useState<number[]>([])
  const [rawFrames, setRawFrames] = useState<RawCaptureFrameItem[]>([])
  const [pairedHidEvents, setPairedHidEvents] = useState<PairedHidEventItem[]>([])
  const [discoveredProbeButtons, setDiscoveredProbeButtons] = useState<DiscoveredProbeButton[]>([])
  const [draggingHidEventId, setDraggingHidEventId] = useState<string | null>(null)
  const [dropKeyRowId, setDropKeyRowId] = useState<string | null>(null)
  const neutralByReportRef = useRef<Map<number, string>>(new Map())
  const pairTrackerRef = useRef(createHidPairTrackerState())

  const [rawSvgContent, setRawSvgContent] = useState('')
  const [sanitizedSvg, setSanitizedSvg] = useState<SanitizedCaptureSvg | null>(null)
  const [draft, setDraft] = useState<ParsedCaptureDraft | null>(null)
  const [svgFileName, setSvgFileName] = useState<string | null>(null)
  const [svgError, setSvgError] = useState('')
  const [loadingPresetSlug, setLoadingPresetSlug] = useState<string | null>(null)
  const [copiedSkillPrompt, setCopiedSkillPrompt] = useState(false)

  const [samples, setSamples] = useState<Map<string, CapturedKeySample>>(() => new Map())
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set())
  const [selectedInputId, setSelectedInputId] = useState<string | null>(null)
  const [armedWaiting, setArmedWaiting] = useState(false)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [keyFilter, setKeyFilter] = useState<KeyFilter>('all')
  const [lastCapturedInputId, setLastCapturedInputId] = useState<string | null>(null)

  const [livePressedIds, setLivePressedIds] = useState<Set<string>>(() => new Set())
  const [liveReleasedIds, setLiveReleasedIds] = useState<Set<string>>(() => new Set())
  const [lastLiveTransition, setLastLiveTransition] = useState<{ label: string; pressed: boolean } | null>(null)
  const [testRecords, setTestRecords] = useState<Map<string, KeyTestRecord>>(() => new Map())
  const [liveHits, setLiveHits] = useState<LiveHitEntry[]>([])
  const liveHitCounterRef = useRef(0)
  const livePressedIdsRef = useRef<Set<string>>(new Set())
  const livePreviewReadyRef = useRef(false)
  const compileReqIdRef = useRef(0)

  const [targetStatus, setTargetStatus] = useState<'active' | 'draft'>('active')
  const [compiled, setCompiled] = useState<CompiledCaptureResult | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [savingExport, setSavingExport] = useState(false)
  const [installingLocal, setInstallingLocal] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [localDeviceEntry, setLocalDeviceEntry] = useState<LocalCustomDeviceEntry | null>(null)
  const [copiedCli, setCopiedCli] = useState(false)

  const [errorBanner, setErrorBanner] = useState('')
  const [infoBanner, setInfoBanner] = useState('')
  const [safetyDialog, setSafetyDialog] = useState<CaptureSafetyDialogState | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)

  const selectedCandidate = useMemo(
    () => candidates.find(item => item.targetId === selectedTargetId) ?? null,
    [candidates, selectedTargetId],
  )

  const activeSessionCandidate = useMemo(() => {
    if (!sessionStatus?.active) return null
    return (
      candidates.find(
        item =>
          (sessionStatus.targetId && item.targetId === sessionStatus.targetId) ||
          (sessionStatus.instanceId && item.instanceId.toUpperCase() === sessionStatus.instanceId.toUpperCase()),
      ) ?? selectedCandidate
    )
  }, [candidates, selectedCandidate, sessionStatus])

  const effectiveCandidate = recordedCandidate ?? activeSessionCandidate ?? selectedCandidate

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
  const activeSessionCandidateRef = useRef<CaptureCandidate | null>(activeSessionCandidate)
  activeSessionCandidateRef.current = activeSessionCandidate ?? selectedCandidate

  const unregisteredBound = useMemo(() => findUnregisteredBoundCandidates(candidates), [candidates])

  const refreshCandidates = useCallback(
    async (withGatt = includeGatt) => {
      if (!nativeRuntime) return
      setLoadingCandidates(true)
      try {
        const list = await captureListCandidates({ includeGatt: withGatt, native: nativeRuntime })
        latestCandidatesRef.current = list
        setCandidates(list)
        setCandidatesInitialized(true)
        setBaselineSnapshot(prev => prev ?? setTempCaptureSnapshot(list))
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
    if (!nativeRuntime) return
    let disposed = false
    void (async () => {
      await captureSetWorkbenchActive(true, true).catch(() => {})
      if (!disposed) {
        await refreshCandidates(false)
      }
    })()
    return () => {
      disposed = true
      void captureSetWorkbenchActive(false, true).catch(() => {})
    }
  }, [nativeRuntime, refreshCandidates])

  useEffect(() => {
    return () => {
      if (latestCandidatesRef.current !== null) {
        setTempCaptureSnapshot(latestCandidatesRef.current)
      }
    }
  }, [])

  const applyLiveKeyTransition = useCallback((inputId: string, pressed: boolean, reportId: number, hex: string) => {
    setLivePressedIds(prev => {
      const next = new Set(prev)
      if (pressed) next.add(inputId)
      else next.delete(inputId)
      livePressedIdsRef.current = next
      return next
    })
    setLiveReleasedIds(prev => {
      const next = new Set(prev)
      if (pressed) next.delete(inputId)
      else next.add(inputId)
      return next
    })
    setTestRecords(prev => {
      const next = new Map(prev)
      const current = next.get(inputId) ?? {
        pressedNow: false,
        verifiedPress: false,
        verifiedRelease: false,
        lastHex: null,
      }
      next.set(inputId, {
        pressedNow: pressed,
        verifiedPress: current.verifiedPress || pressed,
        verifiedRelease: current.verifiedRelease || (!pressed && (current.pressedNow || current.verifiedPress)),
        lastHex: hex,
      })
      return next
    })

    const label = draftRef.current?.inputs.find(item => item.id === inputId)?.label ?? inputId
    setLastLiveTransition({ label, pressed })
    liveHitCounterRef.current += 1
    setLiveHits(prev =>
      [
        {
          id: liveHitCounterRef.current,
          inputId,
          label,
          pressed,
          reportId,
          hex,
        },
        ...prev,
      ].slice(0, MAX_LIVE_HITS),
    )
  }, [])

  const armKeySelection = useCallback(
    async (inputId: string | null) => {
      if (!inputId) {
        setArmedWaiting(false)
        await captureArmKey(null, nativeRuntime).catch(() => {})
        return
      }
      compileReqIdRef.current += 1
      livePreviewReadyRef.current = false
      livePressedIdsRef.current = new Set()
      setLivePressedIds(new Set())
      setLiveReleasedIds(new Set())
      setLastLiveTransition(null)
      setSelectedInputId(inputId)
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
        const source = candidateToEventSource(activeSessionCandidateRef.current)
        setPairedHidEvents(prev =>
          accumulatePairedHidEvent(prev, pairTrackerRef.current, payload, source, MAX_PAIRED_EVENTS),
        )

        if (stepRef.current === 4 && !livePreviewReadyRef.current && !payload.isStreamingNoise) {
          const matched = matchSamplesAgainstRawFrame(samplesRef.current.values(), livePressedIdsRef.current, payload)
          for (const releasedId of matched.releasedIds) {
            applyLiveKeyTransition(releasedId, false, payload.reportId, payload.hex)
          }
          for (const pressedId of matched.pressedIds) {
            applyLiveKeyTransition(pressedId, true, payload.reportId, payload.hex)
          }
        }
        return
      }

      if (payload.kind === 'keyCaptured') {
        const sourceCand = activeSessionCandidateRef.current
        const enrichedSample: CapturedKeySample = {
          ...payload.sample,
          sourceTargetId: sourceCand?.targetId ?? null,
          sourceInstanceId: sourceCand?.instanceId ?? null,
          sourceDeviceName: sourceCand?.displayName ?? null,
          sourceVid: sourceCand?.vid ?? null,
          sourcePid: sourceCand?.pid ?? null,
        }
        if (sourceCand) setRecordedCandidate(sourceCand)

        const nextSamples = new Map(samplesRef.current)
        nextSamples.set(enrichedSample.inputId, enrichedSample)
        samplesRef.current = nextSamples
        setSamples(nextSamples)
        setCompiled(null)
        setExportedPath(null)
        setLastCapturedInputId(enrichedSample.inputId)

        setSkippedIds(prev => {
          if (!prev.has(enrichedSample.inputId)) return prev
          const copy = new Set(prev)
          copy.delete(enrichedSample.inputId)
          skippedIdsRef.current = copy
          return copy
        })

        const hasNewCollisions = detectSampleCollisions(nextSamples.values()).length > 0
        if (hasNewCollisions) {
          setInfoBanner(prev => (prev.startsWith('全部按键已完成采集') ? '' : prev))
        }

        const currentDraft = draftRef.current
        if (autoAdvanceRef.current && currentDraft && stepRef.current === 3) {
          const nextId = nextPendingInputId(
            currentDraft.inputs,
            nextSamples,
            enrichedSample.inputId,
            skippedIdsRef.current,
          )
          setSelectedInputId(nextId ?? enrichedSample.inputId)
          setArmedWaiting(Boolean(nextId))
          void captureArmKey(nextId, nativeRuntime).catch(() => {})
          if (!nextId && !hasNewCollisions) {
            setInfoBanner('全部按键已完成采集，可进入「测试与导出」逐键核对按下与抬起状态')
          }
        } else {
          setArmedWaiting(false)
          void captureArmKey(null, nativeRuntime).catch(() => {})
        }
        return
      }

      if (payload.kind === 'liveHit') {
        if (stepRef.current !== 4) return
        applyLiveKeyTransition(payload.inputId, payload.pressed, payload.reportId, payload.hex)
      }
    }, nativeRuntime).then(stop => {
      if (active) unlisten = stop
      else stop()
    })

    return () => {
      active = false
      unlisten?.()
      livePreviewReadyRef.current = false
      void captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
      void captureStopSession(nativeRuntime).catch(() => {})
    }
  }, [applyLiveKeyTransition, nativeRuntime])

  const enterStep = useCallback(
    async (nextStep: WorkbenchStep) => {
      if (stepRef.current === 4 && nextStep !== 4) {
        compileReqIdRef.current += 1
        livePreviewReadyRef.current = false
        livePressedIdsRef.current = new Set()
        setLivePressedIds(new Set())
        setLiveReleasedIds(new Set())
        setLastLiveTransition(null)
        await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
      }
      if (stepRef.current === 3 && nextStep !== 3) {
        setArmedWaiting(false)
        await captureArmKey(null, nativeRuntime).catch(() => {})
      }
      stepRef.current = nextStep
      setStep(nextStep)
      if (nextStep === 3 && draftRef.current && !selectedInputId) {
        const targetId =
          nextPendingInputId(draftRef.current.inputs, samplesRef.current, null, skippedIdsRef.current) ??
          draftRef.current.inputs[0]?.id ??
          null
        setSelectedInputId(targetId)
      }
    },
    [nativeRuntime, selectedInputId],
  )

  const startSessionForCandidate = useCallback(
    async (candidate: CaptureCandidate, passthroughOverride?: boolean, advanceToWorkspace = false) => {
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
        activeSessionCandidateRef.current = candidate
        setSessionStatus(status)
        setStreamingReportIds(status.streamingReportIds)
        setSelectedTargetId(candidate.targetId)
        if (advanceToWorkspace && stepRef.current <= 2) {
          await enterStep(3)
        }
        return true
      } catch (err) {
        setErrorBanner(formatErr(err))
        return false
      }
    },
    [enterStep, nativeRuntime],
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
      await startSessionForCandidate(candidate, false, true)
    }
  }

  const handleConfirmPreAttach = async (candidate: CaptureCandidate, passthroughStandardKeys: boolean) => {
    setDialogBusy(true)
    try {
      const mounted = await performAttachDriver(candidate, true, passthroughStandardKeys)
      if (mounted) {
        await startSessionForCandidate(candidate, passthroughStandardKeys, false)
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
      livePressedIdsRef.current = new Set()
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
        samplesRef.current = seeded
        setSamples(seeded)
        skippedIdsRef.current = new Set()
        setSkippedIds(new Set())
        setLastCapturedInputId(null)
        setCompiled(null)
        setTestRecords(new Map())
        setLiveReleasedIds(new Set())
        setLastLiveTransition(null)

        const firstPending = nextPendingInputId(parsed.inputs, seeded) ?? parsed.inputs[0]?.id ?? null
        setSelectedInputId(firstPending)
        const definedCount = parsed.inputs.filter(item => isInputDefined(item, seeded)).length
        setTargetStatus(definedCount === parsed.inputs.length && parsed.inputs.length > 0 ? 'active' : 'draft')
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

  const handleLoadRepoPreset = async (preset: RepoSvgPreset) => {
    setLoadingPresetSlug(preset.slug)
    setSvgError('')
    try {
      const response = await fetch(preset.artworkUrl)
      if (!response.ok) {
        throw new Error(`加载模板失败 (${response.status})`)
      }
      const svgText = await response.text()
      await loadSvgContent(svgText, `${preset.slug}.svg`)
    } catch (err) {
      setSvgError(formatErr(err))
    } finally {
      setLoadingPresetSlug(null)
    }
  }

  const runCompileAndPreview = useCallback(
    async (desiredStatus: 'active' | 'draft') => {
      if (!rawSvgContent || !draft) return
      const reqId = ++compileReqIdRef.current
      setCompiling(true)
      setErrorBanner('')
      try {
        await captureArmKey(null, nativeRuntime).catch(() => {})
        setArmedWaiting(false)
        const sampleList = [...samples.values()]
        let result: CompiledCaptureResult
        let backendValidated = false
        try {
          result = await captureCompileSvg(
            {
              draftSvg: rawSvgContent,
              candidate: effectiveCandidate,
              samples: sampleList,
              targetStatus: desiredStatus,
            },
            nativeRuntime,
          )
          backendValidated = true
        } catch (err) {
          if (!nativeRuntime) throw err
          result = compileCaptureSvgLocal(rawSvgContent, effectiveCandidate, sampleList, desiredStatus)
          if (reqId === compileReqIdRef.current && stepRef.current === 4) {
            setInfoBanner(`后端严格校验提示：${formatErr(err)}（已启用本地按键报文测试与草稿预览）`)
          }
        }
        if (reqId !== compileReqIdRef.current || stepRef.current !== 4) {
          return
        }
        setCompiled(result)
        if (backendValidated && nativeRuntime) {
          const ok = await captureSetLivePreviewSvg(result.svgContent, nativeRuntime).catch(() => false)
          if (reqId === compileReqIdRef.current && stepRef.current === 4) {
            livePreviewReadyRef.current = Boolean(ok)
          } else {
            livePreviewReadyRef.current = false
            void captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
          }
        } else {
          livePreviewReadyRef.current = false
          await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
        }
      } catch (err) {
        if (reqId === compileReqIdRef.current) {
          setErrorBanner(formatErr(err))
        }
      } finally {
        if (reqId === compileReqIdRef.current) {
          setCompiling(false)
        }
      }
    },
    [draft, effectiveCandidate, nativeRuntime, rawSvgContent, samples],
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

  const boundLabelsByEventSig = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!draft) return map
    const labelById = new Map(draft.inputs.map(item => [item.id, item.label]))
    for (const sample of samples.values()) {
      const norm = normalizeHexBytes(sample.pressHex)?.hex ?? sample.pressHex.trim().toUpperCase()
      if (!norm) continue
      const sig = `${sample.reportId}:${norm}`
      const list = map.get(sig) ?? []
      list.push(labelById.get(sample.inputId) ?? sample.inputId)
      map.set(sig, list)
    }
    return map
  }, [draft, samples])

  const handleSelectKeyFromStageOrList = (inputId: string) => {
    if (!draft) return
    if (step === 3) {
      void armKeySelection(inputId)
      return
    }
    setSelectedInputId(inputId)
    if (step === 2 && sessionStatus?.active) {
      setStep(3)
      void armKeySelection(inputId)
    }
  }

  const handleStartSequentialCapture = () => {
    if (!draft || draft.inputs.length === 0) return
    const selectedItem = selectedInputId ? draft.inputs.find(item => item.id === selectedInputId) : undefined
    const targetId =
      selectedItem && !isInputDefined(selectedItem, samples)
        ? selectedItem.id
        : (nextPendingInputId(draft.inputs, samples, null, skippedIds) ?? selectedInputId ?? draft.inputs[0].id)
    void armKeySelection(targetId)
  }

  const handleSkipCurrentKey = () => {
    if (!draft || !selectedInputId) return
    const nextSkipped = new Set(skippedIds)
    nextSkipped.add(selectedInputId)
    skippedIdsRef.current = nextSkipped
    setSkippedIds(nextSkipped)
    const nextId = nextPendingInputId(draft.inputs, samples, selectedInputId, nextSkipped)
    if (nextId) {
      void armKeySelection(nextId)
    } else {
      void armKeySelection(null)
    }
  }

  const handleClearKeyDefinition = useCallback(
    (inputId: string, options?: { armAfter?: boolean; silent?: boolean }) => {
      const currentDraft = draftRef.current
      const keyLabel = currentDraft?.inputs.find(item => item.id === inputId)?.label ?? inputId

      if (rawSvgContent) {
        const strippedSvg = clearSvgKeyDefinitions(rawSvgContent, new Set([inputId]))
        if (strippedSvg !== rawSvgContent) {
          const nextSanitized = sanitizeAndExtractSvgStage(strippedSvg)
          setRawSvgContent(nextSanitized.svgContent)
          setSanitizedSvg(nextSanitized)
        }
      }

      if (currentDraft) {
        const nextDraft: ParsedCaptureDraft = {
          ...currentDraft,
          status: 'draft',
          inputs: currentDraft.inputs.map(item =>
            item.id === inputId ? { ...item, binding: 'pending', pressHex: null, releaseHex: null } : item,
          ),
        }
        draftRef.current = nextDraft
        setDraft(nextDraft)
      }

      const nextSamples = new Map(samplesRef.current)
      nextSamples.delete(inputId)
      samplesRef.current = nextSamples
      setSamples(nextSamples)

      setTestRecords(prev => {
        if (!prev.has(inputId)) return prev
        const next = new Map(prev)
        next.delete(inputId)
        return next
      })
      setLivePressedIds(prev => {
        if (!prev.has(inputId)) return prev
        const next = new Set(prev)
        next.delete(inputId)
        livePressedIdsRef.current = next
        return next
      })
      setLiveReleasedIds(prev => {
        if (!prev.has(inputId)) return prev
        const next = new Set(prev)
        next.delete(inputId)
        return next
      })
      setCompiled(null)
      setExportedPath(null)
      setTargetStatus('draft')
      setInfoBanner(prev => (prev.startsWith('全部按键已完成采集') ? '' : prev))

      if (options?.armAfter) {
        if (stepRef.current === 4) {
          compileReqIdRef.current += 1
          livePreviewReadyRef.current = false
          setLastLiveTransition(null)
          void captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
          stepRef.current = 3
          setStep(3)
        }
        void armKeySelection(inputId)
        return
      }

      if (selectedInputId === inputId && armedWaiting) {
        void armKeySelection(null)
      } else if (!armedWaiting && stepRef.current === 3) {
        setSelectedInputId(inputId)
      }
      if (!options?.silent) {
        onToast?.(`已清空【${keyLabel}】按键定义`)
      }
    },
    [armKeySelection, armedWaiting, nativeRuntime, onToast, rawSvgContent, selectedInputId],
  )

  const handleClearAllKeyDefinitions = useCallback(() => {
    const currentDraft = draftRef.current
    if (!currentDraft) return

    if (rawSvgContent) {
      const strippedSvg = clearSvgKeyDefinitions(rawSvgContent)
      const nextSanitized = sanitizeAndExtractSvgStage(strippedSvg)
      const nextDraft = parseCaptureDraftSvgLocal(nextSanitized.svgContent)
      setRawSvgContent(nextSanitized.svgContent)
      setSanitizedSvg(nextSanitized)
      draftRef.current = nextDraft
      setDraft(nextDraft)
    } else {
      const nextDraft: ParsedCaptureDraft = {
        ...currentDraft,
        status: 'draft',
        inputs: currentDraft.inputs.map(item => ({
          ...item,
          binding: 'pending',
          pressHex: null,
          releaseHex: null,
        })),
      }
      draftRef.current = nextDraft
      setDraft(nextDraft)
    }

    const emptySamples = new Map<string, CapturedKeySample>()
    samplesRef.current = emptySamples
    setSamples(emptySamples)
    skippedIdsRef.current = new Set()
    setSkippedIds(new Set())
    setLastCapturedInputId(null)
    setCompiled(null)
    setExportedPath(null)
    setTargetStatus('draft')
    setTestRecords(new Map())
    setLiveHits([])
    livePressedIdsRef.current = new Set()
    setLivePressedIds(new Set())
    setLiveReleasedIds(new Set())
    setLastLiveTransition(null)
    compileReqIdRef.current += 1
    livePreviewReadyRef.current = false
    void captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})

    const firstId = draftRef.current?.inputs[0]?.id ?? null
    setSelectedInputId(firstId)
    void armKeySelection(null)
    setInfoBanner('已清空全部按键定义，可重新逐键采集或拖拽绑定')
    onToast?.('已清空全部按键定义')
  }, [armKeySelection, nativeRuntime, onToast, rawSvgContent])

  const handleRecaptureCurrentKey = () => {
    if (!selectedInputId) return
    handleClearKeyDefinition(selectedInputId, { armAfter: true, silent: true })
  }

  const handleAssignHidEventToKey = useCallback(
    (inputId: string, eventId: string) => {
      const eventItem = pairedHidEvents.find(item => item.id === eventId)
      if (!eventItem) return

      const matchedCand =
        candidates.find(
          c =>
            (eventItem.source.targetId && c.targetId === eventItem.source.targetId) ||
            (eventItem.source.instanceId && c.instanceId === eventItem.source.instanceId),
        ) ??
        activeSessionCandidate ??
        selectedCandidate

      if (matchedCand) {
        setRecordedCandidate(matchedCand)
      }

      const sample: CapturedKeySample = {
        inputId,
        reportId: eventItem.reportId,
        pressHex: eventItem.pressHex,
        releaseHex: eventItem.releaseHex,
        pressLength: eventItem.pressLength,
        releaseLength: eventItem.releaseLength,
        holdCount: eventItem.hitCount,
        durationMs: 0,
        sourceTargetId: eventItem.source.targetId ?? matchedCand?.targetId ?? null,
        sourceInstanceId: eventItem.source.instanceId ?? matchedCand?.instanceId ?? null,
        sourceDeviceName: eventItem.source.deviceName ?? matchedCand?.displayName ?? null,
        sourceVid: eventItem.source.vid ?? matchedCand?.vid ?? null,
        sourcePid: eventItem.source.pid ?? matchedCand?.pid ?? null,
      }

      const nextSamples = new Map(samplesRef.current)
      nextSamples.set(inputId, sample)
      samplesRef.current = nextSamples
      setSamples(nextSamples)
      setCompiled(null)
      setExportedPath(null)
      setLastCapturedInputId(inputId)

      setSkippedIds(prev => {
        if (!prev.has(inputId)) return prev
        const copy = new Set(prev)
        copy.delete(inputId)
        skippedIdsRef.current = copy
        return copy
      })

      const keyLabel = draftRef.current?.inputs.find(item => item.id === inputId)?.label ?? inputId
      if (autoAdvance && draftRef.current) {
        const nextId = nextPendingInputId(draftRef.current.inputs, nextSamples, inputId, skippedIdsRef.current)
        setSelectedInputId(nextId ?? inputId)
        if (armedWaiting && selectedInputId === inputId) {
          setArmedWaiting(Boolean(nextId))
          void captureArmKey(nextId, nativeRuntime).catch(() => {})
        }
      } else {
        setSelectedInputId(inputId)
        if (armedWaiting && selectedInputId === inputId) {
          setArmedWaiting(false)
          void captureArmKey(null, nativeRuntime).catch(() => {})
        }
      }

      setDraggingHidEventId(null)
      setDropKeyRowId(null)
      onToast?.(`已记录【${keyLabel}】按下与抬起报文`)
    },
    [
      activeSessionCandidate,
      armedWaiting,
      autoAdvance,
      candidates,
      nativeRuntime,
      onToast,
      pairedHidEvents,
      selectedCandidate,
      selectedInputId,
    ],
  )

  const handleEventDragStart = (event: DragEvent<HTMLElement>, item: PairedHidEventItem) => {
    setDraggingHidEventId(item.id)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData(HID_EVENT_DRAG_MIME, item.id)
      event.dataTransfer.setData('text/plain', `${item.pressHex} -> ${item.releaseHex}`)
    }
  }

  const handleEventDragEnd = () => {
    setDraggingHidEventId(null)
    setDropKeyRowId(null)
  }

  const handleClearStream = () => {
    setRawFrames([])
    setPairedHidEvents([])
    setDiscoveredProbeButtons([])
    neutralByReportRef.current.clear()
    pairTrackerRef.current = createHidPairTrackerState()
  }

  const handleResetLiveTest = () => {
    livePressedIdsRef.current = new Set()
    setLivePressedIds(new Set())
    setLiveReleasedIds(new Set())
    setLastLiveTransition(null)
    setTestRecords(new Map())
    setLiveHits([])
  }

  const handleExportRawProbeJson = () => {
    const payload = {
      schema: 'axonkey.capture-probe/1',
      exportedAt: new Date().toISOString(),
      candidate: effectiveCandidate,
      sessionStatus,
      pairedEvents: pairedHidEvents,
      discoveredButtons: discoveredProbeButtons,
      recentFrames: rawFrames,
    }
    const fileBase = draft?.deviceId || effectiveCandidate?.displayName.replace(/[^\w-]+/g, '-') || 'device-probe'
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

  const handleInstallLocalAndTest = async () => {
    if (!draft || !rawSvgContent || adaptedCount === 0) return
    setInstallingLocal(true)
    setErrorBanner('')
    try {
      let activeCompiled = targetStatus === 'active' && compiled ? compiled : null
      if (!activeCompiled) {
        const sampleList = [...samples.values()]
        try {
          activeCompiled = await captureCompileSvg(
            {
              draftSvg: rawSvgContent,
              candidate: effectiveCandidate,
              samples: sampleList,
              targetStatus: 'active',
            },
            nativeRuntime,
          )
        } catch (err) {
          if (!nativeRuntime) {
            activeCompiled = compileCaptureSvgLocal(rawSvgContent, effectiveCandidate, sampleList, 'active')
          } else {
            throw err
          }
        }
        setTargetStatus('active')
        setCompiled(activeCompiled)
      }

      const installed = nativeRuntime
        ? upsertLocalCustomDevice(
            await captureInstallLocalDevice(
              {
                svgContent: activeCompiled.svgContent,
                markdownContent: activeCompiled.markdownSummary,
              },
              true,
            ),
          )
        : upsertLocalCustomDevice(
            buildPreviewLocalCustomDeviceEntry(activeCompiled.svgContent),
            typeof window !== 'undefined' ? window.localStorage : undefined,
          )
      setLocalDeviceEntry(installed)
      setExportedPath(installed.filePath)
      onDevicesChanged?.()
      const overridesCloud = getLocalCloudDescriptorOverrides().some(item => item.kind === installed.kind)
      onToast?.(
        overridesCloud
          ? `已放入本机可用目录（${installed.name}），当前将覆盖同型号云端配置`
          : `已放入本机可用目录（${installed.name}）`,
      )

      await captureSetLivePreviewSvg(null, nativeRuntime).catch(() => {})
      await captureStopSession(nativeRuntime).catch(() => {})
      await captureSetWorkbenchActive(false, nativeRuntime).catch(() => {})
      if (onInstalledLocalDevice) {
        onInstalledLocalDevice(installed.kind)
      } else {
        onBack()
      }
    } catch (err) {
      setErrorBanner(formatErr(err))
    } finally {
      setInstallingLocal(false)
    }
  }

  const handleOpenLocalDir = async () => {
    setErrorBanner('')
    try {
      await captureOpenLocalDevicesDir(localDeviceEntry?.filePath ?? null, nativeRuntime)
    } catch (err) {
      setErrorBanner(formatErr(err))
    }
  }

  const handleCopySkillPrompt = async () => {
    try {
      await navigator.clipboard?.writeText(SKILL_SVG_PROMPT)
      setCopiedSkillPrompt(true)
      setTimeout(() => setCopiedSkillPrompt(false), 1800)
    } catch {
      /* Clipboard may be unavailable in restricted contexts. */
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
    await captureSetWorkbenchActive(false, nativeRuntime).catch(() => {})
    onBack()
  }

  const currentInput = useMemo(
    () => draft?.inputs.find(item => item.id === selectedInputId) ?? null,
    [draft, selectedInputId],
  )
  const currentInputDefined = Boolean(currentInput && isInputDefined(currentInput, samples))

  const filteredInputs = useMemo(() => {
    if (!draft) return []
    return draft.inputs.filter(item => {
      const defined = isInputDefined(item, samples)
      if (keyFilter === 'pending') return !defined
      if (keyFilter === 'captured') return defined
      return true
    })
  }, [draft, keyFilter, samples])

  const adaptedInputs = useMemo(
    () => (draft ? draft.inputs.filter(item => isInputDefined(item, samples)) : []),
    [draft, samples],
  )

  const adaptedCount = adaptedInputs.length
  const totalCount = draft?.inputs.length ?? 0
  const verifiedCompleteCount = useMemo(
    () =>
      adaptedInputs.filter(item => {
        const rec = testRecords.get(item.id)
        return Boolean(rec?.verifiedPress && rec?.verifiedRelease)
      }).length,
    [adaptedInputs, testRecords],
  )

  const gridClassName =
    step === 3
      ? `capture-workbench-grid is-three-col${treeDrawerOpen ? '' : ' is-drawer-collapsed'}`
      : 'capture-workbench-grid'

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
          {effectiveCandidate && (
            <span className="capture-header-device-pill">
              {effectiveCandidate.displayName} · {formatVidPid(effectiveCandidate.vid, effectiveCandidate.pid)}
            </span>
          )}
        </div>

        <nav className="capture-step-tabs is-header-steps" aria-label="适配流程步骤">
          <button
            type="button"
            aria-current={step === 1 ? 'step' : undefined}
            className={`capture-step-tab${step === 1 ? ' is-active' : ''}${draft ? ' is-done' : ''}`}
            onClick={() => void enterStep(1)}
          >
            <span className="capture-step-num">1</span>
            <span>准备 SVG</span>
          </button>
          <button
            type="button"
            aria-current={step === 2 ? 'step' : undefined}
            className={`capture-step-tab${step === 2 ? ' is-active' : ''}${sessionStatus?.active ? ' is-done' : ''}`}
            onClick={() => void enterStep(2)}
          >
            <span className="capture-step-num">2</span>
            <span>定位与挂载</span>
          </button>
          <button
            type="button"
            aria-current={step === 3 ? 'step' : undefined}
            className={`capture-step-tab${step === 3 ? ' is-active' : ''}${totalCount > 0 && adaptedCount === totalCount ? ' is-done' : ''}`}
            onClick={() => void enterStep(3)}
          >
            <span className="capture-step-num">3</span>
            <span>采集绑定</span>
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
            <span>测试与导出</span>
          </button>
        </nav>

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

      <div className={gridClassName}>
        <CaptureSvgStage
          sanitizedSvg={sanitizedSvg}
          draft={draft}
          svgFileName={svgFileName}
          svgError={svgError}
          samples={samples}
          armedInputId={step === 3 && armedWaiting ? selectedInputId : null}
          selectedInputId={step === 3 ? selectedInputId : null}
          livePressedIds={step === 4 ? livePressedIds : EMPTY_STRING_SET}
          liveReleasedIds={step === 4 ? liveReleasedIds : undefined}
          lastLiveTransition={step === 4 ? lastLiveTransition : null}
          collisionIds={collisionIds}
          draggingHidEventId={step === 3 ? draggingHidEventId : null}
          onSelectKey={handleSelectKeyFromStageOrList}
          onDropHidEventOnKey={step === 3 ? handleAssignHidEventToKey : undefined}
          onLoadSvgText={loadSvgContent}
        />

        {step === 1 && (
          <aside className="capture-flow-panel" aria-label="准备设备 SVG 面板">
            <div className="capture-step-body">
              <div className="capture-draft-step">
                <input
                  ref={stepFileInputRef}
                  type="file"
                  accept=".svg,image/svg+xml"
                  hidden
                  aria-label="选择本地 SVG 图稿文件"
                  onChange={event => void handleStepFilePick(event)}
                />

                <div className="capture-skill-card">
                  <div className="capture-skill-head">
                    <Camera size={16} aria-hidden="true" />
                    <strong>拍照生成规范 SVG</strong>
                    <button
                      type="button"
                      className="capture-copy-btn"
                      aria-label="复制生成 SVG 技能指令"
                      onClick={() => void handleCopySkillPrompt()}
                    >
                      {copiedSkillPrompt ? <Check size={13} /> : <Copy size={13} />}
                      {copiedSkillPrompt ? '已复制' : '复制指令'}
                    </button>
                  </div>
                  <p className="capture-skill-copy">
                    拍摄设备正面与侧边按键实拍照，使用仓库内置 <code>axonkey-device-svg</code> 技能生成{' '}
                    <code>docs/device-drafts/&lt;device-id&gt;.svg</code>。
                  </p>
                </div>

                <div className="capture-drop-card">
                  <FileCode2 size={22} aria-hidden="true" />
                  <div className="capture-drop-copy">
                    <strong>{svgFileName ?? '选择本地 SVG 文件'}</strong>
                    <span>
                      {draft
                        ? `${draft.displayName} (${draft.deviceId}) · ${totalCount} 个按键${adaptedCount > 0 ? ` · 已含 ${adaptedCount} 个定义` : ''}`
                        : '支持草稿 SVG 或已采集的设备描述文件'}
                    </span>
                  </div>
                  <div className="capture-drop-actions">
                    {draft && adaptedCount > 0 && (
                      <button type="button" className="capture-btn-secondary" onClick={handleClearAllKeyDefinitions}>
                        <Trash2 size={13} aria-hidden="true" />
                        清空按键定义
                      </button>
                    )}
                    <button
                      type="button"
                      className="capture-btn-primary"
                      onClick={() => stepFileInputRef.current?.click()}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      {draft ? '重新选择' : '选择文件'}
                    </button>
                  </div>
                </div>

                <div className="capture-preset-section">
                  <div className="capture-subpanel-head">
                    <strong>或选用现有设备 SVG ({REPO_SVG_PRESETS.length})</strong>
                  </div>
                  <div className="capture-preset-svg-list" role="list" aria-label="仓库现有 SVG 列表">
                    {REPO_SVG_PRESETS.map(preset => {
                      const isCurrent = svgFileName === `${preset.slug}.svg`
                      return (
                        <button
                          key={preset.slug}
                          type="button"
                          role="listitem"
                          data-preset-slug={preset.slug}
                          aria-pressed={isCurrent}
                          disabled={loadingPresetSlug !== null}
                          className={`capture-preset-row${isCurrent ? ' is-selected' : ''}`}
                          onClick={() => void handleLoadRepoPreset(preset)}
                        >
                          <span className="capture-preset-name">{preset.label}</span>
                          <code className="capture-preset-slug">{preset.slug}.svg</code>
                          <span className="capture-preset-count">
                            {loadingPresetSlug === preset.slug ? '加载中…' : `${preset.inputCount} 键`}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="capture-step-footer">
                  <span className="capture-footer-summary">
                    {draft ? `已就绪：${draft.displayName}（${totalCount} 键）` : '可先加载 SVG 再定位新设备'}
                  </span>
                  <button type="button" className="capture-btn-primary" onClick={() => void enterStep(2)}>
                    下一步：定位与挂载
                  </button>
                </div>
              </div>
            </div>
          </aside>
        )}

        {step === 2 && (
          <aside className="capture-flow-panel" aria-label="定位新设备与挂载驱动面板">
            <div className="capture-step-body">
              <CaptureDeviceList
                native={nativeRuntime}
                candidates={candidates}
                baselineSnapshot={candidatesInitialized ? baselineSnapshot : null}
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
                onStartSession={candidate => void startSessionForCandidate(candidate, undefined, true)}
                onStopSession={() => void handleStopSession()}
              />
              <div className="capture-step-footer">
                <button type="button" className="capture-btn-secondary" onClick={() => void enterStep(1)}>
                  上一步：更换 SVG
                </button>
                <button type="button" className="capture-btn-primary" onClick={() => void enterStep(3)}>
                  进入三列采集台
                </button>
              </div>
            </div>
          </aside>
        )}

        {step === 3 && (
          <>
            <section className="capture-stream-panel" aria-label="HID 事件流面板">
              <div className="capture-step-body">
                <div className="capture-keys-step">
                  <div
                    className={`capture-prompt-card${armedWaiting && sessionStatus?.active ? ' is-armed' : ''}`}
                    aria-live="polite"
                  >
                    {!draft ? (
                      <div className="capture-prompt-head">
                        <strong className="capture-prompt-title">尚未选择 SVG 图稿</strong>
                        <button type="button" className="capture-btn-secondary" onClick={() => void enterStep(1)}>
                          去选择 SVG
                        </button>
                      </div>
                    ) : armedWaiting && currentInput ? (
                      <>
                        <div className="capture-prompt-head">
                          <strong className="capture-prompt-title">请按下并松开【{currentInput.label}】</strong>
                          <code className="capture-prompt-id">{currentInput.id}</code>
                        </div>
                        <div className="capture-prompt-status-row">
                          {sessionStatus?.active ? (
                            <span className="capture-prompt-hint is-waiting">
                              正在监听实体按键按下与抬起，或将下方事件拖到左侧热区…
                            </span>
                          ) : (
                            <span className="capture-prompt-hint is-warn">
                              尚未连接采集会话，请在右侧设备树挂载或连接设备
                            </span>
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
                          {currentInputDefined && (
                            <button
                              type="button"
                              className="capture-btn-secondary"
                              onClick={() => handleClearKeyDefinition(currentInput.id)}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              清空该键
                            </button>
                          )}
                          <button
                            type="button"
                            className="capture-btn-secondary"
                            onClick={() => void armKeySelection(null)}
                          >
                            停止逐步
                          </button>
                          <label className="capture-inline-check capture-auto-advance">
                            <input
                              type="checkbox"
                              checked={autoAdvance}
                              onChange={event => setAutoAdvance(event.target.checked)}
                            />
                            <span>自动下一键</span>
                          </label>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="capture-prompt-head">
                          <strong className="capture-prompt-title">
                            {currentInput ? `当前按键：【${currentInput.label}】` : '拖拽事件或点击左侧按键逐步采集'}
                          </strong>
                          {currentInput && <code className="capture-prompt-id">{currentInput.id}</code>}
                        </div>
                        {currentInput && currentInputDefined && (
                          <div className="capture-prompt-status-row">
                            <span className="capture-prompt-hint is-done">
                              {samples.has(currentInput.id) ? (
                                <>
                                  ↓ {formatHexShort(samples.get(currentInput.id)?.pressHex, 5)} / ↑{' '}
                                  {formatHexShort(samples.get(currentInput.id)?.releaseHex, 5) || '—'}
                                  {samples.get(currentInput.id)?.sourceDeviceName
                                    ? ` · ${samples.get(currentInput.id)?.sourceDeviceName}`
                                    : ''}
                                </>
                              ) : (
                                '已包含预设按键映射定义'
                              )}
                            </span>
                          </div>
                        )}
                        <div className="capture-prompt-controls">
                          <button type="button" className="capture-btn-primary" onClick={handleStartSequentialCapture}>
                            开始逐步采集
                          </button>
                          {currentInput && currentInputDefined && (
                            <>
                              <button
                                type="button"
                                className="capture-btn-secondary"
                                onClick={handleRecaptureCurrentKey}
                              >
                                <RotateCcw size={13} aria-hidden="true" />
                                重采该键
                              </button>
                              <button
                                type="button"
                                className="capture-btn-secondary"
                                onClick={() => handleClearKeyDefinition(currentInput.id)}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                                清空该键
                              </button>
                            </>
                          )}
                          <label className="capture-inline-check capture-auto-advance">
                            <input
                              type="checkbox"
                              checked={autoAdvance}
                              onChange={event => setAutoAdvance(event.target.checked)}
                            />
                            <span>自动下一键</span>
                          </label>
                        </div>
                      </>
                    )}
                  </div>

                  {streamingReportIds.length > 0 && (
                    <div className="capture-noise-notice" role="status">
                      已自动忽略持续数据流报告 {streamingReportIds.map(id => formatReportIdHex(id)).join('、')}
                    </div>
                  )}

                  {collisions.length > 0 && draft && (
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
                              <div className="capture-collision-actions">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleClearKeyDefinition(item.firstInputId, { armAfter: true, silent: true })
                                  }
                                >
                                  重采 {firstLabel}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleClearKeyDefinition(item.secondInputId, { armAfter: true, silent: true })
                                  }
                                >
                                  重采 {secondLabel}
                                </button>
                                <button type="button" onClick={() => handleClearKeyDefinition(item.firstInputId)}>
                                  清空 {firstLabel}
                                </button>
                                <button type="button" onClick={() => handleClearKeyDefinition(item.secondInputId)}>
                                  清空 {secondLabel}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="capture-stream-toolbar">
                    <div className="capture-stage-mode-tabs" role="tablist" aria-label="采集流与按键切换">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={streamTab === 'events'}
                        className={`capture-mode-tab${streamTab === 'events' ? ' active' : ''}`}
                        onClick={() => setStreamTab('events')}
                      >
                        HID 事件流
                        {pairedHidEvents.length > 0 && (
                          <span className="capture-tab-count">{pairedHidEvents.length}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={streamTab === 'keys'}
                        className={`capture-mode-tab${streamTab === 'keys' ? ' active' : ''}`}
                        onClick={() => setStreamTab('keys')}
                      >
                        按键清单
                        {totalCount > 0 && (
                          <span className="capture-tab-count">
                            {adaptedCount}/{totalCount}
                          </span>
                        )}
                      </button>
                    </div>

                    {streamTab === 'events' ? (
                      <div className="capture-stream-actions">
                        <button
                          type="button"
                          className="capture-tool-button"
                          disabled={pairedHidEvents.length === 0 && rawFrames.length === 0}
                          onClick={handleExportRawProbeJson}
                        >
                          <Download size={12} aria-hidden="true" />
                          导出 JSON
                        </button>
                        <button
                          type="button"
                          className="capture-tool-button"
                          disabled={pairedHidEvents.length === 0 && rawFrames.length === 0}
                          aria-label="清空 HID 事件流"
                          onClick={handleClearStream}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          清空
                        </button>
                      </div>
                    ) : (
                      <div className="capture-stream-actions">
                        <div className="capture-filter-pills" role="group" aria-label="按键状态筛选">
                          <button type="button" aria-pressed={keyFilter === 'all'} onClick={() => setKeyFilter('all')}>
                            全部 ({totalCount})
                          </button>
                          <button
                            type="button"
                            aria-pressed={keyFilter === 'pending'}
                            onClick={() => setKeyFilter('pending')}
                          >
                            待采 ({totalCount - adaptedCount})
                          </button>
                          <button
                            type="button"
                            aria-pressed={keyFilter === 'captured'}
                            onClick={() => setKeyFilter('captured')}
                          >
                            已采 ({adaptedCount})
                          </button>
                        </div>
                        <button
                          type="button"
                          className="capture-tool-button is-danger-hover"
                          disabled={adaptedCount === 0}
                          aria-label="清空全部按键定义"
                          onClick={handleClearAllKeyDefinitions}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          清空全部
                        </button>
                      </div>
                    )}
                  </div>

                  {streamTab === 'events' ? (
                    pairedHidEvents.length === 0 ? (
                      <div className="capture-empty-box">
                        <strong>
                          {sessionStatus?.active ? '按下实体设备按键产生 HID 事件' : '等待连接设备采集会话'}
                        </strong>
                        <span>
                          {sessionStatus?.active
                            ? '每次按下与抬起会自动合并为单条事件，可直接拖拽到左侧 SVG 按键上。'
                            : '在右侧设备树挂载拦截驱动或连接采集后，按键报文将实时显示在此处。'}
                        </span>
                      </div>
                    ) : (
                      <div className="capture-hid-event-list" role="list" aria-label="HID 事件流列表">
                        {pairedHidEvents.map(item => {
                          const sig = `${item.reportId}:${item.pressHex}`
                          const boundLabels = boundLabelsByEventSig.get(sig) ?? []
                          const isDraggingThis = draggingHidEventId === item.id
                          return (
                            <div
                              key={item.id}
                              role="listitem"
                              draggable
                              data-hid-event-id={item.id}
                              data-pressed={item.isPressed || undefined}
                              className={`capture-hid-event-card${item.isPressed ? ' is-pressed' : ''}${isDraggingThis ? ' is-dragging' : ''}${boundLabels.length > 0 ? ' is-bound' : ''}`}
                              onDragStart={event => handleEventDragStart(event, item)}
                              onDragEnd={handleEventDragEnd}
                            >
                              <div className="capture-hid-event-head">
                                <GripVertical size={13} className="capture-hid-grip" aria-hidden="true" />
                                <span className="capture-hex-chip">{formatReportIdHex(item.reportId)}</span>
                                {item.source.deviceName && (
                                  <span className="capture-hid-device-tag" title={item.source.instanceId ?? undefined}>
                                    {item.source.deviceName}
                                  </span>
                                )}
                                <span className={`capture-hid-hit-pill${item.isPressed ? ' is-live' : ''}`}>
                                  {item.isPressed ? '按下中' : `×${item.hitCount}`}
                                </span>
                                {boundLabels.length > 0 && (
                                  <span className="capture-hid-bound-badge">{boundLabels.join('、')}</span>
                                )}
                              </div>

                              <div className="capture-hid-pair-rows">
                                <div className="capture-hid-pair-row">
                                  <span className="capture-hid-phase is-press">按下</span>
                                  <code>{item.pressHex}</code>
                                </div>
                                <div className="capture-hid-pair-row">
                                  <span className="capture-hid-phase is-release">抬起</span>
                                  <code>
                                    {item.hasObservedRelease || !item.isPressed ? item.releaseHex : '等待抬起…'}
                                  </code>
                                </div>
                              </div>

                              {currentInput && (
                                <div className="capture-hid-card-actions">
                                  <span className="capture-hid-drag-hint">拖拽到左侧按键</span>
                                  <button
                                    type="button"
                                    className="capture-probe-bind"
                                    aria-label={`绑定事件到 ${currentInput.label}`}
                                    onClick={() => handleAssignHidEventToKey(currentInput.id, item.id)}
                                  >
                                    <Link2 size={11} aria-hidden="true" />
                                    绑定到 {currentInput.label}
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  ) : !draft ? (
                    <div className="capture-empty-box">
                      <strong>尚未加载 SVG 图稿</strong>
                    </div>
                  ) : (
                    <div className="capture-key-list" role="list" aria-label="设备按键采集列表">
                      {filteredInputs.map(item => {
                        const sample = samples.get(item.id)
                        const isDefined = isInputDefined(item, samples)
                        const isSelected = selectedInputId === item.id
                        const hasCollision = collisionIds.has(item.id)
                        const justCaptured = lastCapturedInputId === item.id
                        const isRowDrop = dropKeyRowId === item.id
                        return (
                          <div
                            key={item.id}
                            role="listitem"
                            data-key-row={item.id}
                            className={`capture-key-row${isSelected ? ' is-selected' : ''}${isDefined ? ' is-captured' : ''}${hasCollision ? ' is-collision' : ''}${justCaptured ? ' is-flash' : ''}${isRowDrop ? ' is-drop-target' : ''}`}
                            onDragOver={event => {
                              if (!draggingHidEventId && !event.dataTransfer?.types?.includes(HID_EVENT_DRAG_MIME)) {
                                return
                              }
                              event.preventDefault()
                              if (dropKeyRowId !== item.id) setDropKeyRowId(item.id)
                            }}
                            onDragLeave={() => {
                              if (dropKeyRowId === item.id) setDropKeyRowId(null)
                            }}
                            onDrop={event => {
                              const droppedId =
                                event.dataTransfer?.getData(HID_EVENT_DRAG_MIME) || draggingHidEventId || ''
                              if (!droppedId) return
                              event.preventDefault()
                              handleAssignHidEventToKey(item.id, droppedId)
                            }}
                          >
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              className="capture-key-row-main"
                              onClick={() => void armKeySelection(item.id)}
                            >
                              <span className="capture-key-dot" aria-hidden="true" />
                              <span className="capture-key-label">{item.label}</span>
                              {sample ? (
                                <code
                                  className="capture-key-hex"
                                  title={`按下: ${sample.pressHex}\n抬起: ${sample.releaseHex}`}
                                >
                                  {formatHexShort(sample.pressHex, 5)}
                                </code>
                              ) : isDefined ? (
                                <span className="capture-key-hex">预设定义</span>
                              ) : (
                                <span className="capture-key-pending">
                                  {skippedIds.has(item.id) ? '已跳过' : '待采集'}
                                </span>
                              )}
                            </button>
                            {isDefined && (
                              <button
                                type="button"
                                className="capture-key-clear-btn"
                                aria-label={`清空 ${item.label} 按键定义`}
                                title="清空该键定义"
                                onClick={() => handleClearKeyDefinition(item.id)}
                              >
                                <Trash2 size={12} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <div className="capture-step-footer">
                    <span className="capture-footer-summary">
                      已适配 {adaptedCount} / {totalCount}
                    </span>
                    <button
                      type="button"
                      className="capture-btn-primary"
                      disabled={!draft}
                      onClick={() => {
                        setTargetStatus(adaptedCount === totalCount && totalCount > 0 ? 'active' : 'draft')
                        void enterStep(4)
                      }}
                    >
                      <Play size={13} aria-hidden="true" />
                      进入测试与导出
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <aside className={`capture-tree-drawer${treeDrawerOpen ? '' : ' is-collapsed'}`} aria-label="设备树抽屉">
              {treeDrawerOpen ? (
                <>
                  <header className="capture-drawer-header">
                    <strong className="capture-panel-title">设备树</strong>
                    <span className="capture-tab-count">{candidates.length}</span>
                    <button
                      type="button"
                      className="capture-drawer-toggle"
                      aria-label="收起设备树"
                      aria-expanded={true}
                      onClick={() => setTreeDrawerOpen(false)}
                    >
                      <PanelRightClose size={14} aria-hidden="true" />
                      <span>收起</span>
                    </button>
                  </header>
                  <div className="capture-drawer-body">
                    <CaptureDeviceList
                      native={nativeRuntime}
                      candidates={candidates}
                      baselineSnapshot={candidatesInitialized ? baselineSnapshot : null}
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
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="capture-drawer-rail-btn"
                  aria-label="展开设备树"
                  aria-expanded={false}
                  onClick={() => setTreeDrawerOpen(true)}
                >
                  <PanelRightOpen size={15} aria-hidden="true" />
                  <span>设备树</span>
                </button>
              )}
            </aside>
          </>
        )}

        {step === 4 && (
          <aside className="capture-flow-panel" aria-label="按键测试与导出面板">
            <div className="capture-step-body">
              {!draft ? (
                <div className="capture-empty-box">
                  <strong>请先选择设备 SVG 图稿</strong>
                  <button type="button" className="capture-btn-primary" onClick={() => void enterStep(1)}>
                    去准备 SVG
                  </button>
                </div>
              ) : (
                <div className="capture-export-step">
                  <div className="capture-live-test-card">
                    <div className="capture-live-test-head">
                      <Sparkles size={15} aria-hidden="true" />
                      <strong>逐键按下 / 抬起测试</strong>
                      <span className="capture-test-progress">
                        已验证 {verifiedCompleteCount} / {adaptedCount}
                      </span>
                      {liveHits.length > 0 && (
                        <button type="button" className="capture-copy-btn" onClick={handleResetLiveTest}>
                          重置
                        </button>
                      )}
                      <span className={`capture-validation-pill ${compiled?.validated ? 'is-ok' : 'is-draft'}`}>
                        {compiling ? '正在编译…' : compiled?.validated ? '解析校验通过' : '草稿待完善'}
                      </span>
                    </div>

                    {adaptedInputs.length === 0 ? (
                      <p className="capture-empty-hint">尚未采集任何按键，请先返回步骤 3 拖拽绑定或逐键采集。</p>
                    ) : (
                      <div className="capture-test-key-list" role="list" aria-label="按键按下抬起测试列表">
                        {adaptedInputs.map(input => {
                          const record = testRecords.get(input.id)
                          const sample = samples.get(input.id)
                          const pressedNow = Boolean(record?.pressedNow)
                          const verifiedPress = Boolean(record?.verifiedPress)
                          const verifiedRelease = Boolean(record?.verifiedRelease)
                          return (
                            <div
                              key={input.id}
                              role="listitem"
                              data-test-key={input.id}
                              data-pressed-now={pressedNow || undefined}
                              data-verified-press={verifiedPress || undefined}
                              data-verified-release={verifiedRelease || undefined}
                              className={`capture-test-key-row${pressedNow ? ' is-pressing' : ''}${verifiedPress && verifiedRelease ? ' is-verified-both' : ''}`}
                            >
                              <div className="capture-test-key-info">
                                <strong>{input.label}</strong>
                                {sample?.sourceDeviceName && <small>{sample.sourceDeviceName}</small>}
                              </div>
                              <div className="capture-test-state-badges">
                                <span
                                  className={`capture-test-badge ${pressedNow ? 'is-down-now' : verifiedPress ? 'is-verified' : 'is-idle'}`}
                                >
                                  {pressedNow ? '按下中' : verifiedPress ? '按下 ✓' : '待按下'}
                                </span>
                                <span
                                  className={`capture-test-badge ${!pressedNow && verifiedRelease ? 'is-up-verified' : pressedNow ? 'is-waiting-up' : 'is-idle'}`}
                                >
                                  {!pressedNow && verifiedRelease ? '抬起 ✓' : pressedNow ? '松开测试…' : '待抬起'}
                                </span>
                                <button
                                  type="button"
                                  className="capture-row-mini-btn"
                                  aria-label={`重新采集 ${input.label}`}
                                  onClick={() => handleClearKeyDefinition(input.id, { armAfter: true, silent: true })}
                                >
                                  重采
                                </button>
                                <button
                                  type="button"
                                  className="capture-row-mini-btn is-danger"
                                  aria-label={`清空 ${input.label} 按键定义`}
                                  onClick={() => handleClearKeyDefinition(input.id)}
                                >
                                  清空
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {liveHits.length > 0 && (
                      <div className="capture-live-hit-list" aria-label="实机试按命中记录">
                        {liveHits.map(hit => (
                          <div key={hit.id} className={`capture-live-hit-row ${hit.pressed ? 'is-down' : 'is-up'}`}>
                            <strong>{hit.label}</strong>
                            <span>{hit.pressed ? '按下' : '抬起'}</span>
                            <code>{formatHexShort(hit.hex, 5)}</code>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="capture-export-box">
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
                                  按键冲突：【{firstLabel}】与【{secondLabel}】（
                                  <code>{formatHexShort(item.pressHex, 5)}</code>）
                                </span>
                                <div className="capture-collision-actions">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleClearKeyDefinition(item.firstInputId, { armAfter: true, silent: true })
                                    }
                                  >
                                    重采 {firstLabel}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleClearKeyDefinition(item.secondInputId, { armAfter: true, silent: true })
                                    }
                                  >
                                    重采 {secondLabel}
                                  </button>
                                  <button type="button" onClick={() => handleClearKeyDefinition(item.firstInputId)}>
                                    清空 {firstLabel}
                                  </button>
                                  <button type="button" onClick={() => handleClearKeyDefinition(item.secondInputId)}>
                                    清空 {secondLabel}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <div className="capture-export-actions">
                      <button
                        type="button"
                        className="capture-btn-primary capture-export-btn"
                        disabled={
                          compiling || installingLocal || savingExport || adaptedCount === 0 || collisions.length > 0
                        }
                        onClick={() => void handleInstallLocalAndTest()}
                      >
                        <Sparkles size={15} aria-hidden="true" />
                        {installingLocal ? '正在放入本机…' : '放入本机并测试'}
                      </button>
                      <button
                        type="button"
                        className="capture-btn-secondary capture-export-btn"
                        disabled={!compiled || compiling || savingExport || installingLocal}
                        onClick={() => void handleSaveExport()}
                      >
                        <Download size={15} aria-hidden="true" />
                        {savingExport ? '正在保存…' : '保存 SVG 与采集记录'}
                      </button>
                    </div>

                    {exportedPath && (
                      <p className="capture-exported-path" role="status">
                        已输出：<code>{exportedPath}</code>
                      </p>
                    )}

                    <div className="capture-cli-next">
                      <div className="capture-cli-next-head">
                        <span>本机 custom-devices 目录已对接集成体系；也可上传云端控制台或构建内置索引</span>
                        <div className="capture-cli-next-actions">
                          {nativeRuntime && (
                            <button
                              type="button"
                              className="capture-copy-btn"
                              onClick={() => void handleOpenLocalDir()}
                              aria-label="打开本机设备目录"
                            >
                              <FolderOpen size={13} aria-hidden="true" />
                              打开本机目录
                            </button>
                          )}
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
                      </div>
                      <code>{CLI_GENERATE_CMD}</code>
                    </div>

                    <div className="capture-step-footer">
                      <button type="button" className="capture-btn-secondary" onClick={() => void enterStep(3)}>
                        返回采集绑定
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
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
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
              if (stepRef.current <= 2) {
                void enterStep(3)
              }
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
                  await captureSetWorkbenchActive(false, nativeRuntime).catch(() => {})
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
                  await captureSetWorkbenchActive(false, nativeRuntime).catch(() => {})
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

function candidateToEventSource(candidate: CaptureCandidate | null): PairedHidEventSource {
  if (!candidate) {
    return {
      targetId: null,
      instanceId: null,
      deviceName: null,
      vid: null,
      pid: null,
    }
  }
  return {
    targetId: candidate.targetId,
    instanceId: candidate.instanceId,
    deviceName: candidate.displayName,
    vid: candidate.vid,
    pid: candidate.pid,
  }
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
