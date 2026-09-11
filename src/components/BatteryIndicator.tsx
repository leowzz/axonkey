import { Battery, BatteryFull, BatteryLow, BatteryMedium } from 'lucide-react'

export function BatteryIndicator({ level }: { level: number | null }) {
  const tone = level !== null && level < 20 ? 'low' : level === 100 ? 'full' : 'normal'
  const Icon = level === null ? Battery : tone === 'low' ? BatteryLow : tone === 'full' ? BatteryFull : BatteryMedium
  const description = level === null ? '电量未知' : `${level}%${tone === 'low' ? '，电量不足' : tone === 'full' ? '，已满电' : ''}`

  return <>
    <Icon className={`battery-icon ${tone}`} size={14} aria-hidden="true" />
    <span className={`battery-level ${tone}`} aria-label={description} title={description}>{level === null ? '电量未知' : `${level}%`}</span>
  </>
}

export function BatteryDebugControls({ onAdjust }: { onAdjust: (delta: number) => void }) {
  return <div className="battery-debug-controls" role="group" aria-label="预览电量">
    <span>预览电量</span>
    <button type="button" onClick={() => onAdjust(-5)} aria-label="预览电量减少5%">−5%</button>
    <button type="button" onClick={() => onAdjust(5)} aria-label="预览电量增加5%">+5%</button>
  </div>
}
